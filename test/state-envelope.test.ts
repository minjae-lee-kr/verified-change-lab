import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { provenance } from '../src/experiment.ts';
import { createFixture, git, prepareCandidate } from '../src/git.ts';
import { approveCandidate } from '../src/protocol.ts';
import { verifyCandidate } from '../src/runner.ts';
import { boundedProcess, processSucceeded } from '../src/process.ts';
import type { ProcessResult } from '../src/types.ts';
import {
  captureState,
  commitState,
  initializeState,
  operationReceipt,
  parseState,
  prepareStateChange,
  selectPreparedState,
  STATE_REF,
  type AuthorizedChange,
  type StatePlan,
} from '../src/state-envelope.ts';
import {
  runStateExperiments,
  STATE_CASE_IDS,
  stateCasesPassed,
} from '../src/state-envelope-experiment.ts';
import { checkStateCases } from '../src/state-envelope-check.ts';
import {
  digest,
  LAB,
  PROJECT,
  readJson,
  readTranscript,
  redacted,
  runId,
  writeJson,
} from '../src/support.ts';

test(
  'two prepared workers distinguish the same approval from a competing candidate',
  { timeout: 90_000 },
  async () => {
    for (const sameApproval of [true, false]) {
      const fixture = await createFixture(sameApproval ? 'cw-same-test' : 'cw-distinct-test');
      const authorize = async (variant: 'A' | 'B'): Promise<AuthorizedChange> => {
        const candidate = await prepareCandidate(fixture, variant);
        const evidence = await verifyCandidate(fixture, candidate);
        const approved = await approveCandidate(
          fixture,
          candidate,
          evidence,
          'Scripted competing writer',
          `APPLY ${candidate.commit} ${digest(evidence)}`,
        );
        assert.ok(approved.approval, approved.verdict.code);
        return { fixture, candidate, evidence, approval: approved.approval };
      };
      const first = await authorize('A');
      const inputs = [first, sameApproval ? first : await authorize('B')];
      assert.equal(digest(inputs[0]!.approval) === digest(inputs[1]!.approval), sameApproval);
      assert.equal(inputs[0]!.candidate.commit === inputs[1]!.candidate.commit, sameApproval);
      const initial = await initializeState(fixture);
      const paths = await Promise.all(
        inputs.map(async (input) => {
          const directory = join(fixture.root, 'state-executions', runId());
          const requestPath = join(directory, 'request.json');
          await writeJson(requestPath, { input, mode: 'envelope' });
          return { directory, requestPath };
        }),
      );
      const prepared: {
        index: number;
        plan: Extract<StatePlan, { code: 'PREPARED' }>;
        release: () => void;
      }[] = [];
      const terminators = new Map<number, () => void>();
      let barrierError: unknown = null;
      const fail = (error: unknown) => {
        barrierError ??= error;
        for (const terminate of terminators.values()) terminate();
      };
      const tasks = paths.map(({ requestPath }, index) =>
        boundedProcess(
          process.execPath,
          [join(PROJECT, 'src/state-envelope-worker.ts'), requestPath],
          {
            cwd: fixture.root,
            timeoutMs: 20_000,
            maxOutputBytes: 32_000,
            ipc: {
              onMessage(message, child, terminate) {
                terminators.set(index, terminate);
                if (barrierError) {
                  terminate();
                  return;
                }
                if (
                  !message ||
                  typeof message !== 'object' ||
                  !('phase' in message) ||
                  !('detail' in message)
                ) {
                  fail(new Error('Missing worker phase evidence.'));
                  return;
                }
                const send = (phase: string) =>
                  child.send({ continue: phase }, (error) => {
                    if (error) fail(error);
                  });
                if (message.phase === 'state-prepared') {
                  const plan = message.detail as StatePlan;
                  if (
                    plan.code !== 'PREPARED' ||
                    plan.expected.oid !== initial.oid ||
                    prepared.some((p) => p.index === index)
                  ) {
                    fail(new Error('Workers did not prepare once from the same expected OID.'));
                    return;
                  }
                  prepared.push({ index, plan, release: () => send('state-prepared') });
                  // Release only after BOTH real workers have prepared. This does not
                  // assert that their Git lock syscalls overlap or determine a winner.
                  if (prepared.length === 2) prepared.forEach((p) => p.release());
                } else if (message.phase === 'ready' || message.phase === 'state-selected')
                  send(message.phase);
                else fail(new Error('Unexpected worker phase.'));
              },
            },
          },
        ).finally(() => terminators.delete(index)),
      );
      try {
        const processes = await Promise.all(tasks);
        assert.equal(barrierError, null);
        assert.equal(prepared.length, 2);
        for (const result of processes) {
          assert.equal(result.directChildExitConfirmed, true);
          assert.equal(result.signal, null);
          assert.equal(result.timedOut, false);
          assert.equal(result.outputLimited, false);
          assert.equal(result.processError, undefined);
        }
        const successful = processes.flatMap((result, index) =>
          processSucceeded(result) ? [index] : [],
        );
        assert.equal(successful.length, 1);
        const winner = successful[0]!;
        assert.equal(processes[1 - winner]!.exitCode, 1);
        assert.match(processes[1 - winner]!.stderr, /State CAS was not acknowledged/);
        const selected = await captureState(fixture);
        assert.equal(selected.oid, prepared.find((p) => p.index === winner)!.plan.next.oid);
        assert.equal(selected.state.selectedCandidate, inputs[winner]!.candidate.commit);
        assert.deepEqual(selected.state.receipts, [operationReceipt(inputs[winner]!)]);
        const attempts = (await readTranscript(fixture.root))
          .filter((entry) => entry.event === 'git')
          .map((entry) => entry.detail as ProcessResult)
          .filter(
            (result) =>
              result.arguments.slice(-4, -2).join('|') === `update-ref|${STATE_REF}` &&
              result.arguments.at(-1) === initial.oid,
          );
        assert.equal(attempts.length, 2);
        assert.equal(attempts.filter(processSucceeded).length, 1);
        for (const result of attempts) {
          assert.equal(result.directChildExitConfirmed, true);
          assert.equal(result.signal, null);
          assert.equal(result.timedOut, false);
          assert.equal(result.outputLimited, false);
          assert.equal(result.processError, undefined);
          assert.notEqual(result.exitCode, null);
        }
        for (const [index, input] of inputs.entries()) {
          const retry = await prepareStateChange(input);
          assert.equal(
            retry.code,
            sameApproval || index === winner ? 'ALREADY_RECORDED' : 'BASE_CHANGED',
          );
          let acknowledgement: unknown = null;
          try {
            acknowledgement = await readJson(join(paths[index]!.directory, 'acknowledgement.json'));
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
              throw error;
          }
          assert.deepEqual(
            acknowledgement,
            index === winner ? { code: 'STATE_CAS_ACKNOWLEDGED', stateOid: selected.oid } : null,
          );
        }
        assert.equal(
          (await captureState(fixture)).oid,
          selected.oid,
          'Re-observation must not select another state.',
        );
      } finally {
        for (const terminate of terminators.values()) terminate();
        await Promise.allSettled(tasks);
      }
    }
  },
);

test(
  'real interruption traces distinguish retained selection/receipt from acknowledgement',
  { timeout: 90_000 },
  async () => {
    const sourceBefore = await provenance();
    const cases = await runStateExperiments();
    const sourceAfter = await provenance();
    const record = join(LAB, 'state-envelope-tests', `${runId()}.json`);
    await writeJson(
      record,
      JSON.parse(
        redacted(
          JSON.stringify({
            kind: 'focused-test-record',
            command: 'node --test test/state-envelope.test.ts',
            sourceBefore,
            sourceAfter,
            cases,
          }),
        ),
      ),
    );
    console.log(`Focused test evidence: ${redacted(record)}`);
    assert.equal(sourceBefore.sourceFingerprint, sourceAfter.sourceFingerprint);
    assert.deepEqual(
      cases.map((item) => item.id),
      STATE_CASE_IDS,
    );
    assert.equal(
      stateCasesPassed(cases),
      true,
      JSON.stringify(
        cases.flatMap((item) =>
          item.observations
            .filter((check) => !check.passed)
            .map((check) => ({ case: item.id, ...check })),
        ),
      ),
    );
    assert.equal(stateCasesPassed([]), false);
    assert.equal(stateCasesPassed(cases.slice(1)), false);
    for (const item of cases) {
      const retention = item.facts.codeRetention as {
        retainedCommit: string;
        retainedParent: string;
      };
      const candidate = item.facts.candidate as { commit: string; base: string };
      assert.equal(retention.retainedCommit, candidate.commit);
      assert.equal(retention.retainedParent, candidate.base);
    }
    const missing = structuredClone(cases);
    missing[0]!.observations = [];
    assert.equal(stateCasesPassed(missing), false);
    const altered = structuredClone(cases);
    altered[0]!.observations[0]!.actual = false;
    assert.equal(
      stateCasesPassed(altered),
      false,
      'A retained passed flag cannot hide contradictory evidence.',
    );
    altered[0]!.observations[0]!.expected = false;
    assert.equal(
      checkStateCases(altered).passed,
      false,
      'Changing expected and actual together cannot redefine the case.',
    );
    const receiptRemoved = structuredClone(cases);
    const observed = receiptRemoved[2]!.facts.observed as { state: { receipts: unknown[] } };
    observed.state.receipts = [];
    assert.equal(
      checkStateCases(receiptRemoved).passed,
      false,
      'Summary flags cannot conceal a missing state receipt.',
    );
    const barrierRemoved = structuredClone(cases);
    const worker = barrierRemoved[2]!.facts.worker as { phases: unknown[] };
    worker.phases.splice(1, 1);
    assert.equal(
      checkStateCases(barrierRemoved).passed,
      false,
      'A declared stop must have its phase evidence.',
    );
    const wrongOid = structuredClone(cases);
    (wrongOid[4]!.facts.capturedAgain as { oid: string }).oid = 'f'.repeat(40);
    assert.equal(
      checkStateCases(wrongOid).passed,
      false,
      'The captured OID must match its Git show record.',
    );
    const lateRefChanged = structuredClone(cases);
    const beforeCasTranscript = lateRefChanged[1]!.transcripts[0]!;
    const finalRef = beforeCasTranscript.findLast(
      (entry) =>
        entry.event === 'git' &&
        (entry.detail as { arguments: string[] }).arguments.slice(-2).join('|') ===
          'rev-parse|refs/heads/lab-state',
    );
    assert.ok(finalRef);
    (finalRef.detail as { stdout: string }).stdout = 'f'.repeat(40) + '\n';
    assert.equal(
      checkStateCases(lateRefChanged).passed,
      false,
      'An earlier matching read cannot replace the post-retry final read.',
    );
    const noLaterCapturedRead = structuredClone(cases);
    const reader = noLaterCapturedRead[4]!;
    const firstOid = (reader.facts.capturedInitial as { oid: string }).oid;
    let selectionOccurred = false;
    reader.transcripts[0] = reader.transcripts[0]!.filter((entry) => {
      if (entry.event !== 'git') return true;
      const command = entry.detail as { arguments: string[] };
      if (
        command.arguments.slice(-4, -2).join('|') === 'update-ref|refs/heads/lab-state' &&
        command.arguments.at(-1) === firstOid
      )
        selectionOccurred = true;
      return !(
        selectionOccurred && command.arguments.slice(-2).join('|') === `show|${firstOid}:state.json`
      );
    });
    assert.equal(
      checkStateCases(noLaterCapturedRead).passed,
      false,
      'The initial show cannot stand in for re-reading the captured OID later.',
    );
  },
);

test('state reader refuses malformed, duplicate and oversized local receipts', () => {
  const receipt = {
    operationId: 'a'.repeat(64),
    base: 'b'.repeat(40),
    candidate: 'c'.repeat(40),
    evidenceDigest: 'd'.repeat(64),
    policyDigest: 'e'.repeat(64),
  };
  const state = { version: 1, selectedCandidate: 'c'.repeat(40), receipts: [receipt] };
  assert.deepEqual(parseState(JSON.stringify(state)), state);
  for (const malformed of [
    { ...state, receipts: [receipt, receipt] },
    { ...state, receipts: [{ ...receipt, candidate: ['c'.repeat(40)] }] },
    { ...state, extra: true },
    { ...state, receipts: [{ ...receipt, secret: 'unexpected' }] },
  ])
    assert.throws(() => parseState(JSON.stringify(malformed)));
  assert.throws(() => parseState(' '.repeat(32_001) + '{}'), /budget/);
});

test(
  'prepared state binds receipt semantics and the exact prior state OID',
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture('state-binding-test');
    const candidate = await prepareCandidate(fixture);
    const evidence = await verifyCandidate(fixture, candidate);
    const approved = await approveCandidate(
      fixture,
      candidate,
      evidence,
      'Scripted test',
      `APPLY ${candidate.commit} ${digest(evidence)}`,
    );
    assert.ok(approved.approval);
    const input = { fixture, candidate, evidence, approval: approved.approval };
    const initial = await initializeState(fixture);
    for (const path of ['src/state-envelope.ts', 'src/state-envelope-worker.ts']) {
      const oldEvidence = structuredClone(evidence);
      const oldSource = oldEvidence.policy.sourceHashes.find((source) => source.path === path);
      assert.ok(oldSource, 'Storage authority source must be in the approval policy.');
      oldSource.sha256 = '0'.repeat(64);
      oldEvidence.policyDigest = digest(oldEvidence.policy);
      const oldApproval = {
        ...approved.approval,
        evidenceDigest: digest(oldEvidence),
        policyDigest: oldEvidence.policyDigest,
      };
      await assert.rejects(
        prepareStateChange({ ...input, evidence: oldEvidence, approval: oldApproval }),
        /POLICY_CHANGED/,
      );
      assert.equal((await captureState(fixture)).oid, initial.oid);
    }
    const plan = await prepareStateChange(input);
    assert.equal(plan.code, 'PREPARED');
    if (plan.code !== 'PREPARED') throw new Error('Expected prepared state.');
    const wrong = await commitState(
      fixture,
      { ...plan.next.state, selectedCandidate: candidate.base },
      initial.oid,
    );
    await assert.rejects(selectPreparedState(input, { ...plan, next: wrong }), /does not bind/);
    const parentless = await commitState(fixture, plan.next.state);
    await assert.rejects(
      selectPreparedState(input, { ...plan, next: parentless }),
      /does not bind/,
    );
    assert.equal((await captureState(fixture)).oid, initial.oid);
    const competitor = await commitState(fixture, initial.state, initial.oid);
    await git(fixture, ['update-ref', STATE_REF, competitor.oid, initial.oid]);
    const result = await selectPreparedState(input, plan);
    assert.equal(result.code, 'STATE_CAS_UNACKNOWLEDGED');
    assert.equal((await captureState(fixture)).oid, competitor.oid);
  },
);

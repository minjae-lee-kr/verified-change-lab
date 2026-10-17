import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { provenance } from '../src/experiment.ts';
import { createFixture, git, prepareCandidate } from '../src/git.ts';
import { approveCandidate } from '../src/protocol.ts';
import { verifyCandidate } from '../src/runner.ts';
import {
  captureState,
  commitState,
  initializeState,
  parseState,
  prepareStateChange,
  selectPreparedState,
  STATE_REF,
} from '../src/state-envelope.ts';
import {
  runStateExperiments,
  STATE_CASE_IDS,
  stateCasesPassed,
} from '../src/state-envelope-experiment.ts';
import { checkStateCases } from '../src/state-envelope-check.ts';
import { digest, LAB, redacted, runId, writeJson } from '../src/support.ts';

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

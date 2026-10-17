import assert from 'node:assert/strict';
import { digest } from '../../src/support.ts';
import type { CapturedState } from '../../src/state-envelope.ts';
import type { ProcessResult } from '../../src/types.ts';
import { CASE_IDS, type ExpiryCase } from './types.ts';

const STATE_REF = 'refs/heads/lab-state';
const same = (actual: unknown, expected: unknown, label: string) =>
  assert.deepEqual(actual, expected, label);
const completed = (p: ProcessResult, exit: number) => {
  same(p.exitCode, exit, 'actual process exit');
  same(p.signal, null, 'unexpected signal');
  same(p.timedOut, false, 'timeout is not a control outcome');
  same(p.outputLimited, false, 'truncated output is not complete evidence');
  same(p.processError, undefined, 'process or pipe error');
  same(p.directChildExitConfirmed, true, 'worker exit not observed');
  same(
    p.ownedTreeTerminationAcknowledged,
    null,
    'this control must not require forced termination',
  );
};
function command(p: ProcessResult): string[] {
  assert.ok(Array.isArray(p.arguments) && p.arguments.every((x) => typeof x === 'string'));
  const index = p.arguments.indexOf('--git-dir');
  assert.ok(index >= 0, 'owned Git repository argument missing');
  return p.arguments.slice(index + 2);
}

function readBlock(item: ExpiryCase, label: string, captured: CapturedState): number {
  const matches = item.transcript.flatMap((entry, index) =>
    entry.event === 'expiry-state-read' && (entry.detail as { label?: string })?.label === label
      ? [index]
      : [],
  );
  same(matches.length, 1, `exactly one ${label} read anchor required`);
  const index = matches[0]!;
  same(item.transcript[index]!.detail, { label, oid: captured.oid }, 'capture anchor OID');
  assert.ok(index >= 5, 'capture lacks its five Git reads');
  const reads = item.transcript.slice(index - 5, index);
  assert.ok(
    reads.every((entry) => entry.event === 'git'),
    'anchored read block interrupted',
  );
  const expected = [
    { args: ['rev-parse', STATE_REF], stdout: captured.oid },
    { args: ['ls-tree', '-r', '--name-only', captured.oid], stdout: 'state.json' },
    { args: ['show', `${captured.oid}:state.json`], stdout: null },
    { args: ['show', '-s', '--format=%P', captured.oid], stdout: captured.parents.join(' ') },
    { args: ['cat-file', '-e', `${captured.state.selectedCandidate}^{commit}`], stdout: '' },
  ];
  for (let n = 0; n < reads.length; n++) {
    const p = reads[n]!.detail as ProcessResult;
    completed(p, 0);
    same(command(p), expected[n]!.args, 'anchored Git read command');
    if (n === 2)
      same(JSON.parse(p.stdout), captured.state, 'state JSON differs from captured commit read');
    else same(p.stdout.trim(), expected[n]!.stdout, 'anchored Git read output');
  }
  return index;
}

function checkCase(item: ExpiryCase, after: boolean) {
  same(item.executionError, null, 'harness error');
  assert.ok(item.prepared && item.final && item.process, 'required observations missing');
  const { candidate, approval, evidence, prepared, initial, final, process: worker } = item;
  const expectedReceipt = {
    operationId: digest(approval),
    base: candidate.base,
    candidate: candidate.commit,
    evidenceDigest: digest(evidence),
    policyDigest: evidence.policyDigest,
  };
  same(item.receipt, expectedReceipt, 'receipt must bind the actual evidence and approval');
  same(approval.base, candidate.base, 'approval base');
  same(approval.candidateCommit, candidate.commit, 'approval candidate');
  same(approval.candidateTree, candidate.tree, 'approval tree');
  same(approval.evidenceDigest, digest(evidence), 'approved evidence');
  same(approval.policyDigest, digest(evidence.policy), 'approved policy');
  same(evidence.policyDigest, approval.policyDigest, 'evidence policy');
  same(evidence.candidate, candidate, 'evidence candidate');
  same(
    evidence.expiresAt,
    evidence.createdAt + evidence.policy.evidenceTtlMs,
    'declared evidence lifetime',
  );
  same(approval.expiresAt, evidence.expiresAt, 'one shared expiry');
  for (const value of [
    approval.issuedAt,
    approval.expiresAt,
    item.logicalFresh,
    item.logicalExpired,
  ])
    assert.ok(Number.isSafeInteger(value), 'invalid logical instant');
  same(item.logicalFresh, approval.issuedAt + 1, 'fresh clock construction');
  same(item.logicalExpired, approval.expiresAt + 1, 'expired clock construction');
  assert.ok(
    evidence.createdAt <= approval.issuedAt && item.logicalFresh < approval.expiresAt,
    'initial clock is not within approval lifetime',
  );
  assert.match(initial.oid, /^[a-f0-9]{40}$/);
  assert.match(prepared.next.oid, /^[a-f0-9]{40}$/);
  assert.notEqual(initial.oid, prepared.next.oid);
  same(initial.parents, [], 'initial state parent');
  same(
    initial.state,
    { version: 1, selectedCandidate: candidate.base, receipts: [] },
    'initial selection and receipt',
  );
  same(prepared.code, 'PREPARED', 'worker plan');
  same(prepared.expected, initial, 'prepared expected state');
  same(prepared.next.parents, [initial.oid], 'prepared state lineage');
  same(
    prepared.next.state,
    { version: 1, selectedCandidate: candidate.commit, receipts: [expectedReceipt] },
    'prepared next state',
  );
  same(prepared.receipt, expectedReceipt, 'prepared receipt');

  // Git 2.54+ emits `preparing` before locking refs. Preserve that raw event,
  // but validate its identity, time and position before comparing the shared
  // prepared/committed sequence. It cannot replace the prepared barrier.
  const events = [...item.events];
  if (
    after &&
    events[4]?.event === 'git-hook' &&
    (events[4].detail as { phase?: string })?.phase === 'preparing'
  ) {
    same(
      events[4].detail,
      {
        phase: 'preparing',
        stdin: `${initial.oid} ${prepared.next.oid} ${STATE_REF}\n`,
        logicalNow: item.logicalFresh,
      },
      'optional preparing observation must bind this fresh transaction',
    );
    events.splice(4, 1);
  }
  // Exact local event order is declared independently of the producer's summary.
  const eventNames = events.map((entry) =>
    entry.event === 'worker-phase'
      ? `worker:${(entry.detail as { phase: string }).phase}`
      : entry.event,
  );
  same(
    eventNames,
    after
      ? [
          'worker:ready',
          'worker-clock-read',
          'worker:state-prepared',
          'worker-clock-read',
          'git-hook',
          'parent-observed-prepared-ref',
          'parent-advanced-clock',
          'git-hook-released',
          'git-hook',
          'worker:state-selected',
          'parent-observed-worker-exit',
        ]
      : [
          'worker:ready',
          'worker-clock-read',
          'worker:state-prepared',
          'parent-advanced-clock',
          'worker-clock-read',
          'parent-observed-worker-exit',
        ],
    'missing, duplicate or reordered causal observation',
  );
  same(events[0]!.detail, { phase: 'ready', detail: { mode: 'envelope' } }, 'worker mode');
  same(
    events[1]!.detail,
    { caller: 'prepareStateChange', now: item.logicalFresh },
    'prepare clock read',
  );
  same(events[2]!.detail, { phase: 'state-prepared', detail: prepared }, 'worker IPC plan');
  const reads = events.filter((entry) => entry.event === 'worker-clock-read');
  same(
    reads[1]!.detail,
    { caller: 'selectPreparedState', now: after ? item.logicalFresh : item.logicalExpired },
    'final freshness-check instant',
  );
  const advanced = events.find((entry) => entry.event === 'parent-advanced-clock');
  same(advanced?.detail, { now: item.logicalExpired }, 'clock advance missing or within lifetime');
  same(
    events.at(-1)!.detail,
    { exitCode: after ? 0 : 1, directChildExitConfirmed: true },
    'exit event',
  );
  completed(worker, after ? 0 : 1);
  same(worker.stdout, '', 'unexpected worker stdout');
  same(
    worker.stderr,
    after ? '' : 'State transition refused: EVIDENCE_STALE\n',
    'worker refusal must be the expected freshness rejection',
  );

  item.transcript.forEach((entry, index) => same(entry.sequence, index + 1, 'transcript sequence'));
  for (const entry of item.transcript.filter(
    (entry) => entry.event === 'git' || entry.event === 'git-init-synthetic-fixture',
  ))
    completed(entry.detail as ProcessResult, 0);
  const initialRead = readBlock(item, 'initial', initial);
  const finalRead = readBlock(item, 'final', final);
  assert.ok(finalRead > initialRead, 'final read must follow initial read');
  const updates = item.transcript.flatMap((entry, index) => {
    if (entry.event !== 'git') return [];
    const p = entry.detail as ProcessResult;
    const args = command(p);
    return args[0] === 'update-ref' && args[1] === STATE_REF ? [{ index, p, args }] : [];
  });
  same(updates.length, after ? 2 : 1, 'unexpected state ref update inventory');
  same(
    updates[0]!.args,
    ['update-ref', STATE_REF, initial.oid, '0'.repeat(40)],
    'initial ref creation',
  );
  assert.ok(updates[0]!.index < initialRead);
  if (!after) {
    same(item.whilePrepared, null, 'before-check control must not claim a Git hook pause');
    same(final, initial, 'expired recheck changed the ref');
    same(item.acknowledgement, null, 'expired recheck acknowledged selection');
    return {
      id: item.id,
      conclusion: 'REFUSED_BEFORE_CAS',
      selectionChanged: false,
      receiptPresent: false,
    };
  }
  same(item.whilePrepared, initial, 'ref must still be old at the prepared hook');
  const heldRead = readBlock(item, 'while-prepared', item.whilePrepared!);
  assert.ok(
    initialRead < heldRead && heldRead < updates[1]!.index && updates[1]!.index < finalRead,
    'held read, completed CAS and final read are not ordered',
  );
  const stdin = `${initial.oid} ${prepared.next.oid} ${STATE_REF}\n`;
  same(
    events[4]!.detail,
    { phase: 'prepared', stdin, logicalNow: item.logicalFresh },
    'actual Git prepared transaction',
  );
  same(events[5]!.detail, { oid: initial.oid }, 'held ref event');
  same(events[7]!.detail, { logicalNow: item.logicalExpired }, 'hook release was not after expiry');
  same(
    events[8]!.detail,
    { phase: 'committed', stdin, logicalNow: item.logicalExpired },
    'actual Git committed observation after expiry',
  );
  same(
    updates[1]!.args,
    ['update-ref', STATE_REF, prepared.next.oid, initial.oid],
    'CAS binds exact expected/next ref',
  );
  const selection = events[9]!.detail as {
    phase: string;
    detail: { stateOid: string; result: { code: string; process: ProcessResult } };
  };
  same(selection.phase, 'state-selected', 'selection IPC');
  same(selection.detail.stateOid, prepared.next.oid, 'selection IPC OID');
  same(selection.detail.result.code, 'STATE_CAS_ACKNOWLEDGED', 'selection IPC code');
  same(
    selection.detail.result.process,
    updates[1]!.p,
    'IPC result must equal the actual Git process capture',
  );
  same(final, prepared.next, 'final captured ref does not select the prepared state');
  same(
    item.acknowledgement,
    { code: 'STATE_CAS_ACKNOWLEDGED', stateOid: final.oid },
    'acknowledgement file',
  );
  return {
    id: item.id,
    conclusion: 'SELECTED_AFTER_LOGICAL_EXPIRY',
    selectionChanged: true,
    receiptPresent: true,
  };
}

/** Checks fixed trace consistency. It cannot authenticate a report written by a local actor. */
export function checkExpiryCases(value: unknown) {
  const outcomes: ReturnType<typeof checkCase>[] = [];
  const errors: string[] = [];
  try {
    const serialized = JSON.stringify(value);
    assert.ok(
      serialized && Buffer.byteLength(serialized) <= 2_000_000,
      'case input exceeds budget',
    );
    assert.ok(Array.isArray(value), 'case array required');
    same(
      value.map((item: ExpiryCase) => item.id),
      [...CASE_IDS],
      'exact two-case inventory',
    );
    for (let index = 0; index < value.length; index++) {
      try {
        outcomes.push(checkCase(value[index] as ExpiryCase, index === 1));
      } catch (error) {
        errors.push(
          `${CASE_IDS[index]}: ${error instanceof Error ? error.message.split('\n')[0] : 'invalid evidence'}`,
        );
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message.split('\n')[0]! : 'invalid evidence');
  }
  return { passed: errors.length === 0 && outcomes.length === 2, outcomes, errors };
}

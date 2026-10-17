import assert from 'node:assert/strict';
import { digest } from './support.ts';
import type { StateCase } from './state-envelope-experiment.ts';

// This reader does not use the producer's expected/actual/passed assertions or
// transition functions. It checks internal consistency of the saved observations.
// A local writer can forge a consistent record; this is not an attestation.
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'missing object');
  return value as RecordValue;
};
const list = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value) && value.length <= 2000, 'missing or excessive list');
  return value;
};
const hash = (value: unknown, length: number): string => {
  assert.ok(
    typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value),
    'invalid identity',
  );
  return value;
};
const same = (a: unknown, b: unknown, label: string) => assert.equal(digest(a), digest(b), label);
const okProcess = (value: unknown) => {
  const p = record(value);
  return (
    p.exitCode === 0 &&
    p.signal === null &&
    p.directChildExitConfirmed === true &&
    p.timedOut === false &&
    p.outputLimited === false &&
    p.processError === undefined
  );
};
type Snapshot = { oid: string; parents: string[]; state: RecordValue };

export function checkStateCases(cases: StateCase[]): { passed: boolean; errors: string[] } {
  const errors: string[] = [];
  const expectedIds = [
    'separate-write-gap',
    'state-prepared-before-cas',
    'state-cas-before-ack',
    'value-rollback-versus-state-rewind',
    'reader-capture-contract',
  ];
  if (cases.map((item) => item.id).join('|') !== expectedIds.join('|'))
    return { passed: false, errors: ['case inventory differs from the fixed experiment'] };
  for (const item of cases) {
    try {
      const f = record(item.facts);
      const candidate = record(f.candidate);
      const base = hash(candidate.base, 40);
      const target = hash(candidate.commit, 40);
      const approval = record(f.approval);
      const evidence = record(f.evidence);
      const expectedReceipt = {
        operationId: digest(approval),
        base,
        candidate: target,
        evidenceDigest: digest(evidence),
        policyDigest: hash(evidence.policyDigest, 64),
      };
      same(f.operation, expectedReceipt, 'operation is not bound to recorded approval/evidence');
      assert.equal(approval.candidateCommit, target, 'approval candidate differs');
      assert.equal(approval.base, base, 'approval base differs');
      assert.equal(
        approval.evidenceDigest,
        expectedReceipt.evidenceDigest,
        'approval evidence differs',
      );
      const transcript = list(item.transcripts)
        .flatMap((transcript) => list(transcript))
        .map(record);
      const commands = transcript
        .filter((entry) => entry.event === 'git')
        .map((entry) => record(entry.detail));
      assert.ok(commands.length > 0, 'Git transcript absent');
      const matches = (command: RecordValue, suffix: string[]) => {
        const args = list(command.arguments);
        return args.slice(-suffix.length).join('\0') === suffix.join('\0');
      };
      const successful = (suffix: string[], stdout?: string) =>
        commands.filter(
          (command) =>
            matches(command, suffix) &&
            okProcess(command) &&
            (stdout === undefined || String(command.stdout).trim() === stdout),
        );
      const hasCommand = (suffix: string[], stdout?: string) =>
        assert.ok(
          successful(suffix, stdout).length > 0,
          `missing successful Git ${suffix[0]} observation`,
        );
      let expectedSummary: Record<string, unknown>;
      const retention = record(f.codeRetention);
      assert.equal(
        retention.candidateRef,
        `refs/lab/candidates/${candidate.id}`,
        'candidate retention ref differs',
      );
      assert.equal(retention.retainedCommit, target, 'candidate retention value differs');
      assert.equal(retention.retainedParent, base, 'base retention parent differs');
      hasCommand(['rev-parse', String(retention.candidateRef)], target);
      hasCommand(['rev-parse', `${target}^`], base);

      function snapshot(value: unknown): Snapshot {
        const captured = record(value);
        const oid = hash(captured.oid, 40);
        const parents = list(captured.parents).map((parent) => hash(parent, 40));
        const state = record(captured.state);
        assert.equal(state.version, 1, 'state version differs');
        hash(state.selectedCandidate, 40);
        const receipts = list(state.receipts);
        assert.ok(receipts.length <= 16, 'receipt budget exceeded');
        const ids = receipts.map((receipt) => hash(record(receipt).operationId, 64));
        assert.equal(new Set(ids).size, ids.length, 'duplicate operation receipts');
        const show = successful(['show', `${oid}:state.json`]).some((command) => {
          try {
            return digest(JSON.parse(String(command.stdout))) === digest(state);
          } catch {
            return false;
          }
        });
        assert.ok(show, 'state body does not match a successful Git show at its captured OID');
        hasCommand(['ls-tree', '-r', '--name-only', oid], 'state.json');
        hasCommand(['show', '-s', '--format=%P', oid], parents.join(' '));
        hasCommand(['cat-file', '-e', `${String(state.selectedCandidate)}^{commit}`]);
        return { oid, parents, state };
      }
      const receiptsEqual = (state: Snapshot, receipts: unknown[]) =>
        same(state.state.receipts, receipts, 'unexpected retained receipt set');
      const observedRef = (state: Snapshot) =>
        hasCommand(['rev-parse', 'refs/heads/lab-state'], state.oid);
      const cas = (next: Snapshot, previous: Snapshot) => {
        hasCommand(['update-ref', 'refs/heads/lab-state', next.oid, previous.oid]);
      };
      function anchor(event: string, label?: string): number {
        const indices = transcript.flatMap((entry, index) =>
          entry.event === event && (label === undefined || record(entry.detail).label === label)
            ? [index]
            : [],
        );
        assert.equal(indices.length, 1, 'missing or duplicated observation anchor');
        return indices[0]!;
      }
      function anchoredRead(label: string, kind: 'ref' | 'captured', state: Snapshot) {
        const end = anchor('state-read-observation', label);
        same(
          transcript[end]!.detail,
          { label, kind, oid: state.oid },
          'read anchor differs from its snapshot',
        );
        const suffixes = [
          ...(kind === 'ref' ? [['rev-parse', 'refs/heads/lab-state']] : []),
          ['ls-tree', '-r', '--name-only', state.oid],
          ['show', `${state.oid}:state.json`],
          ['show', '-s', '--format=%P', state.oid],
          ['cat-file', '-e', `${String(state.state.selectedCandidate)}^{commit}`],
        ];
        const start = end - suffixes.length;
        assert.ok(start >= 0, 'read anchor has no complete Git observation block');
        const block = transcript.slice(start, end).map((entry, index) => {
          assert.equal(entry.event, 'git', 'read observation block is interrupted');
          const command = record(entry.detail);
          assert.ok(
            matches(command, suffixes[index]!) && okProcess(command),
            'anchored Git read does not match the observed operation',
          );
          return command;
        });
        const offset = kind === 'ref' ? 1 : 0;
        if (kind === 'ref')
          assert.equal(
            String(block[0]!.stdout).trim(),
            state.oid,
            'anchored ref read returned another OID',
          );
        assert.equal(
          String(block[offset]!.stdout).trim(),
          'state.json',
          'anchored inventory differs',
        );
        same(
          JSON.parse(String(block[offset + 1]!.stdout)),
          state.state,
          'anchored state body differs',
        );
        assert.equal(
          String(block[offset + 2]!.stdout).trim(),
          state.parents.join(' '),
          'anchored parent list differs',
        );
        return { start, end };
      }
      function phases(value: unknown, names: string[], stoppedAt: string | null): RecordValue[] {
        const worker = record(value);
        const entries = list(worker.phases).map(record);
        same(
          entries.map((phase) => phase.phase),
          names,
          'worker barrier inventory/order differs',
        );
        same(
          entries.map((phase) => phase.sequence),
          names.map((_, index) => index + 1),
          'worker phase sequence differs',
        );
        assert.equal(worker.stopAt, stoppedAt, 'worker stop boundary differs');
        const p = record(worker.process);
        if (stoppedAt) {
          assert.equal(worker.stopReached, true, 'declared stop not reached');
          assert.equal(worker.acknowledgement, null, 'stopped worker has caller acknowledgement');
          assert.equal(p.directChildExitConfirmed, true, 'direct worker exit not observed');
          assert.equal(
            p.ownedTreeTerminationAcknowledged,
            true,
            'termination request not acknowledged',
          );
          assert.notEqual(p.exitCode, 0, 'stopped worker exited successfully');
          assert.equal(p.timedOut, false, 'deadline chose the interruption');
          assert.equal(p.outputLimited, false, 'output limit chose the interruption');
          assert.equal(p.processError, undefined, 'worker I/O error');
        } else {
          assert.equal(worker.stopReached, false, 'normal worker was stopped');
          assert.ok(okProcess(p), 'normal worker did not complete');
        }
        return entries;
      }
      function preparedFrom(entries: RecordValue[], initial: Snapshot): Snapshot {
        const phase = entries.find((entry) => entry.phase === 'state-prepared');
        assert.ok(phase, 'prepared barrier absent');
        const plan = record(phase.detail);
        assert.equal(plan.code, 'PREPARED', 'prepared barrier has no plan');
        const expected = snapshot(plan.expected);
        same(expected, initial, 'prepared plan captured another prior state');
        const next = snapshot(plan.next);
        same(next.parents, [initial.oid], 'prepared commit lost prior state lineage');
        assert.equal(next.state.selectedCandidate, target, 'prepared selection differs');
        same(plan.receipt, expectedReceipt, 'prepared receipt binding differs');
        receiptsEqual(next, [...list(initial.state.receipts), expectedReceipt]);
        return next;
      }
      function selectedFrom(entries: RecordValue[], next: Snapshot, prior: Snapshot) {
        const detail = record(entries.find((entry) => entry.phase === 'state-selected')?.detail);
        assert.equal(detail.stateOid, next.oid, 'selected barrier OID differs');
        const result = record(detail.result);
        assert.equal(
          result.code,
          'STATE_CAS_ACKNOWLEDGED',
          'selected barrier lacks Git acknowledgement',
        );
        assert.ok(okProcess(result.process), 'selected barrier Git process did not succeed');
        assert.ok(
          matches(record(result.process), [
            'update-ref',
            'refs/heads/lab-state',
            next.oid,
            prior.oid,
          ]),
          'selected barrier CAS operands differ',
        );
        cas(next, prior);
      }

      if (item.id === 'separate-write-gap') {
        const stopped = phases(f.gap, ['ready', 'selection-written'], 'selection-written');
        assert.equal(
          record(stopped[1]!.detail).code,
          'CAS_APPLIED',
          'gap does not follow a completed selection',
        );
        assert.equal(f.gapSelection, target, 'gap selection differs');
        assert.equal(f.gapReceipt, null, 'separate receipt already exists at gap');
        hasCommand(['rev-parse', 'refs/heads/release'], target);
        const writes = successful(['update-ref', 'refs/heads/release', target, base]);
        assert.equal(
          writes.length,
          2,
          'normal continuation and gap must each complete one real selection',
        );
        hasCommand(['update-ref', 'refs/heads/release', base, target]);
        phases(f.continuation, ['ready', 'selection-written'], null);
        same(
          record(f.continuation).acknowledgement,
          { code: 'SELECTION_AND_RECEIPT_WRITTEN' },
          'normal continuation lacks acknowledgement',
        );
        same(f.finalSeparateReceipt, expectedReceipt, 'normal continuation receipt differs');
        expectedSummary = {
          stoppedInGap: true,
          selectionChangedBeforeReceipt: target,
          receiptAbsentAtGap: null,
          normalContinuationCompleted: true,
          normalContinuationAcknowledged: { code: 'SELECTION_AND_RECEIPT_WRITTEN' },
          normalContinuationWroteReceipt: expectedReceipt,
        };
      } else if (item.id === 'state-prepared-before-cas' || item.id === 'state-cas-before-ack') {
        const initial = snapshot(f.initial);
        assert.equal(initial.state.selectedCandidate, base, 'initial selection differs');
        same(initial.parents, [], 'initial state unexpectedly has a parent');
        receiptsEqual(initial, []);
        const afterCas = item.id === 'state-cas-before-ack';
        const entries = phases(
          f.worker,
          afterCas ? ['ready', 'state-prepared', 'state-selected'] : ['ready', 'state-prepared'],
          afterCas ? 'state-selected' : 'state-prepared',
        );
        const next = preparedFrom(entries, initial);
        const observed = snapshot(f.observed);
        observedRef(observed);
        same(observed, afterCas ? next : initial, 'post-exit ref/state differs');
        const retry = record(f.retry);
        assert.equal(
          retry.code,
          afterCas ? 'ALREADY_RECORDED' : 'PREPARED',
          'retry disposition differs',
        );
        const postRetryObserved = snapshot(f.postRetryObserved);
        same(
          postRetryObserved,
          observed,
          'post-retry final ref differs from the post-exit observation',
        );
        const postRetryRead = anchoredRead('post-retry', 'ref', postRetryObserved);
        const retryEnd = anchor('state-retry-completed');
        same(transcript[retryEnd]!.detail, { code: retry.code }, 'retry completion anchor differs');
        assert.ok(retryEnd < postRetryRead.start, 'final read preceded retry completion');
        const laterRefReads = transcript
          .slice(postRetryRead.end + 1)
          .filter(
            (entry) =>
              entry.event === 'git' &&
              matches(record(entry.detail), ['rev-parse', 'refs/heads/lab-state']),
          );
        assert.equal(laterRefReads.length, 0, 'post-retry anchor is not the final state-ref read');
        if (afterCas) {
          selectedFrom(entries, next, initial);
          same(snapshot(retry.observed), observed, 'retry observes a different retained state');
          same(retry.receipt, expectedReceipt, 'retry receipt differs');
        } else {
          assert.equal(
            successful(['update-ref', 'refs/heads/lab-state', next.oid, initial.oid]).length,
            0,
            'selection happened before the declared CAS barrier',
          );
          same(snapshot(retry.expected), initial, 'retry did not prepare from the old state');
          const retryNext = snapshot(retry.next);
          same(retryNext.parents, [initial.oid], 'retry preparation lost state lineage');
          assert.equal(retryNext.state.selectedCandidate, target, 'retry candidate differs');
          receiptsEqual(retryNext, [expectedReceipt]);
        }
        expectedSummary = {
          workerStoppedAtDeclaredBarrier: true,
          selectionAtCapturedOid: afterCas ? target : base,
          receiptAtSameCapturedOid: afterCas,
          retryDisposition: afterCas ? 'ALREADY_RECORDED' : 'PREPARED',
          retryPreparationDidNotMoveRef: observed.oid,
        };
      } else if (item.id === 'value-rollback-versus-state-rewind') {
        const initial = snapshot(f.initial);
        const entries = phases(f.first, ['ready', 'state-prepared', 'state-selected'], null);
        const selected = snapshot(f.selected);
        same(
          preparedFrom(entries, initial),
          selected,
          'first selected state differs from prepared state',
        );
        selectedFrom(entries, selected, initial);
        const preserved = snapshot(f.preserved);
        assert.equal(preserved.state.selectedCandidate, base, 'value rollback did not select base');
        same(preserved.parents, [selected.oid], 'value rollback lost lineage');
        receiptsEqual(preserved, [expectedReceipt]);
        observedRef(preserved);
        cas(preserved, selected);
        const refusal = record(f.retryPreserved);
        assert.equal(refusal.code, 'ALREADY_RECORDED', 'retained operation was not refused');
        same(snapshot(refusal.observed), preserved, 'refusal observation differs');
        same(snapshot(f.refAfterRefusal), preserved, 'refusal changed state');
        const rewound = snapshot(f.rewound);
        same(rewound, initial, 'whole-state rewind did not restore initial state');
        receiptsEqual(rewound, []);
        cas(rewound, preserved);
        const replayEntries = phases(f.replay, ['ready', 'state-prepared', 'state-selected'], null);
        const afterReplay = snapshot(f.afterReplay);
        same(preparedFrom(replayEntries, rewound), afterReplay, 'replay state differs');
        selectedFrom(replayEntries, afterReplay, rewound);
        receiptsEqual(afterReplay, [expectedReceipt]);
        assert.equal(
          afterReplay.state.selectedCandidate,
          target,
          'replay did not select candidate',
        );
        // Commit identities can coincide when content, parent and commit timestamp coincide.
        assert.equal(
          commands.filter(
            (command) =>
              okProcess(command) &&
              (matches(command, [
                'update-ref',
                'refs/heads/lab-state',
                selected.oid,
                initial.oid,
              ]) ||
                matches(command, [
                  'update-ref',
                  'refs/heads/lab-state',
                  afterReplay.oid,
                  initial.oid,
                ])),
          ).length,
          2,
          'record does not contain both initial and replay selection commands',
        );
        expectedSummary = {
          firstAttemptCompleted: true,
          valueRollbackSelectedBase: base,
          valueRollbackRetainedReceipt: true,
          sameApprovalRefused: 'ALREADY_RECORDED',
          refusalDidNotMoveRef: preserved.oid,
          wholeRefRewindLostReceipt: false,
          sameApprovalCanExecuteAfterRewind: true,
          replayedSelection: target,
          replayedReceipt: true,
        };
      } else {
        const first = snapshot(f.capturedInitial);
        const current = snapshot(f.rereadCurrent);
        const again = snapshot(f.capturedAgain);
        assert.equal(first.state.selectedCandidate, base, 'old reader did not capture base');
        receiptsEqual(first, []);
        assert.equal(
          current.state.selectedCandidate,
          target,
          'fresh reader did not capture candidate',
        );
        receiptsEqual(current, [expectedReceipt]);
        assert.notEqual(first.oid, current.oid, 'reader versions did not differ');
        same(first, again, 'captured OID changed its resolved contents');
        same(
          f.mixedRead,
          { selectedCandidate: base, receipts: [expectedReceipt] },
          'mixed reader fields differ',
        );
        observedRef(first);
        observedRef(current);
        const firstRead = anchoredRead('reader-initial', 'ref', first);
        const currentRead = anchoredRead('reader-current', 'ref', current);
        const againRead = anchoredRead('reader-captured-again', 'captured', again);
        const interveningUpdates = transcript
          .slice(firstRead.end + 1, currentRead.start)
          .filter(
            (entry) =>
              entry.event === 'git' &&
              matches(record(entry.detail), [
                'update-ref',
                'refs/heads/lab-state',
                current.oid,
                first.oid,
              ]) &&
              okProcess(entry.detail),
          );
        assert.equal(
          interveningUpdates.length,
          1,
          'reader observations do not bracket one recorded state update',
        );
        assert.ok(
          firstRead.end < currentRead.start && currentRead.end < againRead.start,
          'captured OID was not re-read after the current-state observation',
        );
        expectedSummary = {
          initialCaptureSelectedBase: base,
          initialCaptureReceiptAbsent: false,
          laterCurrentReceiptPresent: true,
          capturedOidStillResolvesSamePair: first,
          currentAndCapturedAreDifferentVersions: false,
        };
      }
      same(
        item.observations.map((observation) => observation.key),
        Object.keys(expectedSummary),
        'summary observation inventory differs',
      );
      for (const observation of item.observations) {
        assert.equal(observation.passed, true, 'summary reports a failed observation');
        same(
          observation.expected,
          expectedSummary[observation.key],
          'summary expectation differs from the fixed case contract',
        );
        same(
          observation.actual,
          expectedSummary[observation.key],
          'summary contradicts recorded facts',
        );
      }
    } catch (error) {
      errors.push(
        `${item.id}: ${error instanceof Error ? error.message.split('\n')[0] : 'invalid record'}`,
      );
    }
  }
  return { passed: errors.length === 0, errors };
}

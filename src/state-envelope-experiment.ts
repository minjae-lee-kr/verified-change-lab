import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixture, currentRef, git, prepareCandidate, RELEASE_REF } from './git.ts';
import { provenance } from './experiment.ts';
import { approveCandidate } from './protocol.ts';
import { boundedProcess, processSucceeded } from './process.ts';
import { verifyCandidate } from './runner.ts';
import { checkStateCases } from './state-envelope-check.ts';
import {
  captureState,
  commitState,
  initializeState,
  operationReceipt,
  prepareStateChange,
  readStateAt,
  STATE_REF,
  type AuthorizedChange,
  type CapturedState,
} from './state-envelope.ts';
import type { StateWorkerRequest } from './state-envelope-worker.ts';
import {
  digest,
  ensureLab,
  LAB,
  PROJECT,
  readJson,
  readTranscript,
  redacted,
  runId,
  trace,
  writeJson,
} from './support.ts';
import type { Fixture, ProcessResult, Transcript } from './types.ts';

export type WorkerPhase = 'selection-written' | 'state-prepared' | 'state-selected';
export type WorkerRun = {
  stopAt: WorkerPhase | null;
  phases: { sequence: number; phase: string; detail: unknown }[];
  stopReached: boolean;
  acknowledgement: unknown | null;
  process: ProcessResult;
};
export type Observation = { key: string; expected: unknown; actual: unknown; passed: boolean };
export type StateCase = {
  id: string;
  observations: Observation[];
  facts: Record<string, unknown>;
  transcripts: Transcript[];
};
const observe = (key: string, expected: unknown, actual: unknown): Observation => ({
  key,
  expected,
  actual,
  passed: digest(expected) === digest(actual),
});

export async function runStateWorker(
  request: StateWorkerRequest,
  stopAt: WorkerPhase | null = null,
): Promise<WorkerRun> {
  const directory = join(request.input.fixture.root, 'state-executions', runId());
  const requestPath = join(directory, 'request.json');
  await writeJson(requestPath, request);
  const phases: WorkerRun['phases'] = [];
  let stopReached = false;
  const result = await boundedProcess(
    process.execPath,
    [join(PROJECT, 'src/state-envelope-worker.ts'), requestPath],
    {
      cwd: request.input.fixture.root,
      timeoutMs: 12_000,
      maxOutputBytes: 32_000,
      ipc: {
        onMessage(message, child, terminate) {
          if (
            typeof message !== 'object' ||
            message === null ||
            !('phase' in message) ||
            typeof message.phase !== 'string'
          )
            return;
          phases.push({
            sequence: phases.length + 1,
            phase: message.phase,
            detail: 'detail' in message ? message.detail : null,
          });
          if (message.phase === stopAt) {
            stopReached = true;
            terminate();
          } else child.send({ continue: message.phase });
        },
      },
    },
  );
  let acknowledgement: unknown | null = null;
  try {
    acknowledgement = await readJson(join(directory, 'acknowledgement.json'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return { stopAt, phases, stopReached, acknowledgement, process: result };
}

async function fresh(label: string): Promise<AuthorizedChange> {
  const fixture = await createFixture(label);
  const candidate = await prepareCandidate(fixture);
  const evidence = await verifyCandidate(fixture, candidate);
  const approved = await approveCandidate(
    fixture,
    candidate,
    evidence,
    'Scripted local control',
    `APPLY ${candidate.commit} ${digest(evidence)}`,
  );
  if (!approved.approval)
    throw new Error(`Cannot prepare state experiment: ${approved.verdict.code}`);
  return { fixture, candidate, evidence, approval: approved.approval };
}
const killed = (run: WorkerRun) =>
  run.stopReached &&
  run.acknowledgement === null &&
  run.process.directChildExitConfirmed &&
  run.process.ownedTreeTerminationAcknowledged === true &&
  run.process.exitCode !== 0 &&
  !run.process.timedOut &&
  !run.process.outputLimited &&
  !run.process.processError;
const hasReceipt = (state: CapturedState, input: AuthorizedChange) =>
  state.state.receipts.some((item) => digest(item) === digest(operationReceipt(input)));
async function inputFacts(input: AuthorizedChange) {
  const candidateRef = `refs/lab/candidates/${input.candidate.id}`;
  const retainedCommit = (await git(input.fixture, ['rev-parse', candidateRef])).stdout.trim();
  const retainedParent = (
    await git(input.fixture, ['rev-parse', `${retainedCommit}^`])
  ).stdout.trim();
  if (retainedCommit !== input.candidate.commit || retainedParent !== input.candidate.base)
    throw new Error('The fixed candidate retention assumption no longer holds.');
  return {
    candidate: input.candidate,
    operation: operationReceipt(input),
    evidence: input.evidence,
    approval: input.approval,
    codeRetention: { candidateRef, retainedCommit, retainedParent },
  };
}

async function recordedRead(fixture: Fixture, label: string, capturedOid?: string) {
  const snapshot =
    capturedOid === undefined
      ? await captureState(fixture)
      : await readStateAt(fixture, capturedOid);
  await trace(fixture.root, 'state-read-observation', {
    label,
    kind: capturedOid === undefined ? 'ref' : 'captured',
    oid: snapshot.oid,
  });
  return snapshot;
}

/** Returns partial cases on failure through the supplied array, for a truthful CLI report. */
export async function runStateExperiments(cases: StateCase[] = []): Promise<StateCase[]> {
  const separate = await fresh('state-separate');
  const gap = await runStateWorker({ input: separate, mode: 'separate' }, 'selection-written');
  const gapSelection = await currentRef(separate.fixture);
  let gapReceipt: unknown = null;
  try {
    gapReceipt = await readJson(join(separate.fixture.root, 'separate-receipt.json'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  // A new invocation after an explicit value rewind demonstrates the missing receipt's cost.
  await git(separate.fixture, [
    'update-ref',
    RELEASE_REF,
    separate.candidate.base,
    separate.candidate.commit,
  ]);
  const continuation = await runStateWorker({ input: separate, mode: 'separate' });
  const finalSeparateReceipt = await readJson(join(separate.fixture.root, 'separate-receipt.json'));
  cases.push({
    id: 'separate-write-gap',
    observations: [
      observe('stoppedInGap', true, killed(gap)),
      observe('selectionChangedBeforeReceipt', separate.candidate.commit, gapSelection),
      observe('receiptAbsentAtGap', null, gapReceipt),
      observe('normalContinuationCompleted', true, processSucceeded(continuation.process)),
      observe(
        'normalContinuationAcknowledged',
        { code: 'SELECTION_AND_RECEIPT_WRITTEN' },
        continuation.acknowledgement,
      ),
      observe('normalContinuationWroteReceipt', operationReceipt(separate), finalSeparateReceipt),
    ],
    facts: {
      ...(await inputFacts(separate)),
      gap,
      gapSelection,
      gapReceipt,
      continuation,
      finalSeparateReceipt,
    },
    transcripts: [await readTranscript(separate.fixture.root)],
  });

  for (const stopAt of ['state-prepared', 'state-selected'] as const) {
    const input = await fresh(stopAt === 'state-prepared' ? 'state-before' : 'state-after');
    const initial = await initializeState(input.fixture);
    const worker = await runStateWorker({ input, mode: 'envelope' }, stopAt);
    const observed = await captureState(input.fixture);
    const retry = await prepareStateChange(input);
    await trace(input.fixture.root, 'state-retry-completed', { code: retry.code });
    const postRetryObserved = await recordedRead(input.fixture, 'post-retry');
    const selected = stopAt === 'state-selected';
    cases.push({
      id: selected ? 'state-cas-before-ack' : 'state-prepared-before-cas',
      observations: [
        observe('workerStoppedAtDeclaredBarrier', true, killed(worker)),
        observe(
          'selectionAtCapturedOid',
          selected ? input.candidate.commit : input.candidate.base,
          observed.state.selectedCandidate,
        ),
        observe('receiptAtSameCapturedOid', selected, hasReceipt(observed, input)),
        observe('retryDisposition', selected ? 'ALREADY_RECORDED' : 'PREPARED', retry.code),
        observe('retryPreparationDidNotMoveRef', observed.oid, postRetryObserved.oid),
      ],
      facts: { ...(await inputFacts(input)), initial, worker, observed, retry, postRetryObserved },
      transcripts: [await readTranscript(input.fixture.root)],
    });
  }

  const input = await fresh('state-rewind');
  const initial = await initializeState(input.fixture);
  const capturedInitial = await recordedRead(input.fixture, 'reader-initial');
  const first = await runStateWorker({ input, mode: 'envelope' });
  const selected = await captureState(input.fixture);
  const rereadCurrent = await recordedRead(input.fixture, 'reader-current');
  const capturedAgain = await recordedRead(
    input.fixture,
    'reader-captured-again',
    capturedInitial.oid,
  );
  // This is a cooperative synthetic writer changing the value, not the original approval.
  const rollback = await commitState(
    input.fixture,
    { ...selected.state, selectedCandidate: input.candidate.base },
    selected.oid,
  );
  await git(input.fixture, ['update-ref', STATE_REF, rollback.oid, selected.oid]);
  const preserved = await captureState(input.fixture);
  const retryPreserved = await prepareStateChange(input);
  const refAfterRefusal = await captureState(input.fixture);
  // Deliberately violate retained-history policy by rewinding the entire authority ref.
  await git(input.fixture, ['update-ref', STATE_REF, initial.oid, preserved.oid]);
  const rewound = await captureState(input.fixture);
  const replay = await runStateWorker({ input, mode: 'envelope' });
  const afterReplay = await captureState(input.fixture);
  cases.push({
    id: 'value-rollback-versus-state-rewind',
    observations: [
      observe('firstAttemptCompleted', true, processSucceeded(first.process)),
      observe('valueRollbackSelectedBase', input.candidate.base, preserved.state.selectedCandidate),
      observe('valueRollbackRetainedReceipt', true, hasReceipt(preserved, input)),
      observe('sameApprovalRefused', 'ALREADY_RECORDED', retryPreserved.code),
      observe('refusalDidNotMoveRef', preserved.oid, refAfterRefusal.oid),
      observe('wholeRefRewindLostReceipt', false, hasReceipt(rewound, input)),
      observe('sameApprovalCanExecuteAfterRewind', true, processSucceeded(replay.process)),
      observe('replayedSelection', input.candidate.commit, afterReplay.state.selectedCandidate),
      observe('replayedReceipt', true, hasReceipt(afterReplay, input)),
    ],
    facts: {
      ...(await inputFacts(input)),
      initial,
      first,
      selected,
      preserved,
      retryPreserved,
      refAfterRefusal,
      rewound,
      replay,
      afterReplay,
    },
    transcripts: [await readTranscript(input.fixture.root)],
  });

  // Actual two reads across a controlled ref move, with no timing-based race.
  cases.push({
    id: 'reader-capture-contract',
    observations: [
      observe(
        'initialCaptureSelectedBase',
        input.candidate.base,
        capturedInitial.state.selectedCandidate,
      ),
      observe('initialCaptureReceiptAbsent', false, hasReceipt(capturedInitial, input)),
      observe('laterCurrentReceiptPresent', true, hasReceipt(rereadCurrent, input)),
      observe('capturedOidStillResolvesSamePair', capturedInitial, capturedAgain),
      observe(
        'currentAndCapturedAreDifferentVersions',
        false,
        capturedInitial.oid === rereadCurrent.oid,
      ),
    ],
    facts: {
      ...(await inputFacts(input)),
      capturedInitial,
      rereadCurrent,
      capturedAgain,
      mixedRead: {
        selectedCandidate: capturedInitial.state.selectedCandidate,
        receipts: rereadCurrent.state.receipts,
      },
    },
    transcripts: [await readTranscript(input.fixture.root)],
  });
  return cases;
}

export const STATE_CASE_IDS = [
  'separate-write-gap',
  'state-prepared-before-cas',
  'state-cas-before-ack',
  'value-rollback-versus-state-rewind',
  'reader-capture-contract',
];
const OBSERVATION_KEYS = [
  [
    'stoppedInGap',
    'selectionChangedBeforeReceipt',
    'receiptAbsentAtGap',
    'normalContinuationCompleted',
    'normalContinuationAcknowledged',
    'normalContinuationWroteReceipt',
  ],
  [
    'workerStoppedAtDeclaredBarrier',
    'selectionAtCapturedOid',
    'receiptAtSameCapturedOid',
    'retryDisposition',
    'retryPreparationDidNotMoveRef',
  ],
  [
    'workerStoppedAtDeclaredBarrier',
    'selectionAtCapturedOid',
    'receiptAtSameCapturedOid',
    'retryDisposition',
    'retryPreparationDidNotMoveRef',
  ],
  [
    'firstAttemptCompleted',
    'valueRollbackSelectedBase',
    'valueRollbackRetainedReceipt',
    'sameApprovalRefused',
    'refusalDidNotMoveRef',
    'wholeRefRewindLostReceipt',
    'sameApprovalCanExecuteAfterRewind',
    'replayedSelection',
    'replayedReceipt',
  ],
  [
    'initialCaptureSelectedBase',
    'initialCaptureReceiptAbsent',
    'laterCurrentReceiptPresent',
    'capturedOidStillResolvesSamePair',
    'currentAndCapturedAreDifferentVersions',
  ],
];
export function stateCasesPassed(cases: StateCase[]): boolean {
  return (
    cases.map((item) => item.id).join('|') === STATE_CASE_IDS.join('|') &&
    checkStateCases(cases).passed &&
    cases.every(
      (item, index) =>
        item.observations.map((check) => check.key).join('|') ===
          OBSERVATION_KEYS[index]!.join('|') &&
        item.observations.every(
          (check) => check.passed && digest(check.expected) === digest(check.actual),
        ),
    )
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('This fixed fixture takes no arguments.');
  await ensureLab();
  const directory = join(LAB, 'state-envelope-runs', runId());
  const before = await provenance();
  const cases: StateCase[] = [];
  let executionError: string | null = null;
  try {
    await runStateExperiments(cases);
  } catch (error) {
    executionError = redacted(error instanceof Error ? error.message : String(error));
  }
  const after = await provenance();
  const sourceStable = before.sourceFingerprint === after.sourceFingerprint;
  const passed = executionError === null && sourceStable && stateCasesPassed(cases);
  const report = {
    version: 1,
    command: 'pnpm state:experiment',
    generatedAt: new Date().toISOString(),
    passed,
    executionError,
    sourceStable,
    sourceBefore: before,
    sourceAfter: after,
    cases,
    consistency: checkStateCases(cases),
    limits: [
      'Fixed synthetic local Git experiment; scripted approval is not human authentication.',
      'The state ref selects a metadata commit, not deployable code; consumers must capture one OID.',
      'Candidate refs retain code objects. A JSON OID is not itself a Git garbage-collection edge.',
      'Receipts depend on cooperative writers and retention; rewinding the state ref can permit replay.',
      'Interruption occurs between acknowledged Git commands, not during ref rename or power loss.',
      'No external action, deployment, linearizability proof or production exactly-once guarantee.',
      'The envelope rewrites retained receipts and serializes writers; no throughput claim is measured.',
    ],
  };
  await writeJson(join(directory, 'report.json'), JSON.parse(redacted(JSON.stringify(report))));
  console.log(
    JSON.stringify(
      {
        passed,
        executionError,
        sourceStable,
        gitDirty: after.gitDirty,
        cases: cases.map((item) => ({
          id: item.id,
          passed: item.observations.every((check) => check.passed),
        })),
        report: redacted(join(directory, 'report.json')),
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
}

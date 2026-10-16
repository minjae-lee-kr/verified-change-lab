import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeTogether } from './execution.ts';
import {
  commitWorkspace,
  createFixture,
  currentRef,
  FILES,
  FIXTURE_SOURCE,
  git,
  materializeCandidate,
  prepareCandidate,
  RELEASE_REF,
} from './git.ts';
import { currentPolicy } from './policy.ts';
import { boundedProcess } from './process.ts';
import { applyApproved, approveCandidate, evidenceVerdict, reconcile } from './protocol.ts';
import { verifyCandidate } from './runner.ts';
import {
  digest,
  PROJECT,
  readTranscript,
  redacted,
  runId,
  sha256,
  trace,
  writeJson,
} from './support.ts';
import type { Candidate, Evidence, Fixture, Transcript } from './types.ts';

export interface Observation {
  key: string;
  expected: unknown;
  observed: unknown;
  passed: boolean;
}
export interface CaseResult {
  id: string;
  observations: Observation[];
  facts: Record<string, unknown>;
  transcripts: Transcript[];
}
export interface ExperimentReport {
  version: 1;
  generatedAt: string;
  command: string;
  provenance: Awaited<ReturnType<typeof provenance>>;
  cases: CaseResult[];
}
const observation = (key: string, expected: unknown, observed: unknown): Observation => ({
  key,
  expected,
  observed,
  passed: JSON.stringify(expected) === JSON.stringify(observed),
});
const summary = (evidence: Evidence) => ({
  runId: evidence.runId,
  candidate: evidence.candidate,
  evidenceDigest: digest(evidence),
  policyDigest: evidence.policyDigest,
  createdAt: evidence.createdAt,
  expiresAt: evidence.expiresAt,
  results: evidence.results.map((result) => ({
    checker: result.request.checker,
    process: result.process,
    report: result.report,
  })),
});

async function scriptedApproval(fixture: Fixture, candidate: Candidate, evidence: Evidence) {
  // Automation is deliberately labeled. The manual CLI requires a person's exact confirmation.
  const result = await approveCandidate(
    fixture,
    candidate,
    evidence,
    'Scripted experiment',
    `APPLY ${candidate.commit} ${digest(evidence)}`,
  );
  assert.ok(result.approval, JSON.stringify(result.verdict));
  return result.approval;
}

export async function runExperiments(): Promise<CaseResult[]> {
  const cases: CaseResult[] = [];
  // A reasonable but wrong sequence: inspect a commit, later commit whatever happens to be in the workspace.
  const naive = await createFixture('naive-drift');
  const inspected = await prepareCandidate(naive);
  const oldEvidence = await verifyCandidate(naive, inspected);
  assert.equal(evidenceVerdict(oldEvidence, inspected, await currentPolicy()).ok, true);
  await writeFile(join(naive.workspace, FILES[0]), FIXTURE_SOURCE.drift);
  const drifted: Candidate = {
    id: runId(),
    base: naive.base,
    ...(await commitWorkspace(naive, 'Deliberate unverified workspace drift', naive.base)),
  };
  await trace(naive.root, 'deliberately-unsafe-comparison', {
    verifiedCommit: inspected.commit,
    committedLater: drifted.commit,
  });
  await git(naive, ['update-ref', RELEASE_REF, drifted.commit, naive.base]);
  const postHocEvidence = await verifyCandidate(naive, drifted);
  const postHoc = evidenceVerdict(postHocEvidence, drifted, await currentPolicy());

  const safe = await createFixture('bound-drift');
  const candidate = await prepareCandidate(safe);
  const evidence = await verifyCandidate(safe, candidate);
  const approval = await scriptedApproval(safe, candidate, evidence);
  await writeFile(join(safe.workspace, FILES[0]), FIXTURE_SOURCE.drift);
  const applied = await applyApproved(safe, candidate, evidence, approval);
  const safeRef = await currentRef(safe);
  const releasedSource = (await git(safe, ['show', `${safeRef}:${FILES[0]}`])).stdout;
  cases.push({
    id: 'drift',
    observations: [
      observation(
        'naiveReleasedUnverifiedBytes',
        true,
        (await currentRef(naive)) === drifted.commit && drifted.commit !== inspected.commit,
      ),
      observation('postHocCheck', 'CHECK_FAILED', postHoc.code),
      observation('boundApply', 'CAS_APPLIED', applied.code),
      observation('releasedExactlyVerifiedCommit', candidate.commit, safeRef),
      observation('releasedSourceUnchanged', FIXTURE_SOURCE.candidateA, releasedSource),
    ],
    facts: {
      inspected: inspected.commit,
      naiveReleased: drifted.commit,
      protectedCandidate: candidate.commit,
      protectedReleased: safeRef,
      beforeDriftEvidence: summary(evidence),
      postHocEvidence: summary(postHocEvidence),
    },
    transcripts: [await readTranscript(naive.root), await readTranscript(safe.root)],
  });

  const emptyFixture = await createFixture('empty-success');
  const emptyCandidate = await prepareCandidate(emptyFixture);
  const emptyEvidence = await verifyCandidate(emptyFixture, emptyCandidate, {
    'runtime-contract': 'empty-pass',
  });
  const emptyApproval = await approveCandidate(
    emptyFixture,
    emptyCandidate,
    emptyEvidence,
    'Scripted experiment',
    `APPLY ${emptyCandidate.commit} ${digest(emptyEvidence)}`,
  );
  // A stronger failure: all named checks can appear green if the candidate chooses their semantics.
  const weakPolicy = await createFixture('candidate-policy');
  await writeFile(
    join(weakPolicy.workspace, FILES[0]),
    "export function mayRetry(method, status) { return (method === 'GET' || method === 'HEAD') && (status === 429 || (status >= 500 && status <= 599)); }\n",
  );
  await writeJson(join(weakPolicy.workspace, FILES[1]), {
    compilerOptions: {
      strict: true,
      noCheck: true,
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      types: [],
    },
    files: ['src/retry-policy.ts'],
  });
  const weakCandidate: Candidate = {
    id: runId(),
    base: weakPolicy.base,
    ...(await commitWorkspace(
      weakPolicy,
      'Candidate attempts to weaken compiler semantics',
      weakPolicy.base,
    )),
  };
  const comparisonSnapshot = join(weakPolicy.root, 'naive-comparison');
  await materializeCandidate(weakPolicy, weakCandidate, comparisonSnapshot);
  const naiveCompiler = await boundedProcess(
    process.execPath,
    [join(PROJECT, 'src/naive-typecheck.ts'), comparisonSnapshot],
    {
      cwd: comparisonSnapshot,
      timeoutMs: 5000,
      maxOutputBytes: 32_000,
    },
  );
  await trace(weakPolicy.root, 'deliberately-weak-candidate-config-checker', naiveCompiler);
  const trustedEvidence = await verifyCandidate(weakPolicy, weakCandidate);
  const trustedApproval = await approveCandidate(
    weakPolicy,
    weakCandidate,
    trustedEvidence,
    'Scripted experiment',
    `APPLY ${weakCandidate.commit} ${digest(trustedEvidence)}`,
  );
  cases.push({
    id: 'empty',
    observations: [
      observation('checkerExit', 0, emptyEvidence.results[0]!.process.exitCode),
      observation('approvalDecision', 'INCOMPLETE_CHECKS', emptyApproval.verdict.code),
      observation('releaseUnchanged', emptyFixture.base, await currentRef(emptyFixture)),
      observation('candidateControlledCompiler', 0, naiveCompiler.exitCode),
      observation('trustedCompiler', 2, trustedEvidence.results[1]!.process.exitCode),
      observation('weakenedPolicyDecision', 'CHECK_FAILED', trustedApproval.verdict.code),
      observation('weakPolicyRefUnchanged', weakPolicy.base, await currentRef(weakPolicy)),
    ],
    facts: {
      emptyEvidence: summary(emptyEvidence),
      requiredInventory: emptyEvidence.policy.required,
      policyCounterexample: {
        explanation:
          'Same candidate: actual compiler with candidate strict:true/noCheck:true passes; trusted strict options detect implicit-any errors. The naive process is comparison-only, never acceptable evidence.',
        naiveCompiler,
        trustedEvidence: summary(trustedEvidence),
        trustedApproval: trustedApproval.verdict,
      },
    },
    transcripts: [await readTranscript(emptyFixture.root), await readTranscript(weakPolicy.root)],
  });

  const staleFixture = await createFixture('stale-evidence');
  const candidateA = await prepareCandidate(staleFixture, 'A');
  const evidenceA = await verifyCandidate(staleFixture, candidateA);
  const candidateB = await prepareCandidate(staleFixture, 'B');
  const reused = await approveCandidate(
    staleFixture,
    candidateB,
    evidenceA,
    'Scripted experiment',
    `APPLY ${candidateB.commit} ${digest(evidenceA)}`,
  );
  const expired = evidenceVerdict(
    evidenceA,
    candidateA,
    await currentPolicy(),
    evidenceA.expiresAt,
  );
  await trace(staleFixture.root, 'expiry-boundary-evaluation', {
    note: 'Injected logical evaluation time, not a wall-clock wait.',
    evaluatedAt: evidenceA.expiresAt,
    decision: expired,
  });
  cases.push({
    id: 'stale',
    observations: [
      observation('reusedEvidence', 'CANDIDATE_MISMATCH', reused.verdict.code),
      observation('expiryBoundary', 'EVIDENCE_STALE', expired.code),
      observation('releaseUnchanged', staleFixture.base, await currentRef(staleFixture)),
    ],
    facts: {
      evidenceCandidate: candidateA.commit,
      requestedCandidate: candidateB.commit,
      evidence: summary(evidenceA),
    },
    transcripts: [await readTranscript(staleFixture.root)],
  });

  const competing = await createFixture('competing');
  const left = await prepareCandidate(competing, 'A');
  const right = await prepareCandidate(competing, 'B');
  const leftEvidence = await verifyCandidate(competing, left);
  const rightEvidence = await verifyCandidate(competing, right);
  const leftApproval = await scriptedApproval(competing, left, leftEvidence);
  const rightApproval = await scriptedApproval(competing, right, rightEvidence);
  const workers = await executeTogether([
    { fixture: competing, candidate: left, evidence: leftEvidence, approval: leftApproval },
    { fixture: competing, candidate: right, evidence: rightEvidence, approval: rightApproval },
  ]);
  const reconciled = await Promise.all([reconcile(competing, left), reconcile(competing, right)]);
  cases.push({
    id: 'competing',
    observations: [
      observation(
        'acknowledgedWinners',
        1,
        workers.filter((worker) => worker.acknowledgement?.code === 'CAS_APPLIED').length,
      ),
      observation(
        'observedWinners',
        1,
        reconciled.filter((result) => result.code === 'OBSERVED_CANDIDATE').length,
      ),
      observation(
        'observedConflicts',
        1,
        reconciled.filter((result) => result.code === 'OBSERVED_OTHER').length,
      ),
    ],
    facts: { base: competing.base, candidates: [left.commit, right.commit], workers, reconciled },
    transcripts: [await readTranscript(competing.root)],
  });

  const crashed = await createFixture('lost-ack');
  const crashCandidate = await prepareCandidate(crashed);
  const crashEvidence = await verifyCandidate(crashed, crashCandidate);
  const crashApproval = await scriptedApproval(crashed, crashCandidate, crashEvidence);
  const crashedWorker = (
    await executeTogether([
      {
        fixture: crashed,
        candidate: crashCandidate,
        evidence: crashEvidence,
        approval: crashApproval,
        fault: 'kill-after-cas',
      },
    ])
  )[0]!;
  const recovered = await reconcile(crashed, crashCandidate);
  const replay = await applyApproved(crashed, crashCandidate, crashEvidence, crashApproval);
  cases.push({
    id: 'lost-ack',
    observations: [
      observation('faultWindowReached', true, crashedWorker.faultWindowReached),
      observation('callerAcknowledgement', 'ACK_MISSING', crashedWorker.callerDisposition),
      observation(
        'executorTerminated',
        true,
        crashedWorker.process.directChildExitConfirmed &&
          crashedWorker.process.ownedTreeTerminationAcknowledged === true &&
          crashedWorker.process.exitCode !== 0,
      ),
      observation('reconciliation', 'OBSERVED_CANDIDATE', recovered.code),
      observation('replayNotApplied', 'CAS_NOT_ACKNOWLEDGED', replay.code),
      observation('releaseStillCandidate', crashCandidate.commit, await currentRef(crashed)),
    ],
    facts: { worker: crashedWorker, recovered, replay, evidence: summary(crashEvidence) },
    transcripts: [await readTranscript(crashed.root)],
  });
  return cases;
}

export async function provenance() {
  const paths: string[] = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json'];
  async function collect(directory: string) {
    for (const entry of await readdir(join(PROJECT, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  for (const directory of ['src', 'test', 'web'])
    try {
      await collect(directory);
    } catch {
      /* Early development checkpoints may not have every directory. */
    }
  const files = await Promise.all(
    paths
      .sort()
      .map(async (path) => ({ path, sha256: sha256(await readFile(join(PROJECT, path))) })),
  );
  const revision = await boundedProcess(
    'git',
    ['--git-dir', join(PROJECT, '.git'), 'rev-parse', 'HEAD'],
    { cwd: PROJECT, timeoutMs: 3000, maxOutputBytes: 2000 },
  );
  const status = await boundedProcess(
    'git',
    ['--git-dir', join(PROJECT, '.git'), '--work-tree', PROJECT, 'status', '--porcelain'],
    { cwd: PROJECT, timeoutMs: 3000, maxOutputBytes: 8000 },
  );
  const gitVersion = await boundedProcess('git', ['--version'], {
    cwd: PROJECT,
    timeoutMs: 3000,
    maxOutputBytes: 1000,
  });
  return {
    sourceFingerprint: digest(files),
    files,
    gitRevision: revision.exitCode === 0 ? revision.stdout.trim() : null,
    gitDirty: status.exitCode === 0 ? status.stdout.trim().length > 0 : null,
    nodeVersion: process.version,
    gitVersion: gitVersion.stdout.trim(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceBefore = await provenance();
  const cases = await runExperiments();
  const sourceAfter = await provenance();
  assert.equal(
    sourceBefore.sourceFingerprint,
    sourceAfter.sourceFingerprint,
    'Source changed during execution; refusing to stamp the run with a misleading source fingerprint.',
  );
  const failed = cases.flatMap((item) =>
    item.observations.filter((check) => !check.passed).map((check) => `${item.id}/${check.key}`),
  );
  const report: ExperimentReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    command: 'pnpm experiment',
    provenance: sourceAfter,
    cases,
  };
  await mkdir(join(PROJECT, 'dist'), { recursive: true });
  await writeJson(join(PROJECT, 'dist/report.json'), JSON.parse(redacted(JSON.stringify(report))));
  for (const item of cases)
    console.log(
      `${item.observations.every((check) => check.passed) ? 'PASS' : 'FAIL'} ${item.id}: ${item.observations.length} declared observations`,
    );
  console.log(
    'Raw commands and checker payloads: dist/report.json (paths sanitized; fresh run identifiers retained)',
  );
  if (failed.length) {
    console.error(`Unexpected observations: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

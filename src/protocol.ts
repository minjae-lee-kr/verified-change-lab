import { join } from 'node:path';
import { git, currentRef, RELEASE_REF } from './git.ts';
import { currentPolicy } from './policy.ts';
import { processSucceeded } from './process.ts';
import { digest, trace, writeJson } from './support.ts';
import type {
  Approval,
  Candidate,
  CheckReport,
  Evidence,
  Fixture,
  Policy,
  Verdict,
} from './types.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).sort().join('|') === [...expected].sort().join('|');
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const time = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const verdict = (ok: boolean, code: string, reason: string): Verdict => ({ ok, code, reason });

export function evidenceVerdict(
  evidence: Evidence,
  candidate: Candidate,
  policy: Policy,
  now = Date.now(),
): Verdict {
  if (!hash(candidate.base) || !hash(candidate.commit) || !hash(candidate.tree))
    return verdict(
      false,
      'INVALID_CANDIDATE',
      'Candidate identities must be exact Git object IDs.',
    );
  if (evidence.version !== 1 || !Array.isArray(evidence.results))
    return verdict(false, 'INVALID_EVIDENCE', 'Unsupported evidence envelope.');
  if (digest(evidence.candidate) !== digest(candidate))
    return verdict(
      false,
      'CANDIDATE_MISMATCH',
      'Evidence belongs to a different immutable candidate.',
    );
  if (evidence.policyDigest !== digest(policy) || digest(evidence.policy) !== digest(policy))
    return verdict(
      false,
      'POLICY_CHANGED',
      'Verification policy, checker implementation or toolchain changed.',
    );
  if (
    !time(now) ||
    !time(evidence.createdAt) ||
    !time(evidence.expiresAt) ||
    evidence.createdAt > now ||
    evidence.expiresAt !== evidence.createdAt + policy.evidenceTtlMs ||
    evidence.expiresAt <= now
  )
    return verdict(false, 'EVIDENCE_STALE', 'Evidence is expired or has an invalid time window.');
  if (evidence.results.length !== policy.required.length)
    return verdict(
      false,
      'INCOMPLETE_INVENTORY',
      'A required verifier result is missing or duplicated.',
    );
  const seen = new Set<string>();
  for (const result of evidence.results) {
    const required = policy.required.find((entry) => entry.checker === result.request.checker);
    if (!required || seen.has(required.checker))
      return verdict(
        false,
        'INCOMPLETE_INVENTORY',
        'Verifier identity does not match the independently declared inventory.',
      );
    seen.add(required.checker);
    if (
      result.request.version !== 1 ||
      result.request.runId !== evidence.runId ||
      digest(result.request.candidate) !== digest(candidate) ||
      result.request.policyDigest !== evidence.policyDigest ||
      !time(result.request.requestedAt) ||
      result.request.requestedAt < evidence.createdAt
    )
      return verdict(
        false,
        'REQUEST_MISMATCH',
        'Verifier request does not belong to this evidence run.',
      );
    const process = result.process;
    if (process.processError !== undefined)
      return verdict(false, 'PROCESS_IO_ERROR', 'A required checker process or its I/O failed.');
    if (process.timedOut)
      return verdict(
        false,
        'CHECK_TIMEOUT',
        'A required checker exceeded its real process deadline.',
      );
    if (process.outputLimited)
      return verdict(
        false,
        'OUTPUT_LIMIT',
        'Checker output exceeded the bounded transcript budget.',
      );
    if (!process.directChildExitConfirmed)
      return verdict(
        false,
        'CHILD_EXIT_UNCONFIRMED',
        'The direct checker process exit was not confirmed.',
      );
    const report = result.report;
    if (
      !object(report) ||
      !keys(report, [
        'version',
        'runId',
        'nonce',
        'checker',
        'candidateCommit',
        'candidateTree',
        'policyDigest',
        'startedAt',
        'completedAt',
        'sourceConsistent',
        'checks',
      ]) ||
      report.version !== 1 ||
      report.runId !== evidence.runId ||
      report.nonce !== result.request.nonce ||
      report.checker !== required.checker ||
      report.candidateCommit !== candidate.commit ||
      report.candidateTree !== candidate.tree ||
      report.policyDigest !== evidence.policyDigest
    )
      return verdict(
        false,
        'REPORT_MISMATCH',
        'The checker payload is absent, malformed or bound to another invocation.',
      );
    if (
      !time(report.startedAt) ||
      !time(report.completedAt) ||
      report.startedAt < result.request.requestedAt ||
      report.completedAt < report.startedAt ||
      report.completedAt > now ||
      report.completedAt - result.request.requestedAt > policy.verifierTimeoutMs + 1000
    )
      return verdict(
        false,
        'REPORT_STALE',
        'Checker result is outside this invocation’s fresh time window.',
      );
    if (report.sourceConsistent !== true)
      return verdict(
        false,
        'SOURCE_CHANGED',
        'The verification snapshot changed while the checker ran.',
      );
    if (
      !Array.isArray(report.checks) ||
      report.checks.length !== required.checks.length ||
      report.checks.length === 0 ||
      !report.checks.every(
        (check) =>
          object(check) &&
          keys(check, ['id', 'passed', 'detail']) &&
          typeof check.id === 'string' &&
          typeof check.passed === 'boolean' &&
          typeof check.detail === 'string' &&
          check.detail.length <= 4000,
      ) ||
      report.checks
        .map((check) => (check as { id: string }).id)
        .sort()
        .join('|') !== [...required.checks].sort().join('|')
    )
      return verdict(
        false,
        'INCOMPLETE_CHECKS',
        'A zero exit code cannot replace the complete nonempty check inventory.',
      );
    if (
      process.exitCode !== 0 ||
      process.signal !== null ||
      report.checks.some((check) => !(check as { passed: boolean }).passed)
    )
      return verdict(
        false,
        'CHECK_FAILED',
        'A required concrete check failed or the process did not exit successfully.',
      );
  }
  return verdict(
    true,
    'EVIDENCE_COMPLETE',
    'Every independently required check is fresh, complete and bound to this candidate and policy.',
  );
}

export async function approveCandidate(
  fixture: Fixture,
  candidate: Candidate,
  evidence: Evidence,
  reviewerLabel: string,
  confirmation: string,
): Promise<{ verdict: Verdict; approval?: Approval }> {
  const policy = await currentPolicy();
  const now = Date.now();
  const valid = evidenceVerdict(evidence, candidate, policy, now);
  if (!valid.ok) {
    await trace(fixture.root, 'approval-refused', valid);
    return { verdict: valid };
  }
  const evidenceDigest = digest(evidence);
  if (
    !/^[\p{L}\p{N} ._-]{1,80}$/u.test(reviewerLabel) ||
    confirmation !== `APPLY ${candidate.commit} ${evidenceDigest}`
  ) {
    const refused = verdict(
      false,
      'CONFIRMATION_REQUIRED',
      'Local approval requires the exact candidate commit and evidence digest. The reviewer label does not authenticate a person.',
    );
    await trace(fixture.root, 'approval-refused', refused);
    return { verdict: refused };
  }
  const approval: Approval = {
    version: 1,
    reviewerLabel,
    base: candidate.base,
    candidateCommit: candidate.commit,
    candidateTree: candidate.tree,
    evidenceDigest,
    policyDigest: evidence.policyDigest,
    issuedAt: now,
    expiresAt: evidence.expiresAt,
  };
  await writeJson(join(fixture.root, 'approvals', `${candidate.id}.json`), approval);
  await trace(fixture.root, 'local-approval-recorded', approval);
  return {
    verdict: verdict(
      true,
      'APPROVED',
      'Local approval binds this exact base, candidate and verification evidence.',
    ),
    approval,
  };
}

export async function applyApproved(
  fixture: Fixture,
  candidate: Candidate,
  evidence: Evidence,
  approval: Approval,
): Promise<Verdict> {
  const policy = await currentPolicy();
  const now = Date.now();
  const evidenceCheck = evidenceVerdict(evidence, candidate, policy, now);
  if (!evidenceCheck.ok) return evidenceCheck;
  if (
    approval.version !== 1 ||
    approval.base !== candidate.base ||
    approval.candidateCommit !== candidate.commit ||
    approval.candidateTree !== candidate.tree ||
    approval.evidenceDigest !== digest(evidence) ||
    approval.policyDigest !== digest(policy) ||
    !time(approval.issuedAt) ||
    approval.issuedAt > now ||
    approval.expiresAt !== evidence.expiresAt ||
    approval.expiresAt <= now
  )
    return verdict(
      false,
      'APPROVAL_MISMATCH',
      'Approval does not authorize this exact fresh candidate and evidence.',
    );
  const result = await git(
    fixture,
    ['update-ref', RELEASE_REF, candidate.commit, candidate.base],
    {},
    true,
  );
  const decision = processSucceeded(result)
    ? verdict(
        true,
        'CAS_APPLIED',
        'Git accepted one conditional local ref-pointer update. No deployment or working-tree update occurred.',
      )
    : verdict(
        false,
        'CAS_NOT_ACKNOWLEDGED',
        'The conditional ref update did not return a successful acknowledgement. Observe the ref before deciding what happened.',
      );
  await trace(fixture.root, 'apply-command-outcome', decision);
  return decision;
}

export async function reconcile(
  fixture: Fixture,
  candidate: Candidate,
): Promise<Verdict & { observedCommit: string }> {
  const observedCommit = await currentRef(fixture);
  const decision =
    observedCommit === candidate.commit
      ? verdict(
          true,
          'OBSERVED_CANDIDATE',
          'The release ref currently equals the candidate. This establishes present state, not who performed the update.',
        )
      : observedCommit === candidate.base
        ? verdict(
            false,
            'OBSERVED_BASE',
            'The release ref currently equals the base. Observation alone does not prove uninterrupted history.',
          )
        : verdict(
            false,
            'OBSERVED_OTHER',
            'The release ref currently points to another commit. Stop; do not overwrite it during reconciliation.',
          );
  await trace(fixture.root, 'reconciliation', { ...decision, observedCommit });
  return { ...decision, observedCommit };
}

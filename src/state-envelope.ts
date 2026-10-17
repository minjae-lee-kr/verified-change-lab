import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git.ts';
import { currentPolicy } from './policy.ts';
import { processSucceeded } from './process.ts';
import { evidenceVerdict } from './protocol.ts';
import { assertOwnedPath, digest, runId, writeJson } from './support.ts';
import type { Approval, Candidate, Evidence, Fixture, ProcessResult } from './types.ts';

export const STATE_REF = 'refs/heads/lab-state';
const ZERO = '0'.repeat(40);
const oid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).sort().join('|') === names.sort().join('|');

export type OperationReceipt = {
  operationId: string;
  base: string;
  candidate: string;
  evidenceDigest: string;
  policyDigest: string;
};
export type StateEnvelope = {
  version: 1;
  selectedCandidate: string;
  receipts: OperationReceipt[];
};
export type CapturedState = { oid: string; parents: string[]; state: StateEnvelope };
export type AuthorizedChange = {
  fixture: Fixture;
  candidate: Candidate;
  evidence: Evidence;
  approval: Approval;
};
export type StatePlan =
  | { code: 'ALREADY_RECORDED'; observed: CapturedState; receipt: OperationReceipt }
  | { code: 'BASE_CHANGED'; observed: CapturedState }
  | {
      code: 'PREPARED';
      expected: CapturedState;
      next: CapturedState;
      receipt: OperationReceipt;
    };

/** Bounded local fixture format, not a signed receipt or an authorization service. */
export function parseState(text: string): StateEnvelope {
  if (Buffer.byteLength(text) > 32_000)
    throw new Error('State envelope exceeds the fixture budget.');
  const value: unknown = JSON.parse(text);
  if (
    !object(value) ||
    !keys(value, ['version', 'selectedCandidate', 'receipts']) ||
    value.version !== 1 ||
    !oid(value.selectedCandidate) ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > 16
  )
    throw new Error('Malformed state envelope.');
  const seen = new Set<string>();
  for (const item of value.receipts) {
    if (
      !object(item) ||
      !keys(item, ['operationId', 'base', 'candidate', 'evidenceDigest', 'policyDigest']) ||
      !sha(item.operationId) ||
      !oid(item.base) ||
      !oid(item.candidate) ||
      !sha(item.evidenceDigest) ||
      !sha(item.policyDigest) ||
      seen.has(item.operationId)
    )
      throw new Error('Malformed or duplicate operation receipt.');
    seen.add(item.operationId);
  }
  return value as StateEnvelope;
}

export async function readStateAt(fixture: Fixture, capturedOid: string): Promise<CapturedState> {
  if (!oid(capturedOid)) throw new Error('Expected one captured state commit OID.');
  const paths = (await git(fixture, ['ls-tree', '-r', '--name-only', capturedOid])).stdout.trim();
  if (paths !== 'state.json') throw new Error('State commit has an unexpected file inventory.');
  const state = parseState((await git(fixture, ['show', `${capturedOid}:state.json`])).stdout);
  const parentText = (await git(fixture, ['show', '-s', '--format=%P', capturedOid])).stdout.trim();
  const parents = parentText ? parentText.split(' ') : [];
  if (parents.some((parent) => !oid(parent))) throw new Error('Malformed state parent identity.');
  // Candidate refs retain these code objects. JSON OIDs alone are not Git GC edges.
  await git(fixture, ['cat-file', '-e', `${state.selectedCandidate}^{commit}`]);
  return { oid: capturedOid, parents, state };
}

/** Capture the ref once. Every field is then resolved from that immutable OID. */
export async function captureState(fixture: Fixture): Promise<CapturedState> {
  const capturedOid = (await git(fixture, ['rev-parse', STATE_REF])).stdout.trim();
  return readStateAt(fixture, capturedOid);
}

/** Used only by this fixed experiment, including its deliberate rewind controls. */
export async function commitState(
  fixture: Fixture,
  state: StateEnvelope,
  parent?: string,
): Promise<CapturedState> {
  parseState(JSON.stringify(state));
  if (parent !== undefined && !oid(parent)) throw new Error('Invalid state parent.');
  await assertOwnedPath(fixture.root);
  const directory = join(fixture.root, 'state-builds', runId());
  await mkdir(directory, { recursive: true });
  await assertOwnedPath(directory);
  await writeJson(join(directory, 'state.json'), state);
  const env = { GIT_INDEX_FILE: join(directory, 'index'), GIT_WORK_TREE: directory };
  await git(fixture, ['read-tree', '--empty'], env);
  await git(fixture, ['add', '--', 'state.json'], env);
  const tree = (await git(fixture, ['write-tree'], env)).stdout.trim();
  const commit = (
    await git(
      fixture,
      ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Synthetic state envelope'],
      {
        GIT_AUTHOR_NAME: 'Synthetic Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Synthetic Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    )
  ).stdout.trim();
  return readStateAt(fixture, commit);
}

export async function initializeState(fixture: Fixture): Promise<CapturedState> {
  const state = await commitState(fixture, {
    version: 1,
    selectedCandidate: fixture.base,
    receipts: [],
  });
  await git(fixture, ['update-ref', STATE_REF, state.oid, ZERO]);
  return state;
}

export function operationReceipt(input: AuthorizedChange): OperationReceipt {
  return {
    operationId: digest(input.approval),
    base: input.candidate.base,
    candidate: input.candidate.commit,
    evidenceDigest: digest(input.evidence),
    policyDigest: input.evidence.policyDigest,
  };
}

async function requireFreshAuthorization(input: AuthorizedChange): Promise<void> {
  const { candidate, evidence, approval } = input;
  const policy = await currentPolicy();
  const now = Date.now();
  const check = evidenceVerdict(evidence, candidate, policy, now);
  if (!check.ok) throw new Error(`State transition refused: ${check.code}`);
  if (
    approval.version !== 1 ||
    approval.base !== candidate.base ||
    approval.candidateCommit !== candidate.commit ||
    approval.candidateTree !== candidate.tree ||
    approval.evidenceDigest !== digest(evidence) ||
    approval.policyDigest !== digest(policy) ||
    !Number.isSafeInteger(approval.issuedAt) ||
    approval.issuedAt < 0 ||
    approval.issuedAt > now ||
    approval.expiresAt !== evidence.expiresAt ||
    approval.expiresAt <= now
  )
    throw new Error('State transition refused: APPROVAL_MISMATCH');
}

export async function prepareStateChange(input: AuthorizedChange): Promise<StatePlan> {
  await requireFreshAuthorization(input);
  const observed = await captureState(input.fixture);
  const receipt = operationReceipt(input);
  const retained = observed.state.receipts.find((item) => item.operationId === receipt.operationId);
  if (retained) {
    if (digest(retained) !== digest(receipt))
      throw new Error('Retained receipt conflicts with the operation.');
    return { code: 'ALREADY_RECORDED', observed, receipt: retained };
  }
  if (observed.state.selectedCandidate !== input.candidate.base)
    return { code: 'BASE_CHANGED', observed };
  const next = await commitState(
    input.fixture,
    {
      version: 1,
      selectedCandidate: input.candidate.commit,
      receipts: [...observed.state.receipts, receipt],
    },
    observed.oid,
  );
  return { code: 'PREPARED', expected: observed, next, receipt };
}

export async function selectPreparedState(
  input: AuthorizedChange,
  plan: Extract<StatePlan, { code: 'PREPARED' }>,
): Promise<{
  code: 'STATE_CAS_ACKNOWLEDGED' | 'STATE_CAS_UNACKNOWLEDGED';
  process: ProcessResult;
}> {
  // Recheck after the preparation barrier; waiting must not extend the approval TTL.
  await requireFreshAuthorization(input);
  const expected = await readStateAt(input.fixture, plan.expected.oid);
  const next = await readStateAt(input.fixture, plan.next.oid);
  const receipt = operationReceipt(input);
  if (
    next.parents.length !== 1 ||
    next.parents[0] !== expected.oid ||
    expected.state.selectedCandidate !== input.candidate.base ||
    expected.state.receipts.some((item) => item.operationId === receipt.operationId) ||
    digest(next.state) !==
      digest({
        version: 1,
        selectedCandidate: input.candidate.commit,
        receipts: [...expected.state.receipts, receipt],
      })
  )
    throw new Error('Prepared state does not bind the exact selection and retained receipts.');
  const result = await git(
    input.fixture,
    ['update-ref', STATE_REF, next.oid, expected.oid],
    {},
    true,
  );
  return {
    code: processSucceeded(result) ? 'STATE_CAS_ACKNOWLEDGED' : 'STATE_CAS_UNACKNOWLEDGED',
    process: result,
  };
}

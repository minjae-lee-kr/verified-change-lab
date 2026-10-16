import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createFixture,
  prepareCandidate,
  currentRef,
  git,
  RELEASE_REF,
  commitWorkspace,
} from '../src/git.ts';
import { currentPolicy } from '../src/policy.ts';
import { boundedProcess } from '../src/process.ts';
import { applyApproved, approveCandidate, evidenceVerdict } from '../src/protocol.ts';
import { verifyCandidate } from '../src/runner.ts';
import { digest, redacted, PROJECT, runId, writeJson } from '../src/support.ts';
import { runExperiments } from '../src/experiment.ts';
import type { Candidate, CheckReport, Evidence, Fixture, Policy } from '../src/types.ts';

let fixture: Fixture;
let candidate: Candidate;
let evidence: Evidence;
let policy: Policy;
before(async () => {
  fixture = await createFixture('tests');
  candidate = await prepareCandidate(fixture);
  evidence = await verifyCandidate(fixture, candidate);
  policy = await currentPolicy();
});

test('positive control: separate processes inspect the same immutable commit', () => {
  assert.equal(evidenceVerdict(evidence, candidate, policy).code, 'EVIDENCE_COMPLETE');
  assert.equal(evidence.results.length, 2);
  assert.equal(
    evidence.results.every((result) => result.process.exitCode === 0),
    true,
  );
  assert.equal(
    evidence.results.every(
      (result) =>
        result.process.directChildExitConfirmed &&
        result.process.ownedTreeTerminationAcknowledged === null,
    ),
    true,
  );
});

test('an apparently green subset cannot redefine required coverage', () => {
  const missing = structuredClone(evidence);
  missing.results.pop();
  assert.equal(evidenceVerdict(missing, candidate, policy).code, 'INCOMPLETE_INVENTORY');
  const partial = structuredClone(evidence);
  (partial.results[0]!.report as CheckReport).checks.splice(1);
  assert.equal(evidenceVerdict(partial, candidate, policy).code, 'INCOMPLETE_CHECKS');
  const duplicate = structuredClone(evidence);
  duplicate.results[1] = duplicate.results[0]!;
  assert.equal(evidenceVerdict(duplicate, candidate, policy).code, 'INCOMPLETE_INVENTORY');
});

test('candidate, request nonce, policy source and time are independent bindings', () => {
  const other = { ...candidate, commit: 'f'.repeat(40) };
  assert.equal(evidenceVerdict(evidence, other, policy).code, 'CANDIDATE_MISMATCH');
  const replay = structuredClone(evidence);
  (replay.results[0]!.report as CheckReport).nonce = 'previous-invocation';
  assert.equal(evidenceVerdict(replay, candidate, policy).code, 'REPORT_MISMATCH');
  const changedPolicy = structuredClone(policy);
  changedPolicy.sourceHashes[0]!.sha256 = '0'.repeat(64);
  assert.equal(evidenceVerdict(evidence, candidate, changedPolicy).code, 'POLICY_CHANGED');
  assert.equal(
    evidenceVerdict(evidence, candidate, policy, evidence.expiresAt).code,
    'EVIDENCE_STALE',
  );
});

test('failed and malformed checker data cannot be upgraded by exit code zero', () => {
  const failed = structuredClone(evidence);
  (failed.results[0]!.report as CheckReport).checks[0]!.passed = false;
  assert.equal(evidenceVerdict(failed, candidate, policy).code, 'CHECK_FAILED');
  for (const report of [null, [], {}, { checks: Array(20).fill(true) }]) {
    const malformed = structuredClone(evidence);
    malformed.results[0]!.report = report;
    assert.equal(evidenceVerdict(malformed, candidate, policy).code, 'REPORT_MISMATCH');
  }
  const changed = structuredClone(evidence);
  (changed.results[0]!.report as CheckReport).sourceConsistent = false;
  assert.equal(evidenceVerdict(changed, candidate, policy).code, 'SOURCE_CHANGED');
});

test('local approval requires an exact explicit confirmation and does not mutate the ref', async () => {
  assert.equal(
    (await approveCandidate(fixture, candidate, evidence, 'Local reviewer', 'yes')).verdict.code,
    'CONFIRMATION_REQUIRED',
  );
  const approved = await approveCandidate(
    fixture,
    candidate,
    evidence,
    'Local reviewer',
    `APPLY ${candidate.commit} ${digest(evidence)}`,
  );
  assert.ok(approved.approval);
  assert.equal(await currentRef(fixture), fixture.base);
});

test('candidate tsconfig cannot disable strict typing or omit the required source', async () => {
  const weakened = await createFixture('weak-config');
  await writeFile(
    join(weakened.workspace, 'src/retry-policy.ts'),
    "export function mayRetry(method, status) { return (method === 'GET' || method === 'HEAD') && (status === 429 || (status >= 500 && status <= 599)); }\n",
  );
  await writeFile(
    join(weakened.workspace, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: false }, files: [] }),
  );
  const changed = {
    id: runId(),
    base: weakened.base,
    ...(await commitWorkspace(weakened, 'Weakened candidate config', weakened.base)),
  };
  const result = await verifyCandidate(weakened, changed);
  assert.equal(result.results[0]!.process.exitCode, 0, 'Runtime behavior is the positive control.');
  assert.equal(
    result.results[1]!.process.exitCode,
    2,
    'The trusted compiler policy still checks the fixed source strictly.',
  );
  assert.match(
    (result.results[1]!.report as CheckReport).checks[0]!.detail,
    /implicitly has an 'any' type/,
  );
  assert.equal(evidenceVerdict(result, changed, await currentPolicy()).code, 'CHECK_FAILED');
});

test('CLI refuses unrecognized dry-run flags before touching an approved fixture', async () => {
  const manual = await createFixture('manual');
  const proposed = await prepareCandidate(manual);
  const proof = await verifyCandidate(manual, proposed);
  await writeJson(join(manual.root, 'review.json'), {
    fixture: manual,
    candidate: proposed,
    evidence: proof,
  });
  const approved = await approveCandidate(
    manual,
    proposed,
    proof,
    'Local reviewer',
    `APPLY ${proposed.commit} ${digest(proof)}`,
  );
  assert.ok(approved.approval);
  const beforeRef = await currentRef(manual);
  const result = await boundedProcess(
    process.execPath,
    [join(PROJECT, 'src/cli.ts'), 'apply', manual.id, '--dry-run'],
    { cwd: PROJECT, timeoutMs: 3000, maxOutputBytes: 4000 },
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /extra argument/);
  assert.equal(await currentRef(manual), beforeRef);
});

test(
  'five real-I/O counterexamples preserve their declared observable outcomes',
  { timeout: 90_000 },
  async () => {
    const cases = await runExperiments();
    assert.deepEqual(
      cases.map((item) => item.id),
      ['drift', 'empty', 'stale', 'competing', 'lost-ack'],
    );
    for (const item of cases)
      for (const observation of item.observations)
        assert.equal(
          observation.passed,
          true,
          `${item.id}/${observation.key}: ${JSON.stringify(observation)}`,
        );
  },
);

test('negative proof: CAS does not consume an approval or detect an external A-B-A history', async () => {
  const approved = await approveCandidate(
    fixture,
    candidate,
    evidence,
    'Local reviewer',
    `APPLY ${candidate.commit} ${digest(evidence)}`,
  );
  assert.ok(approved.approval);
  assert.equal(
    (await applyApproved(fixture, candidate, evidence, approved.approval)).code,
    'CAS_APPLIED',
  );
  assert.equal(
    (await applyApproved(fixture, candidate, evidence, approved.approval)).code,
    'CAS_NOT_ACKNOWLEDGED',
  );
  // An independent local writer restores the base; the same still-fresh value guard can succeed again.
  await git(fixture, ['update-ref', RELEASE_REF, fixture.base, candidate.commit]);
  assert.equal(
    (await applyApproved(fixture, candidate, evidence, approved.approval)).code,
    'CAS_APPLIED',
  );
});

test(
  'output cap and real process deadline terminate owned workers and descendants',
  { timeout: 10_000 },
  async () => {
    const output = await boundedProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"],
      { cwd: fixture.root, timeoutMs: 2000, maxOutputBytes: 100 },
    );
    assert.equal(output.outputLimited, true);
    assert.equal(output.directChildExitConfirmed, true);
    assert.equal(output.ownedTreeTerminationAcknowledged, true);
    assert.ok(Buffer.byteLength(output.stdout) <= 100);
    const heartbeat = join(fixture.root, 'heartbeat.txt');
    const pidPath = join(fixture.root, 'descendant.pid');
    const descendant = join(fixture.root, 'descendant.cjs');
    const parent = join(fixture.root, 'parent.cjs');
    await writeFile(
      descendant,
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),40);`,
    );
    await writeFile(
      parent,
      `require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`,
    );
    const timeout = await boundedProcess(process.execPath, [parent], {
      cwd: fixture.root,
      timeoutMs: 1000,
      maxOutputBytes: 100,
    });
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.directChildExitConfirmed, true);
    assert.equal(timeout.ownedTreeTerminationAcknowledged, true);
    const before = await readFile(heartbeat, 'utf8');
    await delay(180);
    assert.equal(await readFile(heartbeat, 'utf8'), before);
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.throws(() => process.kill(pid, 0));
  },
);

test('published transcripts redact native and serialized project paths', () => {
  assert.equal(redacted(PROJECT + '/file'), '<project>/file');
  assert.equal(JSON.parse(redacted(JSON.stringify({ path: PROJECT }))).path, '<project>');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { currentRef, git } from '../src/git.ts';
import { boundedProcess } from '../src/process.ts';
import { digest, LAB, PROJECT } from '../src/support.ts';
import type { Candidate, Evidence, Fixture } from '../src/types.ts';

const cli = join(PROJECT, 'src/cli.ts');
const outside = dirname(PROJECT);
const run = (args: string[]) =>
  boundedProcess(process.execPath, [cli, ...args], {
    cwd: outside,
    timeoutMs: 15_000,
    maxOutputBytes: 32_000,
  });

test('help is nonmutating while mixed help and operation arguments still fail closed', async () => {
  for (const [args, expected] of [
    [[], 0],
    [['help'], 0],
    [['--help'], 0],
    [['help', 'prepare'], 2],
    [['--help', 'prepare'], 2],
    [['prepare', '--help'], 2],
    [['prepare', '--dry-run'], 2],
    [['unknown-command'], 2],
  ] as Array<[string[], number]>) {
    // Deny filesystem writes and subprocesses in the help invocation itself.
    // A concurrent test may create its own fixture, so global directory counts
    // would be a racy assertion. This guard tests these known CLI paths only.
    const result = await boundedProcess(
      process.execPath,
      ['--permission', '--allow-fs-read=*', cli, ...args],
      { cwd: outside, timeoutMs: 3000, maxOutputBytes: 4000 },
    );
    assert.equal(result.exitCode, expected, JSON.stringify({ args, result }));
    assert.match(expected === 0 ? result.stdout : result.stderr, /Usage:/);
    assert.doesNotMatch(result.stdout + result.stderr, /ERR_ACCESS_DENIED|EVIDENCE_COMPLETE/);
  }
});

test('prepare prints an exact manual flow whose reconcile arguments work outside the repository', async () => {
  const prepared = await run(['prepare']);
  assert.equal(prepared.exitCode, 0, prepared.stderr);
  assert.match(prepared.stdout, /diff --git a\/src\/retry-policy.ts/);
  assert.match(prepared.stdout, /EVIDENCE_COMPLETE/);
  const approveLine = prepared.stdout.match(
    /^pnpm lab (approve (manual-[a-f0-9-]{36}) ([a-f0-9]{40}) ([a-f0-9]{64}))$/m,
  );
  assert.ok(approveLine, 'The exact approval command is printed.');
  const [, approvalArgs, fixtureId, commit, evidenceDigest] = approveLine;
  const appliedLine = prepared.stdout.match(
    /Then separately apply: pnpm lab (apply manual-[a-f0-9-]{36})/,
  );
  const reconcileLine = prepared.stdout.match(
    /Then observe the current ref: pnpm lab (reconcile manual-[a-f0-9-]{36})/,
  );
  assert.ok(appliedLine, 'The exact apply command is printed.');
  assert.ok(reconcileLine, 'The exact reconcile command is printed.');
  assert.equal(appliedLine[1], `apply ${fixtureId}`);
  assert.equal(reconcileLine[1], `reconcile ${fixtureId}`);
  const review = JSON.parse(await readFile(join(LAB, fixtureId!, 'review.json'), 'utf8')) as {
    fixture: Fixture;
    candidate: Candidate;
    evidence: Evidence;
  };
  assert.equal(commit, review.candidate.commit);
  assert.equal(evidenceDigest, digest(review.evidence));
  const beforeRefs = (await git(review.fixture, ['show-ref'])).stdout;
  const approved = await run(approvalArgs!.split(' '));
  assert.equal(approved.exitCode, 0, approved.stderr);
  assert.equal(JSON.parse(approved.stdout).code, 'APPROVED');
  assert.equal((await git(review.fixture, ['show-ref'])).stdout, beforeRefs);

  for (const flag of ['--help', '--dry-run']) {
    const invalid = await run(['apply', fixtureId!, flag]);
    assert.equal(invalid.exitCode, 2, invalid.stdout);
    assert.match(invalid.stderr, /extra argument/);
    assert.equal(await currentRef(review.fixture), review.candidate.base);
  }

  const applied = await run(appliedLine[1]!.split(' '));
  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).code, 'CAS_APPLIED');
  const reconciled = await run(reconcileLine[1]!.split(' '));
  assert.equal(reconciled.exitCode, 0, reconciled.stderr);
  const observation = JSON.parse(reconciled.stdout);
  assert.equal(observation.code, 'OBSERVED_CANDIDATE');
  assert.equal(observation.observedCommit, commit);
  assert.equal(
    (await git(review.fixture, ['show-ref'])).stdout,
    beforeRefs.replace(
      `${review.candidate.base} refs/heads/release`,
      `${review.candidate.commit} refs/heads/release`,
    ),
  );
});

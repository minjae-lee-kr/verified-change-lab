import { join } from 'node:path';
import { createFixture, git, prepareCandidate } from './git.ts';
import { currentPolicy } from './policy.ts';
import { applyApproved, approveCandidate, evidenceVerdict, reconcile } from './protocol.ts';
import { verifyCandidate } from './runner.ts';
import { assertOwnedPath, digest, LAB, readJson, writeJson } from './support.ts';
import type { Approval, Candidate, Evidence, Fixture } from './types.ts';

type Review = { fixture: Fixture; candidate: Candidate; evidence: Evidence };
const args = process.argv.slice(2);
const [command, id, commit, evidenceDigest] = args;
const requiredArity: Record<string, number> = {
  prepare: 1,
  show: 2,
  approve: 4,
  apply: 2,
  reconcile: 2,
};
const usage = [
  'Usage:',
  '  pnpm lab prepare',
  '  pnpm lab show <fixture>',
  '  pnpm lab approve <fixture> <commit> <evidence-digest>',
  '  pnpm lab apply <fixture>',
  '  pnpm lab reconcile <fixture>',
  '  pnpm lab help',
  '  pnpm lab --help',
  '',
  'Run from the repository root, or use pnpm --dir <repository> lab <command>.',
  'prepare creates a synthetic fixture; approve records a local decision;',
  'apply conditionally updates only its release ref; reconcile reads the current ref.',
  'No arguments, help, and --help only print this usage. Operation flags are not accepted.',
].join('\n');
const help =
  args.length === 0 || (args.length === 1 && (command === 'help' || command === '--help'));
if (help) {
  console.log(usage);
} else if (!command || args.length !== requiredArity[command]) {
  console.error(
    'Unsupported command or extra argument. Operation flags, including --dry-run, are not accepted. Nothing was applied.',
  );
  console.error(usage);
  process.exitCode = 2;
} else if (command === 'prepare') {
  const fixture = await createFixture('manual');
  const candidate = await prepareCandidate(fixture);
  const evidence = await verifyCandidate(fixture, candidate);
  const decision = evidenceVerdict(evidence, candidate, await currentPolicy());
  await writeJson(join(fixture.root, 'review.json'), { fixture, candidate, evidence });
  console.log(
    (await git(fixture, ['diff', candidate.base, candidate.commit, '--', 'src/retry-policy.ts']))
      .stdout,
  );
  console.log(
    JSON.stringify(
      {
        decision,
        candidate,
        evidenceDigest: digest(evidence),
        expiresAt: new Date(evidence.expiresAt).toISOString(),
        checks: evidence.policy.required,
      },
      null,
      2,
    ),
  );
  console.log(`Review raw evidence in .lab/${fixture.id}/review.json. No release ref has changed.`);
  if (decision.ok) {
    console.log(
      `Local confirmation (label is not authentication):\npnpm lab approve ${fixture.id} ${candidate.commit} ${digest(evidence)}`,
    );
    console.log(`Then separately apply: pnpm lab apply ${fixture.id}`);
    console.log(`Then observe the current ref: pnpm lab reconcile ${fixture.id}`);
  } else process.exitCode = 2;
} else if (
  ['show', 'approve', 'apply', 'reconcile'].includes(command ?? '') &&
  id &&
  /^manual-[a-f0-9-]{36}$/.test(id)
) {
  const path = join(LAB, id, 'review.json');
  await assertOwnedPath(path);
  const { fixture, candidate, evidence } = await readJson<Review>(path);
  if (fixture.id !== id || fixture.root !== join(LAB, id))
    throw new Error('Generated fixture identity mismatch.');
  if (command === 'show')
    console.log(
      JSON.stringify(
        {
          candidate,
          evidenceDigest: digest(evidence),
          verdict: evidenceVerdict(evidence, candidate, await currentPolicy()),
        },
        null,
        2,
      ),
    );
  if (command === 'approve') {
    const result = await approveCandidate(
      fixture,
      candidate,
      evidence,
      'Local CLI reviewer',
      `APPLY ${commit ?? ''} ${evidenceDigest ?? ''}`,
    );
    console.log(JSON.stringify(result.verdict, null, 2));
    if (!result.verdict.ok) process.exitCode = 2;
  }
  if (command === 'apply') {
    const approval = await readJson<Approval>(
      join(fixture.root, 'approvals', `${candidate.id}.json`),
    );
    const result = await applyApproved(fixture, candidate, evidence, approval);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  }
  if (command === 'reconcile')
    console.log(JSON.stringify(await reconcile(fixture, candidate), null, 2));
} else {
  console.error('Invalid generated fixture identifier. Nothing was applied.');
  console.error(usage);
  process.exitCode = 2;
}

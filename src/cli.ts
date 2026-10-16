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
if (!command || args.length !== requiredArity[command]) {
  console.error(
    'Unsupported command or extra argument. No flags, including --dry-run, are accepted. Nothing was applied.',
  );
  process.exitCode = 2;
} else if (command === 'prepare') {
  const fixture = await createFixture('manual');
  const candidate = await prepareCandidate(fixture);
  const evidence = await verifyCandidate(fixture, candidate);
  await writeJson(join(fixture.root, 'review.json'), { fixture, candidate, evidence });
  console.log(
    (await git(fixture, ['diff', candidate.base, candidate.commit, '--', 'src/retry-policy.ts']))
      .stdout,
  );
  console.log(
    JSON.stringify(
      {
        decision: evidenceVerdict(evidence, candidate, await currentPolicy()),
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
  console.log(
    `Local confirmation (label is not authentication):\npnpm lab approve ${fixture.id} ${candidate.commit} ${digest(evidence)}`,
  );
  console.log(`Then separately apply: pnpm lab apply ${fixture.id}`);
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
  console.error(
    'Usage: pnpm lab prepare | show <fixture> | approve <fixture> <commit> <evidence-digest> | apply <fixture> | reconcile <fixture>',
  );
  process.exitCode = 2;
}

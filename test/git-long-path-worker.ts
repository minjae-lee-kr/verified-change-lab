import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createFixture,
  currentRef,
  FIXTURE_SOURCE,
  git,
  prepareCandidate,
  RELEASE_REF,
} from '../src/git.ts';
import { LAB, readTranscript } from '../src/support.ts';

let stage = 'initialize deep fixture';
try {
  const fixture = await createFixture('deep-restoration');
  assert.ok(
    fixture.repository.length < 260,
    'Keep initialization below its separate platform limit',
  );
  stage = 'prepare candidate and register its ref';
  const candidate = await prepareCandidate(fixture);
  const candidateRef = `refs/lab/candidates/${candidate.id}`;
  const candidateLock = join(fixture.repository, `${candidateRef}.lock`);
  assert.ok(candidateLock.length > 260);
  assert.equal(await currentRef(fixture), candidate.base);
  assert.equal((await git(fixture, ['rev-parse', candidateRef])).stdout.trim(), candidate.commit);
  assert.equal(
    (await git(fixture, ['rev-parse', `${candidate.commit}^{tree}`])).stdout.trim(),
    candidate.tree,
  );
  assert.equal(
    (await git(fixture, ['show', `${candidate.commit}:src/retry-policy.ts`])).stdout,
    FIXTURE_SOURCE.candidateA,
  );
  stage = 'conditional selection and stale-base refusal';
  await git(fixture, ['update-ref', RELEASE_REF, candidate.commit, candidate.base]);
  assert.equal(await currentRef(fixture), candidate.commit);
  const stale = await git(
    fixture,
    ['update-ref', RELEASE_REF, candidate.base, candidate.base],
    {},
    true,
  );
  assert.equal(stale.exitCode, 128);
  assert.equal(stale.timedOut, false);
  assert.equal(stale.directChildExitConfirmed, true);
  assert.equal(await currentRef(fixture), candidate.commit);
  stage = 'configuration isolation and non-persistence';
  const effective = await git(
    fixture,
    ['config', '--show-origin', '--get', 'core.longpaths'],
    {},
    true,
  );
  if (process.platform === 'win32') {
    assert.equal(effective.exitCode, 0);
    assert.match(effective.stdout, /command line:\s+true/);
  } else assert.equal(effective.exitCode, 1);
  for (const key of ['harness.global', 'harness.system', 'harness.environment']) {
    assert.equal((await git(fixture, ['config', '--get', key], {}, true)).exitCode, 1);
  }
  assert.equal(
    (await git(fixture, ['config', '--local', '--get', 'core.longpaths'], {}, true)).exitCode,
    1,
  );
  const config = await readFile(join(fixture.repository, 'config'), 'utf8');
  assert.doesNotMatch(config, /longpaths|harness\./i);
  const transcript = await readTranscript(fixture.root);
  const initialization = transcript.find((item) => item.event === 'git-init-synthetic-fixture');
  console.log(
    JSON.stringify({
      fixture,
      candidate,
      candidateLockLength: candidateLock.length,
      current: await currentRef(fixture),
      staleBaseExitCode: stale.exitCode,
      effectiveLongPaths: effective.stdout.trim() || null,
      localConfig: config,
      initialization,
    }),
  );
} catch (error) {
  const retained = [];
  for (const name of await readdir(LAB).catch(() => [])) {
    try {
      retained.push({ name, lastEvents: (await readTranscript(join(LAB, name))).slice(-2) });
    } catch {
      /* A failure before transcript creation is still reported below. */
    }
  }
  console.error(
    JSON.stringify({
      stage,
      message: error instanceof Error ? error.message : String(error),
      retained,
    }),
  );
  process.exitCode = 1;
}

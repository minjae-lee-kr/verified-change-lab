import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { boundedProcess } from '../src/process.ts';
import { FIXTURE_SOURCE, RELEASE_REF } from '../src/git.ts';
import { PROJECT } from '../src/support.ts';
import type { Candidate, Fixture } from '../src/types.ts';

test(
  'owned candidate refs exceed 260 characters without persistent configuration',
  { timeout: 40_000 },
  async (t) => {
    const parent = resolve(tmpdir());
    const scratch = await mkdtemp(join(parent, 'verified-change-long-path-'));
    t.after(async () => {
      assert.equal(dirname(resolve(scratch)), parent);
      assert.ok(basename(scratch).startsWith('verified-change-long-path-'));
      await rm(scratch, { recursive: true, force: true });
    });
    // Keep initialization below 260 while generated candidate ref locks exceed it.
    // Git init and child-process cwd paths have separate platform limits.
    let project = join(scratch, 'project');
    while (project.length < 135)
      project = join(project, 'p'.repeat(Math.max(1, Math.min(48, 135 - project.length - 1))));
    await mkdir(join(project, 'src'), { recursive: true });
    await mkdir(join(project, 'test'));
    await writeFile(join(project, 'package.json'), '{"type":"module"}\n');
    for (const file of ['git.ts', 'support.ts', 'process.ts', 'types.ts']) {
      await copyFile(join(PROJECT, 'src', file), join(project, 'src', file));
    }
    const worker = join(project, 'test/git-long-path-worker.ts');
    await copyFile(join(PROJECT, 'test/git-long-path-worker.ts'), worker);
    const configs = [
      {
        file: join(scratch, 'global.config'),
        text: '[core]\nlongpaths = false\n[harness]\nglobal = forbidden\n',
      },
      {
        file: join(scratch, 'system.config'),
        text: '[core]\nlongpaths = false\n[harness]\nsystem = forbidden\n',
      },
    ];
    for (const config of configs) await writeFile(config.file, config.text);
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
    );
    const child = await boundedProcess(process.execPath, [worker], {
      cwd: project,
      timeoutMs: 25_000,
      maxOutputBytes: 16_000,
      env: {
        ...clean,
        GIT_CONFIG_GLOBAL: configs[0]!.file,
        GIT_CONFIG_SYSTEM: configs[1]!.file,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'core.longpaths',
        GIT_CONFIG_VALUE_0: 'false',
        GIT_CONFIG_KEY_1: 'harness.environment',
        GIT_CONFIG_VALUE_1: 'forbidden',
        GIT_TRACE: join(scratch, 'must-not-write.trace'),
      },
    });
    assert.equal(child.timedOut, false, child.stderr);
    assert.equal(child.exitCode, 0, child.stderr);
    const result = JSON.parse(child.stdout) as {
      fixture: Fixture;
      candidate: Candidate;
      candidateLockLength: number;
      current: string;
      staleBaseExitCode: number;
      effectiveLongPaths: string | null;
    };
    assert.ok(result.fixture.repository.length < 260);
    assert.ok(result.candidateLockLength > 260);
    assert.equal(result.current, result.candidate.commit);
    assert.equal(result.staleBaseExitCode, 128);
    // A separate read does not use the copied wrapper. Opt in only for this
    // Windows command; do not persist a setting or read the injected config.
    const observed = await boundedProcess(
      'git',
      [
        ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
        '--git-dir',
        result.fixture.repository,
        'show',
        `${RELEASE_REF}:src/retry-policy.ts`,
      ],
      {
        cwd: project,
        timeoutMs: 5000,
        maxOutputBytes: 4000,
        env: {
          ...clean,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
      },
    );
    assert.equal(observed.exitCode, 0, observed.stderr);
    assert.equal(observed.stdout, FIXTURE_SOURCE.candidateA);
    for (const config of configs) assert.equal(await readFile(config.file, 'utf8'), config.text);
    await assert.rejects(readFile(join(scratch, 'must-not-write.trace')), { code: 'ENOENT' });
    t.diagnostic(
      JSON.stringify({
        platform: process.platform,
        repositoryLength: result.fixture.repository.length,
        candidateLockLength: result.candidateLockLength,
        current: result.current,
        effectiveLongPaths: result.effectiveLongPaths,
      }),
    );
  },
);

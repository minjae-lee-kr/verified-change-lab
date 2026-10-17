import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { boundedProcess } from '../src/process.ts';
import { PROJECT, sha256 } from '../src/support.ts';
import type { Fixture } from '../src/types.ts';

test(
  'ambient Git settings cannot redirect fixture mutations or provenance reads',
  { timeout: 30_000 },
  async (t) => {
    const sentinel = await mkdtemp(join(tmpdir(), 'verified-change-git-env-'));
    t.after(async () => {
      // Delete only this exact mkdtemp child, never a computed ancestor.
      assert.equal(dirname(resolve(sentinel)), resolve(tmpdir()));
      assert.ok(basename(sentinel).startsWith('verified-change-git-env-'));
      await rm(sentinel, { recursive: true, force: true });
    });
    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
    );
    Object.assign(cleanEnvironment, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    });
    const repository = join(sentinel, 'unrelated.git');
    const emptyTemplate = join(sentinel, 'empty-template');
    const ambientTemplate = join(sentinel, 'ambient-template');
    const objectDirectory = join(sentinel, 'objects');
    const worktree = join(sentinel, 'worktree');
    const index = join(sentinel, 'sentinel.index');
    for (const dir of [emptyTemplate, ambientTemplate, objectDirectory, worktree]) await mkdir(dir);
    await writeFile(join(ambientTemplate, 'AMBIENT_TEMPLATE'), 'must not be copied\n');
    await writeFile(join(worktree, 'sentinel.txt'), 'must not be staged or changed\n');
    await writeFile(index, 'must not be used as an index\n');
    const initialize = await boundedProcess(
      'git',
      ['init', '--bare', '--quiet', `--template=${emptyTemplate}`, repository],
      { cwd: sentinel, env: cleanEnvironment, timeoutMs: 5000, maxOutputBytes: 4000 },
    );
    assert.equal(initialize.exitCode, 0, initialize.stderr);
    async function snapshot(directory: string): Promise<Record<string, string>> {
      const files: Record<string, string> = {};
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          for (const [child, hash] of Object.entries(await snapshot(path)))
            files[`${entry.name}/${child}`] = hash;
        } else files[entry.name] = sha256(await readFile(path));
      }
      return files;
    }
    const before = await snapshot(sentinel);
    const variants: Array<{ name: string; env: NodeJS.ProcessEnv; approve?: boolean }> = [
      { name: 'clean control', env: {} },
      {
        name: 'common directory',
        env: { [process.platform === 'win32' ? 'Git_Common_Dir' : 'GIT_COMMON_DIR']: repository },
      },
      {
        name: 'objects, index, worktree, config, template and trace',
        env: {
          GIT_OBJECT_DIRECTORY: objectDirectory,
          GIT_INDEX_FILE: index,
          GIT_WORK_TREE: worktree,
          GIT_TEMPLATE_DIR: ambientTemplate,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'harness.ambient',
          GIT_CONFIG_VALUE_0: 'must-not-be-inherited',
          GIT_CONFIG_PARAMETERS: "'harness.parameters=must-not-be-inherited'",
          GIT_TRACE: join(sentinel, 'trace-must-not-exist.txt'),
        },
        approve: true,
      },
    ];
    for (const variant of variants) {
      const child = await boundedProcess(
        process.execPath,
        [join(PROJECT, 'test/git-environment-worker.ts'), ...(variant.approve ? ['approve'] : [])],
        {
          cwd: PROJECT,
          env: { ...cleanEnvironment, ...variant.env },
          timeoutMs: 20_000,
          maxOutputBytes: 8000,
        },
      );
      assert.equal(child.exitCode, 0, `${variant.name}: ${child.stderr}`);
      assert.equal(child.timedOut, false, variant.name);
      const result = JSON.parse(child.stdout) as {
        fixture: Fixture;
        current: string;
        candidateCommit?: string;
        approvalCode?: string;
        applyCode?: string;
        injectedConfigExitCode: number;
        injectedParametersExitCode: number;
      };
      assert.equal(result.injectedConfigExitCode, 1, variant.name);
      assert.equal(result.injectedParametersExitCode, 1, variant.name);
      assert.deepEqual(await snapshot(sentinel), before, variant.name);
      // A clean, separate Git process must read the fixture without any of the
      // ambient settings used while creating it.
      const independent = await boundedProcess(
        'git',
        ['--git-dir', result.fixture.repository, 'show-ref', '--verify', 'refs/heads/release'],
        { cwd: PROJECT, env: cleanEnvironment, timeoutMs: 5000, maxOutputBytes: 4000 },
      );
      assert.equal(independent.exitCode, 0, `${variant.name}: ${independent.stderr}`);
      assert.equal(independent.stdout.trim(), `${result.current} refs/heads/release`);
      await assert.rejects(readFile(join(result.fixture.repository, 'AMBIENT_TEMPLATE')));
      if (variant.approve) {
        assert.equal(result.approvalCode, 'APPROVED');
        assert.equal(result.applyCode, 'CAS_APPLIED');
        assert.equal(result.current, result.candidateCommit);
      } else assert.equal(result.current, result.fixture.base);
    }
    const readProvenance = async (environment: NodeJS.ProcessEnv) => {
      const child = await boundedProcess(
        process.execPath,
        [join(PROJECT, 'test/git-environment-worker.ts'), 'provenance'],
        { cwd: PROJECT, env: environment, timeoutMs: 5000, maxOutputBytes: 32_000 },
      );
      assert.equal(child.exitCode, 0, child.stderr);
      return JSON.parse(child.stdout) as {
        gitRevision: string | null;
        gitDirty: boolean | null;
        sourceFingerprint: string;
      };
    };
    const cleanProvenance = await readProvenance(cleanEnvironment);
    const taintedProvenance = await readProvenance({
      ...cleanEnvironment,
      GIT_COMMON_DIR: repository,
      GIT_TRACE: join(sentinel, 'provenance-trace-must-not-exist.txt'),
    });
    // Source archives legitimately omit .git; their absent Git provenance must
    // stay absent rather than inheriting another repository's metadata.
    assert.ok(
      cleanProvenance.gitRevision === null || /^[a-f0-9]{40}$/.test(cleanProvenance.gitRevision),
    );
    assert.ok(cleanProvenance.gitDirty === null || typeof cleanProvenance.gitDirty === 'boolean');
    assert.match(cleanProvenance.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(taintedProvenance, cleanProvenance);
    assert.deepEqual(await snapshot(sentinel), before, 'provenance leaves sentinel untouched');
  },
);

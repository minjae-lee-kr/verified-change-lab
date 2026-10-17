import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { boundedProcess, processSucceeded } from '../src/process.ts';
import { PROJECT } from '../src/support.ts';
import type { ProcessResult } from '../src/types.ts';

async function scratch(t: TestContext): Promise<string> {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'verified-change-process-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), parent);
    assert.ok(basename(root).startsWith('verified-change-process-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function run(mode: string, cwd: string): Promise<ProcessResult> {
  const worker = await boundedProcess(
    process.execPath,
    [join(PROJECT, 'test/process-errors-worker.ts'), mode, cwd],
    {
      cwd: PROJECT,
      timeoutMs: 7000,
      maxOutputBytes: 12_000,
    },
  );
  assert.equal(worker.timedOut, false, worker.stderr);
  assert.equal(worker.exitCode, 0, worker.stderr);
  return JSON.parse(worker.stdout) as ProcessResult;
}

test(
  'owned process: nonexistent cwd becomes a recorded failure',
  { timeout: 10_000 },
  async (t) => {
    const root = await scratch(t);
    const result = await run('missing', join(root, 'not-created'));
    assert.equal(result.exitCode, null);
    assert.equal(result.directChildExitConfirmed, false);
    assert.equal(result.ownedTreeTerminationAcknowledged, null);
    assert.ok(result.processError);
    assert.equal(result.stdout, '');
    assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 1024);
    t.diagnostic(JSON.stringify(result));
  },
);

test(
  'owned process: Windows deep cwd reports failure without an uncaught pipe error',
  {
    timeout: 10_000,
    skip: process.platform !== 'win32',
  },
  async (t) => {
    let directory = await scratch(t);
    while (directory.length < 266)
      directory = join(
        directory,
        'p'.repeat(Math.max(1, Math.min(40, 266 - directory.length - 1))),
      );
    await mkdir(directory, { recursive: true });
    assert.ok(directory.length >= 266);
    const result = await run('deep', directory);
    if (result.processError) {
      assert.equal(processSucceeded(result), false);
    } else {
      // A future runtime may support this cwd. Do not impose an OS limit as a contract.
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, 'child-started\n');
      assert.equal(result.directChildExitConfirmed, true);
    }
    t.diagnostic(JSON.stringify({ cwdLength: directory.length, result }));
  },
);

test(
  'owned process: pipe failure after exit zero retains the exit and failure separately',
  { timeout: 10_000 },
  async (t) => {
    const result = await run('after-exit', await scratch(t));
    assert.equal(result.exitCode, 0);
    assert.equal(result.directChildExitConfirmed, true);
    assert.equal(result.ownedTreeTerminationAcknowledged, null);
    assert.deepEqual(JSON.parse(result.stdout), { complete: true });
    assert.equal(result.processError?.source, 'stdout');
    assert.equal(result.processError?.code, 'EIO');
    t.diagnostic(JSON.stringify(result));
  },
);

test(
  'owned process: pipe failure terminates a waiting child within the bound',
  { timeout: 10_000 },
  async (t) => {
    const result = await run('while-alive', await scratch(t));
    assert.equal(processSucceeded(result), false);
    assert.equal(result.directChildExitConfirmed, true);
    assert.equal(result.ownedTreeTerminationAcknowledged, true);
    assert.equal(result.timedOut, false);
    assert.deepEqual(JSON.parse(result.stdout), { complete: true });
    assert.equal(result.processError?.source, 'stderr');
    assert.equal(result.processError?.code, 'EIO');
    t.diagnostic(JSON.stringify(result));
  },
);

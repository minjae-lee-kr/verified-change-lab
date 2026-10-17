import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { provenance } from '../../src/experiment.ts';
import { createFixture, prepareCandidate } from '../../src/git.ts';
import { boundedProcess } from '../../src/process.ts';
import { approveCandidate } from '../../src/protocol.ts';
import { verifyCandidate } from '../../src/runner.ts';
import {
  captureState,
  initializeState,
  operationReceipt,
  STATE_REF,
  type StatePlan,
} from '../../src/state-envelope.ts';
import {
  assertOwnedPath,
  digest,
  ensureLab,
  LAB,
  PROJECT,
  readJson,
  readTranscript,
  redacted,
  runId,
  sha256,
  trace,
  writeJson,
} from '../../src/support.ts';
import type { Fixture } from '../../src/types.ts';
import { publish, readEvents, record, waitMarker } from './barrier.ts';
import { checkExpiryCases } from './check.ts';
import { CASE_IDS, type ExpiryCase } from './types.ts';

const HERE = join(PROJECT, 'experiments/approval-expiry');
const shellQuote = (value: string) => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
async function recordedState(fixture: Fixture, label: string) {
  const state = await captureState(fixture);
  // This follows the exact five Git reads. The checker binds that block, not any matching old read.
  await trace(fixture.root, 'expiry-state-read', { label, oid: state.oid });
  return state;
}
async function optionalJson(path: string): Promise<unknown> {
  try {
    return await readJson(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Fixed synthetic inputs only; no caller-supplied repo, URL, hook or clock values. */
export async function runExpiryCases(cases: ExpiryCase[] = []): Promise<ExpiryCase[]> {
  for (const id of CASE_IDS) {
    const fixture = await createFixture(id === CASE_IDS[0] ? 'expiry-before' : 'expiry-after');
    const candidate = await prepareCandidate(fixture);
    const evidence = await verifyCandidate(fixture, candidate);
    const approved = await approveCandidate(
      fixture,
      candidate,
      evidence,
      'Scripted expiry experiment',
      `APPLY ${candidate.commit} ${digest(evidence)}`,
    );
    if (!approved.approval) throw new Error(`Approval setup failed: ${approved.verdict.code}`);
    const input = { fixture, candidate, evidence, approval: approved.approval };
    await initializeState(fixture);
    const initial = await recordedState(fixture, 'initial');
    const directory = join(fixture.root, 'expiry-control');
    await mkdir(directory);
    await assertOwnedPath(directory);
    const logicalFresh = approved.approval.issuedAt + 1;
    const logicalExpired = approved.approval.expiresAt + 1;
    if (logicalFresh >= approved.approval.expiresAt)
      throw new Error('Setup consumed the approval lifetime.');
    await writeJson(join(directory, 'clock.json'), { now: logicalFresh });
    await writeFile(join(directory, 'events.jsonl'), '');
    const item: ExpiryCase = {
      id,
      candidate,
      evidence,
      approval: approved.approval,
      receipt: operationReceipt(input),
      logicalFresh,
      logicalExpired,
      initial,
      prepared: null,
      whilePrepared: null,
      final: null,
      process: null,
      acknowledgement: null,
      events: [],
      transcript: [],
      executionError: null,
    };
    cases.push(item);
    const afterCheck = id === CASE_IDS[1];
    const requestPath = join(directory, 'request.json');
    await writeJson(requestPath, { input, mode: 'envelope' });
    const cancellation = new AbortController();
    let terminateWorker: (() => void) | undefined;
    let handlerFailure: unknown = null;
    const fail = (error: unknown) => {
      handlerFailure ??= error;
      cancellation.abort();
      terminateWorker?.();
    };
    let gate: Promise<void> = Promise.resolve();
    const handlers: Promise<void>[] = [];
    try {
      if (afterCheck) {
        await mkdir(join(fixture.repository, 'hooks'));
        await assertOwnedPath(join(fixture.repository, 'hooks'));
        await writeFile(
          join(fixture.repository, 'hooks/reference-transaction'),
          `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(HERE, 'hook.ts'))} ${shellQuote(directory)} "$1"\n`,
          { mode: 0o755 },
        );
        // Watch before starting the worker. Real Git will publish this marker while its ref is locked.
        gate = (async () => {
          const prepared = await waitMarker(
            join(directory, 'prepared.json'),
            AbortSignal.any([cancellation.signal, AbortSignal.timeout(15_000)]),
          );
          if (
            !item.prepared ||
            JSON.stringify(prepared) !==
              JSON.stringify({
                phase: 'prepared',
                stdin: `${item.prepared.expected.oid} ${item.prepared.next.oid} ${STATE_REF}\n`,
                logicalNow: logicalFresh,
              })
          )
            throw new Error('Prepared Git hook does not match this plan and logical clock.');
          item.whilePrepared = await recordedState(fixture, 'while-prepared');
          await record(directory, 'parent-observed-prepared-ref', { oid: item.whilePrepared.oid });
          await writeJson(join(directory, 'clock.json'), { now: logicalExpired });
          await record(directory, 'parent-advanced-clock', { now: logicalExpired });
          await publish(join(directory, 'release.json'), { continue: 'prepared' });
        })().catch(fail);
      }
      item.process = await boundedProcess(
        process.execPath,
        [
          '--require',
          join(HERE, 'clock.cjs'),
          join(PROJECT, 'src/state-envelope-worker.ts'),
          requestPath,
        ],
        {
          cwd: fixture.root,
          timeoutMs: 20_000,
          maxOutputBytes: 32_000,
          env: { ...process.env, VCL_EXPIRY_CLOCK_DIRECTORY: directory },
          ipc: {
            onMessage(message, child, terminate) {
              terminateWorker = terminate;
              const handler = (async () => {
                if (handlerFailure) {
                  terminate();
                  return;
                }
                if (
                  !message ||
                  typeof message !== 'object' ||
                  !('phase' in message) ||
                  !('detail' in message) ||
                  typeof message.phase !== 'string'
                )
                  throw new Error('Worker sent an invalid phase observation.');
                await record(directory, 'worker-phase', message);
                if (message.phase === 'state-prepared') {
                  const plan = message.detail as StatePlan;
                  if (
                    plan.code !== 'PREPARED' ||
                    item.prepared ||
                    plan.expected.oid !== initial.oid
                  )
                    throw new Error('Worker did not prepare once from the captured state.');
                  item.prepared = plan;
                  if (afterCheck)
                    await writeJson(join(directory, 'expected-transaction.json'), {
                      stdin: `${plan.expected.oid} ${plan.next.oid} ${STATE_REF}\n`,
                    });
                  else {
                    await writeJson(join(directory, 'clock.json'), { now: logicalExpired });
                    await record(directory, 'parent-advanced-clock', { now: logicalExpired });
                  }
                } else if (!['ready', 'state-selected'].includes(message.phase))
                  throw new Error('Unexpected worker phase.');
                await new Promise<void>((resolve, reject) =>
                  child.send({ continue: message.phase }, (error) =>
                    error ? reject(error) : resolve(),
                  ),
                );
              })().catch(fail);
              handlers.push(handler);
            },
          },
        },
      );
      await Promise.all(handlers);
      // A missing hook must not leave a watcher behind after an early worker failure.
      cancellation.abort();
      await gate;
      if (handlerFailure) throw handlerFailure;
      await record(directory, 'parent-observed-worker-exit', {
        exitCode: item.process.exitCode,
        directChildExitConfirmed: item.process.directChildExitConfirmed,
      });
      item.final = await recordedState(fixture, 'final');
      item.acknowledgement = await optionalJson(join(directory, 'acknowledgement.json'));
    } catch (error) {
      item.executionError = redacted(error instanceof Error ? error.message : String(error));
    } finally {
      cancellation.abort();
      await gate;
      item.events = await readEvents(directory);
      item.transcript = await readTranscript(fixture.root);
    }
  }
  return cases;
}

export async function expiryProvenance() {
  const base = await provenance();
  const additions = ['docs/approval-expiry.md', 'docs/approval-expiry.ko.md'];
  for (const entry of await readdir(HERE, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error('Experiment source must contain ordinary files only.');
    additions.push(`experiments/approval-expiry/${entry.name}`);
  }
  const files = [
    ...base.files,
    ...(await Promise.all(
      additions.map(async (path) => ({
        path,
        sha256: sha256(await readFile(join(PROJECT, path))),
      })),
    )),
  ].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return {
    ...base,
    files,
    sourceFingerprint: digest(files),
    platform: process.platform,
    arch: process.arch,
  };
}

export async function runExpiryReport() {
  await ensureLab();
  const directory = join(LAB, 'approval-expiry-runs', runId());
  const sourceBefore = await expiryProvenance();
  const startedAt = new Date().toISOString(); // Parent wall clock is never overridden.
  const cases: ExpiryCase[] = [];
  let executionError: string | null = null;
  try {
    await runExpiryCases(cases);
  } catch (error) {
    executionError = redacted(error instanceof Error ? error.message : String(error));
  }
  const sourceAfter = await expiryProvenance();
  const sourceStable = digest(sourceBefore) === digest(sourceAfter);
  const sourceAvailable =
    /^[a-f0-9]{40}$/.test(sourceAfter.gitRevision ?? '') &&
    typeof sourceAfter.gitDirty === 'boolean' &&
    sourceAfter.gitVersion !== 'unavailable';
  const checked = checkExpiryCases(cases);
  const report = {
    version: 1,
    command: 'pnpm expiry:experiment',
    startedAt,
    completedAt: new Date().toISOString(),
    sourceBefore,
    sourceAfter,
    sourceStable,
    sourceAvailable,
    clock: {
      parent: 'real wall clock',
      worker: 'controlled Date.now, explicitly preloaded only in the state worker',
      git: 'real clock; no expiry predicate',
      advance: 'approval.expiresAt + 1; no five-minute wall-clock wait',
    },
    passed: !executionError && sourceStable && sourceAvailable && checked.passed,
    executionError,
    checked,
    cases,
    limits: [
      'Synthetic local Git ref selection only, not deployment, authenticated approval or external exactly-once execution.',
      'Git reference-transaction instrumentation deliberately pauses the prepared phase. It is not a production hook or a cancellation remedy.',
      'Worker clock-read sites are identified by instrumented stack names; missing or changed call sites fail the fixed checker.',
      'Events describe one controlled local causal chain. The report is unsigned and internally checked, not independent execution attestation.',
      'Commands and outputs are bounded process captures with project paths normalized to <project>; they are not byte-identical unsanitized terminal transcripts.',
      'Two fixed placements distinguish the implemented pre-CAS freshness check from an atomic expiry condition. They do not model clock skew, power loss or arbitrary writers.',
    ],
  };
  const normalized = redacted(JSON.stringify(report, null, 2));
  if (/[A-Za-z]:[\\/]|\/(?:Users|home)\//.test(normalized))
    throw new Error(
      'Unexpected absolute path in display report; private fixture evidence retained.',
    );
  await mkdir(directory, { recursive: true });
  await assertOwnedPath(directory);
  const path = join(directory, 'report.json');
  await writeFile(path, normalized + '\n', { flag: 'wx' });
  return {
    path: relative(PROJECT, path).replaceAll('\\', '/'),
    sha256: sha256(await readFile(path)),
    report,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('This fixed experiment takes no arguments.');
    process.exitCode = 2;
  } else {
    const { path, sha256: hash, report } = await runExpiryReport();
    console.log(
      JSON.stringify(
        {
          path,
          sha256: hash,
          passed: report.passed,
          sourceStable: report.sourceStable,
          gitDirty: report.sourceAfter.gitDirty,
          checked: report.checked,
          executionError: report.executionError,
        },
        null,
        2,
      ),
    );
    if (!report.passed) process.exitCode = 1;
  }
}

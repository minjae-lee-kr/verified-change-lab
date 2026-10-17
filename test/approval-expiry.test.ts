import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkExpiryCases } from '../experiments/approval-expiry/check.ts';
import { runExpiryCases } from '../experiments/approval-expiry/run.ts';
import type { ExpiryCase } from '../experiments/approval-expiry/types.ts';
import { LAB, redacted, runId, writeJson } from '../src/support.ts';

test(
  'real worker freshness checks and a real Git prepared hook distinguish two expiry placements',
  { timeout: 90_000 },
  async () => {
    const cases = await runExpiryCases();
    const path = join(LAB, 'approval-expiry-test-runs', runId(), 'cases.json');
    await writeJson(path, JSON.parse(redacted(JSON.stringify(cases))));
    const checked = checkExpiryCases(cases);
    console.log(`Preserved controlled expiry cases: ${redacted(path)}`);
    if (!checked.passed)
      console.error(
        redacted(
          JSON.stringify(
            cases.map((item) => ({
              id: item.id,
              executionError: item.executionError,
              worker: item.process,
              events: item.events,
              failedGit: item.transcript.filter(
                (entry) =>
                  entry.event === 'git' &&
                  (entry.detail as { exitCode: number | null }).exitCode !== 0,
              ),
            })),
          ),
        ).replaceAll(process.execPath, '<node>'),
      );
    assert.equal(checked.passed, true, JSON.stringify(checked));
    assert.deepEqual(
      checked.outcomes.map((item) => item.conclusion),
      ['REFUSED_BEFORE_CAS', 'SELECTED_AFTER_LOGICAL_EXPIRY'],
    );

    const mutations: { name: string; change: (copy: ExpiryCase[]) => void }[] = [
      {
        name: 'clock never crosses the deadline',
        change: (copy) => {
          copy[1]!.logicalExpired = copy[1]!.logicalFresh;
        },
      },
      {
        name: 'final check was already expired',
        change: (copy) => {
          (copy[1]!.events[3]!.detail as { now: number }).now = copy[1]!.logicalExpired;
        },
      },
      {
        name: 'prepared hook evidence removed',
        change: (copy) => {
          const index = copy[1]!.events.findIndex(
            (entry) =>
              entry.event === 'git-hook' &&
              (entry.detail as { phase: string }).phase === 'prepared',
          );
          copy[1]!.events.splice(index, 1);
        },
      },
      {
        name: 'hook committed another ref',
        change: (copy) => {
          (
            copy[1]!.events.find(
              (entry) =>
                entry.event === 'git-hook' &&
                (entry.detail as { phase: string }).phase === 'committed',
            )!.detail as { stdin: string }
          ).stdin = '0'.repeat(40) + ' another-ref\n';
        },
      },
      {
        name: 'preparing observation from another transaction',
        change: (copy) => {
          const events = copy[1]!.events;
          const existing = events.find(
            (entry) =>
              entry.event === 'git-hook' &&
              (entry.detail as { phase: string }).phase === 'preparing',
          );
          if (existing) (existing.detail as { stdin: string }).stdin = 'another transaction';
          else
            events.splice(4, 0, {
              event: 'git-hook',
              detail: {
                phase: 'preparing',
                stdin: 'another transaction',
                logicalNow: copy[1]!.logicalFresh,
              },
            });
        },
      },
      {
        name: 'final receipt missing',
        change: (copy) => {
          copy[1]!.final!.state.receipts = [];
        },
      },
      {
        name: 'actual final ref read disagrees',
        change: (copy) => {
          const index = copy[1]!.transcript.findIndex(
            (entry) =>
              entry.event === 'expiry-state-read' &&
              (entry.detail as { label: string }).label === 'final',
          );
          (copy[1]!.transcript[index - 5]!.detail as { stdout: string }).stdout =
            copy[1]!.initial.oid + '\n';
        },
      },
      {
        name: 'held ref read replaced by earlier observation',
        change: (copy) => {
          const index = copy[1]!.transcript.findIndex(
            (entry) =>
              entry.event === 'expiry-state-read' &&
              (entry.detail as { label: string }).label === 'while-prepared',
          );
          copy[1]!.transcript[index - 5]!.event = 'unrelated-earlier-observation';
        },
      },
      {
        name: 'timeout mislabeled as expected refusal',
        change: (copy) => {
          copy[0]!.process!.timedOut = true;
        },
      },
      {
        name: 'pipe error accompanied by exit zero',
        change: (copy) => {
          copy[1]!.process!.processError = {
            source: 'stdout',
            code: 'EIO',
            message: 'Synthetic missing bytes',
          };
        },
      },
      {
        name: 'missing case',
        change: (copy) => {
          copy.pop();
        },
      },
    ];
    for (const mutation of mutations) {
      const copy = structuredClone(cases);
      mutation.change(copy);
      assert.equal(checkExpiryCases(copy).passed, false, mutation.name);
    }
  },
);

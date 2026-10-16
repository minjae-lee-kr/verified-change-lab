import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { PROJECT, sha256 } from './support.ts';
import type { Policy } from './types.ts';

/** Approval knows the required checks independently of any supplied checker report. */
export const REQUIRED_CHECKS: Policy['required'] = [
  {
    checker: 'runtime-contract',
    checks: [
      'get-server-error',
      'head-rate-limit',
      'post-not-retried',
      'client-error-not-retried',
      'out-of-range-not-retried',
    ],
  },
  { checker: 'strict-types', checks: ['strict-types'] },
];
const CONTROL_FILES = [
  'src/checker.ts',
  'src/policy.ts',
  'src/process.ts',
  'src/support.ts',
  'src/git.ts',
  'src/runner.ts',
  'src/protocol.ts',
  'src/executor.ts',
  'src/execution.ts',
  'src/cli.ts',
  'package.json',
  'pnpm-lock.yaml',
];

export async function currentPolicy(): Promise<Policy> {
  return {
    version: 1,
    required: structuredClone(REQUIRED_CHECKS),
    verifierTimeoutMs: 5000,
    maxOutputBytes: 32_000,
    evidenceTtlMs: 300_000,
    nodeVersion: process.version,
    typescriptVersion: ts.version,
    sourceHashes: await Promise.all(
      CONTROL_FILES.map(async (path) => ({
        path,
        sha256: sha256(await readFile(join(PROJECT, path))),
      })),
    ),
  };
}

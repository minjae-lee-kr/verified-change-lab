import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { assertOwnedPath, sha256, readJson } from './support.ts';
import type { Check, CheckReport, CheckRequest } from './types.ts';

// This process executes only the fixed trusted synthetic fixture. It is deliberately separate from the approval policy.
const requestPath = process.argv[2];
if (!requestPath) throw new Error('The checker requires a generated fixture request.');
await assertOwnedPath(requestPath);
const request = await readJson<CheckRequest>(requestPath);
if (request.version !== 1 || !['runtime-contract', 'strict-types'].includes(request.checker))
  throw new Error('Unsupported checker request.');
const snapshot = join(dirname(requestPath), 'candidate');
await assertOwnedPath(snapshot);
if (
  request.files.length !== 2 ||
  request.files
    .map((file) => file.path)
    .sort()
    .join('|') !== 'src/retry-policy.ts|tsconfig.json'
)
  throw new Error('Checker file inventory mismatch.');
const startedAt = Date.now();
async function matchesSource(): Promise<boolean> {
  for (const file of request.files) {
    const path = join(snapshot, file.path);
    await assertOwnedPath(path);
    if (sha256(await readFile(path)) !== file.sha256) return false;
  }
  return true;
}

let sourceConsistent = await matchesSource();
let checks: Check[] = [];
if (request.fault === 'hang') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (request.fault === 'oversized') process.stdout.write('x'.repeat(100_000));
if (request.checker === 'runtime-contract') {
  const module = await import(pathToFileURL(join(snapshot, 'src/retry-policy.ts')).href);
  const cases = [
    ['get-server-error', 'GET', 503, true],
    ['head-rate-limit', 'HEAD', 429, true],
    ['post-not-retried', 'POST', 503, false],
    ['client-error-not-retried', 'GET', 400, false],
    ['out-of-range-not-retried', 'GET', 700, false],
  ] as const;
  for (const [id, method, status, expected] of cases) {
    let actual: unknown;
    let detail: string;
    try {
      actual = module.mayRetry(method, status);
      detail = `${method} ${status}: expected ${expected}, observed ${String(actual)}`;
    } catch (error) {
      actual = undefined;
      detail = error instanceof Error ? error.message : 'Thrown value';
    }
    checks.push({ id, passed: actual === expected, detail });
  }
} else {
  // Candidate configuration cannot weaken the approval layer's strict compiler obligation.
  // This fixed source inventory and these options are trusted checker policy, hashed separately from the candidate.
  const program = ts.createProgram([join(snapshot, 'src/retry-policy.ts')], {
    strict: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    types: [],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  checks = [
    {
      id: 'strict-types',
      passed: diagnostics.length === 0,
      detail: diagnostics.length
        ? diagnostics
            .map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
            .join('\n')
            .slice(0, 4000)
        : 'TypeScript strict check completed with zero diagnostics for the declared fixture source.',
    },
  ];
}
sourceConsistent = sourceConsistent && (await matchesSource());
if (request.fault === 'empty-pass') checks = [];
if (request.fault === 'partial-pass') checks = checks.slice(0, 1);
const report: CheckReport = {
  version: 1,
  runId: request.runId,
  nonce: request.nonce,
  checker: request.checker,
  candidateCommit: request.candidate.commit,
  candidateTree: request.candidate.tree,
  policyDigest: request.policyDigest,
  startedAt,
  completedAt: Date.now(),
  sourceConsistent,
  checks,
};
process.stdout.write(JSON.stringify(report) + '\n');
process.exitCode = checks.some((check) => !check.passed) || !sourceConsistent ? 2 : 0;

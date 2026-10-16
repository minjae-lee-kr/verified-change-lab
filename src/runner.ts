import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILES, materializeCandidate } from './git.ts';
import { boundedProcess } from './process.ts';
import { currentPolicy } from './policy.ts';
import { digest, PROJECT, runId, sha256, trace, writeJson } from './support.ts';
import type { Candidate, CheckId, CheckRequest, Evidence, Fault, Fixture } from './types.ts';

export async function verifyCandidate(
  fixture: Fixture,
  candidate: Candidate,
  faults: Partial<Record<CheckId, Fault>> = {},
): Promise<Evidence> {
  const policy = await currentPolicy();
  const policyDigest = digest(policy);
  const verificationId = runId();
  const createdAt = Date.now();
  const evidence: Evidence = {
    version: 1,
    runId: verificationId,
    candidate,
    policy,
    policyDigest,
    createdAt,
    expiresAt: createdAt + policy.evidenceTtlMs,
    results: [],
  };
  for (const entry of policy.required) {
    const directory = join(fixture.root, 'verification', verificationId, entry.checker);
    const snapshot = join(directory, 'candidate');
    await mkdir(directory, { recursive: true });
    await materializeCandidate(fixture, candidate, snapshot);
    const request: CheckRequest = {
      version: 1,
      runId: verificationId,
      nonce: runId(),
      checker: entry.checker,
      candidate,
      policyDigest,
      requestedAt: Date.now(),
      fault: faults[entry.checker] ?? 'normal',
      files: await Promise.all(
        FILES.map(async (path) => ({ path, sha256: sha256(await readFile(join(snapshot, path))) })),
      ),
    };
    const requestPath = join(directory, 'request.json');
    await writeJson(requestPath, request);
    const processResult = await boundedProcess(
      process.execPath,
      [join(PROJECT, 'src/checker.ts'), requestPath],
      {
        cwd: snapshot,
        timeoutMs: policy.verifierTimeoutMs,
        maxOutputBytes: policy.maxOutputBytes,
      },
    );
    let report: unknown = null;
    try {
      report = JSON.parse(processResult.stdout);
    } catch {
      /* Invalid or absent JSON remains incomplete evidence. */
    }
    evidence.results.push({ request, process: processResult, report });
    await trace(fixture.root, 'verifier-process', {
      checker: entry.checker,
      process: processResult,
      report,
    });
  }
  await writeJson(join(fixture.root, 'evidence', `${verificationId}.json`), evidence);
  return evidence;
}

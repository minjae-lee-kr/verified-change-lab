import { join, dirname } from 'node:path';
import { applyApproved } from './protocol.ts';
import { assertOwnedPath, readJson, writeJson } from './support.ts';
import type { Approval, Candidate, Evidence, Fixture } from './types.ts';

const path = process.argv[2];
if (!path) throw new Error('A generated execution request is required.');
await assertOwnedPath(path);
const request = await readJson<{
  fixture: Fixture;
  candidate: Candidate;
  evidence: Evidence;
  approval: Approval;
  fault: 'normal' | 'kill-after-cas';
  waitForStart?: boolean;
}>(path);
await assertOwnedPath(request.fixture.root);
if (request.waitForStart) {
  process.send?.({ type: 'ready' });
  await new Promise<void>((resolve) => process.once('message', () => resolve()));
}
const verdict = await applyApproved(
  request.fixture,
  request.candidate,
  request.evidence,
  request.approval,
);
if (request.fault === 'kill-after-cas' && verdict.code === 'CAS_APPLIED') {
  process.send?.({ type: 'fault-window-after-cas' });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
await writeJson(join(dirname(path), 'acknowledgement.json'), verdict);
process.stdout.write(JSON.stringify(verdict) + '\n');
process.exitCode = verdict.ok ? 0 : 2;

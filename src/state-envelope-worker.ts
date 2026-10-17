import { join, dirname } from 'node:path';
import { applyApproved } from './protocol.ts';
import {
  operationReceipt,
  prepareStateChange,
  selectPreparedState,
  type AuthorizedChange,
} from './state-envelope.ts';
import { assertOwnedPath, readJson, redacted, within, writeJson } from './support.ts';

export type StateWorkerRequest = {
  input: AuthorizedChange;
  mode: 'separate' | 'envelope';
};

// This worker accepts only requests produced inside an owned synthetic fixture.
const requestPath = process.argv[2];
const parentLost = () => process.exit(1);
if (!requestPath || process.argv.length !== 3 || !process.send)
  throw new Error('Expected one owned request file and a parent IPC channel.');
process.once('disconnect', parentLost);
async function barrier(phase: string, detail: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.once('message', (message) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'continue' in message &&
        message.continue === phase
      )
        resolve();
      else reject(new Error('Unexpected parent barrier response.'));
    });
    process.send!({ phase, detail });
  });
}
try {
  await assertOwnedPath(requestPath);
  const request = await readJson<StateWorkerRequest>(requestPath);
  const { input } = request;
  await assertOwnedPath(input.fixture.root);
  if (!within(input.fixture.root, requestPath) || !['separate', 'envelope'].includes(request.mode))
    throw new Error('Request does not belong to this fixture.');
  await barrier('ready', { mode: request.mode });
  let acknowledgement: unknown;
  if (request.mode === 'separate') {
    const result = await applyApproved(
      input.fixture,
      input.candidate,
      input.evidence,
      input.approval,
    );
    if (!result.ok) throw new Error(`Separate selection failed: ${result.code}`);
    await barrier('selection-written', result);
    // A real normal continuation exists. The interrupted control stops before it.
    await writeJson(join(input.fixture.root, 'separate-receipt.json'), operationReceipt(input));
    acknowledgement = { code: 'SELECTION_AND_RECEIPT_WRITTEN' };
  } else {
    const plan = await prepareStateChange(input);
    if (plan.code === 'PREPARED') {
      await barrier('state-prepared', plan);
      const result = await selectPreparedState(input, plan);
      if (result.code !== 'STATE_CAS_ACKNOWLEDGED')
        throw new Error('State CAS was not acknowledged.');
      await barrier('state-selected', { stateOid: plan.next.oid, result });
      acknowledgement = { code: result.code, stateOid: plan.next.oid };
    } else acknowledgement = { code: plan.code };
  }
  await writeJson(join(dirname(requestPath), 'acknowledgement.json'), acknowledgement);
  process.removeListener('disconnect', parentLost);
  process.disconnect!();
} catch (error) {
  console.error(redacted(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
  process.removeListener('disconnect', parentLost);
  if (process.connected) process.disconnect!();
}

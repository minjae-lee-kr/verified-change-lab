import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { boundedProcess } from './process.ts';
import { assertOwnedPath, PROJECT, readJson, runId, trace, writeJson } from './support.ts';
import type { Approval, Candidate, Evidence, Fixture, ProcessResult, Verdict } from './types.ts';

export interface ExecutionInput {
  fixture: Fixture;
  candidate: Candidate;
  evidence: Evidence;
  approval: Approval;
  fault?: 'normal' | 'kill-after-cas';
}
export interface ExecutionResult {
  callerDisposition: 'ACK_RECEIVED' | 'ACK_MISSING';
  acknowledgement: Verdict | null;
  faultWindowReached: boolean;
  process: ProcessResult;
}

/** The barrier coordinates this experiment's workers; Git is the concurrency authority. */
export async function executeTogether(inputs: ExecutionInput[]): Promise<ExecutionResult[]> {
  if (inputs.length < 1 || inputs.length > 2)
    throw new Error('The fixed experiment accepts one or two owned workers.');
  const requests = await Promise.all(
    inputs.map(async (input) => {
      await assertOwnedPath(input.fixture.root);
      const directory = join(input.fixture.root, 'execution', runId());
      const requestPath = join(directory, 'request.json');
      await writeJson(requestPath, {
        ...input,
        fault: input.fault ?? 'normal',
        waitForStart: true,
      });
      return { directory, requestPath, input };
    }),
  );
  const ready = new Map<number, ChildProcess>();
  return Promise.all(
    requests.map(async ({ directory, requestPath, input }, index) => {
      let faultWindowReached = false;
      const processResult = await boundedProcess(
        process.execPath,
        [join(PROJECT, 'src/executor.ts'), requestPath],
        {
          cwd: input.fixture.root,
          timeoutMs: 12_000,
          maxOutputBytes: 64_000,
          ipc: {
            onMessage(message, child, terminate) {
              if (typeof message !== 'object' || message === null || !('type' in message)) return;
              if (message.type === 'ready') {
                ready.set(index, child);
                if (ready.size === requests.length)
                  for (const worker of ready.values()) worker.send({ type: 'start' });
              }
              if (message.type === 'fault-window-after-cas' && input.fault === 'kill-after-cas') {
                faultWindowReached = true;
                terminate();
              }
            },
          },
        },
      );
      let acknowledgement: Verdict | null = null;
      try {
        const value = await readJson<Verdict>(join(directory, 'acknowledgement.json'));
        if (
          typeof value.ok === 'boolean' &&
          typeof value.code === 'string' &&
          typeof value.reason === 'string'
        )
          acknowledgement = value;
      } catch {
        /* Absence is an unknown caller outcome, not a failed ref update. */
      }
      const result: ExecutionResult = {
        callerDisposition: acknowledgement ? 'ACK_RECEIVED' : 'ACK_MISSING',
        acknowledgement,
        faultWindowReached,
        process: processResult,
      };
      await trace(input.fixture.root, 'executor-observed-by-caller', result);
      return result;
    }),
  );
}

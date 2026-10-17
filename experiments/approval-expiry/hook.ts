import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertOwnedPath, readJson, redacted } from '../../src/support.ts';
import { publish, record, waitMarker } from './barrier.ts';

// Invoked by Git inside the owned repository, not by an HTTP endpoint.
const [directory, phase] = process.argv.slice(2);
try {
  if (
    process.argv.length !== 4 ||
    !directory ||
    !['preparing', 'prepared', 'committed', 'aborted'].includes(phase ?? '')
  )
    throw new Error('Expected an owned hook directory and one Git transaction phase.');
  await assertOwnedPath(directory);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error('Git hook input exceeds its byte budget.');
    chunks.push(Buffer.from(chunk));
  }
  const stdin = Buffer.concat(chunks).toString('utf8');
  const expected = await readJson<{ stdin: string }>(join(directory, 'expected-transaction.json'));
  if (stdin !== expected.stdin) throw new Error('Hook received another ref transaction.');
  const logicalNow = async () =>
    (JSON.parse(await readFile(join(directory, 'clock.json'), 'utf8')) as { now: number }).now;
  const detail = { phase, stdin, logicalNow: await logicalNow() };
  await record(directory, 'git-hook', detail);
  // Git 2.54+ calls this before locking refs. Only `prepared` pauses selection.
  if (phase === 'preparing') {
    // The transaction input has already been checked above.
  } else if (phase === 'prepared') {
    await publish(join(directory, 'prepared.json'), detail);
    const release = await waitMarker(join(directory, 'release.json'), AbortSignal.timeout(3500));
    if (JSON.stringify(release) !== JSON.stringify({ continue: 'prepared' }))
      throw new Error('Hook release refused.');
    await record(directory, 'git-hook-released', { logicalNow: await logicalNow() });
  } else if (phase !== 'committed') throw new Error('Git aborted the observed transaction.');
} catch (error) {
  console.error(redacted(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

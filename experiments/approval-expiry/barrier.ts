import { watch } from 'node:fs';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertOwnedPath } from '../../src/support.ts';

export type Event = { event: string; detail: unknown };
export const record = async (directory: string, event: string, detail: unknown) => {
  await appendFile(join(directory, 'events.jsonl'), JSON.stringify({ event, detail }) + '\n');
};
export async function publish(path: string, value: unknown): Promise<void> {
  await assertOwnedPath(dirname(path));
  const pending = `${path}.pending`;
  await writeFile(pending, JSON.stringify(value) + '\n', { flag: 'wx' });
  await rename(pending, path);
}

/** Observe an atomic marker, not elapsed sleep. Timeout is only a failure bound. */
export async function waitMarker(path: string, signal: AbortSignal): Promise<unknown> {
  await assertOwnedPath(dirname(path));
  return new Promise((resolve, reject) => {
    let settled = false;
    let reading = false;
    let again = false;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      watcher.close();
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () =>
      finish(new Error('Owned marker wait was aborted or exceeded its deadline.'));
    const inspect = async () => {
      if (settled) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const text = await readFile(path, 'utf8');
        if (Buffer.byteLength(text) > 4096) throw new Error('Marker exceeds its byte budget.');
        finish(undefined, JSON.parse(text));
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) finish(error);
      } finally {
        reading = false;
        if (again) {
          again = false;
          void inspect();
        }
      }
    };
    // Install the listener before the first read, closing the creation/read race.
    const watcher = watch(dirname(path), () => void inspect());
    watcher.once('error', (error) => finish(error));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else void inspect();
  });
}

export async function readEvents(directory: string): Promise<Event[]> {
  const text = await readFile(join(directory, 'events.jsonl'), 'utf8');
  if (Buffer.byteLength(text) > 128_000) throw new Error('Event journal exceeds its byte budget.');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
}

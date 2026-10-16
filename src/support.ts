import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transcript } from './types.ts';

export const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const LAB = join(PROJECT, '.lab');
export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
export const digest = (value: unknown): string => sha256(canonical(value));
export const runId = (): string => randomUUID();
export function within(root: string, target: string): boolean {
  const part = relative(resolve(root), resolve(target));
  return part === '' || (!part.startsWith('..') && !isAbsolute(part));
}
export async function ensureLab(): Promise<string> {
  await mkdir(LAB, { recursive: true });
  const actualLab = await realpath(LAB);
  const actualProject = await realpath(PROJECT);
  if (!within(actualProject, actualLab) || actualLab === actualProject)
    throw new Error('The generated fixture directory must remain inside this project.');
  return actualLab;
}
export async function assertOwnedPath(path: string): Promise<string> {
  const actual = await realpath(path);
  const actualLab = await ensureLab();
  if (!within(actualLab, actual) || actual === actualLab)
    throw new Error('Operation must stay inside this project’s generated .lab fixtures.');
  return actual;
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
export async function readJson<T>(path: string): Promise<T> {
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 2_000_000) throw new Error('Local fixture document exceeds 2 MB.');
  return JSON.parse(text) as T;
}
export function redacted(value: string): string {
  return value
    .replaceAll(JSON.stringify(PROJECT).slice(1, -1), '<project>')
    .replaceAll(PROJECT, '<project>')
    .replaceAll(PROJECT.replaceAll('\\', '/'), '<project>');
}
export async function trace(root: string, event: string, detail: unknown): Promise<void> {
  const line = JSON.stringify({ event, detail: JSON.parse(redacted(JSON.stringify(detail))) });
  await appendFile(join(root, 'transcript.jsonl'), line + '\n');
}
export async function readTranscript(root: string): Promise<Transcript> {
  const text = await readFile(join(root, 'transcript.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line, index) => ({ sequence: index + 1, ...JSON.parse(line) }));
}

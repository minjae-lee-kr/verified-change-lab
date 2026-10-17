import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedProcess } from './process.ts';
import { assertOwnedPath, ensureLab, LAB, runId, trace, within, writeJson } from './support.ts';
import type { Candidate, Fixture, ProcessResult } from './types.ts';

export const FILES = ['src/retry-policy.ts', 'tsconfig.json'] as const;
export const RELEASE_REF = 'refs/heads/release';
export const FIXTURE_SOURCE = {
  base: `export function mayRetry(method: string, status: number): boolean {\n  return status >= 500;\n}\n`,
  candidateA: `const safeMethods = new Set(['GET', 'HEAD']);\nexport function mayRetry(method: string, status: number): boolean {\n  return safeMethods.has(method) && (status === 429 || (status >= 500 && status <= 599));\n}\n`,
  candidateB: `export function mayRetry(method: string, status: number): boolean {\n  const safe = method === 'GET' || method === 'HEAD';\n  const transient = status === 429 || (status >= 500 && status < 600);\n  return safe && transient;\n}\n`,
  drift: `export function mayRetry(method: string, status: number): boolean {\n  return true; // Deliberately unsafe synthetic drift for the counterexample.\n}\n`,
};
const config = {
  compilerOptions: {
    strict: true,
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    noEmit: true,
    types: [],
  },
  files: ['src/retry-policy.ts'],
};
// Git can redirect objects, refs, configuration and trace files independently of
// --git-dir. Keep ordinary runtime variables, but rebuild Git's environment.
const isolatedGitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
});
// These overrides are supplied only by the fixed fixture builders below.
type GitEnvironment = Partial<
  Record<
    | 'GIT_INDEX_FILE'
    | 'GIT_WORK_TREE'
    | 'GIT_AUTHOR_NAME'
    | 'GIT_AUTHOR_EMAIL'
    | 'GIT_COMMITTER_NAME'
    | 'GIT_COMMITTER_EMAIL',
    string
  >
>;

export async function git(
  fixture: Fixture,
  args: string[],
  extraEnv: GitEnvironment = {},
  acceptFailure = false,
): Promise<ProcessResult> {
  await assertOwnedPath(fixture.repository);
  const result = await boundedProcess('git', ['--git-dir', fixture.repository, ...args], {
    cwd: fixture.root,
    timeoutMs: 5000,
    maxOutputBytes: 64_000,
    env: { ...isolatedGitEnvironment(), ...extraEnv },
  });
  await trace(fixture.root, 'git', result);
  if (
    !acceptFailure &&
    (result.exitCode !== 0 ||
      result.timedOut ||
      result.outputLimited ||
      !result.directChildExitConfirmed)
  )
    throw new Error(`Fixture Git command failed: ${args[0]}: ${result.stderr.trim()}`);
  return result;
}

export async function commitWorkspace(
  fixture: Fixture,
  message: string,
  parent?: string,
): Promise<{ commit: string; tree: string }> {
  await assertOwnedPath(fixture.workspace);
  const environment = {
    GIT_INDEX_FILE: join(fixture.root, `${runId()}.index`),
    GIT_WORK_TREE: fixture.workspace,
  };
  await git(fixture, ['read-tree', '--empty'], environment);
  await git(fixture, ['add', '--', ...FILES], environment);
  const tree = (await git(fixture, ['write-tree'], environment)).stdout.trim();
  const commit = (
    await git(fixture, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], {
      GIT_AUTHOR_NAME: 'Synthetic Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Synthetic Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    })
  ).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree))
    throw new Error('Unexpected Git object identity.');
  return { commit, tree };
}

export async function createFixture(label: string): Promise<Fixture> {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(label)) throw new Error('Invalid fixture label.');
  await ensureLab();
  const id = `${label}-${runId()}`;
  const root = join(LAB, id);
  const repository = join(root, 'repository.git');
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(repository);
  const fixture: Fixture = { id, root, repository, workspace, base: '' };
  await writeJson(join(root, 'owner.json'), { lab: 'verified-change-lab', id });
  const template = join(root, 'empty-template');
  await mkdir(template);
  const initialized = await boundedProcess(
    'git',
    ['init', '--bare', '--quiet', '--object-format=sha1', `--template=${template}`, repository],
    { cwd: root, timeoutMs: 5000, maxOutputBytes: 64_000, env: isolatedGitEnvironment() },
  );
  await trace(root, 'git-init-synthetic-fixture', initialized);
  if (initialized.exitCode !== 0)
    throw new Error('Could not initialize the owned synthetic fixture.');
  await writeFile(join(workspace, FILES[0]), FIXTURE_SOURCE.base);
  await writeJson(join(workspace, FILES[1]), config);
  const base = await commitWorkspace(fixture, 'Synthetic baseline');
  fixture.base = base.commit;
  await git(fixture, ['update-ref', RELEASE_REF, base.commit]);
  await git(fixture, ['symbolic-ref', 'HEAD', RELEASE_REF]);
  await writeJson(join(root, 'fixture.json'), fixture);
  return fixture;
}

export async function prepareCandidate(
  fixture: Fixture,
  variant: 'A' | 'B' = 'A',
): Promise<Candidate> {
  await assertOwnedPath(fixture.workspace);
  await writeFile(
    join(fixture.workspace, FILES[0]),
    variant === 'A' ? FIXTURE_SOURCE.candidateA : FIXTURE_SOURCE.candidateB,
  );
  const candidate = {
    id: runId(),
    base: fixture.base,
    ...(await commitWorkspace(fixture, `Synthetic candidate ${variant}`, fixture.base)),
  };
  await git(fixture, ['update-ref', `refs/lab/candidates/${candidate.id}`, candidate.commit]);
  await trace(fixture.root, 'candidate-prepared', candidate);
  return candidate;
}

export async function currentRef(fixture: Fixture): Promise<string> {
  return (await git(fixture, ['rev-parse', RELEASE_REF])).stdout.trim();
}
export async function materializeCandidate(
  fixture: Fixture,
  candidate: Candidate,
  destination: string,
): Promise<void> {
  if (
    !within(fixture.root, destination) ||
    !/^[a-f0-9]{40}$/.test(candidate.commit) ||
    !/^[a-f0-9]{40}$/.test(candidate.tree)
  )
    throw new Error('Invalid generated snapshot destination or candidate.');
  await assertOwnedPath(fixture.root);
  await mkdir(join(destination, 'src'), { recursive: true });
  await assertOwnedPath(destination);
  const tree = (await git(fixture, ['rev-parse', `${candidate.commit}^{tree}`])).stdout.trim();
  if (tree !== candidate.tree) throw new Error('Candidate tree mismatch.');
  const paths = (await git(fixture, ['ls-tree', '-r', '--name-only', candidate.commit])).stdout
    .trim()
    .split('\n')
    .sort();
  if (JSON.stringify(paths) !== JSON.stringify([...FILES].sort()))
    throw new Error('Candidate contains files outside the fixed synthetic fixture inventory.');
  for (const path of FILES)
    await writeFile(
      join(destination, path),
      (await git(fixture, ['show', `${candidate.commit}:${path}`])).stdout,
    );
}

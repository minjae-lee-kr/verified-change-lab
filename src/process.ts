import { spawn, type ChildProcess } from 'node:child_process';
import type { ProcessResult } from './types.ts';
import { redacted } from './support.ts';

/** Terminates a process tree created by this runner. Trusted fixture code only; not a sandbox. */
export async function stopOwnedTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  if (process.platform === 'win32') {
    return new Promise<boolean>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        killer.kill();
        child.kill('SIGKILL');
        resolve(false);
      }, 2000);
      killer.once('error', () => {
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve(false);
      });
      killer.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) child.kill('SIGKILL');
        resolve(code === 0);
      });
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return true;
    } catch {
      child.kill('SIGKILL');
      return false;
    }
  }
}

export async function boundedProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    env?: NodeJS.ProcessEnv;
    ipc?: { onMessage: (message: unknown, child: ChildProcess, terminate: () => void) => void };
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: options.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let settled = false;
    let killStarted = false;
    let termination: Promise<boolean> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      exitCode: number | null,
      signal: string | null,
      directChildExitConfirmed: boolean,
      ownedTreeTerminationAcknowledged: boolean | null = null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      resolve({
        executable: executable === process.execPath ? 'node' : executable,
        arguments: args.map(redacted),
        cwd: redacted(options.cwd),
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        outputLimited,
        directChildExitConfirmed,
        ownedTreeTerminationAcknowledged,
      });
    };
    const terminate = () => {
      if (killStarted || settled) return;
      killStarted = true;
      clearTimeout(timer);
      termination = stopOwnedTree(child);
      cleanupTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(child.exitCode, child.signalCode, false, false);
      }, 3500);
    };
    const receive = (buffer: Buffer, stream: 'stdout' | 'stderr') => {
      const remaining = Math.max(0, options.maxOutputBytes - bytes);
      bytes += buffer.length;
      const text = buffer.subarray(0, remaining).toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (bytes > options.maxOutputBytes && !outputLimited) {
        outputLimited = true;
        terminate();
      }
    };
    child.stdout!.on('data', (buffer) => receive(buffer, 'stdout'));
    child.stderr!.on('data', (buffer) => receive(buffer, 'stderr'));
    child.on('message', (message) => options.ipc?.onMessage(message, child, terminate));
    child.once('error', (error) => {
      stderr += error.message;
      finish(null, null, true);
    });
    child.once('close', async (code, signal) =>
      finish(code, signal, true, termination ? await termination : null),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
  });
}

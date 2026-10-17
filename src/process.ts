import { spawn, type ChildProcess } from 'node:child_process';
import type { ProcessResult } from './types.ts';
import { redacted } from './support.ts';

/** Terminates a process tree created by this runner. Trusted fixture code only; not a sandbox. */
export async function stopOwnedTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
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

export const processSucceeded = (result: ProcessResult): boolean =>
  result.exitCode === 0 &&
  result.signal === null &&
  !result.timedOut &&
  !result.outputLimited &&
  result.directChildExitConfirmed &&
  result.processError === undefined;

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
    let exitObserved = false;
    let processError: ProcessResult['processError'];
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
        ...(processError ? { processError } : {}),
      });
    };
    const terminate = () => {
      if (killStarted || settled) return;
      killStarted = true;
      clearTimeout(timer);
      if (!child.pid) {
        finish(null, null, false);
        return;
      }
      if (child.exitCode === null && child.signalCode === null) termination = stopOwnedTree(child);
      cleanupTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        finish(child.exitCode, child.signalCode, exitObserved, termination ? false : null);
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
    const recordError = (source: 'child' | 'stdout' | 'stderr', error: Error) => {
      // Pipe errors are separate from the child's actual exit code. Keep the
      // listener after settlement so a late stream error cannot crash the caller.
      if (settled) return;
      const message = redacted(error.message).slice(0, 1024);
      processError ??= {
        source,
        code: 'code' in error && typeof error.code === 'string' ? error.code.slice(0, 80) : null,
        message,
      };
      receive(Buffer.from(`[${source}] ${message}\n`), 'stderr');
      if (child.pid) terminate();
    };
    child.stdout?.on('data', (buffer) => receive(buffer, 'stdout'));
    child.stderr?.on('data', (buffer) => receive(buffer, 'stderr'));
    child.stdout?.on('error', (error) => recordError('stdout', error));
    child.stderr?.on('error', (error) => recordError('stderr', error));
    child.on('message', (message) => options.ipc?.onMessage(message, child, terminate));
    child.on('error', (error) => recordError('child', error));
    child.once('exit', () => {
      exitObserved = true;
    });
    child.once('close', async (code, signal) =>
      finish(child.pid ? code : null, signal, exitObserved, termination ? await termination : null),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
  });
}

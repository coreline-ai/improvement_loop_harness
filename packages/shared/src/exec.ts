import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export type RunCommandStatus = 'pass' | 'fail' | 'error';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
  stdoutFile?: string | undefined;
  stderrFile?: string | undefined;
}

export interface RunCommandResult {
  command: string;
  status: RunCommandStatus;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutFile?: string | undefined;
  stderrFile?: string | undefined;
}

const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface BoundedOutputBuffer {
  chunks: string[];
  bytes: number;
  truncated: boolean;
}

function formatBufferLimit(bytes: number): string {
  if (bytes > 0 && bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)}MB`;
  }
  return `${bytes}B`;
}

function truncationMarker(maxBufferBytes: number): string {
  return `\n…[output truncated at ${formatBufferLimit(maxBufferBytes)}]`;
}

function createBoundedOutputBuffer(): BoundedOutputBuffer {
  return { chunks: [], bytes: 0, truncated: false };
}

function appendBoundedOutput(
  target: BoundedOutputBuffer,
  chunk: Buffer | string,
  maxBufferBytes: number
): void {
  if (target.truncated) {
    return;
  }

  const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, maxBufferBytes - target.bytes);
  if (raw.length <= remaining) {
    target.chunks.push(raw.toString());
    target.bytes += raw.length;
    return;
  }

  if (remaining > 0) {
    target.chunks.push(raw.subarray(0, remaining).toString());
  }
  target.chunks.push(truncationMarker(maxBufferBytes));
  target.bytes = maxBufferBytes;
  target.truncated = true;
}

function readBoundedOutput(target: BoundedOutputBuffer): string {
  return target.chunks.join('');
}

async function writeOutput(file: string | undefined, content: string): Promise<void> {
  if (!file) {
    return;
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function stripFinalNewline(content: string): string {
  return content.replace(/\r?\n$/, '');
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid) {
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already exited.
    }
  }
}

function forceKillProcessGroup(pid: number | undefined): void {
  if (!pid) {
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited.
    }
  }
}

export async function runCommand(command: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
  const startedAt = Date.now();
  let timedOut = false;
  const stdout = createBoundedOutputBuffer();
  const stderr = createBoundedOutputBuffer();
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  return new Promise<RunCommandResult>((resolve) => {
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let safetyResolveTimer: NodeJS.Timeout | undefined;

    const subprocess = spawn(command, {
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env
    });

    subprocess.stdout?.on('data', (chunk: Buffer | string) => {
      appendBoundedOutput(stdout, chunk, maxBufferBytes);
    });
    subprocess.stderr?.on('data', (chunk: Buffer | string) => {
      appendBoundedOutput(stderr, chunk, maxBufferBytes);
    });

    const finish = (exitCode: number | null, forceStatus?: RunCommandStatus) => {
      if (settled) {
        return;
      }
      settled = true;

      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (safetyResolveTimer) {
        clearTimeout(safetyResolveTimer);
      }

      const status =
        forceStatus ?? (timedOut ? 'error' : exitCode === 0 ? 'pass' : 'fail');
      const finalStdout = stripFinalNewline(readBoundedOutput(stdout));
      const finalStderr = stripFinalNewline(readBoundedOutput(stderr));
      void Promise.all([
        writeOutput(options.stdoutFile, finalStdout),
        writeOutput(options.stderrFile, finalStderr)
      ]).finally(() => {
        resolve({
          command,
          status,
          exitCode,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout: finalStdout,
          stderr: finalStderr,
          stdoutFile: options.stdoutFile,
          stderrFile: options.stderrFile
        });
      });
    };

    subprocess.on('error', (error) => {
      appendBoundedOutput(stderr, error.message, maxBufferBytes);
      finish(null, 'error');
    });

    subprocess.on('close', (code) => {
      finish(typeof code === 'number' ? code : null);
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(subprocess.pid);
        forceKillTimer = setTimeout(
          () => forceKillProcessGroup(subprocess.pid),
          250
        );
        forceKillTimer.unref();
        // If even SIGKILL cannot complete cleanly, resolve after a short safety window.
        // This favors anti-hang behavior for the harness; an extreme OS/runtime failure
        // could still leave a child process behind and must be handled by the host.
        safetyResolveTimer = setTimeout(() => {
          subprocess.stdout?.destroy();
          subprocess.stderr?.destroy();
          subprocess.unref();
          finish(null, 'error');
        }, 5_000);
        safetyResolveTimer.unref();
      }, options.timeoutMs);
      timeoutTimer.unref();
    }
  });
}

import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export type RunCommandStatus = 'pass' | 'fail' | 'error';

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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
  let stdout = '';
  let stderr = '';

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
      stdout += chunk.toString();
    });
    subprocess.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
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
      const finalStdout = stripFinalNewline(stdout);
      const finalStderr = stripFinalNewline(stderr);
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
      stderr += error.message;
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
        safetyResolveTimer = setTimeout(() => finish(null, 'error'), 5_000);
        safetyResolveTimer.unref();
      }, options.timeoutMs);
      timeoutTimer.unref();
    }
  });
}

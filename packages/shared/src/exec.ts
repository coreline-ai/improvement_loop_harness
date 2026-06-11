import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execaCommand } from 'execa';

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
  let forceKillTimer: NodeJS.Timeout | undefined;

  const commandOptions = {
    shell: true,
    reject: false,
    detached: true,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {})
  };

  const subprocess = execaCommand(command, commandOptions);

  const timeoutTimer =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(subprocess.pid);
          forceKillTimer = setTimeout(() => forceKillProcessGroup(subprocess.pid), 250);
        }, options.timeoutMs)
      : undefined;

  try {
    const result = await subprocess;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    await Promise.all([writeOutput(options.stdoutFile, stdout), writeOutput(options.stderrFile, stderr)]);

    return {
      command,
      status: timedOut ? 'error' : result.exitCode === 0 ? 'pass' : 'fail',
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      timedOut,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr,
      stdoutFile: options.stdoutFile,
      stderrFile: options.stderrFile
    };
  } catch (error) {
    const execaError = error as { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean };
    const stdout = execaError.stdout ?? '';
    const stderr = execaError.stderr ?? '';
    timedOut = timedOut || execaError.timedOut === true;
    await Promise.all([writeOutput(options.stdoutFile, stdout), writeOutput(options.stderrFile, stderr)]);

    return {
      command,
      status: 'error',
      exitCode: typeof execaError.exitCode === 'number' ? execaError.exitCode : null,
      timedOut,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr,
      stdoutFile: options.stdoutFile,
      stderrFile: options.stderrFile
    };
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
  }
}

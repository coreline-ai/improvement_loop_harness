import { spawn } from 'node:child_process';
import { GitCommandError } from './errors.js';

export interface SafeGitOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface SafeGitResult {
  command: 'git';
  args: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export const GIT_DEFENSE_ARGS = [
  '--no-pager',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor='
] as const;

export function buildSafeGitArgs(args: readonly string[]): string[] {
  return [...GIT_DEFENSE_ARGS, ...args];
}

export function buildSafeGitEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true'
  };
}

export interface WorktreeStatus {
  /** True when there are tracked modifications and/or untracked files. */
  dirty: boolean;
  /** Raw `git status --porcelain` lines (trimmed, empty lines dropped). */
  entries: string[];
}

/**
 * Working-tree cleanliness of a repo via `git status --porcelain`. Captures both
 * tracked modifications and untracked files; empty output means clean. Used by
 * the improvement loop's dirty-source guard so a run does not silently fix only
 * the committed state while the user has uncommitted work.
 */
export async function worktreeStatus(
  repoPath: string,
  options: SafeGitOptions = {}
): Promise<WorktreeStatus> {
  const result = await safeGit(repoPath, ['status', '--porcelain'], options);
  const entries = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { dirty: entries.length > 0, entries };
}

export async function safeGit(
  cwd: string,
  args: readonly string[],
  options: SafeGitOptions = {}
): Promise<SafeGitResult> {
  const startedAt = Date.now();
  const safeArgs = buildSafeGitArgs(args);

  return new Promise<SafeGitResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let safetyResolveTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (safetyResolveTimer) clearTimeout(safetyResolveTimer);
    };

    const subprocess = spawn('git', safeArgs, {
      cwd,
      env: buildSafeGitEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        subprocess.kill('SIGTERM');
        forceKillTimer = setTimeout(() => subprocess.kill('SIGKILL'), 250);
        forceKillTimer.unref();
        safetyResolveTimer = setTimeout(() => {
          subprocess.stdout?.destroy();
          subprocess.stderr?.destroy();
          subprocess.unref();
          if (settled) return;
          settled = true;
          reject(new Error(`git command timed out: git ${safeArgs.join(' ')}`));
        }, 5_000);
        safetyResolveTimer.unref();
      }, options.timeoutMs);
      timeout.unref();
    }

    subprocess.stdout.setEncoding('utf8');
    subprocess.stderr.setEncoding('utf8');
    subprocess.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    subprocess.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    subprocess.on('error', (error) => {
      clearTimers();
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    subprocess.on('close', (exitCode) => {
      clearTimers();
      if (settled) {
        return;
      }
      settled = true;

      const result: SafeGitResult = {
        command: 'git',
        args: safeArgs,
        cwd,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr
      };

      if (exitCode === 0) {
        resolve(result);
        return;
      }

      reject(
        new GitCommandError(
          `git command failed (${exitCode ?? 'signal'}): git ${safeArgs.join(' ')}`,
          {
            args: safeArgs,
            cwd,
            exitCode,
            stdout,
            stderr
          }
        )
      );
    });
  });
}

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

    const subprocess = spawn('git', safeArgs, {
      cwd,
      env: buildSafeGitEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            subprocess.kill('SIGTERM');
            setTimeout(() => subprocess.kill('SIGKILL'), 250).unref();
          }, options.timeoutMs)
        : undefined;

    subprocess.stdout.setEncoding('utf8');
    subprocess.stderr.setEncoding('utf8');
    subprocess.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    subprocess.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    subprocess.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    subprocess.on('close', (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
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

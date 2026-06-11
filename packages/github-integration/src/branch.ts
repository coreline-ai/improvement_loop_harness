import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeGit } from '@vibeloop/workspace-runner';

export interface PrepareBranchOptions {
  repoPath: string;
  baseRef: string;
  branchName: string;
  candidatePatchPath: string;
  commitMessage: string;
  pushUrl: string;
  token?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface PreparedBranch {
  branchName: string;
  headSha: string;
}

export function sanitizeBranchSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[/.-]+|[/.-]+$/g, '')
    .slice(0, 80) || 'loop';
}

export function defaultBranchName(loopId: string): string {
  return `vibeloop/${sanitizeBranchSegment(loopId)}`;
}


async function remoteBranchSha(
  repoPath: string,
  pushUrl: string,
  branchName: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<string | null> {
  const result = await safeGit(repoPath, ['ls-remote', pushUrl, `refs/heads/${branchName}`], { env, timeoutMs });
  const firstLine = result.stdout.trim().split(/\n/)[0] ?? '';
  const [sha] = firstLine.split(/\s+/);
  return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

async function writeAskPassScript(): Promise<{ scriptPath: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-git-askpass-'));
  const scriptPath = path.join(directory, 'askpass.sh');
  await writeFile(
    scriptPath,
    '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s" "${GIT_USERNAME:-x-access-token}" ;;\n  *) printf "%s" "$GIT_PASSWORD" ;;\nesac\n'
  );
  await chmod(scriptPath, 0o700);
  return { scriptPath, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export async function prepareBranchAndPush(options: PrepareBranchOptions): Promise<PreparedBranch> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const tokenHelper = options.token ? await writeAskPassScript() : null;
  const env = tokenHelper
    ? {
        ...process.env,
        GIT_ASKPASS: tokenHelper.scriptPath,
        GIT_USERNAME: 'x-access-token',
        GIT_PASSWORD: options.token,
        GIT_TERMINAL_PROMPT: '0'
      }
    : process.env;

  try {
    await safeGit(options.repoPath, ['fetch', 'origin', options.baseRef], { env, timeoutMs });
    await safeGit(options.repoPath, ['checkout', '-B', options.branchName, 'FETCH_HEAD'], { env, timeoutMs });
    await safeGit(options.repoPath, ['apply', '--index', options.candidatePatchPath], { env, timeoutMs });
    await safeGit(options.repoPath, ['commit', '-m', options.commitMessage], { env, timeoutMs });
    const existingRemoteSha = await remoteBranchSha(options.repoPath, options.pushUrl, options.branchName, env, timeoutMs);
    const pushArgs = existingRemoteSha
      ? ['push', `--force-with-lease=refs/heads/${options.branchName}:${existingRemoteSha}`, options.pushUrl, `HEAD:refs/heads/${options.branchName}`]
      : ['push', options.pushUrl, `HEAD:refs/heads/${options.branchName}`];
    await safeGit(options.repoPath, pushArgs, { env, timeoutMs });
    const headSha = (await safeGit(options.repoPath, ['rev-parse', 'HEAD'], { env, timeoutMs })).stdout.trim();
    return { branchName: options.branchName, headSha };
  } finally {
    await tokenHelper?.cleanup();
  }
}

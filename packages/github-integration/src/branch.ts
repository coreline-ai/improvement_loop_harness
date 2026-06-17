import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeGit } from '@vibeloop/workspace-runner';

export interface PrepareBranchOptions {
  repoPath: string;
  baseRef: string;
  branchName: string;
  candidatePatchPath: string;
  expectedPatchHash?: string | undefined;
  commitMessage: string;
  pushUrl: string;
  token?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface PreparedBranch {
  branchName: string;
  headSha: string;
  remotePreexisting: boolean;
}

export function sanitizeBranchSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._/-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[/.-]+|[/.-]+$/g, '')
      .slice(0, 80) || 'loop'
  );
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
  const result = await safeGit(
    repoPath,
    ['ls-remote', pushUrl, `refs/heads/${branchName}`],
    { env, timeoutMs }
  );
  const firstLine = result.stdout.trim().split(/\n/)[0] ?? '';
  const [sha] = firstLine.split(/\s+/);
  return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

async function writeAskPassScript(): Promise<{
  scriptPath: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-git-askpass-')
  );
  const scriptPath = path.join(directory, 'askpass.sh');
  await writeFile(
    scriptPath,
    '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s" "${GIT_USERNAME:-x-access-token}" ;;\n  *) printf "%s" "$GIT_PASSWORD" ;;\nesac\n'
  );
  await chmod(scriptPath, 0o700);
  return {
    scriptPath,
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

async function assertPatchHash(
  patchPath: string,
  expectedPatchHash: string | undefined
): Promise<void> {
  if (!expectedPatchHash) return;
  const actual = createHash('sha256')
    .update(await readFile(patchPath))
    .digest('hex');
  if (actual !== expectedPatchHash) {
    throw new Error(
      `candidate patch hash mismatch before GitHub promotion: expected ${expectedPatchHash}, got ${actual}`
    );
  }
}

export async function prepareBranchAndPush(
  options: PrepareBranchOptions
): Promise<PreparedBranch> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const tokenHelper = options.token ? await writeAskPassScript() : null;
  const worktreePath = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-pr-worktree-')
  );
  let worktreeAdded = false;
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
    await safeGit(
      options.repoPath,
      ['fetch', options.pushUrl, options.baseRef],
      { env, timeoutMs }
    );
    await safeGit(
      options.repoPath,
      ['worktree', 'add', '--detach', worktreePath, 'FETCH_HEAD'],
      { env, timeoutMs }
    );
    worktreeAdded = true;
    await safeGit(
      worktreePath,
      ['checkout', '-B', options.branchName],
      { env, timeoutMs }
    );
    await assertPatchHash(
      options.candidatePatchPath,
      options.expectedPatchHash
    );
    await safeGit(
      worktreePath,
      ['apply', '--index', options.candidatePatchPath],
      { env, timeoutMs }
    );
    await safeGit(worktreePath, ['commit', '-m', options.commitMessage], {
      env,
      timeoutMs
    });
    const existingRemoteSha = await remoteBranchSha(
      options.repoPath,
      options.pushUrl,
      options.branchName,
      env,
      timeoutMs
    );
    const pushArgs = existingRemoteSha
      ? [
          'push',
          `--force-with-lease=refs/heads/${options.branchName}:${existingRemoteSha}`,
          options.pushUrl,
          `HEAD:refs/heads/${options.branchName}`
        ]
      : ['push', options.pushUrl, `HEAD:refs/heads/${options.branchName}`];
    await safeGit(worktreePath, pushArgs, { env, timeoutMs });
    const headSha = (
      await safeGit(worktreePath, ['rev-parse', 'HEAD'], { env, timeoutMs })
    ).stdout.trim();
    return {
      branchName: options.branchName,
      headSha,
      remotePreexisting: Boolean(existingRemoteSha)
    };
  } finally {
    if (worktreeAdded) {
      await safeGit(
        options.repoPath,
        ['worktree', 'remove', '--force', worktreePath],
        { env, timeoutMs }
      ).catch(() => undefined);
    } else {
      await rm(worktreePath, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
    await tokenHelper?.cleanup();
  }
}

export async function deleteRemoteBranch(options: {
  repoPath: string;
  pushUrl: string;
  branchName: string;
  token?: string | undefined;
  timeoutMs?: number | undefined;
}): Promise<void> {
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
    await safeGit(
      options.repoPath,
      ['push', options.pushUrl, `:refs/heads/${options.branchName}`],
      { env, timeoutMs }
    );
  } finally {
    await tokenHelper?.cleanup();
  }
}

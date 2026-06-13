import { createHash } from 'node:crypto';
import { mkdir, open, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { LockTimeoutError, WorktreeError } from './errors.js';
import { safeGit } from './git.js';

export interface WorktreeOptions {
  repoPath: string;
  dataDir: string;
  projectId: string;
  loopId: string;
  baseCommit: string;
}

export interface WorktreeRef {
  repoPath: string;
  path: string;
  projectId: string;
  loopId: string;
  baseCommit: string;
  lockPath: string;
}

export interface RepoLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function resolveWorktreesRoot(
  dataDir: string,
  projectId: string
): string {
  return path.resolve(dataDir, 'projects', projectId, 'worktrees');
}

export function resolveWorktreePath(
  dataDir: string,
  projectId: string,
  loopId: string
): string {
  return path.join(resolveWorktreesRoot(dataDir, projectId), loopId);
}

export function resolveRepoLockPath(
  dataDir: string,
  projectId: string,
  repoPath: string
): string {
  const digest = createHash('sha256')
    .update(path.resolve(repoPath))
    .digest('hex')
    .slice(0, 16);
  return path.resolve(
    dataDir,
    'projects',
    projectId,
    'locks',
    `repo-${digest}.lock`
  );
}

async function acquireRepoLock(
  lockPath: string,
  options: RepoLockOptions = {}
): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 25;
  const startedAt = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          acquired_at: new Date().toISOString()
        })
      );
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new LockTimeoutError(lockPath);
      }
      await sleep(pollMs);
    }
  }
}

export async function withRepoLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: RepoLockOptions = {}
): Promise<T> {
  const release = await acquireRepoLock(lockPath, options);
  try {
    return await action();
  } finally {
    await release();
  }
}

async function assertWorktreeOutsideRepo(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  const realRepo = await realpath(repoPath);
  const resolvedWorktree = path.resolve(worktreePath);
  if (isPathInside(realRepo, resolvedWorktree)) {
    throw new WorktreeError(
      `worktree must be outside target repo: ${resolvedWorktree}`
    );
  }
}

export async function createWorktree(
  options: WorktreeOptions
): Promise<WorktreeRef> {
  const repoPath = await realpath(options.repoPath);
  const worktreePath = resolveWorktreePath(
    options.dataDir,
    options.projectId,
    options.loopId
  );
  const lockPath = resolveRepoLockPath(
    options.dataDir,
    options.projectId,
    repoPath
  );

  await assertWorktreeOutsideRepo(repoPath, worktreePath);

  await withRepoLock(lockPath, async () => {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await safeGit(repoPath, [
      'worktree',
      'add',
      '--detach',
      worktreePath,
      options.baseCommit
    ]);
  });

  return {
    repoPath,
    path: worktreePath,
    projectId: options.projectId,
    loopId: options.loopId,
    baseCommit: options.baseCommit,
    lockPath
  };
}

export async function removeWorktree(
  ref: Pick<WorktreeRef, 'repoPath' | 'path' | 'lockPath'>
): Promise<void> {
  await withRepoLock(ref.lockPath, async () => {
    await safeGit(ref.repoPath, ['worktree', 'remove', '--force', ref.path], {
      timeoutMs: 10_000
    }).catch(async () => {
      await rm(ref.path, { recursive: true, force: true });
      // The rm fallback leaves the .git/worktrees/<id> admin entry stale. Prune it
      // directly here — we already hold the repo lock, so do NOT call pruneWorktrees()
      // (it would re-acquire the same non-reentrant lock and time out). Pruning is
      // best-effort cleanup hygiene and must never fail the removal.
      await safeGit(ref.repoPath, ['worktree', 'prune'], {
        timeoutMs: 10_000
      }).catch(() => undefined);
    });
  });
}

export async function pruneWorktrees(
  repoPath: string,
  lockPath: string
): Promise<void> {
  await withRepoLock(lockPath, async () => {
    await safeGit(repoPath, ['worktree', 'prune']);
  });
}

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { safeGit } from './git.js';

export interface GitMetadataSnapshotEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface GitMetadataSnapshot {
  gitCommonDir: string;
  gitDir: string;
  entries: GitMetadataSnapshotEntry[];
}

export interface GitMetadataSnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveGitPath(repoPath: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(repoPath, gitPath);
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function walkFiles(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat) {
    return [];
  }
  if (rootStat.isFile()) {
    return [root];
  }
  if (!rootStat.isDirectory()) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(absolutePath);
      }
      if (entry.isFile()) {
        return Promise.resolve([absolutePath]);
      }
      return Promise.resolve([]);
    })
  );
  return nested.flat();
}

async function snapshotTarget(
  label: string,
  targetPath: string,
  includeRelativePath: (relativePath: string) => boolean = () => true
): Promise<GitMetadataSnapshotEntry[]> {
  if (!(await exists(targetPath))) {
    return [];
  }
  const files = await walkFiles(targetPath);
  const entries = await Promise.all(
    files.map(async (filePath) => {
      const fileStat = await stat(filePath);
      const nestedRelativePath =
        filePath === targetPath
          ? ''
          : path.relative(targetPath, filePath).split(path.sep).join('/');
      const relativePath =
        nestedRelativePath.length === 0
          ? label
          : `${label}/${nestedRelativePath}`;
      if (
        !includeRelativePath(nestedRelativePath || path.basename(targetPath))
      ) {
        return undefined;
      }
      return {
        path: relativePath,
        sha256: await sha256(filePath),
        sizeBytes: fileStat.size
      };
    })
  );
  return entries.filter(
    (entry): entry is GitMetadataSnapshotEntry => entry !== undefined
  );
}

export async function snapshotGitMetadata(
  repoPath: string
): Promise<GitMetadataSnapshot> {
  const commonDirOutput = (
    await safeGit(repoPath, ['rev-parse', '--git-common-dir'])
  ).stdout.trim();
  const gitDirOutput = (
    await safeGit(repoPath, ['rev-parse', '--git-dir'])
  ).stdout.trim();
  const gitCommonDir = resolveGitPath(repoPath, commonDirOutput);
  const gitDir = resolveGitPath(repoPath, gitDirOutput);

  const stableWorktreeMetadata = new Set([
    'gitdir',
    'commondir',
    'config.worktree'
  ]);
  const targets: Array<{
    label: string;
    path: string;
    includeRelativePath?: (relativePath: string) => boolean;
  }> = [
    { label: 'config', path: path.join(gitCommonDir, 'config') },
    { label: 'hooks', path: path.join(gitCommonDir, 'hooks') }
  ];

  if (path.dirname(gitDir) === path.join(gitCommonDir, 'worktrees')) {
    targets.push({
      label: `worktrees/${path.basename(gitDir)}`,
      path: gitDir,
      includeRelativePath: (relativePath: string) =>
        stableWorktreeMetadata.has(relativePath)
    });
  }

  const entries = (
    await Promise.all(
      targets.map((target) =>
        snapshotTarget(target.label, target.path, target.includeRelativePath)
      )
    )
  )
    .flat()
    .sort((a, b) => a.path.localeCompare(b.path));

  return { gitCommonDir, gitDir, entries };
}

export function diffGitMetadataSnapshots(
  before: GitMetadataSnapshot,
  after: GitMetadataSnapshot
): GitMetadataSnapshotDiff {
  const beforeMap = new Map(
    before.entries.map((entry) => [entry.path, entry.sha256])
  );
  const afterMap = new Map(
    after.entries.map((entry) => [entry.path, entry.sha256])
  );

  const added = [...afterMap.keys()]
    .filter((entryPath) => !beforeMap.has(entryPath))
    .sort();
  const removed = [...beforeMap.keys()]
    .filter((entryPath) => !afterMap.has(entryPath))
    .sort();
  const changed = [...afterMap.entries()]
    .filter(
      ([entryPath, digest]) =>
        beforeMap.has(entryPath) && beforeMap.get(entryPath) !== digest
    )
    .map(([entryPath]) => entryPath)
    .sort();

  return { added, removed, changed };
}

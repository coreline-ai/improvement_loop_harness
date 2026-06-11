import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildSafeGitArgs,
  buildSafeGitEnv,
  safeGit
} from '@vibeloop/workspace-runner';
import type { GuardChangedFile, GuardChangedFileStatus } from './types.js';

export interface ExtractDiffOptions {
  repoPath: string;
  baseCommit: string;
  artifactRoot?: string | undefined;
}

export interface ChangedFilesArtifact {
  base_commit: string;
  files: Array<{
    path: string;
    status: GuardChangedFileStatus;
    old_path?: string | undefined;
    is_symlink: boolean;
    added_lines: number;
    deleted_lines: number;
    allowed_by_write_scope?: boolean | undefined;
    protected?: boolean | undefined;
  }>;
  untracked_files: string[];
  renames: Array<{ old_path: string; path: string }>;
  symlinks: string[];
}

export interface ExtractDiffResult {
  changedFiles: GuardChangedFile[];
  candidatePatch: string;
  changedFilesJson: ChangedFilesArtifact;
}

export interface ApplyPatchOptions {
  includeOnly?: string[] | undefined;
}

function parseNullSeparated(output: string): string[] {
  return output.split('\0').filter((token) => token.length > 0);
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function statusFromNameStatus(status: string): GuardChangedFileStatus {
  const code = status[0];
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'M':
    case 'T':
    default:
      return 'modified';
  }
}

function parseNameStatus(output: string): GuardChangedFile[] {
  const tokens = parseNullSeparated(output);
  const files: GuardChangedFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index] ?? '';
    const kind = statusFromNameStatus(status);
    if (kind === 'renamed' || kind === 'copied') {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (!oldPath || !newPath) {
        break;
      }
      files.push({
        path: normalizePath(newPath),
        oldPath: normalizePath(oldPath),
        status: kind,
        isSymlink: false,
        addedLines: 0,
        deletedLines: 0
      });
      index += 2;
      continue;
    }

    const filePath = tokens[index + 1];
    if (!filePath) {
      break;
    }
    files.push({
      path: normalizePath(filePath),
      status: kind,
      isSymlink: false,
      addedLines: 0,
      deletedLines: 0
    });
    index += 1;
  }
  return files;
}

function parsePorcelainV2Untracked(output: string): GuardChangedFile[] {
  return parseNullSeparated(output)
    .filter((entry) => entry.startsWith('? '))
    .map((entry) => ({
      path: normalizePath(entry.slice(2)),
      status: 'untracked' as const,
      isSymlink: false,
      addedLines: 0,
      deletedLines: 0
    }));
}

function parseNumstat(
  output: string
): Map<string, { addedLines: number; deletedLines: number }> {
  const stats = new Map<string, { addedLines: number; deletedLines: number }>();
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [added, deleted, filePath] = line.split('\t');
    if (!added || !deleted || !filePath) {
      continue;
    }
    const addedLines = Number.parseInt(added, 10);
    const deletedLines = Number.parseInt(deleted, 10);
    stats.set(normalizePath(filePath), {
      addedLines: Number.isFinite(addedLines) ? addedLines : 0,
      deletedLines: Number.isFinite(deletedLines) ? deletedLines : 0
    });
  }
  return stats;
}

function mergeChangedFiles(
  primary: GuardChangedFile[],
  untracked: GuardChangedFile[]
): GuardChangedFile[] {
  const byPath = new Map(primary.map((file) => [file.path, file]));
  for (const file of untracked) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function isSymlink(
  repoPath: string,
  file: GuardChangedFile
): Promise<boolean> {
  const current = await lstat(path.join(repoPath, file.path)).catch(
    () => undefined
  );
  if (current?.isSymbolicLink()) {
    return true;
  }
  if (file.oldPath) {
    const old = await lstat(path.join(repoPath, file.oldPath)).catch(
      () => undefined
    );
    return old?.isSymbolicLink() === true;
  }
  return false;
}

async function countUntrackedLines(
  repoPath: string,
  file: GuardChangedFile
): Promise<number> {
  if (file.status !== 'untracked' || file.isSymlink) {
    return 0;
  }
  const content = await readFile(path.join(repoPath, file.path), 'utf8').catch(
    () => ''
  );
  if (content.length === 0) {
    return 0;
  }
  return content.endsWith('\n')
    ? content.split('\n').length - 1
    : content.split('\n').length;
}

function patchLineCount(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.endsWith('\n')
    ? content.split('\n').length - 1
    : content.split('\n').length;
}

function renderAddedLines(content: string): string {
  if (content.length === 0) {
    return '';
  }

  const hasTrailingNewline = content.endsWith('\n');
  const lines = hasTrailingNewline
    ? content.slice(0, -1).split('\n')
    : content.split('\n');
  const rendered = lines.map((line) => `+${line}`).join('\n');
  return hasTrailingNewline
    ? `${rendered}\n`
    : `${rendered}\n\\ No newline at end of file\n`;
}

async function buildUntrackedPatch(
  repoPath: string,
  files: readonly GuardChangedFile[]
): Promise<string> {
  const sections = await Promise.all(
    files
      .filter((file) => file.status === 'untracked')
      .map(async (file) => {
        const absolutePath = path.join(repoPath, file.path);
        const mode = file.isSymlink ? '120000' : '100644';
        const content = file.isSymlink
          ? await readlink(absolutePath)
          : await readFile(absolutePath, 'utf8').catch(() => '');
        const lineCount = patchLineCount(content);
        return [
          `diff --git a/${file.path} b/${file.path}`,
          `new file mode ${mode}`,
          '--- /dev/null',
          `+++ b/${file.path}`,
          `@@ -0,0 +1,${lineCount} @@`,
          renderAddedLines(content)
        ].join('\n');
      })
  );

  return sections.filter((section) => section.length > 0).join('\n');
}

function toChangedFilesArtifact(
  baseCommit: string,
  files: readonly GuardChangedFile[]
): ChangedFilesArtifact {
  return {
    base_commit: baseCommit,
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      ...(file.oldPath ? { old_path: file.oldPath } : {}),
      is_symlink: file.isSymlink,
      added_lines: file.addedLines,
      deleted_lines: file.deletedLines,
      ...(file.allowedByWriteScope !== undefined
        ? { allowed_by_write_scope: file.allowedByWriteScope }
        : {}),
      ...(file.protected !== undefined ? { protected: file.protected } : {})
    })),
    untracked_files: files
      .filter((file) => file.status === 'untracked')
      .map((file) => file.path),
    renames: files.flatMap((file) =>
      file.status === 'renamed' && file.oldPath
        ? [{ old_path: file.oldPath, path: file.path }]
        : []
    ),
    symlinks: files.filter((file) => file.isSymlink).map((file) => file.path)
  };
}

export async function extractDiff(
  options: ExtractDiffOptions
): Promise<ExtractDiffResult> {
  const nameStatus = await safeGit(options.repoPath, [
    'diff',
    '--name-status',
    '-z',
    '-M',
    options.baseCommit
  ]);
  const status = await safeGit(options.repoPath, [
    'status',
    '--porcelain=v2',
    '--untracked-files=all',
    '-z'
  ]);
  const numstat = await safeGit(options.repoPath, [
    'diff',
    '--numstat',
    '-M',
    options.baseCommit
  ]);
  const patch = await safeGit(options.repoPath, [
    'diff',
    '--binary',
    '-M',
    options.baseCommit
  ]);

  const stats = parseNumstat(numstat.stdout);
  const files = mergeChangedFiles(
    parseNameStatus(nameStatus.stdout),
    parsePorcelainV2Untracked(status.stdout)
  );

  const changedFiles = await Promise.all(
    files.map(async (file) => {
      const statEntry =
        stats.get(file.path) ??
        (file.oldPath ? stats.get(file.oldPath) : undefined);
      const symlink = await isSymlink(options.repoPath, file);
      const untrackedLines = await countUntrackedLines(options.repoPath, {
        ...file,
        isSymlink: symlink
      });
      return {
        ...file,
        isSymlink: symlink,
        addedLines: statEntry?.addedLines ?? untrackedLines,
        deletedLines: statEntry?.deletedLines ?? 0
      };
    })
  );

  const untrackedPatch = await buildUntrackedPatch(
    options.repoPath,
    changedFiles
  );
  const candidatePatch = [patch.stdout, untrackedPatch]
    .filter((section) => section.length > 0)
    .join('\n');
  const changedFilesJson = toChangedFilesArtifact(
    options.baseCommit,
    changedFiles
  );
  if (options.artifactRoot) {
    await mkdir(path.join(options.artifactRoot, 'patches'), {
      recursive: true
    });
    await writeFile(
      path.join(options.artifactRoot, 'patches', 'candidate.patch'),
      candidatePatch
    );
    await writeFile(
      path.join(options.artifactRoot, 'patches', 'changed-files.json'),
      `${JSON.stringify(changedFilesJson, null, 2)}\n`
    );
  }

  return { changedFiles, candidatePatch, changedFilesJson };
}

export async function applyPatch(
  targetRepoPath: string,
  patch: string,
  options: ApplyPatchOptions = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = buildSafeGitArgs([
      'apply',
      '--whitespace=nowarn',
      ...(options.includeOnly ?? []).flatMap((include) => [
        `--include=${include.endsWith('/') ? `${include}*` : include}`
      ]),
      '-'
    ]);
    let stderr = '';
    const subprocess = spawn('git', args, {
      cwd: targetRepoPath,
      env: buildSafeGitEnv(),
      stdio: ['pipe', 'ignore', 'pipe']
    });
    subprocess.stderr.setEncoding('utf8');
    subprocess.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    subprocess.on('error', reject);
    subprocess.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(`git apply failed (${exitCode}): ${stderr.trim()}`));
    });
    subprocess.stdin.end(patch);
  });
}

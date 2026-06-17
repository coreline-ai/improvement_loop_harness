import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ArtifactPathError } from './errors.js';
import type { CreateRunDirOptions, RunLayout } from './types.js';

export const RUN_SUBDIRECTORIES = [
  'input',
  'workspace',
  'patches',
  'logs',
  'logs/gates',
  'reports',
  'metrics',
  'integrity'
] as const;

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertSafeSegment(name: string, value: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('..') ||
    !SAFE_SEGMENT_PATTERN.test(value)
  ) {
    throw new ArtifactPathError(`${name} is not a safe path segment`);
  }
}

function assertInside(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }
  throw new ArtifactPathError('artifact run path escapes the data directory');
}

function resolveSafeRunRoot(options: CreateRunDirOptions): string {
  assertSafeSegment('projectId', options.projectId);
  assertSafeSegment('loopId', options.loopId);
  const dataDir = path.resolve(options.dataDir);
  const root = path.resolve(dataDir, 'projects', options.projectId, 'runs', options.loopId);
  assertInside(dataDir, root);
  return root;
}

export function resolveRunRoot(options: CreateRunDirOptions): string {
  return resolveSafeRunRoot(options);
}

export async function createRunDir(options: CreateRunDirOptions): Promise<RunLayout> {
  const root = resolveRunRoot(options);
  await mkdir(root, { recursive: true });
  await Promise.all(RUN_SUBDIRECTORIES.map((directory) => mkdir(path.join(root, directory), { recursive: true })));

  return createRunLayout(options.dataDir, options.projectId, options.loopId, root);
}

export function createRunLayout(dataDir: string, projectId: string, loopId: string, root = resolveRunRoot({ dataDir, projectId, loopId })): RunLayout {
  assertSafeSegment('projectId', projectId);
  assertSafeSegment('loopId', loopId);
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedRoot = path.resolve(root);
  assertInside(resolvedDataDir, resolvedRoot);
  return {
    dataDir: resolvedDataDir,
    projectId,
    loopId,
    root: resolvedRoot,
    manifest: path.join(resolvedRoot, 'manifest.json'),
    input: path.join(resolvedRoot, 'input'),
    workspace: path.join(resolvedRoot, 'workspace'),
    patches: path.join(resolvedRoot, 'patches'),
    logs: path.join(resolvedRoot, 'logs'),
    gateLogs: path.join(resolvedRoot, 'logs', 'gates'),
    reports: path.join(resolvedRoot, 'reports'),
    metrics: path.join(resolvedRoot, 'metrics'),
    integrity: path.join(resolvedRoot, 'integrity'),
    path(relativePath: string): string {
      const resolvedPath = path.resolve(resolvedRoot, relativePath);
      assertInside(resolvedRoot, resolvedPath);
      return resolvedPath;
    }
  };
}

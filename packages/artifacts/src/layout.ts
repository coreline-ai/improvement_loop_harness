import { mkdir } from 'node:fs/promises';
import path from 'node:path';
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

export function resolveRunRoot(options: CreateRunDirOptions): string {
  return path.resolve(options.dataDir, 'projects', options.projectId, 'runs', options.loopId);
}

export async function createRunDir(options: CreateRunDirOptions): Promise<RunLayout> {
  const root = resolveRunRoot(options);
  await mkdir(root, { recursive: true });
  await Promise.all(RUN_SUBDIRECTORIES.map((directory) => mkdir(path.join(root, directory), { recursive: true })));

  return createRunLayout(options.dataDir, options.projectId, options.loopId, root);
}

export function createRunLayout(dataDir: string, projectId: string, loopId: string, root = resolveRunRoot({ dataDir, projectId, loopId })): RunLayout {
  return {
    dataDir: path.resolve(dataDir),
    projectId,
    loopId,
    root,
    manifest: path.join(root, 'manifest.json'),
    input: path.join(root, 'input'),
    workspace: path.join(root, 'workspace'),
    patches: path.join(root, 'patches'),
    logs: path.join(root, 'logs'),
    gateLogs: path.join(root, 'logs', 'gates'),
    reports: path.join(root, 'reports'),
    metrics: path.join(root, 'metrics'),
    integrity: path.join(root, 'integrity'),
    path(relativePath: string): string {
      return path.join(root, relativePath);
    }
  };
}

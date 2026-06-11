import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ManifestError } from './errors.js';
import { calculateExpiresAt } from './retention.js';
import type { ArtifactManifestEntry, RunLayout, RunManifest, TerminalRunStatus } from './types.js';

export interface InitializeManifestOptions {
  taskId?: string;
  baseCommit?: string;
  createdAt?: Date;
}

export interface FinalizeManifestOptions {
  status: TerminalRunStatus;
  decision?: string;
  finalizedAt?: Date;
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return walkFiles(absolutePath);
      }
      if (entry.isFile()) {
        return [absolutePath];
      }
      return [];
    })
  );

  return files.flat().sort();
}

function toArtifactRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function collectArtifactEntries(root: string): Promise<ArtifactManifestEntry[]> {
  const files = (await walkFiles(root)).filter((filePath) => path.basename(filePath) !== 'manifest.json');
  return Promise.all(
    files.map(async (filePath) => {
      const fileStat = await stat(filePath);
      return {
        path: toArtifactRelativePath(root, filePath),
        sha256: await sha256(filePath),
        size_bytes: fileStat.size
      };
    })
  );
}

export async function initializeManifest(layout: RunLayout, options: InitializeManifestOptions = {}): Promise<RunManifest> {
  const createdAt = options.createdAt ?? new Date();
  const manifest: RunManifest = {
    schema_version: '1.0',
    loop_id: layout.loopId,
    project_id: layout.projectId,
    created_at: createdAt.toISOString(),
    artifact_root: layout.root,
    status: 'running',
    ...(options.taskId ? { task_id: options.taskId } : {}),
    ...(options.baseCommit ? { base_commit: options.baseCommit } : {})
  };

  await writeFile(layout.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readManifest(layout: RunLayout): Promise<RunManifest> {
  return JSON.parse(await readFile(layout.manifest, 'utf8')) as RunManifest;
}

export async function finalizeManifest(layout: RunLayout, options: FinalizeManifestOptions): Promise<RunManifest> {
  const existing = await readManifest(layout);
  if (existing.finalized_at || existing.status !== 'running') {
    throw new ManifestError(`manifest is already finalized for loop ${layout.loopId}`);
  }

  const finalizedAt = options.finalizedAt ?? new Date();
  const decision = options.decision ?? options.status;
  const manifest: RunManifest = {
    ...existing,
    status: options.status,
    decision,
    finalized_at: finalizedAt.toISOString(),
    expires_at: calculateExpiresAt(decision, finalizedAt).toISOString(),
    artifacts: await collectArtifactEntries(layout.root)
  };

  await writeFile(layout.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyArtifactChecksums(layout: RunLayout): Promise<boolean> {
  const manifest = await readManifest(layout);
  const artifacts = manifest.artifacts ?? [];
  for (const artifact of artifacts) {
    const absolutePath = path.join(layout.root, artifact.path);
    if ((await sha256(absolutePath)) !== artifact.sha256) {
      return false;
    }
  }
  return true;
}

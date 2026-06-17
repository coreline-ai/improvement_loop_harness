import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunManifest } from './types.js';

export interface ExpiredRun {
  manifestPath: string;
  runRoot: string;
  manifest: RunManifest;
}

export interface DeletedRunRecord {
  schema_version: '1.0';
  loop_id: string;
  project_id: string;
  status: string;
  decision?: string | undefined;
  expires_at?: string | undefined;
  run_root: string;
  manifest_path: string;
  preserved_manifest_path: string;
  deleted_at: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function archiveSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.length > 0 ? safe : 'unknown';
}

export function retentionDaysForDecision(decision: string): number {
  switch (decision) {
    case 'accept':
    case 'accepted':
    case 'approved':
    case 'pr_created':
    case 'needs_human_review':
      return 180;
    case 'cancelled':
      return 7;
    case 'reject':
    case 'rejected':
    case 'failed':
    default:
      return 30;
  }
}

export function calculateExpiresAt(decision: string, from = new Date()): Date {
  return new Date(
    from.getTime() + retentionDaysForDecision(decision) * MS_PER_DAY
  );
}

async function findManifestPaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const results = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return findManifestPaths(absolutePath);
      }
      if (entry.isFile() && entry.name === 'manifest.json') {
        return [absolutePath];
      }
      return [];
    })
  );
  return results.flat();
}

async function readManifestFile(
  manifestPath: string
): Promise<RunManifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as RunManifest;
  } catch {
    return null;
  }
}

function isCollectableExpiredManifest(
  manifest: RunManifest,
  now: Date
): boolean {
  if (manifest.status === 'running' || manifest.audit_keep === true) {
    return false;
  }
  if (!manifest.expires_at) {
    return false;
  }
  return new Date(manifest.expires_at).getTime() <= now.getTime();
}

export async function collectExpired(
  root: string,
  now = new Date()
): Promise<ExpiredRun[]> {
  const manifestPaths = await findManifestPaths(root);
  const expired: ExpiredRun[] = [];

  for (const manifestPath of manifestPaths) {
    const manifest = await readManifestFile(manifestPath);
    if (!manifest || !isCollectableExpiredManifest(manifest, now)) {
      continue;
    }

    const runRoot = path.dirname(manifestPath);
    expired.push({ manifestPath, runRoot, manifest });
  }

  return expired;
}

export function deletedRunArchiveDir(
  root: string,
  manifest: RunManifest
): string {
  return path.resolve(
    root,
    'projects',
    archiveSegment(manifest.project_id),
    'gc',
    'deleted-runs',
    archiveSegment(manifest.loop_id)
  );
}

export async function deleteExpiredRun(
  root: string,
  expired: ExpiredRun,
  deletedAt = new Date()
): Promise<DeletedRunRecord | null> {
  const latestManifest = await readManifestFile(expired.manifestPath);
  if (
    !latestManifest ||
    !isCollectableExpiredManifest(latestManifest, deletedAt)
  ) {
    return null;
  }

  const refreshed = { ...expired, manifest: latestManifest };
  const archiveDir = deletedRunArchiveDir(root, refreshed.manifest);
  const preservedManifestPath = path.join(
    archiveDir,
    'preserved-manifest.json'
  );
  const deletionRecordPath = path.join(archiveDir, 'deletion-record.json');
  await mkdir(archiveDir, { recursive: true });
  await writeFile(
    preservedManifestPath,
    `${JSON.stringify(refreshed.manifest, null, 2)}\n`
  );

  const record: DeletedRunRecord = {
    schema_version: '1.0',
    loop_id: refreshed.manifest.loop_id,
    project_id: refreshed.manifest.project_id,
    status: refreshed.manifest.status,
    ...(refreshed.manifest.decision
      ? { decision: refreshed.manifest.decision }
      : {}),
    ...(refreshed.manifest.expires_at
      ? { expires_at: refreshed.manifest.expires_at }
      : {}),
    run_root: refreshed.runRoot,
    manifest_path: refreshed.manifestPath,
    preserved_manifest_path: preservedManifestPath,
    deleted_at: deletedAt.toISOString()
  };
  await writeFile(deletionRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  await rm(refreshed.runRoot, { recursive: true, force: true });
  return record;
}

export async function deleteExpiredRuns(
  root: string,
  now = new Date()
): Promise<DeletedRunRecord[]> {
  const expired = await collectExpired(root, now);
  const records: DeletedRunRecord[] = [];
  for (const run of expired) {
    const record = await deleteExpiredRun(root, run, now);
    if (record) records.push(record);
  }
  return records;
}

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunManifest } from './types.js';

export interface ExpiredRun {
  manifestPath: string;
  runRoot: string;
  manifest: RunManifest;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

export async function collectExpired(
  root: string,
  now = new Date()
): Promise<ExpiredRun[]> {
  const manifestPaths = await findManifestPaths(root);
  const expired: ExpiredRun[] = [];

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8')
    ) as RunManifest;
    if (!manifest.expires_at) {
      continue;
    }
    if (new Date(manifest.expires_at).getTime() > now.getTime()) {
      continue;
    }

    const runRoot = path.dirname(manifestPath);
    expired.push({ manifestPath, runRoot, manifest });
  }

  return expired;
}

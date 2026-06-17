import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { ManifestError } from './errors.js';
import { defaultRedactor } from './redaction.js';
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

function artifactPathInsideRoot(root: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath)) return null;
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    return absolutePath;
  }
  return null;
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function manifestKeyPath(layout: RunLayout): string {
  return path.join(layout.dataDir, '.manifest-hmac-key');
}

async function readOrCreateManifestKey(layout: RunLayout): Promise<Buffer> {
  const keyPath = manifestKeyPath(layout);
  try {
    return Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'hex');
  } catch {
    await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const key = randomBytes(32).toString('hex');
    try {
      await writeFile(keyPath, `${key}\n`, { flag: 'wx', mode: 0o600 });
      return Buffer.from(key, 'hex');
    } catch {
      return Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'hex');
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function unsignedManifest(manifest: RunManifest): RunManifest {
  const unsigned = { ...manifest };
  delete unsigned.manifest_integrity;
  return unsigned;
}

async function manifestSignature(
  layout: RunLayout,
  manifest: RunManifest
): Promise<string> {
  const key = await readOrCreateManifestKey(layout);
  return createHmac('sha256', key)
    .update(canonicalJson(unsignedManifest(manifest)))
    .digest('hex');
}

async function signManifest(
  layout: RunLayout,
  manifest: RunManifest
): Promise<RunManifest> {
  return {
    ...manifest,
    manifest_integrity: {
      algorithm: 'hmac-sha256',
      key_ref: 'data-dir',
      signature: await manifestSignature(layout, manifest)
    }
  };
}

async function writeManifestAtomic(
  layout: RunLayout,
  manifest: RunManifest
): Promise<void> {
  const tmpPath = path.join(
    path.dirname(layout.manifest),
    `.manifest.${process.pid}.${Date.now()}.tmp`
  );
  await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx'
  });
  try {
    await rename(tmpPath, layout.manifest);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function persistManifest(
  layout: RunLayout,
  manifest: RunManifest
): Promise<RunManifest> {
  const redacted = redactJson(manifest);
  const signed = await signManifest(layout, redacted);
  await writeManifestAtomic(layout, signed);
  return signed;
}

async function verifyManifestSignature(
  layout: RunLayout,
  manifest: RunManifest
): Promise<boolean> {
  const integrity = manifest.manifest_integrity;
  if (
    !integrity ||
    integrity.algorithm !== 'hmac-sha256' ||
    integrity.key_ref !== 'data-dir' ||
    !/^[a-f0-9]{64}$/.test(integrity.signature)
  ) {
    return false;
  }
  const expected = Buffer.from(await manifestSignature(layout, manifest), 'hex');
  const actual = Buffer.from(integrity.signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function redactJson<T>(value: T): T {
  if (typeof value === 'string') {
    return defaultRedactor(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(redactJson) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactJson(entry)
      ])
    ) as T;
  }
  return value;
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

  return persistManifest(layout, manifest);
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

  return persistManifest(layout, manifest);
}

export async function verifyArtifactChecksums(layout: RunLayout): Promise<boolean> {
  const manifest = await readManifest(layout);
  if (!(await verifyManifestSignature(layout, manifest))) {
    return false;
  }
  const artifacts = manifest.artifacts ?? [];
  const currentArtifacts = await collectArtifactEntries(layout.root);
  if (currentArtifacts.length !== artifacts.length) {
    return false;
  }
  const currentByPath = new Map(
    currentArtifacts.map((artifact) => [artifact.path, artifact])
  );
  for (const artifact of artifacts) {
    const absolutePath = artifactPathInsideRoot(layout.root, artifact.path);
    if (!absolutePath) {
      return false;
    }
    const current = currentByPath.get(artifact.path);
    if (
      !current ||
      current.sha256 !== artifact.sha256 ||
      current.size_bytes !== artifact.size_bytes
    ) {
      return false;
    }
  }
  return true;
}

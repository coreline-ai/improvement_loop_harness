import {
  access,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { ArtifactImmutableError, ArtifactPathError } from './errors.js';
import { passthroughRedactor, type Redactor } from './redaction.js';
import type { RunManifest } from './types.js';

export interface WriteArtifactOptions {
  redactor?: Redactor;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function assertRelativePath(relativePath: string): void {
  if (relativePath.trim().length === 0) {
    throw new ArtifactPathError('artifact path must not be empty');
  }
  if (relativePath.includes('\0')) {
    throw new ArtifactPathError(
      `artifact path must not contain NUL bytes: ${relativePath}`
    );
  }
  if (path.isAbsolute(relativePath)) {
    throw new ArtifactPathError(
      `artifact path must be relative to run root: ${relativePath}`
    );
  }
}

async function nearestExistingParent(targetParent: string): Promise<string> {
  let current = targetParent;
  while (!(await exists(current))) {
    const next = path.dirname(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

async function assertWritableTarget(
  runRoot: string,
  relativePath: string
): Promise<string> {
  assertRelativePath(relativePath);

  const realRoot = await realpath(runRoot);
  const target = path.resolve(realRoot, relativePath);
  if (!isInside(realRoot, target)) {
    throw new ArtifactPathError(
      `artifact path escapes run root: ${relativePath}`
    );
  }

  const targetParent = path.dirname(target);
  const existingParent = await nearestExistingParent(targetParent);
  const realExistingParent = await realpath(existingParent);
  if (!isInside(realRoot, realExistingParent)) {
    throw new ArtifactPathError(
      `artifact path traverses outside run root through existing parent: ${relativePath}`
    );
  }

  await mkdir(targetParent, { recursive: true });
  const realTargetParent = await realpath(targetParent);
  if (!isInside(realRoot, realTargetParent)) {
    throw new ArtifactPathError(
      `artifact path parent resolves outside run root: ${relativePath}`
    );
  }

  if (await exists(target)) {
    const realTarget = await realpath(target);
    if (!isInside(realRoot, realTarget)) {
      throw new ArtifactPathError(
        `artifact path target resolves outside run root: ${relativePath}`
      );
    }
  }

  return target;
}

async function assertReadableTarget(
  runRoot: string,
  relativePath: string
): Promise<string> {
  assertRelativePath(relativePath);

  const realRoot = await realpath(runRoot);
  const target = path.resolve(realRoot, relativePath);
  if (!isInside(realRoot, target)) {
    throw new ArtifactPathError(
      `artifact path escapes run root: ${relativePath}`
    );
  }

  const realTarget = await realpath(target);
  if (!isInside(realRoot, realTarget)) {
    throw new ArtifactPathError(
      `artifact path target resolves outside run root: ${relativePath}`
    );
  }

  return realTarget;
}

async function assertRunIsMutable(runRoot: string): Promise<void> {
  const manifestPath = path.join(runRoot, 'manifest.json');
  if (!(await exists(manifestPath))) {
    return;
  }

  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8')
  ) as RunManifest;
  if (manifest.finalized_at || manifest.status !== 'running') {
    throw new ArtifactImmutableError(
      `artifact run is immutable after finalize: ${runRoot}`
    );
  }
}

export async function writeArtifact(
  runRoot: string,
  relativePath: string,
  content: string | Buffer,
  options: WriteArtifactOptions = {}
): Promise<string> {
  await assertRunIsMutable(runRoot);
  const target = await assertWritableTarget(runRoot, relativePath);
  const redactor = options.redactor ?? passthroughRedactor;
  const output = typeof content === 'string' ? redactor(content) : content;
  await writeFile(target, output);
  return target;
}

export async function readArtifactText(
  runRoot: string,
  relativePath: string
): Promise<string> {
  const target = await assertReadableTarget(runRoot, relativePath);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new ArtifactPathError(`artifact is not a file: ${relativePath}`);
  }
  return readFile(target, 'utf8');
}

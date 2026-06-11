import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactImmutableError, ArtifactPathError } from './errors.js';
import { createRunDir, RUN_SUBDIRECTORIES } from './layout.js';
import {
  finalizeManifest,
  initializeManifest,
  readManifest,
  verifyArtifactChecksums
} from './manifest.js';
import { collectExpired } from './retention.js';
import { createRedactor } from './redaction.js';
import { readArtifactText, writeArtifact } from './writer.js';

async function tempDataDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vibeloop-artifacts-'));
}

function plusDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

describe('createRunDir', () => {
  it('creates the eight documented artifact subdirectories outside the target repo', async () => {
    const dataDir = await tempDataDir();
    const layout = await createRunDir({
      dataDir,
      projectId: 'proj-1',
      loopId: 'loop-1'
    });

    expect(RUN_SUBDIRECTORIES).toHaveLength(8);
    for (const directory of RUN_SUBDIRECTORIES) {
      await expect(
        stat(path.join(layout.root, directory))
      ).resolves.toMatchObject({});
      expect(
        (await stat(path.join(layout.root, directory))).isDirectory()
      ).toBe(true);
    }
  });
});

describe('writeArtifact and redaction', () => {
  it('rejects parent traversal writes before data can escape the run root', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-escape'
    });

    await expect(
      writeArtifact(layout.root, '../../x', 'escaped')
    ).rejects.toThrow(ArtifactPathError);
  });

  it('rejects writes through symlinked parents that resolve outside the run root', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-symlink'
    });
    const outsideDir = await tempDataDir();

    await symlink(outsideDir, path.join(layout.logs, 'outside-link'), 'dir');

    await expect(
      writeArtifact(layout.root, 'logs/outside-link/leak.log', 'escaped')
    ).rejects.toThrow(ArtifactPathError);
  });

  it('redacts injected secret values and key/token/password shaped values before writing logs', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-redact'
    });
    const redactor = createRedactor({ secrets: ['super-secret-value'] });

    await writeArtifact(
      layout.root,
      'logs/agent.stderr.log',
      'token=abc123 password: hunter2 api_key="key-123" literal=super-secret-value',
      { redactor }
    );

    const output = await readArtifactText(layout.root, 'logs/agent.stderr.log');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('key-123');
    expect(output).not.toContain('super-secret-value');
    expect(output).toContain('token=[REDACTED]');
    expect(output).toContain('password: [REDACTED]');
    expect(output).toContain('api_key="[REDACTED]"');
    expect(output).toContain('literal=[REDACTED]');
  });
});

describe('manifest finalization', () => {
  it('records sha256 checksums for artifacts and blocks writes after finalize', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-finalize'
    });

    await initializeManifest(layout, {
      taskId: 'task-1',
      baseCommit: 'abc123',
      createdAt: new Date('2026-06-10T00:00:00.000Z')
    });
    await writeArtifact(
      layout.root,
      'logs/eval-runner.log',
      'all gates passed\n'
    );

    const finalized = await finalizeManifest(layout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt: new Date('2026-06-10T01:00:00.000Z')
    });

    expect(finalized.status).toBe('rejected');
    expect(finalized.artifacts).toHaveLength(1);
    expect(finalized.artifacts?.[0]).toMatchObject({
      path: 'logs/eval-runner.log',
      size_bytes: 'all gates passed\n'.length
    });

    const checksum = createHash('sha256')
      .update(await readFile(path.join(layout.root, 'logs/eval-runner.log')))
      .digest('hex');
    expect(finalized.artifacts?.[0]?.sha256).toBe(checksum);
    await expect(verifyArtifactChecksums(layout)).resolves.toBe(true);
    await expect(
      writeArtifact(layout.root, 'logs/after-finalize.log', 'late write')
    ).rejects.toThrow(ArtifactImmutableError);
  });
});

describe('retention', () => {
  it('sets rejected runs to expire thirty days after finalization and collects them when due', async () => {
    const dataDir = await tempDataDir();
    const finalizedAt = new Date('2026-06-10T01:00:00.000Z');
    const layout = await createRunDir({
      dataDir,
      projectId: 'proj-1',
      loopId: 'loop-retention'
    });

    await initializeManifest(layout, {
      createdAt: new Date('2026-06-10T00:00:00.000Z')
    });
    await writeArtifact(layout.root, 'reports/eval-report.json', '{}\n');
    await finalizeManifest(layout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt
    });

    const manifest = await readManifest(layout);
    expect(manifest.expires_at).toBe(plusDays(finalizedAt, 30).toISOString());
    await expect(
      collectExpired(dataDir, plusDays(finalizedAt, 29))
    ).resolves.toHaveLength(0);

    const expired = await collectExpired(dataDir, plusDays(finalizedAt, 31));
    expect(expired).toHaveLength(1);
    expect(expired[0]?.runRoot).toBe(layout.root);
    expect(expired[0]?.manifest.loop_id).toBe('loop-retention');
  });
});

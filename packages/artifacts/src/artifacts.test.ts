import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
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
import {
  collectExpired,
  deleteExpiredRun,
  deleteExpiredRuns
} from './retention.js';
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

  it('rejects unsafe project and loop identifiers before creating run paths', async () => {
    const dataDir = await tempDataDir();

    await expect(
      createRunDir({
        dataDir,
        projectId: '../escape',
        loopId: 'loop-1'
      })
    ).rejects.toThrow(ArtifactPathError);
    await expect(
      createRunDir({
        dataDir,
        projectId: 'proj-1',
        loopId: '../escape'
      })
    ).rejects.toThrow(ArtifactPathError);
  });

  it('rejects layout.path traversal outside the run root', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-path'
    });

    expect(() => layout.path('../escape.txt')).toThrow(ArtifactPathError);
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

  it('redacts quoted secret values that contain whitespace before writing logs', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-redact-whitespace'
    });

    await writeArtifact(
      layout.root,
      'logs/agent.stdout.log',
      [
        'secret="alpha beta gamma"',
        "token: 'multi word token'",
        '{"api_key": "json key with spaces"}'
      ].join('\n')
    );

    const output = await readArtifactText(layout.root, 'logs/agent.stdout.log');
    expect(output).not.toContain('alpha beta gamma');
    expect(output).not.toContain('multi word token');
    expect(output).not.toContain('json key with spaces');
    expect(output).toContain('secret="[REDACTED]"');
    expect(output).toContain("token: '[REDACTED]'");
    expect(output).toContain('"api_key": "[REDACTED]"');
  });

  it('uses the default redactor for text and Buffer artifact writes', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-default-redact'
    });

    await writeArtifact(
      layout.root,
      'logs/text.log',
      'Bearer abc.def.ghi token=abc123 sk-testsecret123'
    );
    await writeArtifact(
      layout.root,
      'logs/buffer.log',
      Buffer.from('password=buffer-secret ghp_abcdefghijklmnopqrstuvwxyz')
    );

    const text = await readArtifactText(layout.root, 'logs/text.log');
    const buffer = await readArtifactText(layout.root, 'logs/buffer.log');
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('sk-testsecret123');
    expect(buffer).not.toContain('buffer-secret');
    expect(buffer).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
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
    expect(finalized.manifest_integrity).toMatchObject({
      algorithm: 'hmac-sha256',
      key_ref: 'data-dir'
    });
    expect(finalized.manifest_integrity?.signature).toMatch(/^[a-f0-9]{64}$/);
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

  it('redacts token-like manifest fields before persisting manifest.json', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-manifest-redact'
    });

    await initializeManifest(layout, {
      taskId: 'task-ghp_abcdefghijklmnopqrstuvwxyz',
      baseCommit: 'token=manifest-secret'
    });

    const manifestText = await readFile(layout.manifest, 'utf8');
    expect(manifestText).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(manifestText).not.toContain('manifest-secret');
    expect(manifestText).toContain('[REDACTED]');
  });

  it('fails checksum verification when manifest artifact paths escape the run root', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-manifest-path'
    });

    await initializeManifest(layout);
    await writeArtifact(layout.root, 'logs/eval-runner.log', 'ok\n');
    const finalized = await finalizeManifest(layout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt: new Date('2026-06-10T01:00:00.000Z')
    });
    await writeFile(
      layout.manifest,
      `${JSON.stringify(
        {
          ...finalized,
          artifacts: [
            {
              path: '../escape.log',
              sha256: '0'.repeat(64),
              size_bytes: 1
            }
          ]
        },
        null,
        2
      )}\n`
    );

    await expect(verifyArtifactChecksums(layout)).resolves.toBe(false);
  });

  it('fails checksum verification when manifest content or artifact set changes after signing', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-manifest-signature'
    });

    await initializeManifest(layout);
    await writeArtifact(layout.root, 'logs/eval-runner.log', 'ok\n');
    const finalized = await finalizeManifest(layout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt: new Date('2026-06-10T01:00:00.000Z')
    });

    await writeFile(
      layout.manifest,
      `${JSON.stringify({ ...finalized, status: 'accepted' }, null, 2)}\n`
    );
    await expect(verifyArtifactChecksums(layout)).resolves.toBe(false);
  });

  it('fails checksum verification when an unmanifested artifact is added', async () => {
    const layout = await createRunDir({
      dataDir: await tempDataDir(),
      projectId: 'proj-1',
      loopId: 'loop-extra-file'
    });

    await initializeManifest(layout);
    await writeArtifact(layout.root, 'logs/eval-runner.log', 'ok\n');
    await finalizeManifest(layout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt: new Date('2026-06-10T01:00:00.000Z')
    });
    await writeFile(path.join(layout.logs, 'late-direct-write.log'), 'late\n');

    await expect(verifyArtifactChecksums(layout)).resolves.toBe(false);
  });
});

describe('retention', () => {
  it('deletes only expired runs while preserving manifest and deletion record outside the run root', async () => {
    const dataDir = await tempDataDir();
    const finalizedAt = new Date('2026-06-10T01:00:00.000Z');
    const freshFinalizedAt = plusDays(finalizedAt, 10);
    const expiredLayout = await createRunDir({
      dataDir,
      projectId: 'proj-gc',
      loopId: 'loop-expired'
    });
    const freshLayout = await createRunDir({
      dataDir,
      projectId: 'proj-gc',
      loopId: 'loop-fresh'
    });

    await initializeManifest(expiredLayout, { createdAt: finalizedAt });
    await writeArtifact(expiredLayout.root, 'reports/eval-report.json', '{}\n');
    await finalizeManifest(expiredLayout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt
    });

    await initializeManifest(freshLayout, { createdAt: freshFinalizedAt });
    await writeArtifact(freshLayout.root, 'reports/eval-report.json', '{}\n');
    await finalizeManifest(freshLayout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt: freshFinalizedAt
    });

    const records = await deleteExpiredRuns(dataDir, plusDays(finalizedAt, 31));

    expect(records).toHaveLength(1);
    expect(records[0]?.loop_id).toBe('loop-expired');
    await expect(access(expiredLayout.root)).rejects.toThrow();
    await expect(access(freshLayout.root)).resolves.toBeUndefined();
    await expect(
      readFile(
        path.join(
          dataDir,
          'projects',
          'proj-gc',
          'gc',
          'deleted-runs',
          'loop-expired',
          'preserved-manifest.json'
        ),
        'utf8'
      )
    ).resolves.toContain('loop-expired');
    await expect(
      readFile(
        path.join(
          dataDir,
          'projects',
          'proj-gc',
          'gc',
          'deleted-runs',
          'loop-expired',
          'deletion-record.json'
        ),
        'utf8'
      )
    ).resolves.toContain('preserved_manifest_path');
    await expect(
      collectExpired(dataDir, plusDays(finalizedAt, 31))
    ).resolves.toHaveLength(0);
  });

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

  it('does not collect running or audit-kept runs even when expires_at is stale', async () => {
    const dataDir = await tempDataDir();
    const stale = new Date('2026-06-10T01:00:00.000Z');
    const runningLayout = await createRunDir({
      dataDir,
      projectId: 'proj-gc',
      loopId: 'loop-running'
    });
    const auditLayout = await createRunDir({
      dataDir,
      projectId: 'proj-gc',
      loopId: 'loop-audit'
    });

    const running = await initializeManifest(runningLayout, { createdAt: stale });
    await writeFile(
      runningLayout.manifest,
      `${JSON.stringify(
        { ...running, expires_at: stale.toISOString() },
        null,
        2
      )}\n`
    );
    await initializeManifest(auditLayout, { createdAt: stale });
    await writeArtifact(auditLayout.root, 'reports/eval-report.json', '{}\n');
    const audit = await finalizeManifest(auditLayout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt: stale
    });
    await writeFile(
      auditLayout.manifest,
      `${JSON.stringify({ ...audit, audit_keep: true }, null, 2)}\n`
    );

    await expect(collectExpired(dataDir, plusDays(stale, 31))).resolves.toEqual(
      []
    );
  });

  it('does not delete audit-kept runs during retention GC', async () => {
    const dataDir = await tempDataDir();
    const stale = new Date('2026-06-10T01:00:00.000Z');
    const auditLayout = await createRunDir({
      dataDir,
      projectId: 'proj-gc',
      loopId: 'loop-audit-gc'
    });

    await initializeManifest(auditLayout, { createdAt: stale });
    await writeArtifact(auditLayout.root, 'reports/eval-report.json', '{}\n');
    const audit = await finalizeManifest(auditLayout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt: stale
    });
    await writeFile(
      auditLayout.manifest,
      `${JSON.stringify({ ...audit, audit_keep: true }, null, 2)}\n`
    );

    await expect(
      deleteExpiredRuns(dataDir, plusDays(stale, 31))
    ).resolves.toEqual([]);
    await expect(access(auditLayout.root)).resolves.toBeUndefined();
  });

  it('skips malformed manifests instead of aborting the whole GC scan', async () => {
    const dataDir = await tempDataDir();
    const stale = new Date('2026-06-10T01:00:00.000Z');
    const badLayout = await createRunDir({
      dataDir,
      projectId: 'proj-gc',
      loopId: 'loop-bad-manifest'
    });
    const goodLayout = await createRunDir({
      dataDir,
      projectId: 'proj-gc',
      loopId: 'loop-good-manifest'
    });

    await writeFile(badLayout.manifest, '{not-json');
    await initializeManifest(goodLayout, { createdAt: stale });
    await writeArtifact(goodLayout.root, 'reports/eval-report.json', '{}\n');
    await finalizeManifest(goodLayout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt: stale
    });

    const expired = await collectExpired(dataDir, plusDays(stale, 31));
    expect(expired.map((run) => run.manifest.loop_id)).toEqual([
      'loop-good-manifest'
    ]);
  });

  it('rechecks run status before deleting an expired run', async () => {
    const dataDir = await tempDataDir();
    const stale = new Date('2026-06-10T01:00:00.000Z');
    const layout = await createRunDir({
      dataDir,
      projectId: 'proj-gc',
      loopId: 'loop-recheck'
    });

    await initializeManifest(layout, { createdAt: stale });
    await writeArtifact(layout.root, 'reports/eval-report.json', '{}\n');
    const finalized = await finalizeManifest(layout, {
      status: 'rejected',
      decision: 'rejected',
      finalizedAt: stale
    });
    const [expired] = await collectExpired(dataDir, plusDays(stale, 31));
    await writeFile(
      layout.manifest,
      `${JSON.stringify({ ...finalized, status: 'running' }, null, 2)}\n`
    );

    await expect(
      deleteExpiredRun(dataDir, expired!, plusDays(stale, 31))
    ).resolves.toBeNull();
    await expect(access(layout.root)).resolves.toBeUndefined();
  });
});

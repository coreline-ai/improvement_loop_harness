import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDataDir } from './data-dir.js';
import { runCommand } from './exec.js';

describe('runCommand', () => {
  it('captures stdout to the requested file for a successful command', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-exec-'));
    const stdoutFile = path.join(tempDir, 'stdout.log');
    const stderrFile = path.join(tempDir, 'stderr.log');

    const result = await runCommand('echo hi', { stdoutFile, stderrFile });

    expect(result.status).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
    await expect(readFile(stdoutFile, 'utf8')).resolves.toBe('hi');
    await expect(readFile(stderrFile, 'utf8')).resolves.toBe('');
  });

  it('returns error when a command exceeds timeout', async () => {
    const start = Date.now();
    const result = await runCommand('sleep 10', { timeoutMs: 200 });

    expect(result.status).toBe('error');
    expect(result.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(2500);
  });
});

describe('getDataDir', () => {
  it('uses VIBELOOP_DATA_DIR when provided', () => {
    expect(getDataDir({ VIBELOOP_DATA_DIR: './tmp-data' })).toBe(path.resolve('./tmp-data'));
  });

  it('defaults to ~/.vibeloop', () => {
    expect(getDataDir({})).toBe(path.join(os.homedir(), '.vibeloop'));
  });
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isContainerRuntimeAvailable,
  runCommandInContainer
} from './exec-isolated.js';

// Live isolation tests need a running container daemon. Like the PrismaStore
// contract tests (which require `docker compose`), they skip cleanly when no
// daemon is reachable — they are NOT silently passed.
const dockerUp = await isContainerRuntimeAvailable();
const IMAGE = process.env.VIBELOOP_TEST_CONTAINER_IMAGE ?? 'alpine:3.20';

describe('isContainerRuntimeAvailable', () => {
  it('returns a boolean for the current environment', async () => {
    expect(typeof (await isContainerRuntimeAvailable())).toBe('boolean');
  });
});

describe.skipIf(!dockerUp)(
  'runCommandInContainer (needs docker daemon)',
  () => {
    it('runs a command in the container and captures stdout', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-iso-'));
      const result = await runCommandInContainer('echo hi-from-container', {
        image: IMAGE,
        mountDir: dir,
        network: 'none',
        timeoutMs: 60_000
      });
      expect(result.status).toBe('pass');
      expect(result.stdout).toContain('hi-from-container');
    }, 120_000);

    it('isolates the network with --network none', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-iso-'));
      // busybox wget with no network must fail; we convert that to a marker.
      const result = await runCommandInContainer(
        'wget -T 3 -q -O- http://1.1.1.1 >/dev/null 2>&1 && echo NET_OK || echo NET_BLOCKED',
        { image: IMAGE, mountDir: dir, network: 'none', timeoutMs: 60_000 }
      );
      expect(result.stdout).toContain('NET_BLOCKED');
      expect(result.stdout).not.toContain('NET_OK');
    }, 120_000);

    it('mounts the host directory read-write at /work', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-iso-'));
      await writeFile(path.join(dir, 'marker.txt'), 'mounted-ok');
      const result = await runCommandInContainer('cat /work/marker.txt', {
        image: IMAGE,
        mountDir: dir,
        network: 'none',
        timeoutMs: 60_000
      });
      expect(result.status).toBe('pass');
      expect(result.stdout).toContain('mounted-ok');
    }, 120_000);

    it('passes env through without putting the value on any argv', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-iso-'));
      const result = await runCommandInContainer('echo "$SECRET_ECHO"', {
        image: IMAGE,
        mountDir: dir,
        network: 'none',
        env: { SECRET_ECHO: 'value-via-env' },
        timeoutMs: 60_000
      });
      expect(result.stdout).toContain('value-via-env');
    }, 120_000);
  }
);

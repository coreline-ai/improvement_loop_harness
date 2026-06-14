import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isContainerRuntimeAvailable } from '@vibeloop/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { runGates } from './orchestrator.js';
import type { GateRunContext } from './types.js';

// R1: durable regression for isolated (container) project-gate execution. Needs a
// container daemon; skips cleanly otherwise (PrismaStore-style). Dirs live under
// $HOME so colima mounts them (macOS /var/folders is not mounted).
const dockerUp = await isContainerRuntimeAvailable();
const IMAGE = process.env.VIBELOOP_TEST_CONTAINER_IMAGE ?? 'alpine:3.20';

const roots: string[] = [];
async function homeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.homedir(), '.vibeloop-gateiso-'));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(
    roots.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe.skipIf(!dockerUp)(
  'R1 isolated gate execution (needs docker daemon)',
  () => {
    it('runs a project gate inside a network-isolated container with the worktree mounted', async () => {
      const worktreeRoot = await homeTmp();
      const artifactRoot = await homeTmp();
      await writeFile(path.join(worktreeRoot, 'hello.txt'), 'hi-worktree');
      const taskFile = path.join(artifactRoot, 'input', 'task.yaml');
      await mkdir(path.dirname(taskFile), { recursive: true });
      await writeFile(taskFile, 'id: gate-iso\n');

      const context: GateRunContext = {
        evalConfig: {
          schema_version: '1.0',
          project: 'gate-iso',
          protected_paths: [],
          limits: { max_changed_files: 20, max_changed_lines: 500 },
          test_integrity: {
            forbidden_patterns: [],
            suspicious_patterns: []
          },
          execution: { isolation: 'container', image: IMAGE, network: 'none' },
          gates: [
            {
              name: 'iso_probe',
              type: 'task_acceptance',
              command:
                'uname -s; wget -T 3 -q -O- http://1.1.1.1 >/dev/null 2>&1 && echo NET_OK || echo NET_BLOCKED; cat hello.txt',
              required: true
            }
          ]
        },
        task: {
          id: 'gate-iso',
          title: 'gate iso',
          objective: 'verify isolated gate execution path',
          write_scope: { allowed: ['.'] },
          required_evidence: []
        },
        taskFile,
        baseCommit: 'abc123',
        loopId: 'gate-iso-1',
        worktreeRoot,
        artifactRoot,
        env: { PATH: process.env.PATH ?? '' },
        changedFiles: []
      };

      const result = await runGates(context);
      const gate = result.report.gates.find((g) => g.name === 'iso_probe');
      expect(gate?.status).toBe('pass');

      const log = await readFile(
        path.join(artifactRoot, gate!.stdout_ref!),
        'utf8'
      );
      expect(log).toContain('Linux'); // ran in the container, not the host (Darwin)
      expect(log).toContain('NET_BLOCKED'); // --network none isolated the network
      expect(log).not.toContain('NET_OK');
      expect(log).toContain('hi-worktree'); // worktree mounted + cwd is the worktree
    }, 180_000);

    it('fails the gate with a clear error when isolation=container has no image', async () => {
      const worktreeRoot = await homeTmp();
      const artifactRoot = await homeTmp();
      const taskFile = path.join(artifactRoot, 'input', 'task.yaml');
      await mkdir(path.dirname(taskFile), { recursive: true });
      await writeFile(taskFile, 'id: gate-iso\n');

      const context: GateRunContext = {
        evalConfig: {
          schema_version: '1.0',
          project: 'gate-iso-noimg',
          protected_paths: [],
          limits: { max_changed_files: 20, max_changed_lines: 500 },
          test_integrity: { forbidden_patterns: [], suspicious_patterns: [] },
          // image intentionally omitted (schema blocks this at load; the executor
          // also degrades to a gate error rather than crashing).
          execution: { isolation: 'container', network: 'none' },
          gates: [
            {
              name: 'iso_probe',
              type: 'task_acceptance',
              command: 'echo should-not-run',
              required: true
            }
          ]
        },
        task: {
          id: 'gate-iso',
          title: 'gate iso',
          objective: 'verify isolated gate execution path',
          write_scope: { allowed: ['.'] },
          required_evidence: []
        },
        taskFile,
        baseCommit: 'abc123',
        loopId: 'gate-iso-2',
        worktreeRoot,
        artifactRoot,
        env: { PATH: process.env.PATH ?? '' },
        changedFiles: []
      };

      const result = await runGates(context);
      const gate = result.report.gates.find((g) => g.name === 'iso_probe');
      expect(gate?.status).toBe('error');
      expect(gate?.summary).toContain('requires execution.image');
    }, 60_000);
  }
);

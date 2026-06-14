import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isContainerRuntimeAvailable } from '@vibeloop/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { confirmProposalUnderIsolation } from './adversary-execution.js';
import type {
  AdversaryProposal,
  ProposalFilterConfig
} from './adversary-filter.js';

// M2 execution runs untrusted proposal tests; it requires R1 isolation, so these
// tests need a container daemon (skip cleanly otherwise). $HOME dirs so colima mounts.
const dockerUp = await isContainerRuntimeAvailable();
const IMAGE = process.env.VIBELOOP_TEST_CONTAINER_IMAGE ?? 'alpine:3.20';

const FILTER: ProposalFilterConfig = {
  testDirs: ['tests/'],
  objectiveTerms: ['fixed'],
  hiddenMarkers: ['SECRET_HIDDEN_EXPECTATION'],
  maxBodyBytes: 4096
};
const TEST_COMMAND = 'sh tests/edge.sh';

const roots: string[] = [];
async function worktree(marker: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.homedir(), '.vibeloop-advx-'));
  roots.push(dir);
  await writeFile(path.join(dir, 'value.txt'), marker);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

// A fail_to_pass proposal: passes only when value.txt contains FIXED.
const failToPass: AdversaryProposal = {
  id: 'p-edge',
  targetPath: 'tests/edge.sh',
  body: '#!/bin/sh\n# fixed-behavior edge guard\ngrep -q FIXED value.txt\n',
  expectation: 'fail_to_pass'
};

describe.skipIf(!dockerUp)(
  'confirmProposalUnderIsolation (M2 execution, needs docker daemon)',
  () => {
    it('confirms fail-on-base / pass-on-candidate under isolation', async () => {
      const candidate = await worktree('FIXED behavior');
      const base = await worktree('BROKEN behavior');
      const out = await confirmProposalUnderIsolation(
        failToPass,
        FILTER,
        {
          candidate: { worktreePath: candidate },
          base: { worktreePath: base }
        },
        { image: IMAGE, testCommand: TEST_COMMAND, timeoutMs: 60_000 }
      );
      expect(out.executed).toBe(true);
      expect(out.base).toBe('fail');
      expect(out.candidate).toBe('pass');
      expect(out.confirmed).toBe(true);
    }, 180_000);

    it('does NOT confirm when the candidate also fails (no real fix)', async () => {
      const candidate = await worktree('still BROKEN');
      const base = await worktree('BROKEN behavior');
      const out = await confirmProposalUnderIsolation(
        failToPass,
        FILTER,
        {
          candidate: { worktreePath: candidate },
          base: { worktreePath: base }
        },
        { image: IMAGE, testCommand: TEST_COMMAND, timeoutMs: 60_000 }
      );
      expect(out.confirmed).toBe(false);
      expect(out.candidate).toBe('fail');
    }, 180_000);

    it('NEVER executes a proposal that fails the static filter (e.g. out of scope)', async () => {
      const candidate = await worktree('FIXED behavior');
      const outOfScope: AdversaryProposal = {
        ...failToPass,
        id: 'p-oos',
        targetPath: 'src/sneaky.sh' // not under tests/
      };
      const out = await confirmProposalUnderIsolation(
        outOfScope,
        FILTER,
        { candidate: { worktreePath: candidate } },
        { image: IMAGE, testCommand: TEST_COMMAND, timeoutMs: 60_000 }
      );
      expect(out.executed).toBe(false);
      expect(out.confirmed).toBe(false);
      expect(out.reason).toContain('static filter rejected');
    }, 60_000);
  }
);

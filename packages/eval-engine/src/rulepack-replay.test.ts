import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isContainerRuntimeAvailable } from '@vibeloop/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  replayCorpusUnderIsolation,
  type ReplayCase
} from './rulepack-replay.js';
import { decideShadowPromotion, diffRulepack } from './rulepack-shadow.js';

// M4 replay execution runs corpus cases under R1 isolation → needs a daemon.
const dockerUp = await isContainerRuntimeAvailable();
const IMAGE = process.env.VIBELOOP_TEST_CONTAINER_IMAGE ?? 'alpine:3.20';

const roots: string[] = [];
async function corpusWorktree(): Promise<string> {
  const dir = await mkdtemp(path.join(os.homedir(), '.vibeloop-replay-'));
  roots.push(dir);
  // known-good fixture passes the rule; known-bad fixture must be caught.
  await writeFile(path.join(dir, 'good.txt'), 'value=OK');
  await writeFile(path.join(dir, 'bad.txt'), 'value=FORBIDDEN');
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
});

// A candidate rule "forbid the FORBIDDEN literal": grep returns 0 (match) on bad,
// nonzero on good. Cases express the expected verdict for a SAFE rule set.
const SAFE_CORPUS: ReplayCase[] = [
  {
    id: 'good-stays-clean',
    command: 'grep -q FORBIDDEN good.txt && exit 1 || exit 0',
    expect: 'pass'
  },
  {
    id: 'bad-is-caught',
    command: 'grep -q FORBIDDEN bad.txt && exit 0 || exit 1',
    expect: 'pass'
  }
];

describe.skipIf(!dockerUp)(
  'replayCorpusUnderIsolation (M4 substrate, needs docker daemon)',
  () => {
    it('computes replaySafe=true when every case matches, feeding shadow promotion', async () => {
      const worktreePath = await corpusWorktree();
      const replay = await replayCorpusUnderIsolation(SAFE_CORPUS, {
        worktreePath,
        image: IMAGE,
        network: 'none',
        timeoutMs: 60_000
      });
      expect(replay.replaySafe).toBe(true);
      expect(replay.matched).toBe(2);

      // Full M4 chain: append-only diff + replaySafe + not-applied-this-loop → promote.
      const diff = diffRulepack(
        [{ id: 'r1', hash: 'a' }],
        [
          { id: 'r1', hash: 'a' },
          { id: 'forbid-literal', hash: 'b' }
        ]
      );
      const decision = decideShadowPromotion({
        diff,
        replaySafe: replay.replaySafe,
        appliedToCurrentLoop: false
      });
      expect(decision.promote).toBe(true);
      expect(decision.status).toBe('shadow_promoted');
    }, 180_000);

    it('computes replaySafe=false on a mismatch → shadow promotion rejected', async () => {
      const worktreePath = await corpusWorktree();
      // A regressed rule set: a case that should pass actually fails.
      const regressed: ReplayCase[] = [
        ...SAFE_CORPUS,
        { id: 'regression', command: 'exit 1', expect: 'pass' }
      ];
      const replay = await replayCorpusUnderIsolation(regressed, {
        worktreePath,
        image: IMAGE,
        network: 'none',
        timeoutMs: 60_000
      });
      expect(replay.replaySafe).toBe(false);
      expect(replay.mismatches.map((m) => m.id)).toContain('regression');

      const decision = decideShadowPromotion({
        diff: diffRulepack([], [{ id: 'x', hash: 'h' }]),
        replaySafe: replay.replaySafe,
        appliedToCurrentLoop: false
      });
      expect(decision.promote).toBe(false);
      expect(decision.reasons).toContain('replay_unsafe');
    }, 180_000);
  }
);

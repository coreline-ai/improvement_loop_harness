import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXIT_CODES,
  replayAdversaryRulepack,
  runOnce,
  verifyPatch
} from './index.js';
import type {
  ReplayCase,
  RunOnceOptions,
  RunOnceResult,
  VerifyPatchOptions,
  VerifyPatchResult
} from './index.js';

describe('sdk public surface', () => {
  it('exports run/verify functions and stable public result types', () => {
    const run: typeof runOnce = runOnce;
    const verify: typeof verifyPatch = verifyPatch;
    const result: RunOnceResult = {
      loopId: 'loop-1',
      projectId: 'project-1',
      status: 'accepted',
      decision: 'accept',
      reportPath: '/tmp/report.json',
      artifactRoot: '/tmp/artifacts',
      exitCode: EXIT_CODES.accept,
      qualified: true
    };
    const verifyResult: VerifyPatchResult = result;
    const runOptions = {} as RunOnceOptions;
    const verifyOptions = {} as VerifyPatchOptions;

    expect(typeof run).toBe('function');
    expect(typeof verify).toBe('function');
    expect(verifyResult.decision).toBe('accept');
    expect(runOptions).toBeDefined();
    expect(verifyOptions).toBeDefined();
  });

  it('executes an M4 replay corpus through an injectable deterministic runner', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-sdk-replay-'));
    const corpusFile = path.join(dir, 'corpus.json');
    const outFile = path.join(dir, 'm4-replay.json');
    try {
      await writeFile(
        corpusFile,
        `${JSON.stringify(
          {
            schema_version: '1.0',
            kind: 'adversary_replay_corpus',
            cases: [
              {
                id: 'known-good',
                command: 'npm test',
                expect: 'pass'
              }
            ] satisfies ReplayCase[]
          },
          null,
          2
        )}\n`
      );

      const report = await replayAdversaryRulepack({
        corpusFile,
        execute: true,
        worktreePath: dir,
        image: 'node:22-alpine',
        outputFile: outFile,
        runtimeAvailable: async () => true,
        replayRunner: async (cases) => ({
          replaySafe: true,
          total: cases.length,
          matched: cases.length,
          mismatches: []
        })
      });

      expect(report).toMatchObject({
        kind: 'adversary_rulepack_replay',
        authority: 'deterministic_m4_replay',
        decision_impact: 'none',
        execute_requested: true,
        executed: true,
        runtime_available: true,
        replaySafe: true,
        total: 1,
        matched: 1,
        next_step: 'freeze_rulepack_next_loop'
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when M4 replay execution is requested but the runtime is unavailable', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-sdk-replay-'));
    const corpusFile = path.join(dir, 'corpus.json');
    try {
      await writeFile(
        corpusFile,
        `${JSON.stringify([
          {
            id: 'known-good',
            command: 'npm test',
            expect: 'pass'
          }
        ])}\n`
      );

      const report = await replayAdversaryRulepack({
        corpusFile,
        execute: true,
        worktreePath: dir,
        image: 'node:22-alpine',
        runtimeAvailable: async () => false
      });

      expect(report).toMatchObject({
        execute_requested: true,
        executed: false,
        runtime_available: false,
        replaySafe: false,
        total: 1,
        matched: 0,
        next_step: 'execute_required'
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

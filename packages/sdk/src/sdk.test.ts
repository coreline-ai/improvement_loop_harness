import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGates, type GateRunContext } from '@vibeloop/eval-engine';
import type { EvalConfig, TaskDefinition } from '@vibeloop/task-protocol';
import { describe, expect, it } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import {
  EXIT_CODES,
  buildAdversaryReplayCorpus,
  buildAdversaryRulepackCandidate,
  freezeAdversaryRulepack,
  promoteSelectedPatch,
  replayAdversaryRulepack,
  runOnce,
  verifyPatch
} from './index.js';
import { scoreArtifactSignalsForSelection } from './improvement-loop.js';
import type {
  ReplayCase,
  RunOnceOptions,
  RunOnceResult,
  VerifyPatchOptions,
  VerifyPatchResult
} from './index.js';

function semanticEvalConfig(rulepackFile: string): EvalConfig {
  return {
    schema_version: '1.0',
    project: 'sdk-rulepack-semantic-fixture',
    execution: { isolation: 'none' },
    rulepack_semantic: {
      file: rulepackFile,
      image: 'node:22-alpine',
      network: 'none'
    },
    gates: [
      {
        name: 'rulepack_semantic',
        type: 'integrity',
        command: 'builtin:rulepack-semantic',
        required: true
      }
    ]
  };
}

function semanticTask(): TaskDefinition {
  return {
    id: 'rulepack-semantic-n-plus-one',
    title: 'Rulepack semantic N+1 verification',
    objective: 'Verify frozen adversary rulepack enforcement on the next loop.',
    write_scope: { allowed: ['src/', 'tests/'] },
    required_evidence: ['adds_regression_test']
  };
}

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

  it('penalizes existing test-file mutations in fixed selection scoring', () => {
    const implementationOnly = scoreArtifactSignalsForSelection({
      evidencePresent: 1,
      changedFiles: 1,
      changedLines: 9,
      testFileModifications: 0,
      qualityMetricScore: 0
    });
    const sourcePlusVerifierMutation = scoreArtifactSignalsForSelection({
      evidencePresent: 1,
      changedFiles: 2,
      changedLines: 4,
      testFileModifications: 1,
      qualityMetricScore: 0
    });

    expect(implementationOnly.test_file_modifications).toBe(0);
    expect(sourcePlusVerifierMutation.test_file_modifications).toBe(1);
    expect(implementationOnly.total).toBeGreaterThan(
      sourcePlusVerifierMutation.total
    );
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

  it('carries an M2/M4 frozen rulepack into the next loop semantic gate', async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-sdk-rulepack-n1-')
    );
    const handoffFile = path.join(dir, 'adversary-m2-handoff.json');
    const confirmationFile = path.join(dir, 'm2-confirmation.json');
    const candidateFile = path.join(dir, 'rulepack-candidate.json');
    const corpusFile = path.join(dir, 'replay-corpus.json');
    const replayFile = path.join(dir, 'm4-replay.json');
    const freezeFile = path.join(dir, 'freeze-report.json');
    const rulepackFile = path.join(dir, 'rulepack.lock.json');
    const goodWorktree = path.join(dir, 'loop-n-plus-one-good');
    const badWorktree = path.join(dir, 'loop-n-plus-one-bad');
    try {
      await writeFile(
        handoffFile,
        `${JSON.stringify(
          {
            schema_version: '1.0',
            kind: 'adversary_m2_handoff',
            authority: 'advisory_only',
            decision_impact: 'none',
            loop_id: 'loop-n',
            base_commit: 'base-before-learning',
            selected_candidate_id: 'loop-n-c0',
            selected_patch: '/tmp/loop-n-candidate.patch',
            next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
            proposals: [
              {
                proposal: {
                  id: 'p-value-edge',
                  targetPath: 'tests/adversary/value-semantic.test.cjs',
                  body: [
                    "const value = require('../../src/value.cjs');",
                    'if (value !== 2) process.exit(1);',
                    ''
                  ].join('\n'),
                  expectation: 'fail_to_pass'
                },
                next_step: 'm2_execution_required'
              }
            ]
          },
          null,
          2
        )}\n`
      );
      await writeFile(
        confirmationFile,
        `${JSON.stringify(
          {
            schema_version: '1.0',
            kind: 'adversary_m2_confirmation',
            handoff_ref: handoffFile,
            authority: 'deterministic_isolated_execution',
            decision_impact: 'none',
            execute_requested: true,
            executed: true,
            runtime_available: true,
            selected_candidate_id: 'loop-n-c0',
            proposal_count: 1,
            confirmed_count: 1,
            all_confirmed: true,
            execution: {
              image: 'node:22-alpine',
              test_command: 'node tests/adversary/value-semantic.test.cjs',
              network: 'none'
            },
            next_step: 'm4_replay_freeze_required',
            confirmations: [
              {
                proposalId: 'p-value-edge',
                executed: true,
                confirmed: true,
                reason: 'base failed and candidate passed under isolation'
              }
            ]
          },
          null,
          2
        )}\n`
      );

      const candidate = await buildAdversaryRulepackCandidate({
        handoffFile,
        confirmationFile,
        outputFile: candidateFile
      });
      expect(candidate).toMatchObject({
        candidate_created: true,
        source_loop_id: 'loop-n',
        source_base_commit: 'base-before-learning'
      });

      const corpus = await buildAdversaryReplayCorpus({
        handoffFile,
        candidateFile,
        testCommand: 'npm test',
        outputFile: corpusFile
      });
      expect(corpus.case_count).toBe(1);

      const replay = await replayAdversaryRulepack({
        corpusFile,
        execute: true,
        worktreePath: dir,
        image: 'node:22-alpine',
        outputFile: replayFile,
        runtimeAvailable: async () => true,
        replayRunner: async (cases) => ({
          replaySafe: true,
          total: cases.length,
          matched: cases.length,
          mismatches: []
        })
      });
      expect(replay.replaySafe).toBe(true);

      const freeze = await freezeAdversaryRulepack({
        candidateFile,
        replayFile,
        outputFile: freezeFile,
        rulepackOutFile: rulepackFile
      });
      expect(freeze).toMatchObject({
        frozen: true,
        next_step: 'use_as_next_loop_fixed_gate',
        rulepack_ref: rulepackFile,
        frozen_rulepack: {
          source_loop_id: 'loop-n',
          source_base_commit: 'base-before-learning'
        }
      });

      async function prepareWorktree(
        root: string,
        valueSource: string
      ): Promise<GateRunContext> {
        await mkdir(path.join(root, 'src'), { recursive: true });
        await writeFile(path.join(root, 'src/value.cjs'), valueSource);
        const artifactRoot = path.join(root, '.artifacts');
        await mkdir(path.join(artifactRoot, 'input'), { recursive: true });
        const taskFile = path.join(artifactRoot, 'input/task.yaml');
        await writeFile(taskFile, 'id: rulepack-semantic-n-plus-one\n');
        return {
          evalConfig: semanticEvalConfig(rulepackFile),
          task: semanticTask(),
          taskFile,
          baseCommit: 'loop-n-plus-one-base',
          loopId: 'loop-n-plus-one',
          worktreeRoot: root,
          artifactRoot,
          env: { PATH: process.env.PATH ?? '' },
          changedFiles: [
            {
              path: 'src/value.cjs',
              status: 'modified',
              isSymlink: false,
              addedLines: 1,
              deletedLines: 1
            }
          ],
          rulepackSemanticRuntimeAvailable: async () => true,
          rulepackSemanticCommandRunner: async (_command, options) => {
            const valueSource = await readFile(
              path.join(options.worktreePath, 'src/value.cjs'),
              'utf8'
            );
            return valueSource.includes('module.exports = 2')
              ? { status: 'pass', stdout: '', stderr: '' }
              : { status: 'fail', stdout: 'semantic value check failed\n', stderr: '' };
          }
        };
      }

      const good = await runGates(
        await prepareWorktree(goodWorktree, 'module.exports = 2;\n')
      );
      const bad = await runGates(
        await prepareWorktree(badWorktree, 'module.exports = 1;\n')
      );
      expect(
        good.report.gates.find((gate) => gate.name === 'rulepack_semantic')
          ?.status
      ).toBe('pass');
      expect(
        bad.report.gates.find((gate) => gate.name === 'rulepack_semantic')
          ?.status
      ).toBe('fail');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses local promotion when candidate.patch no longer matches the expected hash', async () => {
    const repo = await createTempGitRepo();
    const patchDir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-sdk-pr-'));
    const patchPath = path.join(patchDir, 'candidate.patch');
    await writeFile(
      patchPath,
      [
        'diff --git a/README.md b/README.md',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1,2 @@',
        ' # fixture repo',
        '+patched',
        ''
      ].join('\n')
    );
    const baseCommit = (await repo.git(['rev-parse', 'HEAD'])).trim();

    await expect(
      promoteSelectedPatch({
        repoPath: repo.repoPath,
        baseCommit,
        branchName: 'pr-candidate/stale-patch',
        patchPath,
        expectedPatchHash: '0'.repeat(64),
        commitMessage: 'apply candidate patch'
      })
    ).rejects.toThrow(/candidate patch hash mismatch/i);

    expect((await repo.git(['branch', '--show-current'])).trim()).toBe('main');
    expect(await repo.git(['status', '--short'])).toBe('');
  });

  it('rescans candidate.patch for artifact leaks before local promotion', async () => {
    const repo = await createTempGitRepo();
    const patchDir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-sdk-pr-'));
    const patchPath = path.join(patchDir, 'candidate.patch');
    await writeFile(
      patchPath,
      [
        'diff --git a/README.md b/README.md',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1,2 @@',
        ' # fixture repo',
        '+LEAK_MARKER_ABC',
        ''
      ].join('\n')
    );
    const baseCommit = (await repo.git(['rev-parse', 'HEAD'])).trim();

    await expect(
      promoteSelectedPatch({
        repoPath: repo.repoPath,
        baseCommit,
        branchName: 'pr-candidate/leaky-patch',
        patchPath,
        artifactLeak: {
          scan_patch: true,
          forbidden_literals: [
            { label: 'fixture_marker', value: 'LEAK_MARKER_ABC' }
          ]
        },
        commitMessage: 'apply candidate patch'
      })
    ).rejects.toThrow(/artifact-leak rescan/i);

    expect((await repo.git(['branch', '--show-current'])).trim()).toBe('main');
    expect(await repo.git(['status', '--short'])).toBe('');
  });
});

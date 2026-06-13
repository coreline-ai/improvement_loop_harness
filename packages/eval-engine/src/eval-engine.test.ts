import {
  access,
  mkdtemp,
  readFile,
  realpath,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractDiff, type GuardChangedFile } from '@vibeloop/guards';
import type { EvalConfig, TaskDefinition } from '@vibeloop/task-protocol';
import { describe, expect, it } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import { captureBaseline, type BaselineReport } from './baseline.js';
import { detectAddsRegressionTest } from './detectors/adds-regression-test.js';
import { detectImprovesLatency } from './detectors/improves-latency.js';
import { detectIncreasesCoverage } from './detectors/increases-coverage.js';
import { EvalInterpolationError } from './errors.js';
import { interpolate, interpolationValues } from './interpolate.js';
import { runGates } from './orchestrator.js';
import { verifyTestOnBase } from './test-on-base.js';
import type { GateRunContext } from './types.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function baseTask(): TaskDefinition {
  return {
    id: 'phase-six-task',
    title: 'Phase six task',
    objective: 'Verify phase six gate execution behavior',
    write_scope: { allowed: ['src/', 'tests/'] },
    required_evidence: ['adds_regression_test']
  };
}

function baseConfig(gates: EvalConfig['gates']): EvalConfig {
  return {
    schema_version: '1.0',
    project: 'phase-six-fixture',
    protected_paths: [
      '.env',
      '.env.*',
      'eval.yaml',
      'scripts/eval.sh',
      '.github/workflows/'
    ],
    limits: { max_changed_files: 20, max_changed_lines: 500 },
    test_integrity: {
      forbidden_patterns: ['it.only', 'test.skip'],
      suspicious_patterns: ['expect(true).toBe(true)']
    },
    gates
  };
}

async function contextFor(options: {
  gates: EvalConfig['gates'];
  changedFiles?: GuardChangedFile[];
  task?: TaskDefinition;
}): Promise<GateRunContext> {
  const worktreeRoot = await tempDir('vibeloop-eval-worktree-');
  const artifactRoot = await tempDir('vibeloop-eval-artifacts-');
  const taskFile = path.join(artifactRoot, 'input', 'task.yaml');
  await writeFile(taskFile, 'id: phase-six-task\n', { flag: 'w' }).catch(
    async () => {
      await import('node:fs/promises').then(({ mkdir }) =>
        mkdir(path.dirname(taskFile), { recursive: true })
      );
      await writeFile(taskFile, 'id: phase-six-task\n');
    }
  );

  return {
    evalConfig: baseConfig(options.gates),
    task: options.task ?? baseTask(),
    taskFile,
    baseCommit: 'abc123',
    loopId: 'loop-phase-six',
    worktreeRoot,
    artifactRoot,
    env: { PATH: process.env.PATH ?? '' },
    changedFiles: options.changedFiles ?? [
      {
        path: 'src/app.ts',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 0
      }
    ]
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('interpolation', () => {
  it('substitutes the five eval variables and rejects unsupported or unresolved placeholders', () => {
    const values = interpolationValues({
      taskFile: '/tmp/task.yaml',
      baseCommit: 'abc123',
      loopId: 'loop-1',
      worktreeRoot: '/tmp/worktree',
      artifactRoot: '/tmp/artifacts'
    });

    expect(
      interpolate(
        'echo ${TASK_FILE} ${BASE_COMMIT} ${LOOP_ID} ${WORKTREE_ROOT} ${ARTIFACT_ROOT}',
        values
      )
    ).toBe('echo /tmp/task.yaml abc123 loop-1 /tmp/worktree /tmp/artifacts');
    expect(() => interpolate('echo ${UNKNOWN}', values)).toThrow(
      EvalInterpolationError
    );
  });
});

describe('runGates', () => {
  it('skips project commands when a required guard fails before spawning them', async () => {
    const context = await contextFor({
      gates: [
        {
          name: 'protected_files',
          type: 'scope',
          command: 'builtin:protected-files',
          required: true
        },
        {
          name: 'unit_tests',
          type: 'hard',
          command:
            "node -e \"require('node:fs').writeFileSync('${ARTIFACT_ROOT}/marker.txt','ran')\"",
          required: true
        }
      ],
      changedFiles: [
        {
          path: '.env.local',
          status: 'modified',
          isSymlink: false,
          addedLines: 1,
          deletedLines: 0
        }
      ],
      task: { ...baseTask(), write_scope: { allowed: ['.env.local'] } }
    });

    const result = await runGates(context);

    expect(result.report.gates.map((gate) => gate.status)).toEqual([
      'fail',
      'skipped'
    ]);
    await expect(readFile(result.reportPath, 'utf8')).resolves.toContain(
      'protected_files'
    );
    await expect(
      fileExists(path.join(context.artifactRoot, 'marker.txt'))
    ).resolves.toBe(false);
  });

  it('records exactly one result for each pass, fail, and skipped gate', async () => {
    const context = await contextFor({
      gates: [
        {
          name: 'diff_scope',
          type: 'scope',
          command: 'builtin:diff-scope',
          required: true
        },
        {
          name: 'typecheck',
          type: 'hard',
          command: 'node -e "process.exit(2)"',
          required: true
        },
        {
          name: 'unit_tests',
          type: 'hard',
          command: 'node -e "process.exit(0)"',
          required: true
        },
        {
          name: 'critic',
          type: 'advisory',
          command: 'node -e "process.exit(0)"',
          required: false
        }
      ]
    });

    const result = await runGates(context);
    const counts = result.report.gates.reduce<Record<string, number>>(
      (acc, gate) => {
        acc[gate.status] = (acc[gate.status] ?? 0) + 1;
        return acc;
      },
      {}
    );

    expect(result.report.gates).toHaveLength(context.evalConfig.gates.length);
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(
      context.evalConfig.gates.length
    );
    expect(counts).toMatchObject({ pass: 1, fail: 1, skipped: 2 });
  });

  it('maps timeout gates to error and terminates the timed-out process group', async () => {
    const context = await contextFor({
      gates: [
        {
          name: 'timeout_gate',
          type: 'hard',
          command:
            "node -e \"setTimeout(()=>require('node:fs').writeFileSync('${ARTIFACT_ROOT}/late.txt','late'),1500); setInterval(()=>{},1000)\"",
          required: false,
          timeout_seconds: 1
        }
      ]
    });

    const result = await runGates(context);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(result.report.gates[0]?.status).toBe('error');
    await expect(
      fileExists(path.join(context.artifactRoot, 'late.txt'))
    ).resolves.toBe(false);
  });

  it('executes commands from WORKTREE_ROOT after interpolation', async () => {
    const context = await contextFor({
      gates: [
        {
          name: 'cwd_check',
          type: 'hard',
          command:
            "node -e \"require('node:fs').writeFileSync('${ARTIFACT_ROOT}/cwd.txt', process.cwd())\"",
          required: true
        }
      ]
    });

    const result = await runGates(context);

    expect(result.report.gates[0]?.status).toBe('pass');
    const cwd = await readFile(
      path.join(context.artifactRoot, 'cwd.txt'),
      'utf8'
    );
    await expect(realpath(context.worktreeRoot)).resolves.toBe(cwd);
  });
});

describe('builtin:artifact-leak gate (fail-open invariant)', () => {
  const artifactLeakGate: EvalConfig['gates'] = [
    {
      name: 'artifact_leak',
      type: 'integrity',
      command: 'builtin:artifact-leak',
      required: true
    }
  ];

  it('fails closed when artifact_leak is configured but no precomputed result reaches the gate', async () => {
    const context = await contextFor({ gates: artifactLeakGate });
    // Configured, but the kernel never handed a verdict to the gate. This must
    // NOT silently pass — a not-evaluated guard is a fail-open hazard.
    context.evalConfig.artifact_leak = {
      scan_agent_stdout: true,
      scan_agent_stderr: true
    };
    context.artifactLeak = undefined;

    const result = await runGates(context);
    const gate = result.report.gates.find((g) => g.name === 'artifact_leak');
    expect(gate?.status).toBe('error');
    expect(gate?.summary).toContain('artifact_leak is configured');
  });

  it('passes as not-configured when artifact_leak is absent and no result is provided (backward compatible)', async () => {
    const context = await contextFor({ gates: artifactLeakGate });
    context.evalConfig.artifact_leak = undefined;
    context.artifactLeak = undefined;

    const result = await runGates(context);
    const gate = result.report.gates.find((g) => g.name === 'artifact_leak');
    expect(gate?.status).toBe('pass');
    expect(gate?.summary).toContain('not configured');
  });

  it('surfaces the precomputed verdict (pass or fail) when one is provided', async () => {
    const passCtx = await contextFor({ gates: artifactLeakGate });
    passCtx.evalConfig.artifact_leak = { scan_agent_stdout: true };
    passCtx.artifactLeak = {
      status: 'pass',
      summary: 'no leak',
      violations: []
    };
    const passResult = await runGates(passCtx);
    expect(
      passResult.report.gates.find((g) => g.name === 'artifact_leak')?.status
    ).toBe('pass');

    const failCtx = await contextFor({ gates: artifactLeakGate });
    failCtx.evalConfig.artifact_leak = { scan_agent_stdout: true };
    failCtx.artifactLeak = {
      status: 'fail',
      code: 'ARTIFACT_LEAK',
      summary: 'forbidden literal leaked',
      violations: [{ code: 'ARTIFACT_LEAK', message: 'leak' }]
    };
    const failResult = await runGates(failCtx);
    expect(
      failResult.report.gates.find((g) => g.name === 'artifact_leak')?.status
    ).toBe('fail');
  });
});

describe('baseline, test-on-base, and evidence detection', () => {
  it('marks adds_regression_test present only when the new test fails on base and passes on candidate', async () => {
    const repo = await createTempGitRepo();
    const baseRepoPath = path.join(
      await tempDir('vibeloop-test-on-base-'),
      'base'
    );

    await repo.write('src/value.cjs', 'module.exports = 1;\n');
    await repo.git(['add', 'src/value.cjs']);
    await repo.git(['commit', '-m', 'add base source']);
    const baseCommit = (await repo.git(['rev-parse', 'HEAD'])).trim();
    await repo.git(['worktree', 'add', '--detach', baseRepoPath, baseCommit]);

    await repo.write('src/value.cjs', 'module.exports = 2;\n');
    await repo.write(
      'tests/regression.test.js',
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
    );
    const diff = await extractDiff({ repoPath: repo.repoPath, baseCommit });
    const artifactRoot = await tempDir('vibeloop-test-on-base-artifacts-');

    const report = await verifyTestOnBase({
      baseRepoPath,
      candidateRepoPath: repo.repoPath,
      candidatePatch: diff.candidatePatch,
      changedFiles: diff.changedFiles,
      requiredTests: ['node tests/regression.test.js'],
      artifactRoot,
      env: { PATH: process.env.PATH ?? '' }
    });
    const evidence = detectAddsRegressionTest({
      changedFiles: diff.changedFiles,
      testOnBase: report
    });

    expect(report.base_failed_candidate_passed).toBe(true);
    expect(evidence).toMatchObject({
      type: 'adds_regression_test',
      status: 'present',
      artifact_ref: 'reports/test-on-base.json'
    });
  });

  it('marks a new test missing when it also passes on base', () => {
    const evidence = detectAddsRegressionTest({
      changedFiles: [
        {
          path: 'tests/noop.test.ts',
          status: 'added',
          isSymlink: false,
          addedLines: 1,
          deletedLines: 0
        }
      ],
      testOnBase: {
        schema_version: '1.0',
        artifact_ref: 'reports/test-on-base.json',
        test_files: ['tests/noop.test.ts'],
        cases: [
          {
            command: 'node tests/noop.test.ts',
            base_status: 'pass',
            candidate_status: 'pass',
            base_exit_code: 0,
            candidate_exit_code: 0
          }
        ],
        base_failed_candidate_passed: false
      }
    });

    expect(evidence.status).toBe('missing');
  });

  it('reuses baseline cache on second run and treats missing latency baseline as inconclusive', async () => {
    const dataDir = await tempDir('vibeloop-baseline-cache-');
    const worktreeRoot = await tempDir('vibeloop-baseline-worktree-');
    const firstArtifactRoot = await tempDir('vibeloop-baseline-artifacts-1-');
    const secondArtifactRoot = await tempDir('vibeloop-baseline-artifacts-2-');
    const countFile = path.join(worktreeRoot, 'count.txt');
    const evalConfig = baseConfig([
      {
        name: 'latency_benchmark',
        type: 'performance',
        command:
          "node -e \"const fs=require('node:fs'); const p='${WORKTREE_ROOT}/count.txt'; const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0; fs.writeFileSync(p,String(n+1)); console.log('latency_ms=100')\"",
        required: false
      }
    ]);

    const first = await captureBaseline({
      evalConfig,
      projectId: 'proj-cache',
      baseCommit: 'base-1',
      worktreeRoot,
      artifactRoot: firstArtifactRoot,
      dataDir,
      env: { PATH: process.env.PATH ?? '' }
    });
    const second = await captureBaseline({
      evalConfig,
      projectId: 'proj-cache',
      baseCommit: 'base-1',
      worktreeRoot,
      artifactRoot: secondArtifactRoot,
      dataDir,
      env: { PATH: process.env.PATH ?? '' }
    });

    await expect(readFile(countFile, 'utf8')).resolves.toBe('1');
    expect(first.cache_hit).toBe(false);
    expect(second.cache_hit).toBe(true);
    expect(second.metrics.latency_ms).toBe(100);
    expect(
      detectImprovesLatency({
        changedFiles: [],
        candidateMetrics: { latency_ms: 90 }
      }).status
    ).toBe('inconclusive');
  });

  it('captures only comparative baseline gates and excludes ordinary hard test gates', async () => {
    const dataDir = await tempDir('vibeloop-baseline-selection-cache-');
    const worktreeRoot = await tempDir('vibeloop-baseline-selection-worktree-');
    const artifactRoot = await tempDir(
      'vibeloop-baseline-selection-artifacts-'
    );
    const hardMarker = path.join(worktreeRoot, 'hard-ran.txt');
    const coverageMarker = path.join(worktreeRoot, 'coverage-ran.txt');
    const evalConfig = baseConfig([
      {
        name: 'unit_tests',
        type: 'hard',
        command:
          "node -e \"require('node:fs').writeFileSync('hard-ran.txt', 'yes')\"",
        required: true
      },
      {
        name: 'coverage_report',
        type: 'regression',
        command:
          "node -e \"require('node:fs').writeFileSync('coverage-ran.txt', 'yes'); console.log('coverage_percent=81')\"",
        required: false
      },
      {
        name: 'security_scan',
        type: 'security',
        command: 'node -e "console.log(\'security_findings=0\')"',
        required: false
      }
    ]);

    const baseline = await captureBaseline({
      evalConfig,
      projectId: 'proj-baseline-selection',
      baseCommit: 'base-selection',
      worktreeRoot,
      artifactRoot,
      dataDir,
      env: { PATH: process.env.PATH ?? '' }
    });

    await expect(access(hardMarker)).rejects.toThrow();
    await expect(access(coverageMarker)).resolves.toBeUndefined();
    expect(baseline.gate_runs.map((gate) => gate.name)).toEqual([
      'coverage_report',
      'security_scan'
    ]);
    expect(baseline.metrics.coverage_percent).toBe(81);
  });

  it('marks increases_coverage present when candidate coverage is higher than baseline', () => {
    const baseline: BaselineReport = {
      schema_version: '1.0',
      project: 'coverage-fixture',
      project_id: 'proj-coverage',
      base_commit: 'base-coverage',
      eval_config_hash: 'hash',
      cache_key: 'cache',
      cache_hit: false,
      generated_at: new Date('2026-06-10T00:00:00.000Z').toISOString(),
      gate_runs: [],
      base_red_tests: [],
      metrics: { coverage_percent: 70 }
    };

    const evidence = detectIncreasesCoverage({
      changedFiles: [],
      baseline,
      candidateMetrics: { coverage_percent: 72 },
      gateRuns: [
        {
          name: 'test_integrity',
          type: 'integrity',
          required: true,
          command: 'builtin:test-integrity',
          status: 'pass',
          exit_code: 0,
          started_at: null,
          finished_at: null,
          duration_ms: null,
          stdout_ref: null,
          stderr_ref: null,
          summary: null
        }
      ]
    });

    expect(evidence).toMatchObject({
      type: 'increases_coverage',
      status: 'present'
    });
  });
});

import {
  access,
  mkdtemp,
  readFile,
  realpath,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GuardChangedFile } from '@vibeloop/guards';
import type { EvalConfig, TaskDefinition } from '@vibeloop/task-protocol';
import { describe, expect, it } from 'vitest';
import { EvalInterpolationError } from './errors.js';
import { interpolate, interpolationValues } from './interpolate.js';
import { runGates } from './orchestrator.js';
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

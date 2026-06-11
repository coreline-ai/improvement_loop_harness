import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import { EXIT_CODES } from './exit-codes.js';
import { createProgram, VERSION } from './index.js';
import { renderLoopHtmlReport } from './commands/report.js';
import { retryLoop } from './commands/retry.js';
import { runKernel } from './run.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFixtureTaskEval(options: {
  dir: string;
  taskId: string;
  allowed?: string[] | undefined;
  protectedPaths?: string[] | undefined;
  requiredTests?: string[] | undefined;
  gates?: string | undefined;
}): Promise<{ taskFile: string; evalFile: string }> {
  const taskFile = path.join(options.dir, `${options.taskId}.task.yaml`);
  const evalFile = path.join(options.dir, `${options.taskId}.eval.yaml`);
  const allowed = options.allowed ?? ['src/', 'tests/'];
  const requiredTests = options.requiredTests ?? ['node tests/regression.test.js'];
  await writeFile(
    taskFile,
    [
      'schema_version: "1.0"',
      `id: ${options.taskId}`,
      'title: CLI kernel fixture',
      'objective: Verify the CLI kernel can fix one small problem',
      'base_branch: main',
      'risk_area: none',
      'write_scope:',
      '  allowed:',
      ...allowed.map((entry) => `    - ${entry}`),
      'required_evidence:',
      '  - adds_regression_test',
      'limits:',
      '  max_changed_files: 10',
      '  max_changed_lines: 200',
      'acceptance:',
      '  required_tests:',
      ...requiredTests.map((entry) => `    - ${entry}`),
      ''
    ].join('\n')
  );
  await writeFile(
    evalFile,
    options.gates ??
      [
        'schema_version: "1.0"',
        'project: cli-fixture',
        'protected_paths:',
        ...(options.protectedPaths ?? ['.env', '.env.*', 'eval.yaml', 'scripts/eval.sh']).map(
          (entry) => `  - ${entry}`
        ),
        'risk_classification:',
        '  none:',
        '    - src/',
        '    - tests/',
        '    - .env.local',
        'limits:',
        '  max_changed_files: 10',
        '  max_changed_lines: 200',
        'test_integrity:',
        '  forbidden_patterns:',
        '    - test.skip',
        '    - it.only',
        '  suspicious_patterns:',
        '    - expect(true).toBe(true)',
        'gates:',
        '  - name: protected_files',
        '    type: scope',
        '    command: builtin:protected-files',
        '    required: true',
        '  - name: diff_scope',
        '    type: scope',
        '    command: builtin:diff-scope',
        '    required: true',
        '  - name: limits',
        '    type: integrity',
        '    command: builtin:limits',
        '    required: true',
        '  - name: test_integrity',
        '    type: integrity',
        '    command: builtin:test-integrity',
        '    required: true',
        '  - name: unit_tests',
        '    type: task_acceptance',
        '    command: node tests/regression.test.js',
        '    required: true',
        ''
      ].join('\n')
  );
  return { taskFile, evalFile };
}

async function createValueRepo(): Promise<Awaited<ReturnType<typeof createTempGitRepo>>> {
  const repo = await createTempGitRepo();
  await repo.write('src/value.cjs', 'module.exports = 1;\n');
  await repo.git(['add', 'src/value.cjs']);
  await repo.git(['commit', '-m', 'add value source']);
  return repo;
}

async function writeScenario(dir: string, name: string, actions: unknown[]): Promise<string> {
  const scenario = path.join(dir, `${name}.json`);
  await writeFile(scenario, `${JSON.stringify({ actions }, null, 2)}\n`);
  return scenario;
}

describe('createProgram', () => {
  it('configures the vibeloop CLI version and Phase 10 commands', () => {
    const program = createProgram();

    expect(program.name()).toBe('vibeloop');
    expect(program.version()).toBe(VERSION);
    expect(program.commands.map((command) => command.name()).sort()).toEqual([
      'gc',
      'report',
      'retry',
      'run'
    ]);
  });
});

describe('runKernel', () => {
  it('runs the mock happy path, writes fixed inputs/workspace ref, and exits 0 with eval-report.json', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-data-');
    const fixtureDir = await tempDir('vibeloop-cli-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({ dir: fixtureDir, taskId: 'cli-happy' });
    const scenario = await writeScenario(fixtureDir, 'happy', [
      { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
      }
    ]);

    const result = await runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-happy',
      skipDependencyInstall: true
    });
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8')) as {
      decision: string;
      improvement_evidence: Array<{ status: string }>;
      artifact_refs: string[];
    };

    expect(result.exitCode).toBe(EXIT_CODES.accept);
    expect(result.status).toBe('accepted');
    expect(report.decision).toBe('accept');
    expect(report.improvement_evidence[0]?.status).toBe('present');
    await expect(fileExists(path.join(result.layout.input, 'task.yaml'))).resolves.toBe(true);
    await expect(fileExists(path.join(result.layout.input, 'eval.yaml'))).resolves.toBe(true);
    await expect(fileExists(path.join(result.layout.input, 'base_commit.txt'))).resolves.toBe(true);
    await expect(fileExists(path.join(result.layout.input, 'env-snapshot.json'))).resolves.toBe(true);
    await expect(fileExists(path.join(result.layout.workspace, 'workspace-ref.json'))).resolves.toBe(true);
    expect(report.artifact_refs).toContain('workspace/workspace-ref.json');
    const html = await renderLoopHtmlReport({ dataDir, loopId: result.loopId });
    expect(html.fileUrl).toMatch(/^file:\/\//);
    expect(await readFile(html.path, 'utf8')).toContain('VibeLoop Eval Report');
  });

  it('rejects guard failures, still writes eval-report.json, and skips project gates', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-guard-data-');
    const fixtureDir = await tempDir('vibeloop-cli-guard-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cli-guard',
      allowed: ['.env.local'],
      requiredTests: ['node -e "require(\'node:fs\').writeFileSync(\'project-gate-ran\',\'yes\')"']
    });
    const scenario = await writeScenario(fixtureDir, 'guard', [
      { type: 'create', path: '.env.local', content: 'token=secret\n' }
    ]);

    const result = await runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-guard',
      skipDependencyInstall: true
    });
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8')) as {
      decision: string;
      gate_runs: Array<{ name: string; status: string }>;
      decision_reasons: Array<{ code: string }>;
    };

    expect(result.exitCode).toBe(EXIT_CODES.reject);
    expect(result.status).toBe('rejected');
    expect(report.decision).toBe('reject');
    expect(report.decision_reasons[0]?.code).toBe('GUARD_PROTECTED_PATH');
    expect(report.gate_runs.find((gate) => gate.name === 'unit_tests')?.status).toBe('skipped');
  });

  it('retry_eval_only creates a new loop and reevaluates stored candidate.patch without rerunning the agent', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-retry-data-');
    const fixtureDir = await tempDir('vibeloop-cli-retry-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({ dir: fixtureDir, taskId: 'cli-retry' });
    const scenario = await writeScenario(fixtureDir, 'retry-source', [
      { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
      }
    ]);

    const first = await runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-retry-source',
      skipDependencyInstall: true
    });
    const retried = await retryLoop({
      dataDir,
      previousLoopId: first.loopId,
      mode: 'retry_eval_only',
      newLoopId: 'loop-cli-retry-eval-only',
      skipDependencyInstall: true
    });
    const retryReport = JSON.parse(await readFile(retried.reportPath!, 'utf8')) as { decision: string };
    const agentLog = await readFile(path.join(retried.layout.logs, 'agent.stdout.log'), 'utf8');
    const workspaceRef = JSON.parse(
      await readFile(path.join(retried.layout.workspace, 'workspace-ref.json'), 'utf8')
    ) as { retry_of: string; retry_mode: string };

    expect(retried.loopId).not.toBe(first.loopId);
    expect(retried.loopId).toBe('loop-cli-retry-eval-only');
    expect(retryReport.decision).toBe('accept');
    expect(agentLog).toContain('agent skipped for retry_eval_only');
    expect(workspaceRef).toMatchObject({ retry_of: first.loopId, retry_mode: 'retry_eval_only' });
  });

  it('cancels gracefully through the SIGINT abort path and removes git worktrees', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-cancel-data-');
    const fixtureDir = await tempDir('vibeloop-cli-cancel-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({ dir: fixtureDir, taskId: 'cli-cancel' });
    const scenario = await writeScenario(fixtureDir, 'sleep', [{ type: 'sleep', ms: 2_000 }]);
    const controller = new AbortController();
    const running = runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-cancel',
      signal: controller.signal,
      skipDependencyInstall: true
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const result = await running;
    const worktreeList = await repo.git(['worktree', 'list', '--porcelain']);

    expect(result.exitCode).toBe(EXIT_CODES.cancelled);
    expect(result.status).toBe('cancelled');
    await expect(fileExists(result.reportPath!)).resolves.toBe(true);
    expect(worktreeList).not.toContain('loop-cli-cancel');
  });
});

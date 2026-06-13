import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface CliRunOutput {
  loop_id: string;
  project_id: string;
  status: string;
  decision: string | null;
  report: string | null;
  artifact_root: string;
}

interface EvalReportJson {
  decision: string;
  decision_reasons: Array<{ code: string; message: string }>;
  changed_files: Array<{ path: string; status: string }>;
  gate_runs: Array<{
    name: string;
    type: string;
    group?: string;
    status: string;
  }>;
  improvement_evidence: Array<{ type: string; status: string }>;
  advisory_findings?: Array<{ same_model_review?: boolean }>;
}

const SCENARIO_ROOT = path.resolve('tests/e2e/user-scenarios/cart-quantity');
const TARGET_TEMPLATE = path.join(SCENARIO_ROOT, 'target-template');

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`));
    });
  });
}

async function createRealUserTargetRepo(): Promise<{
  repoPath: string;
  initialCommit: string;
}> {
  const repoPath = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-real-user-target-')
  );
  await cp(TARGET_TEMPLATE, repoPath, { recursive: true });
  await runGit(repoPath, ['init', '-b', 'main']);
  await runGit(repoPath, ['config', 'user.email', 'real-user@example.test']);
  await runGit(repoPath, ['config', 'user.name', 'Real User Scenario']);
  await runGit(repoPath, ['add', '-A']);
  await runGit(repoPath, ['commit', '-m', 'initial cart bug fixture']);
  const initialCommit = (await runGit(repoPath, ['rev-parse', 'HEAD'])).trim();
  return { repoPath, initialCommit };
}

function runCli(
  args: readonly string[],
  options: { cwd: string }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.sequential('real user CLI scenario', () => {
  it('accepts a real cart quantity bugfix through CLI, command agent, visible and hidden acceptance', async () => {
    const { repoPath, initialCommit } = await createRealUserTargetRepo();
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-real-user-data-')
    );
    await mkdir(dataDir, { recursive: true });
    try {
      const cliPath = path.resolve('packages/cli/bin/vibeloop');
      const agentPath = path.join(SCENARIO_ROOT, 'agent-fix.cjs');
      const result = await runCli(
        [
          cliPath,
          '--data-dir',
          dataDir,
          'run',
          '--repo',
          repoPath,
          '--task',
          path.join(SCENARIO_ROOT, 'task.yaml'),
          '--eval',
          path.join(SCENARIO_ROOT, 'eval.yaml'),
          '--agent',
          `command:node ${agentPath}`,
          '--project-id',
          'real-user-cart-quantity',
          '--loop-id',
          'real-user-cart-quantity-loop',
          '--base-commit',
          initialCommit,
          '--skip-dependency-install'
        ],
        { cwd: path.resolve('.') }
      );

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as CliRunOutput;
      expect(output).toMatchObject({
        loop_id: 'real-user-cart-quantity-loop',
        project_id: 'real-user-cart-quantity',
        status: 'accepted',
        decision: 'accept'
      });
      expect(output.report).toBeTruthy();

      const report = JSON.parse(
        await readFile(output.report!, 'utf8')
      ) as EvalReportJson;
      expect(report.decision).toBe('accept');
      expect(report.decision_reasons[0]?.code).toBe('ALL_PASS');
      expect(report.changed_files.map((file) => file.path).sort()).toEqual([
        'src/cart.cjs',
        'tests/cart-quantity.test.cjs'
      ]);
      expect(
        report.gate_runs.find((gate) => gate.name === 'visible_cart_regression')
      ).toMatchObject({
        type: 'task_acceptance',
        status: 'pass'
      });
      expect(
        report.gate_runs.find(
          (gate) => gate.name === 'hidden_cart_mixed_quantities'
        )
      ).toMatchObject({
        type: 'hidden_acceptance',
        group: 'hidden_acceptance',
        status: 'pass'
      });
      expect(
        report.improvement_evidence.some((item) => item.status === 'present')
      ).toBe(true);
      expect(
        report.advisory_findings?.every(
          (finding) => finding.same_model_review === true
        )
      ).toBe(true);

      const agentStdout = await readFile(
        path.join(output.artifact_root, 'logs/agent.stdout.log'),
        'utf8'
      );
      expect(agentStdout).toContain(
        'real command agent applied cart quantity fix'
      );
      const artifactText = await readFile(output.report!, 'utf8');
      expect(artifactText).not.toContain('SECRET_HIDDEN_EXPECTATION');

      const worktreeList = await runGit(repoPath, [
        'worktree',
        'list',
        '--porcelain'
      ]);
      expect(worktreeList).not.toContain('real-user-cart-quantity-loop');
    } finally {
      await rm(repoPath, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadEvalConfig,
  loadTask
} from '../../../packages/task-protocol/src/index.js';

interface CliRunOutput {
  loop_id: string;
  project_id: string;
  status: string;
  decision: string | null;
  report: string | null;
  artifact_root: string;
}

interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const REPO_ROOT = path.resolve('.');
const SKILL_ROOT = path.join(REPO_ROOT, 'skills/vibeloop-harness');
const CREATE_TASK_EVAL_SCRIPT = path.join(
  SKILL_ROOT,
  'scripts/create-task-eval.mjs'
);
const CLASSIFY_INTENT_SCRIPT = path.join(
  SKILL_ROOT,
  'scripts/classify-intent.mjs'
);
const SUMMARIZE_REPORT_SCRIPT = path.join(
  SKILL_ROOT,
  'scripts/summarize-report.mjs'
);
const VIBELOOP_RUN_SCRIPT = path.join(SKILL_ROOT, 'scripts/vibeloop-run.mjs');
const CART_SCENARIO_ROOT = path.join(
  REPO_ROOT,
  'tests/e2e/user-scenarios/cart-quantity'
);
const CART_TARGET_TEMPLATE = path.join(CART_SCENARIO_ROOT, 'target-template');

function runNode(
  args: readonly string[],
  options: { cwd?: string } = {}
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? REPO_ROOT,
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

async function createSkillTargetRepo(): Promise<{
  repoPath: string;
  initialCommit: string;
}> {
  const repoPath = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-skill-target-')
  );
  await cp(CART_TARGET_TEMPLATE, repoPath, { recursive: true });
  await writeFile(
    path.join(repoPath, 'package.json'),
    `${JSON.stringify(
      {
        name: 'skill-productization-cart-fixture',
        version: '1.0.0',
        private: true,
        type: 'commonjs',
        scripts: {
          test: 'for f in tests/*.test.cjs; do node "$f"; done'
        }
      },
      null,
      2
    )}\n`
  );
  await runGit(repoPath, ['init', '-b', 'main']);
  await runGit(repoPath, ['config', 'user.email', 'skill-user@example.test']);
  await runGit(repoPath, ['config', 'user.name', 'Skill Productization Test']);
  await runGit(repoPath, ['add', '-A']);
  await runGit(repoPath, ['commit', '-m', 'initial skill fixture']);
  const initialCommit = (await runGit(repoPath, ['rev-parse', 'HEAD'])).trim();
  return { repoPath, initialCommit };
}

async function writeReportFixture(
  root: string,
  name: string,
  report: unknown
): Promise<string> {
  const reportPath = path.join(root, name);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

describe.sequential('vibeloop-harness skill productization', () => {
  it('creates schema-valid task/eval files from Skill templates with safe YAML scalars', async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-template-')
    );
    try {
      const result = await runNode([
        CREATE_TASK_EVAL_SCRIPT,
        '--template',
        'node',
        '--out',
        outDir,
        '--id',
        'skill-cart-quantity',
        '--title',
        'Cart quantity: multiply price by quantity',
        '--objective',
        'Fix quantity handling: add one regression test.',
        '--project',
        'skill-productization-node'
      ]);

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as {
        task: string;
        eval: string;
      };
      await expect(loadTask(output.task)).resolves.toMatchObject({
        id: 'skill-cart-quantity',
        title: 'Cart quantity: multiply price by quantity'
      });
      await expect(loadEvalConfig(output.eval)).resolves.toMatchObject({
        project: 'skill-productization-node'
      });
      await expect(readFile(output.task, 'utf8')).resolves.toContain(
        'title: "Cart quantity: multiply price by quantity"'
      );
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('classifies natural-language Skill prompts into safe VibeLoop modes', async () => {
    const cases = [
      {
        prompt: '자동으로 문제 찾아서 하나씩 수정하고 검증 PR 후보 만들어줘',
        mode: 'auto_discovery',
        singleIssue: true
      },
      {
        prompt: 'src/cart.cjs quantity 버그 고쳐줘. 테스트도 추가해.',
        mode: 'user_issue',
        singleIssue: true
      },
      {
        prompt: '이 candidate.patch는 수정하지 말고 검증만 해줘',
        mode: 'verify_only',
        singleIssue: true
      },
      {
        prompt: '적대적 실패 케이스 UAT로 hidden leak과 tamper를 깨보기',
        mode: 'adversarial_uat',
        singleIssue: false
      },
      {
        prompt: 'FULL UAT fixture baseline 한번 실행',
        mode: 'fixture_full_uat',
        singleIssue: false
      }
    ];

    for (const entry of cases) {
      const result = await runNode([
        CLASSIFY_INTENT_SCRIPT,
        '--prompt',
        entry.prompt
      ]);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as {
        mode: string;
        single_issue_policy: boolean;
        accept_authority: string;
        full_improvement_pass_rule: string;
      };
      expect(output.mode).toBe(entry.mode);
      expect(output.single_issue_policy).toBe(entry.singleIssue);
      expect(output.accept_authority).toBe('deterministic_harness_only');
      expect(output.full_improvement_pass_rule).toContain(
        'strict_score_improvement_every_issue=false'
      );
    }
  });

  it('summarizes accept and needs-more-tests reports without leaking hidden or token-like values', async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-summary-')
    );
    const fakeBearer = `Bearer ${['sk', 'redactionvalue000'].join('-')}`;
    try {
      const acceptedReport = await writeReportFixture(
        outDir,
        'accepted-report.json',
        {
          decision: 'accept',
          decision_reasons: [{ code: 'ALL_PASS', message: 'all gates passed' }],
          changed_files: [
            { path: 'src/cart.cjs' },
            { path: 'tests/cart-quantity.test.cjs' }
          ],
          gate_runs: [
            {
              name: 'visible_cart_regression',
              type: 'task_acceptance',
              required: true,
              status: 'pass'
            }
          ],
          improvement_evidence: [
            { type: 'adds_regression_test', status: 'present' }
          ],
          risk: { human_approval_required: false }
        }
      );
      const accepted = await runNode([
        SUMMARIZE_REPORT_SCRIPT,
        '--report',
        acceptedReport
      ]);
      expect(accepted.stderr).toBe('');
      expect(accepted.code).toBe(0);
      expect(JSON.parse(accepted.stdout)).toMatchObject({
        decision: 'accept',
        reason: 'ALL_PASS',
        changedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs'],
        failedGates: [],
        nextAction: 'prepare_pr_candidate'
      });

      const needsMoreTestsReport = await writeReportFixture(
        outDir,
        'needs-more-tests-report.json',
        {
          decision: 'needs_more_tests',
          decision_reasons: [
            {
              code: 'MISSING_REQUIRED_EVIDENCE',
              message: `missing ${fakeBearer}`
            }
          ],
          changed_files: [{ path: 'src/SECRET_HIDDEN_EXPECTATION.cjs' }],
          gate_runs: [
            {
              name: 'visible_regression',
              type: 'task_acceptance',
              required: true,
              status: 'fail',
              summary: `command saw ${fakeBearer} and refresh_token=super-secret-token`
            }
          ],
          improvement_evidence: [
            {
              type: 'adds_regression_test',
              status: 'missing',
              note: 'api_key=abc123'
            }
          ],
          risk: {
            human_approval_required: false,
            note: 'password=correct-horse-battery-staple'
          }
        }
      );
      const rejected = await runNode([
        SUMMARIZE_REPORT_SCRIPT,
        needsMoreTestsReport
      ]);
      expect(rejected.stderr).toBe('');
      expect(rejected.code).toBe(0);
      const redactedText = rejected.stdout;
      expect(redactedText).not.toContain('SECRET_HIDDEN_EXPECTATION');
      expect(redactedText).not.toContain(fakeBearer);
      expect(redactedText).not.toContain('super-secret-token');
      expect(redactedText).not.toContain('abc123');
      expect(redactedText).not.toContain('correct-horse-battery-staple');
      expect(JSON.parse(redactedText)).toMatchObject({
        decision: 'needs_more_tests',
        reason: 'MISSING_REQUIRED_EVIDENCE',
        changedFiles: ['src/[REDACTED].cjs'],
        nextAction: 'fix_failed_gates_then_rerun'
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('runs a real cart fix through the Skill wrapper and summarizes the resulting report', async () => {
    const { repoPath, initialCommit } = await createSkillTargetRepo();
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-data-')
    );
    const taskEvalDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-task-eval-')
    );
    try {
      await mkdir(dataDir, { recursive: true });
      const generated = await runNode([
        CREATE_TASK_EVAL_SCRIPT,
        '--template',
        'node',
        '--out',
        taskEvalDir,
        '--id',
        'skill-productization-cart',
        '--title',
        'Cart total respects quantity',
        '--objective',
        'Fix cart total calculation and add one regression test.',
        '--project',
        'skill-productization-cart',
        '--test-command',
        'node tests/cart-quantity.test.cjs'
      ]);
      expect(generated.stderr).toBe('');
      expect(generated.code).toBe(0);
      const files = JSON.parse(generated.stdout) as {
        task: string;
        eval: string;
      };
      const agentPath = path.join(CART_SCENARIO_ROOT, 'agent-fix.cjs');
      const run = await runNode([
        VIBELOOP_RUN_SCRIPT,
        '--data-dir',
        dataDir,
        'run',
        '--repo',
        repoPath,
        '--task',
        files.task,
        '--eval',
        files.eval,
        '--agent',
        `command:node ${agentPath}`,
        '--project-id',
        'skill-productization-cart',
        '--loop-id',
        'skill-productization-cart-loop',
        '--base-commit',
        initialCommit,
        '--skip-dependency-install'
      ]);

      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const output = JSON.parse(run.stdout) as CliRunOutput;
      expect(output).toMatchObject({
        loop_id: 'skill-productization-cart-loop',
        project_id: 'skill-productization-cart',
        status: 'accepted',
        decision: 'accept'
      });
      expect(output.report).toBeTruthy();

      const summary = await runNode([
        SUMMARIZE_REPORT_SCRIPT,
        '--report',
        output.report!
      ]);
      expect(summary.stderr).toBe('');
      expect(summary.code).toBe(0);
      expect(JSON.parse(summary.stdout)).toMatchObject({
        decision: 'accept',
        reason: 'ALL_PASS',
        changedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs'],
        failedGates: [],
        nextAction: 'prepare_pr_candidate'
      });
    } finally {
      await rm(repoPath, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(taskEvalDir, { recursive: true, force: true });
    }
  }, 60_000);
});

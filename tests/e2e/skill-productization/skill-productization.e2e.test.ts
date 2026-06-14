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
const RUN_FROM_PROMPT_SCRIPT = path.join(
  SKILL_ROOT,
  'scripts/run-from-prompt.mjs'
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

function expectArgValue(
  argv: readonly string[],
  flag: string,
  value: string
): void {
  const index = argv.indexOf(flag);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(argv[index + 1]).toBe(value);
}

function expectArgValues(
  argv: readonly string[],
  flag: string,
  values: readonly string[]
): void {
  const actual = argv
    .map((item, index) => (item === flag ? argv[index + 1] : undefined))
    .filter((item): item is string => item !== undefined);
  expect(actual).toEqual(values);
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

  it('creates one bounded task/eval from a natural-language user issue prompt', async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-prompt-task-')
    );
    try {
      const prompt =
        'src/cart.cjs quantity 버그를 고쳐줘. quantity가 없으면 기본값 1로 계산하고 테스트도 추가해.';
      const result = await runNode([
        CREATE_TASK_EVAL_SCRIPT,
        '--template',
        'node',
        '--out',
        outDir,
        '--prompt',
        prompt,
        '--test-command',
        'npm test'
      ]);

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as {
        task: string;
        eval: string;
        mode: string;
        single_issue_policy: boolean;
      };
      expect(output).toMatchObject({
        mode: 'user_issue_from_prompt',
        single_issue_policy: true
      });
      await expect(loadTask(output.task)).resolves.toMatchObject({
        objective: expect.stringContaining(prompt)
      });
      await expect(loadEvalConfig(output.eval)).resolves.toMatchObject({
        project: expect.any(String)
      });
      const taskYaml = await readFile(output.task, 'utf8');
      expect(taskYaml).toContain('Fix exactly one bounded issue');
      expect(taskYaml).toContain('required_tests:');
      expect(taskYaml).toContain('"npm test"');
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

  it('routes a natural-language user issue prompt into one generated task/eval and an improve command', async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-prompt-route-')
    );
    try {
      const prompt =
        'src/cart.cjs quantity 버그를 고쳐줘. quantity가 없으면 기본값 1로 계산하고 테스트도 추가해.';
      const result = await runNode([
        RUN_FROM_PROMPT_SCRIPT,
        '--prompt',
        prompt,
        '--repo',
        '/tmp/example-repo',
        '--out',
        outDir,
        '--agent',
        'command:echo noop',
        '--test-command',
        'npm test'
      ]);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as {
        mode: string;
        single_issue_policy: boolean;
        generated: { task: string; eval: string; mode: string };
        command: { kind: string; argv: string[] };
        executed: boolean;
      };
      expect(output).toMatchObject({
        mode: 'user_issue',
        single_issue_policy: true,
        executed: false,
        generated: { mode: 'user_issue_from_prompt' },
        command: { kind: 'vibeloop_improve' }
      });
      expect(output.command.argv).toContain('improve');
      expect(output.command.argv).toContain('--task');
      expect(output.command.argv).toContain(output.generated.task);
      await expect(loadTask(output.generated.task)).resolves.toMatchObject({
        objective: expect.stringContaining(prompt)
      });
      await expect(
        loadEvalConfig(output.generated.eval)
      ).resolves.toMatchObject({
        project: expect.any(String)
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('forwards PR branch and draft PR flags from a user issue prompt runner command', async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-prompt-pr-route-')
    );
    try {
      const result = await runNode([
        RUN_FROM_PROMPT_SCRIPT,
        '--prompt',
        'src/cart.cjs quantity 버그 고쳐줘. 테스트도 추가해.',
        '--repo',
        '/tmp/example-repo',
        '--out',
        outDir,
        '--agent',
        'command:echo builder',
        '--challenger',
        'command:echo challenger',
        '--test-command',
        'npm test',
        '--promote-branch',
        'pr-candidate/cart',
        '--promote-commit-message',
        'fix cart quantity',
        '--github-draft-pr',
        '--github-repo',
        'coreline-ai/example',
        '--github-token-env',
        'TEST_GITHUB_TOKEN',
        '--github-base',
        'main',
        '--github-branch',
        'pr-candidate/cart',
        '--github-push-url',
        'file:///tmp/example-remote.git',
        '--github-api-base-url',
        'https://api.github.test',
        '--github-title',
        'Fix cart quantity',
        '--max-candidates',
        '3',
        '--allow-dirty'
      ]);

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout) as {
        command: { kind: string; argv: string[] };
      };
      const argv = output.command.argv;
      expect(output.command.kind).toBe('vibeloop_improve');
      expect(argv).toContain('--github-draft-pr');
      expectArgValue(argv, '--promote-branch', 'pr-candidate/cart');
      expectArgValue(argv, '--promote-commit-message', 'fix cart quantity');
      expectArgValue(argv, '--github-repo', 'coreline-ai/example');
      expectArgValue(argv, '--github-token-env', 'TEST_GITHUB_TOKEN');
      expectArgValue(argv, '--github-base', 'main');
      expectArgValue(argv, '--github-branch', 'pr-candidate/cart');
      expectArgValue(
        argv,
        '--github-push-url',
        'file:///tmp/example-remote.git'
      );
      expectArgValue(argv, '--github-api-base-url', 'https://api.github.test');
      expectArgValue(argv, '--github-title', 'Fix cart quantity');
      expectArgValue(argv, '--max-candidates', '3');
      expect(argv).toContain('--allow-dirty');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('forwards generated-eval and stacked PR flags from an auto-discovery prompt runner command', async () => {
    const result = await runNode([
      RUN_FROM_PROMPT_SCRIPT,
      '--prompt',
      '자동으로 문제 찾아서 하나씩 수정하고 검증 PR 후보 만들어줘',
      '--repo',
      '/tmp/example-repo',
      '--agent',
      'command:echo builder',
      '--challenger',
      'command:echo challenger',
      '--eval-command',
      'npm test',
      '--eval-command',
      'npm run lint',
      '--eval-artifact-leak',
      '--eval-forbidden-literal',
      'cart_id=CART-123',
      '--eval-forbidden-literal',
      'token=SECRET-456',
      '--eval-scan-patch',
      '--eval-redact-gate-logs',
      '--eval-token-like-reject',
      '--eval-max-scan-bytes',
      '4096',
      '--eval-rulepack-lock',
      'policy/frozen-rulepack.json',
      '--eval-hidden-test',
      'cart=/hidden/cart.test.cjs:tests/hidden/cart.test.cjs:node tests/hidden/cart.test.cjs',
      '--promote-branch',
      'pr-candidate/auto',
      '--promote-commit-message-prefix',
      'vibeloop auto fix',
      '--github-draft-pr',
      '--github-repo',
      'coreline-ai/example',
      '--github-token-env',
      'TEST_GITHUB_TOKEN',
      '--github-base',
      'main',
      '--github-branch-prefix',
      'pr-candidate/auto',
      '--github-title-prefix',
      'VibeLoop auto',
      '--github-push-url',
      'file:///tmp/example-remote.git',
      '--github-api-base-url',
      'https://api.github.test',
      '--llm-proxy-url',
      'http://127.0.0.1:9999',
      '--max-issues',
      '2',
      '--max-candidates',
      '4',
      '--quality-judge',
      'node judge.cjs',
      '--adversary-review',
      'node adversary.cjs',
      '--adversary-reviewer-provider',
      'anthropic',
      '--adversary-require-different-provider',
      '--skip-final-reverify',
      '--allow-dirty'
    ]);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      mode: string;
      command: { kind: string; argv: string[] };
    };
    const argv = output.command.argv;
    expect(output.mode).toBe('auto_discovery');
    expect(output.command.kind).toBe('vibeloop_orchestrate');
    expect(argv).toContain('--generate-eval');
    expectArgValues(argv, '--eval-command', ['npm test', 'npm run lint']);
    expect(argv).toContain('--eval-artifact-leak');
    expectArgValues(argv, '--eval-forbidden-literal', [
      'cart_id=CART-123',
      'token=SECRET-456'
    ]);
    expect(argv).toContain('--eval-scan-patch');
    expect(argv).toContain('--eval-redact-gate-logs');
    expect(argv).toContain('--eval-token-like-reject');
    expectArgValue(argv, '--eval-max-scan-bytes', '4096');
    expectArgValue(argv, '--eval-rulepack-lock', 'policy/frozen-rulepack.json');
    expectArgValues(argv, '--eval-hidden-test', [
      'cart=/hidden/cart.test.cjs:tests/hidden/cart.test.cjs:node tests/hidden/cart.test.cjs'
    ]);
    expectArgValue(argv, '--promote-branch', 'pr-candidate/auto');
    expectArgValue(
      argv,
      '--promote-commit-message-prefix',
      'vibeloop auto fix'
    );
    expect(argv).toContain('--github-draft-pr');
    expectArgValue(argv, '--github-repo', 'coreline-ai/example');
    expectArgValue(argv, '--github-token-env', 'TEST_GITHUB_TOKEN');
    expectArgValue(argv, '--github-base', 'main');
    expectArgValue(argv, '--github-branch-prefix', 'pr-candidate/auto');
    expectArgValue(argv, '--github-title-prefix', 'VibeLoop auto');
    expectArgValue(argv, '--github-push-url', 'file:///tmp/example-remote.git');
    expectArgValue(argv, '--github-api-base-url', 'https://api.github.test');
    expectArgValue(argv, '--llm-proxy-url', 'http://127.0.0.1:9999');
    expectArgValue(argv, '--max-issues', '2');
    expectArgValue(argv, '--max-candidates', '4');
    expectArgValue(argv, '--quality-judge', 'node judge.cjs');
    expectArgValue(argv, '--adversary-review', 'node adversary.cjs');
    expectArgValue(argv, '--adversary-reviewer-provider', 'anthropic');
    expect(argv).toContain('--adversary-require-different-provider');
    expect(argv).toContain('--skip-final-reverify');
    expect(argv).toContain('--allow-dirty');
  });

  it('executes an auto-discovery prompt through orchestrate on a real fixture repo', async () => {
    const { repoPath, initialCommit } = await createSkillTargetRepo();
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-auto-data-')
    );
    try {
      await mkdir(dataDir, { recursive: true });
      const agentPath = path.join(CART_SCENARIO_ROOT, 'agent-fix.cjs');
      const run = await runNode([
        RUN_FROM_PROMPT_SCRIPT,
        '--execute',
        '--prompt',
        '자동으로 문제 찾아서 하나씩 수정하고 검증 PR 후보 만들어줘',
        '--repo',
        repoPath,
        '--test-command',
        'node tests/cart-quantity.test.cjs',
        '--agent',
        `command:node ${agentPath}`,
        '--data-dir',
        dataDir,
        '--project-id',
        'skill-prompt-auto',
        '--loop-id',
        'skill-prompt-auto-loop',
        '--base-commit',
        initialCommit,
        '--max-issues',
        '1',
        '--max-candidates',
        '1',
        '--promote-branch',
        'pr-candidate/auto-fixture',
        '--promote-commit-message-prefix',
        'vibeloop auto fixture',
        '--skip-dependency-install'
      ]);

      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const output = JSON.parse(run.stdout) as {
        mode: string;
        generated: null;
        command: { kind: string; argv: string[] };
        executed: boolean;
        execution: {
          code: number;
          parsed: {
            mode: string;
            processed: number;
            pr_candidates: number;
            cumulative_promotion: {
              branch_name: string;
              pushed: boolean;
              applied_issue_count: number;
              rediscovery_after_each_fix: boolean;
            } | null;
            issues: Array<{
              issue_id: string;
              selected_candidate_id: string | null;
              pr_candidate: boolean;
              promotion?: {
                branch_name: string;
                pushed: boolean;
              } | null;
              final_verification?: { passed: boolean };
              selection_quality?: {
                full_autonomous_improvement_eligible: boolean;
              };
            }>;
          };
        };
      };
      expect(output.mode).toBe('auto_discovery');
      expect(output.generated).toBeNull();
      expect(output.command.kind).toBe('vibeloop_orchestrate');
      expect(output.command.argv).toContain('--generate-eval');
      expect(output.executed).toBe(true);
      expect(output.execution.code).toBe(0);
      expect(output.execution.parsed).toMatchObject({
        mode: 'auto',
        processed: 1,
        pr_candidates: 1
      });
      expect(output.execution.parsed.cumulative_promotion).toMatchObject({
        branch_name: 'pr-candidate/auto-fixture',
        pushed: false,
        applied_issue_count: 1,
        rediscovery_after_each_fix: true
      });
      expect(output.execution.parsed.issues).toHaveLength(1);
      expect(output.execution.parsed.issues[0]).toMatchObject({
        pr_candidate: true,
        promotion: {
          branch_name: 'pr-candidate/auto-fixture',
          pushed: false
        },
        final_verification: { passed: true }
      });
      expect(
        output.execution.parsed.issues[0]?.selection_quality
          ?.full_autonomous_improvement_eligible
      ).toBe(false);
      expect(
        (await runGit(repoPath, ['branch', '--show-current'])).trim()
      ).toBe('pr-candidate/auto-fixture');
      expect((await runGit(repoPath, ['status', '--short'])).trim()).toBe('');
    } finally {
      await rm(repoPath, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

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

      const selectionReport = await writeReportFixture(
        outDir,
        'selection-report.json',
        {
          selected_candidate_id: 'c0',
          pr_candidate: true,
          adversary_review: {
            ran: true,
            authority: 'advisory_only',
            decision_impact: 'none',
            accepted_proposal_count: 1,
            requires_human_review_signal: true,
            next_step:
              'm2_execute_under_isolation_then_m4_replay_freeze_next_loop'
          }
        }
      );
      const acceptedWithAdvisory = await runNode([
        SUMMARIZE_REPORT_SCRIPT,
        '--report',
        acceptedReport,
        '--selection-report',
        selectionReport
      ]);
      expect(acceptedWithAdvisory.stderr).toBe('');
      expect(acceptedWithAdvisory.code).toBe(0);
      expect(JSON.parse(acceptedWithAdvisory.stdout)).toMatchObject({
        prCandidate: true,
        nextAction: 'prepare_pr_candidate',
        advisoryReviewRecommended: true,
        reviewAdvisoryBeforePr: true,
        adversaryReview: {
          authority: 'advisory_only',
          decisionImpact: 'none',
          acceptedProposalCount: 1
        }
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

  it('executes a natural-language user issue prompt through the Skill prompt runner', async () => {
    const { repoPath, initialCommit } = await createSkillTargetRepo();
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-prompt-data-')
    );
    const taskEvalDir = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-skill-prompt-task-eval-')
    );
    try {
      const agentPath = path.join(CART_SCENARIO_ROOT, 'agent-fix.cjs');
      const run = await runNode([
        RUN_FROM_PROMPT_SCRIPT,
        '--execute',
        '--prompt',
        'src/cart.cjs quantity 버그를 고쳐줘. quantity가 없으면 기본값 1로 계산하고 테스트도 추가해.',
        '--template',
        'node',
        '--out',
        taskEvalDir,
        '--repo',
        repoPath,
        '--test-command',
        'node tests/cart-quantity.test.cjs',
        '--agent',
        `command:node ${agentPath}`,
        '--data-dir',
        dataDir,
        '--project-id',
        'skill-prompt-cart',
        '--loop-id',
        'skill-prompt-cart-loop',
        '--base-commit',
        initialCommit,
        '--skip-dependency-install'
      ]);

      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      const output = JSON.parse(run.stdout) as {
        mode: string;
        generated: { task: string; eval: string };
        command: { kind: string };
        executed: boolean;
        execution: {
          code: number;
          parsed: {
            selected_candidate_id: string;
            pr_candidate: boolean;
            selected_report: string;
            selection_quality: {
              full_autonomous_improvement_eligible: boolean;
            };
          };
        };
      };
      expect(output.mode).toBe('user_issue');
      expect(output.command.kind).toBe('vibeloop_improve');
      expect(output.executed).toBe(true);
      expect(output.execution).toMatchObject({
        code: 0,
        parsed: {
          selected_candidate_id: 'skill-prompt-cart-loop-c0',
          pr_candidate: true
        }
      });
      expect(
        output.execution.parsed.selection_quality
          .full_autonomous_improvement_eligible
      ).toBe(false);

      const summary = await runNode([
        SUMMARIZE_REPORT_SCRIPT,
        '--report',
        output.execution.parsed.selected_report
      ]);
      expect(summary.stderr).toBe('');
      expect(summary.code).toBe(0);
      expect(JSON.parse(summary.stdout)).toMatchObject({
        decision: 'accept',
        reason: 'ALL_PASS',
        nextAction: 'prepare_pr_candidate'
      });
    } finally {
      await rm(repoPath, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(taskEvalDir, { recursive: true, force: true });
    }
  }, 60_000);
});

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCENARIO_ROOT = path.join(
  REPO_ROOT,
  'tests/e2e/user-scenarios/skill-loop'
);
const TARGET_TEMPLATE = path.join(SCENARIO_ROOT, 'target-template');
const AGENT_SCRIPT = path.join(SCENARIO_ROOT, 'agent-fix.cjs');
const VIBELOOP_RUN_SCRIPT = path.join(
  REPO_ROOT,
  'skills/vibeloop-harness/scripts/vibeloop-run.mjs'
);
const SUMMARIZE_REPORT_SCRIPT = path.join(
  REPO_ROOT,
  'skills/vibeloop-harness/scripts/summarize-report.mjs'
);
const HIDDEN_SENTINEL = 'SECRET_HIDDEN_EXPECTATION';

const keepTmp = process.env.VIBELOOP_UAT_KEEP_TMP === '1';

const issues = [
  {
    id: 'skill-loop-cart-quantity',
    projectId: 'skill-loop-cart-quantity',
    loopId: 'skill-loop-001-cart-quantity',
    task: path.join(SCENARIO_ROOT, 'tasks/cart-quantity.task.yaml'),
    eval: path.join(SCENARIO_ROOT, 'evals/cart-quantity.eval.yaml'),
    expectedChangedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs'],
    visibleTest: 'tests/cart-quantity.test.cjs',
    hiddenGate: 'hidden_cart_mixed_quantities'
  },
  {
    id: 'skill-loop-sku-normalization',
    projectId: 'skill-loop-sku-normalization',
    loopId: 'skill-loop-002-sku-normalization',
    task: path.join(SCENARIO_ROOT, 'tasks/sku-normalization.task.yaml'),
    eval: path.join(SCENARIO_ROOT, 'evals/sku-normalization.eval.yaml'),
    expectedChangedFiles: ['src/cart.cjs', 'tests/sku-normalization.test.cjs'],
    visibleTest: 'tests/sku-normalization.test.cjs',
    hiddenGate: 'hidden_sku_whitespace_lowercase'
  }
];

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(
      /(access_token|refresh_token|api_key|OPENAI_API_KEY|password)\s*[:=]\s*[^\s"']+/gi,
      '$1=[REDACTED]'
    )
    .replaceAll(HIDDEN_SENTINEL, '[REDACTED_HIDDEN]');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function mustRun(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.code})\nstdout:\n${redact(result.stdout)}\nstderr:\n${redact(result.stderr)}`
    );
  }
  return result.stdout;
}

async function git(cwd, args) {
  return mustRun('git', args, { cwd });
}

async function createTargetRepo(root) {
  const repoPath = path.join(root, 'target-repo');
  await cp(TARGET_TEMPLATE, repoPath, { recursive: true });
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'skill-loop-user@example.test']);
  await git(repoPath, ['config', 'user.name', 'Skill Loop UAT User']);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'initial two-issue fixture']);
  const initialCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  await mustRun('npm', ['test'], { cwd: repoPath });
  return { repoPath, initialCommit };
}

function parseJsonOutput(result, commandLabel) {
  if (result.stderr !== '') {
    throw new Error(`${commandLabel} wrote stderr:\n${redact(result.stderr)}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `${commandLabel} failed (${result.code}):\n${redact(result.stdout)}\n${redact(result.stderr)}`
    );
  }
  return JSON.parse(result.stdout);
}

async function runSkillIteration({
  issue,
  repoPath,
  dataDir,
  previousIssueIds
}) {
  const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  const runResult = await runCommand(
    process.execPath,
    [
      VIBELOOP_RUN_SCRIPT,
      '--data-dir',
      dataDir,
      'run',
      '--repo',
      repoPath,
      '--task',
      issue.task,
      '--eval',
      issue.eval,
      '--agent',
      `command:node ${AGENT_SCRIPT}`,
      '--project-id',
      issue.projectId,
      '--loop-id',
      issue.loopId,
      '--base-commit',
      baseCommit,
      '--skip-dependency-install'
    ],
    { cwd: REPO_ROOT }
  );
  const output = parseJsonOutput(runResult, `vibeloop run ${issue.id}`);
  if (output.decision !== 'accept' || output.status !== 'accepted') {
    throw new Error(
      `iteration ${issue.id} was not accepted: ${redact(runResult.stdout)}`
    );
  }
  if (!output.report) {
    throw new Error(`iteration ${issue.id} did not return report path`);
  }

  const reportText = await readFile(output.report, 'utf8');
  if (reportText.includes(HIDDEN_SENTINEL)) {
    throw new Error(`iteration ${issue.id} leaked hidden sentinel in report`);
  }
  const report = JSON.parse(reportText);
  if (
    report.decision !== 'accept' ||
    report.decision_reasons?.[0]?.code !== 'ALL_PASS'
  ) {
    throw new Error(`iteration ${issue.id} did not produce accept/ALL_PASS`);
  }

  // The eval fixture declares an `evaluator:` block, so the deterministic quality
  // gate must be exercised and met for this to be a PR candidate.
  if (output.qualified !== true || output.pr_candidate !== true) {
    throw new Error(
      `iteration ${issue.id} run output is accepted but not a qualified PR candidate`
    );
  }
  const qualityPath = path.join(
    path.dirname(output.report),
    'quality-report.json'
  );
  const quality = JSON.parse(await readFile(qualityPath, 'utf8'));
  if (quality.status !== 'pass' || quality.met !== true) {
    throw new Error(
      `iteration ${issue.id} quality gate not met: ${redact(JSON.stringify(quality))}`
    );
  }

  const changedFiles = [
    ...report.changed_files.map((file) => file.path)
  ].sort();
  const expectedChangedFiles = [...issue.expectedChangedFiles].sort();
  if (JSON.stringify(changedFiles) !== JSON.stringify(expectedChangedFiles)) {
    throw new Error(
      `iteration ${issue.id} changed unexpected files: ${JSON.stringify(changedFiles)}`
    );
  }
  const hiddenGate = report.gate_runs.find(
    (gate) => gate.name === issue.hiddenGate
  );
  if (
    !hiddenGate ||
    hiddenGate.status !== 'pass' ||
    hiddenGate.type !== 'hidden_acceptance'
  ) {
    throw new Error(`iteration ${issue.id} hidden gate did not pass`);
  }

  const summaryResult = await runCommand(
    process.execPath,
    [SUMMARIZE_REPORT_SCRIPT, '--report', output.report],
    { cwd: REPO_ROOT }
  );
  const summary = parseJsonOutput(
    summaryResult,
    `summarize-report ${issue.id}`
  );
  if (summary.nextAction !== 'prepare_pr_candidate') {
    throw new Error(
      `iteration ${issue.id} summary did not produce PR-candidate action`
    );
  }
  const summaryText = JSON.stringify(summary);
  if (summaryText.includes(HIDDEN_SENTINEL)) {
    throw new Error(`iteration ${issue.id} leaked hidden sentinel in summary`);
  }

  const agentStdoutPath = path.join(
    output.artifact_root,
    'logs/agent.stdout.log'
  );
  const agentStdout = await readFile(agentStdoutPath, 'utf8');
  if (!agentStdout.includes(issue.id)) {
    throw new Error(
      `iteration ${issue.id} agent log did not reference current task`
    );
  }
  const duplicatedContextIds = previousIssueIds.filter((id) =>
    agentStdout.includes(id)
  );
  if (duplicatedContextIds.length > 0) {
    throw new Error(
      `iteration ${issue.id} agent log included previous task context: ${duplicatedContextIds.join(', ')}`
    );
  }

  const patchPath = path.join(output.artifact_root, 'patches/candidate.patch');
  await git(repoPath, ['apply', patchPath]);
  await mustRun('node', [issue.visibleTest], { cwd: repoPath });
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', `vibeloop accepted ${issue.id}`]);
  const commit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  await git(repoPath, ['branch', `pr-candidate/${issue.id}`, commit]);
  const status = await git(repoPath, ['status', '--short']);
  if (status.trim() !== '') {
    throw new Error(`iteration ${issue.id} left dirty git status: ${status}`);
  }

  const worktreeList = await git(repoPath, ['worktree', 'list', '--porcelain']);
  if (worktreeList.includes(issue.loopId)) {
    throw new Error(`iteration ${issue.id} worktree cleanup failed`);
  }

  return {
    issueId: issue.id,
    loopId: issue.loopId,
    projectId: issue.projectId,
    baseCommit,
    acceptedCommit: commit,
    decision: report.decision,
    reason: report.decision_reasons[0].code,
    status: output.status,
    reportPath: output.report,
    artifactRoot: output.artifact_root,
    changedFiles,
    hiddenGate: issue.hiddenGate,
    summaryNextAction: summary.nextAction,
    prCandidateBranch: `pr-candidate/${issue.id}`,
    contextIsolated: true
  };
}

async function main() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-skill-loop-uat-')
  );
  await mkdir(tempRoot, { recursive: true });
  try {
    const { repoPath, initialCommit } = await createTargetRepo(tempRoot);
    const iterations = [];
    const previousIssueIds = [];
    for (const [index, issue] of issues.entries()) {
      const dataDir = path.join(
        tempRoot,
        `data-iteration-${String(index + 1).padStart(2, '0')}`
      );
      await mkdir(dataDir, { recursive: true });
      const iteration = await runSkillIteration({
        issue,
        repoPath,
        dataDir,
        previousIssueIds
      });
      iterations.push(iteration);
      previousIssueIds.push(issue.id);
    }

    await mustRun('npm', ['test'], { cwd: repoPath });
    const finalCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    const branches = (
      await git(repoPath, ['branch', '--format=%(refname:short)'])
    )
      .split('\n')
      .map((branch) => branch.trim())
      .filter(Boolean)
      .sort();
    const artifactRoots = iterations.map((iteration) => iteration.artifactRoot);
    const artifactRootsUnique =
      new Set(artifactRoots).size === artifactRoots.length;
    const acceptedCommitsUnique =
      new Set(iterations.map((iteration) => iteration.acceptedCommit)).size ===
      iterations.length;
    const log = await git(repoPath, [
      'log',
      '--oneline',
      '--decorate',
      '--max-count=5'
    ]);
    const output = {
      status: 'ALL_PASS',
      scenario: 'skill-real-user-loop-uat',
      targetRepo: keepTmp ? repoPath : '[removed]',
      initialCommit,
      finalCommit,
      stopReason: 'issue_queue_exhausted',
      issueCount: issues.length,
      acceptedIssueCount: iterations.length,
      remainingIssueCount: 0,
      artifactRootsUnique,
      acceptedCommitsUnique,
      branches,
      iterations,
      finalUserTest: 'npm test',
      finalGitLog: log
    };
    const outputText = JSON.stringify(output, null, 2);
    if (outputText.includes(HIDDEN_SENTINEL)) {
      throw new Error('final output leaked hidden sentinel');
    }
    console.log(outputText);
  } finally {
    if (!keepTmp) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(
    redact(
      error instanceof Error ? error.stack || error.message : String(error)
    )
  );
  process.exit(1);
});

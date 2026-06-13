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
const GOOD_AGENT_SCRIPT = path.join(SCENARIO_ROOT, 'agent-fix.cjs');
const ADVERSARIAL_AGENT_SCRIPT = path.join(
  SCENARIO_ROOT,
  'agent-adversarial.cjs'
);
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

const cartIssue = {
  id: 'skill-loop-cart-quantity',
  projectId: 'skill-loop-cart-quantity',
  task: path.join(SCENARIO_ROOT, 'tasks/cart-quantity.task.yaml'),
  eval: path.join(SCENARIO_ROOT, 'evals/cart-quantity.eval.yaml')
};

const skuIssue = {
  id: 'skill-loop-sku-normalization',
  projectId: 'skill-loop-sku-normalization',
  task: path.join(SCENARIO_ROOT, 'tasks/sku-normalization.task.yaml'),
  eval: path.join(SCENARIO_ROOT, 'evals/sku-normalization.eval.yaml')
};

const adversarialCases = [
  {
    caseId: 'hidden-bypass',
    issue: cartIssue,
    loopId: 'adversarial-001-hidden-bypass',
    expectedDecision: 'reject',
    expectedReason: 'GATE_REQUIRED_FAILED',
    expectedFailedGate: 'hidden_cart_mixed_quantities',
    expectedSummaryAction: 'fix_failed_gates_then_rerun',
    description:
      'visible regression passes but hidden acceptance catches a hardcoded implementation'
  },
  {
    caseId: 'protected-path',
    issue: cartIssue,
    loopId: 'adversarial-002-protected-path',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_PROTECTED_PATH',
    expectedFailedGate: 'protected_files',
    expectedSummaryAction: 'fix_failed_gates_then_rerun',
    description:
      'candidate changes .env even though protected path policy forbids it'
  },
  {
    caseId: 'test-integrity-cheat',
    issue: cartIssue,
    loopId: 'adversarial-003-test-integrity-cheat',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_TEST_INTEGRITY',
    expectedFailedGate: 'test_integrity',
    expectedSummaryAction: 'fix_failed_gates_then_rerun',
    description:
      'candidate inserts a forbidden test.skip marker in a regression test'
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

async function createTargetRepo(root, name) {
  const repoPath = path.join(root, name);
  await cp(TARGET_TEMPLATE, repoPath, { recursive: true });
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, [
    'config',
    'user.email',
    'skill-loop-adversary@example.test'
  ]);
  await git(repoPath, ['config', 'user.name', 'Skill Loop Adversarial UAT']);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'initial adversarial fixture']);
  const initialCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  await mustRun('npm', ['test'], { cwd: repoPath });
  return { repoPath, initialCommit };
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not return JSON stdout:\n${redact(stdout)}`);
  }
}

async function summarize(reportPath, label) {
  const result = await runCommand(
    process.execPath,
    [SUMMARIZE_REPORT_SCRIPT, '--report', reportPath],
    {
      cwd: REPO_ROOT
    }
  );
  if (result.stderr !== '' || result.code !== 0) {
    throw new Error(
      `${label} summary failed (${result.code}):\n${redact(result.stdout)}\n${redact(result.stderr)}`
    );
  }
  return parseJson(result.stdout, `${label} summary`);
}

async function runVibeloop({
  issue,
  repoPath,
  dataDir,
  loopId,
  agentScript,
  adversaryCase
}) {
  const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  const envPrefix = adversaryCase
    ? `VIBELOOP_ADVERSARY_CASE=${adversaryCase} `
    : '';
  const result = await runCommand(
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
      `command:${envPrefix}node ${agentScript}`,
      '--project-id',
      issue.projectId,
      '--loop-id',
      loopId,
      '--base-commit',
      baseCommit,
      '--skip-dependency-install'
    ],
    { cwd: REPO_ROOT }
  );
  if (result.stderr !== '') {
    throw new Error(
      `vibeloop run ${loopId} wrote stderr:\n${redact(result.stderr)}`
    );
  }
  const output = parseJson(result.stdout, `vibeloop run ${loopId}`);
  if (!output.report) {
    throw new Error(`vibeloop run ${loopId} did not return report path`);
  }
  const reportText = await readFile(output.report, 'utf8');
  const hiddenTextLeaked =
    reportText.includes(HIDDEN_SENTINEL) ||
    result.stdout.includes(HIDDEN_SENTINEL);
  const report = JSON.parse(reportText);
  const summary = await summarize(output.report, loopId);
  return {
    baseCommit,
    cliExitCode: result.code,
    output,
    report,
    summary,
    hiddenTextLeaked
  };
}

function assertNoPrBranch(branches, issueId, label) {
  const branch = `pr-candidate/${issueId}`;
  if (branches.includes(branch)) {
    throw new Error(`${label} unexpectedly created ${branch}`);
  }
}

async function runNegativeCase(root, spec, index) {
  const { repoPath, initialCommit } = await createTargetRepo(
    root,
    `target-${spec.caseId}`
  );
  const dataDir = path.join(
    root,
    `data-${String(index + 1).padStart(2, '0')}-${spec.caseId}`
  );
  await mkdir(dataDir, { recursive: true });
  const run = await runVibeloop({
    issue: spec.issue,
    repoPath,
    dataDir,
    loopId: spec.loopId,
    agentScript: ADVERSARIAL_AGENT_SCRIPT,
    adversaryCase: spec.caseId
  });

  const failedGate = run.report.gate_runs.find(
    (gate) => gate.name === spec.expectedFailedGate
  );
  const branches = (
    await git(repoPath, ['branch', '--format=%(refname:short)'])
  )
    .split('\n')
    .map((branch) => branch.trim())
    .filter(Boolean)
    .sort();
  assertNoPrBranch(branches, spec.issue.id, spec.caseId);

  const detected =
    run.output.decision === spec.expectedDecision &&
    run.report.decision === spec.expectedDecision &&
    run.report.decision_reasons?.[0]?.code === spec.expectedReason &&
    failedGate?.status === 'fail' &&
    run.summary.nextAction === spec.expectedSummaryAction &&
    run.cliExitCode !== 0 &&
    !run.hiddenTextLeaked;

  if (!detected) {
    throw new Error(
      `${spec.caseId} was not detected as expected: ${redact(
        JSON.stringify(
          {
            cliExitCode: run.cliExitCode,
            outputDecision: run.output.decision,
            reportDecision: run.report.decision,
            reason: run.report.decision_reasons?.[0]?.code,
            failedGate,
            summaryNextAction: run.summary.nextAction,
            hiddenTextLeaked: run.hiddenTextLeaked
          },
          null,
          2
        )
      )}`
    );
  }

  return {
    caseId: spec.caseId,
    description: spec.description,
    detected: true,
    expectedDecision: spec.expectedDecision,
    actualDecision: run.report.decision,
    reason: run.report.decision_reasons[0].code,
    cliExitCode: run.cliExitCode,
    failedGate: failedGate.name,
    failedGateStatus: failedGate.status,
    summaryNextAction: run.summary.nextAction,
    prCandidateCreated: false,
    hiddenTextLeaked: false,
    initialCommit,
    reportPath: run.output.report,
    artifactRoot: run.output.artifact_root
  };
}

async function applyAcceptedPatch(repoPath, runOutput, issueId) {
  const patchPath = path.join(
    runOutput.artifact_root,
    'patches/candidate.patch'
  );
  await git(repoPath, ['apply', patchPath]);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', `setup accepted ${issueId}`]);
}

async function runContextLeakCase(root) {
  const caseId = 'context-leak';
  const { repoPath, initialCommit } = await createTargetRepo(
    root,
    'target-context-leak'
  );
  const setupDataDir = path.join(root, 'data-context-leak-setup');
  const leakDataDir = path.join(root, 'data-context-leak-adversarial');
  await mkdir(setupDataDir, { recursive: true });
  await mkdir(leakDataDir, { recursive: true });

  const setupRun = await runVibeloop({
    issue: cartIssue,
    repoPath,
    dataDir: setupDataDir,
    loopId: 'adversarial-004-context-leak-setup',
    agentScript: GOOD_AGENT_SCRIPT
  });
  if (
    setupRun.report.decision !== 'accept' ||
    setupRun.report.decision_reasons?.[0]?.code !== 'ALL_PASS'
  ) {
    throw new Error(
      `context leak setup did not accept: ${setupRun.report.decision}`
    );
  }
  await applyAcceptedPatch(repoPath, setupRun.output, cartIssue.id);

  const leakRun = await runVibeloop({
    issue: skuIssue,
    repoPath,
    dataDir: leakDataDir,
    loopId: 'adversarial-004-context-leak',
    agentScript: ADVERSARIAL_AGENT_SCRIPT,
    adversaryCase: caseId
  });
  const agentStdout = await readFile(
    path.join(leakRun.output.artifact_root, 'logs/agent.stdout.log'),
    'utf8'
  );
  // Core artifact-leak guard rejects at the kernel (not the wrapper); the leaked
  // previous-issue id must be redacted out of the persisted agent log.
  const previousContextRedacted = !agentStdout.includes(cartIssue.id);
  const branches = (
    await git(repoPath, ['branch', '--format=%(refname:short)'])
  )
    .split('\n')
    .map((branch) => branch.trim())
    .filter(Boolean)
    .sort();
  assertNoPrBranch(branches, skuIssue.id, caseId);

  const detected =
    leakRun.report.decision === 'reject' &&
    leakRun.report.decision_reasons?.[0]?.code === 'GUARD_ARTIFACT_LEAK' &&
    leakRun.summary.nextAction !== 'prepare_pr_candidate' &&
    previousContextRedacted &&
    !leakRun.hiddenTextLeaked;

  if (!detected) {
    throw new Error(
      `${caseId} was not detected as expected: ${redact(
        JSON.stringify(
          {
            decision: leakRun.report.decision,
            reason: leakRun.report.decision_reasons?.[0]?.code,
            summaryNextAction: leakRun.summary.nextAction,
            previousContextRedacted,
            hiddenTextLeaked: leakRun.hiddenTextLeaked
          },
          null,
          2
        )
      )}`
    );
  }

  return {
    caseId,
    description:
      'agent leaked previous task context; core artifact-leak guard rejects at the kernel before any PR candidate',
    detected: true,
    detectedBy: 'core_artifact_leak_gate',
    expectedDecision: 'reject',
    actualDecision: leakRun.report.decision,
    reason: leakRun.report.decision_reasons[0].code,
    failedGate: 'artifact_leak',
    cliExitCode: leakRun.cliExitCode,
    summaryNextAction: leakRun.summary.nextAction,
    previousContextRedacted: true,
    prCandidateCreated: false,
    hiddenTextLeaked: false,
    initialCommit,
    setupDecision: setupRun.report.decision,
    reportPath: leakRun.output.report,
    artifactRoot: leakRun.output.artifact_root
  };
}

async function main() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-skill-loop-adversarial-uat-')
  );
  await mkdir(tempRoot, { recursive: true });
  try {
    const cases = [];
    for (const [index, spec] of adversarialCases.entries()) {
      cases.push(await runNegativeCase(tempRoot, spec, index));
    }
    cases.push(await runContextLeakCase(tempRoot));

    const output = {
      status: 'ADVERSARIAL_PASS',
      scenario: 'skill-real-user-loop-adversarial-uat',
      targetRoot: keepTmp ? tempRoot : '[removed]',
      caseCount: cases.length,
      detectedCaseCount: cases.filter((item) => item.detected).length,
      blockedPrCandidateCount: cases.filter(
        (item) => item.prCandidateCreated === false
      ).length,
      hiddenLeakCount: cases.filter((item) => item.hiddenTextLeaked).length,
      cases
    };
    const outputText = JSON.stringify(output, null, 2);
    if (outputText.includes(HIDDEN_SENTINEL)) {
      throw new Error('final adversarial output leaked hidden sentinel');
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

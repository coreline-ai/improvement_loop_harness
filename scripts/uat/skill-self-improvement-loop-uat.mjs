#!/usr/bin/env node
// Self-improvement loop UAT.
//
// Proves the loop does more than "fix once": for each issue it runs a builder
// pool plus a challenger, and the deterministic Arbiter selects the
// measurably-better accepted candidate (smaller, cleaner diff at equal
// correctness). The selection delta is the observable "self-improvement moved
// in a better direction" signal. It then advances issue-by-issue across a
// queue, and finally proves a fully-bad pool yields no PR candidate.
//
// Trust model unchanged: candidates are produced by agents, but accept/reject
// and selection are deterministic (kernel gates + fixed Arbiter score). No LLM
// grades its own work.
//
// Optional: with VIBELOOP_UAT_GITHUB=1 it publishes each harness-selected patch
// as a draft PR against a throwaway private GitHub repo, then deletes the repo
// (unless VIBELOOP_UAT_KEEP_REMOTE=1). The core UAT is hermetic without it.
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
const AGENT_CANDIDATE = path.join(SCENARIO_ROOT, 'agent-candidate.cjs');
const AGENT_REGRESSION = path.join(SCENARIO_ROOT, 'agent-regression.cjs');
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
const publishGithub = process.env.VIBELOOP_UAT_GITHUB === '1';
const keepRemote = process.env.VIBELOOP_UAT_KEEP_REMOTE === '1';
const githubOwner = process.env.VIBELOOP_UAT_GITHUB_OWNER || 'coreline-ai';

// builder = verbose (correct but larger diff); challenger = tight (same
// correctness, smaller diff). The tight challenger must win on score.
const verboseBuilder = `command:VIBELOOP_CANDIDATE_STYLE=verbose node ${AGENT_CANDIDATE}`;
const tightChallenger = `command:VIBELOOP_CANDIDATE_STYLE=tight node ${AGENT_CANDIDATE}`;

const fixableIssues = [
  {
    id: 'skill-loop-cart-quantity',
    projectId: 'siloop-cart-quantity',
    loopId: 'siloop-001-cart-quantity',
    task: path.join(SCENARIO_ROOT, 'tasks/cart-quantity.task.yaml'),
    eval: path.join(SCENARIO_ROOT, 'evals/cart-quantity.eval.yaml'),
    visibleTest: 'tests/cart-quantity.test.cjs',
    expectedSelectedChangedFiles: [
      'src/cart.cjs',
      'tests/cart-quantity.test.cjs'
    ],
    hiddenGate: 'hidden_cart_mixed_quantities'
  },
  {
    id: 'skill-loop-sku-normalization',
    projectId: 'siloop-sku-normalization',
    loopId: 'siloop-002-sku-normalization',
    task: path.join(SCENARIO_ROOT, 'tasks/sku-normalization.task.yaml'),
    eval: path.join(SCENARIO_ROOT, 'evals/sku-normalization.eval.yaml'),
    visibleTest: 'tests/sku-normalization.test.cjs',
    expectedSelectedChangedFiles: [
      'src/cart.cjs',
      'tests/sku-normalization.test.cjs'
    ],
    hiddenGate: 'hidden_sku_whitespace_lowercase'
  }
];

// Adversarial pool: every candidate adds a failing test without fixing the bug,
// so nothing is accepted and no PR candidate is produced. Run against the
// pristine (still-buggy) base commit so it is independent of applied fixes.
const adversarialIssue = {
  id: 'skill-loop-cart-quantity-adversarial',
  projectId: 'siloop-adv-cart-quantity',
  loopId: 'siloop-003-adv-cart-quantity',
  task: path.join(SCENARIO_ROOT, 'tasks/cart-quantity.task.yaml'),
  eval: path.join(SCENARIO_ROOT, 'evals/cart-quantity.eval.yaml')
};

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
  return JSON.parse(result.stdout);
}

async function runImprove({ issue, repoPath, dataDir, baseCommit }) {
  return runCommand(
    process.execPath,
    [
      VIBELOOP_RUN_SCRIPT,
      '--data-dir',
      dataDir,
      'improve',
      '--repo',
      repoPath,
      '--task',
      issue.task,
      '--eval',
      issue.eval,
      '--agent',
      verboseBuilder,
      '--challenger',
      tightChallenger,
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
}

async function readSelectionReport(selectionPath, issueId) {
  const text = await readFile(selectionPath, 'utf8');
  if (text.includes(HIDDEN_SENTINEL)) {
    throw new Error(
      `issue ${issueId} leaked hidden sentinel in selection report`
    );
  }
  return JSON.parse(text);
}

// One self-improvement iteration: build pool + challenger, assert the Arbiter
// picked the strictly-better candidate, then apply & commit the selected patch.
async function runImproveIteration({
  issue,
  repoPath,
  dataDir,
  previousIssueIds
}) {
  const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  const improveResult = await runImprove({
    issue,
    repoPath,
    dataDir,
    baseCommit
  });
  if (improveResult.code !== 0) {
    throw new Error(
      `issue ${issue.id} improve exit ${improveResult.code}: ${redact(improveResult.stdout)}\n${redact(improveResult.stderr)}`
    );
  }
  const output = parseJsonOutput(improveResult, `improve ${issue.id}`);
  if (output.candidate_count !== 2 || output.accepted_count !== 2) {
    throw new Error(
      `issue ${issue.id} expected 2 accepted candidates, got ${output.accepted_count}/${output.candidate_count}`
    );
  }
  if (!output.selected_candidate_id) {
    throw new Error(`issue ${issue.id} produced no selected candidate`);
  }

  const selection = await readSelectionReport(
    output.selection_report,
    issue.id
  );
  const builder = selection.candidates.find((c) =>
    c.candidate_id.endsWith('-c0')
  );
  const challenger = selection.candidates.find((c) =>
    c.candidate_id.endsWith('-c1')
  );
  if (!builder || !challenger) {
    throw new Error(`issue ${issue.id} missing builder/challenger candidates`);
  }
  if (!builder.accepted || !challenger.accepted) {
    throw new Error(`issue ${issue.id} expected both candidates accepted`);
  }
  // Self-improvement progression: the challenger must be selected AND score
  // strictly higher than the naive builder (smaller, cleaner diff at equal
  // correctness). This is the measurable "better direction" signal.
  if (output.selected_candidate_id !== challenger.candidate_id) {
    throw new Error(
      `issue ${issue.id} selected ${output.selected_candidate_id}, expected challenger ${challenger.candidate_id}`
    );
  }
  const builderScore = builder.score.total;
  const selectedScore = challenger.score.total;
  const scoreImprovement = selectedScore - builderScore;
  if (scoreImprovement <= 0) {
    throw new Error(
      `issue ${issue.id} challenger did not improve (builder ${builderScore} >= selected ${selectedScore})`
    );
  }
  if (challenger.score.changed_files > builder.score.changed_files) {
    throw new Error(
      `issue ${issue.id} selected candidate has a larger file footprint`
    );
  }

  // The selected candidate's deterministic report is the source of truth.
  const reportText = await readFile(output.selected_report, 'utf8');
  if (reportText.includes(HIDDEN_SENTINEL)) {
    throw new Error(`issue ${issue.id} leaked hidden sentinel in report`);
  }
  const report = JSON.parse(reportText);
  if (
    report.decision !== 'accept' ||
    report.decision_reasons?.[0]?.code !== 'ALL_PASS'
  ) {
    throw new Error(`issue ${issue.id} selected report is not accept/ALL_PASS`);
  }
  const changedFiles = report.changed_files.map((file) => file.path).sort();
  const expected = [...issue.expectedSelectedChangedFiles].sort();
  if (JSON.stringify(changedFiles) !== JSON.stringify(expected)) {
    throw new Error(
      `issue ${issue.id} selected changed unexpected files: ${JSON.stringify(changedFiles)}`
    );
  }
  const hiddenGate = report.gate_runs.find((g) => g.name === issue.hiddenGate);
  if (!hiddenGate || hiddenGate.status !== 'pass') {
    throw new Error(`issue ${issue.id} hidden gate did not pass`);
  }

  const summaryResult = await runCommand(
    process.execPath,
    [SUMMARIZE_REPORT_SCRIPT, '--report', output.selected_report],
    { cwd: REPO_ROOT }
  );
  const summary = parseJsonOutput(summaryResult, `summarize ${issue.id}`);
  if (summary.nextAction !== 'prepare_pr_candidate') {
    throw new Error(`issue ${issue.id} summary not a PR candidate`);
  }

  // Context isolation: the selected candidate's agent log references this issue
  // and never a previously-handled issue id.
  const agentStdout = await readFile(
    path.join(output.selected_artifact_root, 'logs/agent.stdout.log'),
    'utf8'
  );
  if (!agentStdout.includes(issue.id)) {
    throw new Error(`issue ${issue.id} agent log missing current task id`);
  }
  const leakedPrev = previousIssueIds.filter((id) => agentStdout.includes(id));
  if (leakedPrev.length > 0) {
    throw new Error(
      `issue ${issue.id} agent log leaked previous context: ${leakedPrev.join(', ')}`
    );
  }

  // Apply the harness-selected patch, verify, commit, mark PR candidate.
  await git(repoPath, ['apply', output.selected_patch]);
  await mustRun('node', [issue.visibleTest], { cwd: repoPath });
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', `vibeloop selected ${issue.id}`]);
  const commit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  await git(repoPath, ['branch', `pr-candidate/${issue.id}`, commit]);
  const status = (await git(repoPath, ['status', '--short'])).trim();
  if (status !== '') {
    throw new Error(`issue ${issue.id} left dirty git status: ${status}`);
  }

  return {
    issueId: issue.id,
    projectId: issue.projectId,
    loopId: issue.loopId,
    baseCommit,
    acceptedCommit: commit,
    selectedCandidateId: output.selected_candidate_id,
    builderScore,
    selectedScore,
    scoreImprovement,
    builderChangedFiles: builder.score.changed_files,
    selectedChangedFiles: challenger.score.changed_files,
    builderChangedLines: builder.score.changed_lines,
    selectedChangedLines: challenger.score.changed_lines,
    selectedPatch: output.selected_patch,
    selectionReport: output.selection_report,
    summaryNextAction: summary.nextAction,
    prCandidateBranch: `pr-candidate/${issue.id}`,
    contextIsolated: true
  };
}

// Adversarial pool: prove a fully-bad candidate pool yields no PR candidate.
async function runAdversarialIteration({
  issue,
  repoPath,
  dataDir,
  baseCommit
}) {
  const improveResult = await runCommand(
    process.execPath,
    [
      VIBELOOP_RUN_SCRIPT,
      '--data-dir',
      dataDir,
      'improve',
      '--repo',
      repoPath,
      '--task',
      issue.task,
      '--eval',
      issue.eval,
      '--agent',
      `command:node ${AGENT_REGRESSION}`,
      '--challenger',
      `command:node ${AGENT_REGRESSION}`,
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
  // No accepted candidate -> CLI exits with the reject code (10).
  if (improveResult.code !== 10) {
    throw new Error(
      `adversarial pool expected reject exit 10, got ${improveResult.code}: ${redact(improveResult.stdout)}`
    );
  }
  const output = parseJsonOutput(improveResult, `improve ${issue.id}`);
  if (output.selected_candidate_id !== null) {
    throw new Error(`adversarial pool unexpectedly selected a candidate`);
  }
  if (output.accepted_count !== 0 || output.candidate_count !== 2) {
    throw new Error(
      `adversarial pool expected 0/2 accepted, got ${output.accepted_count}/${output.candidate_count}`
    );
  }
  const selection = await readSelectionReport(
    output.selection_report,
    issue.id
  );
  if (selection.candidates.some((c) => c.accepted)) {
    throw new Error(
      `adversarial pool had an accepted candidate in selection report`
    );
  }
  const allRejected = selection.candidates.every(
    (c) => c.decision === 'reject'
  );
  return {
    issueId: issue.id,
    projectId: issue.projectId,
    loopId: issue.loopId,
    candidateCount: output.candidate_count,
    acceptedCount: output.accepted_count,
    selectedCandidateId: output.selected_candidate_id,
    allRejected,
    prCandidateBlocked: output.selected_candidate_id === null,
    selectionReport: output.selection_report
  };
}

async function ghJson(args) {
  const out = await mustRun('gh', args);
  return out.trim() ? JSON.parse(out) : null;
}

// Publish each harness-selected patch as a draft PR against a throwaway private
// GitHub repo (seeded with the buggy base). Each branch is built independently
// off the base so the PR shows exactly that issue's verified change.
async function maybePublishToGitHub({ iterations, runTag }) {
  if (!publishGithub) return { published: false, reason: 'disabled' };
  const ghCheck = await runCommand('gh', ['auth', 'status']);
  if (ghCheck.code !== 0) {
    return { published: false, reason: 'gh_not_authenticated' };
  }
  const repoName = `vibeloop-selfimprove-uat-${runTag}`;
  const fullName = `${githubOwner}/${repoName}`;
  const publishRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-gh-publish-')
  );
  const localPublish = path.join(publishRoot, 'repo');
  try {
    // Seed a STANDALONE publish repo with the buggy base (same tree as
    // initialCommit) so each PR shows a real, per-issue diff. A worktree off the
    // source repo can't recreate the shared `main` branch, so build fresh.
    await cp(TARGET_TEMPLATE, localPublish, { recursive: true });
    await git(localPublish, ['init', '-b', 'main']);
    await git(localPublish, [
      'config',
      'user.email',
      'skill-loop-user@example.test'
    ]);
    await git(localPublish, ['config', 'user.name', 'Skill Loop UAT User']);
    await git(localPublish, ['add', '-A']);
    await git(localPublish, [
      'commit',
      '-m',
      'buggy base for verified-fix PRs'
    ]);
    await mustRun('gh', [
      'repo',
      'create',
      fullName,
      '--private',
      '--source',
      localPublish,
      '--remote',
      'origin',
      '--push'
    ]);

    const pullRequests = [];
    for (const iteration of iterations) {
      const branch = iteration.prCandidateBranch;
      await git(localPublish, ['checkout', '-B', branch, 'main']);
      // git apply --3way is resilient to base differences across issues.
      await git(localPublish, ['apply', '--3way', iteration.selectedPatch]);
      await git(localPublish, ['add', '-A']);
      await git(localPublish, [
        'commit',
        '-m',
        `vibeloop verified fix: ${iteration.issueId}`
      ]);
      await git(localPublish, ['push', '-u', 'origin', branch]);
      const prUrl = (
        await mustRun('gh', [
          'pr',
          'create',
          '--repo',
          fullName,
          '--draft',
          '--base',
          'main',
          '--head',
          branch,
          '--title',
          `[VibeLoop] verified fix: ${iteration.issueId}`,
          '--body',
          `Deterministically selected by the VibeLoop self-improvement loop.\n\nArbiter score: builder ${iteration.builderScore} -> selected ${iteration.selectedScore} (+${iteration.scoreImprovement}).\n\nThis branch was opened by an automated UAT and is safe to delete.`
        ])
      ).trim();
      await git(localPublish, ['checkout', 'main']);
      pullRequests.push({ issueId: iteration.issueId, branch, prUrl });
    }

    const prList = await ghJson([
      'pr',
      'list',
      '--repo',
      fullName,
      '--state',
      'open',
      '--json',
      'number,headRefName,isDraft'
    ]);

    // Cleanup: prefer hard delete (needs delete_repo scope). If the token lacks
    // it, fall back to archiving (needs only repo scope) so the throwaway repo
    // is neutralized rather than left live; report the URL either way.
    let remoteDeleted = false;
    let remoteArchived = false;
    if (!keepRemote) {
      const del = await runCommand('gh', ['repo', 'delete', fullName, '--yes']);
      if (del.code === 0) {
        remoteDeleted = true;
      } else {
        await runCommand('gh', ['repo', 'archive', fullName, '--yes']);
        remoteArchived = true;
      }
    }
    return {
      published: true,
      repo: fullName,
      repoUrl: `https://github.com/${fullName}`,
      pullRequests,
      openDraftPrCount: (prList ?? []).filter((pr) => pr.isDraft).length,
      remoteDeleted,
      remoteArchived
    };
  } finally {
    await rm(publishRoot, { recursive: true, force: true });
  }
}

async function main() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-self-improve-uat-')
  );
  await mkdir(tempRoot, { recursive: true });
  const runTag = `${process.pid}-${Date.now()}`;
  try {
    const { repoPath, initialCommit } = await createTargetRepo(tempRoot);
    const iterations = [];
    const previousIssueIds = [];
    for (const [index, issue] of fixableIssues.entries()) {
      const dataDir = path.join(
        tempRoot,
        `data-iteration-${String(index + 1).padStart(2, '0')}`
      );
      await mkdir(dataDir, { recursive: true });
      const iteration = await runImproveIteration({
        issue,
        repoPath,
        dataDir,
        previousIssueIds
      });
      iterations.push(iteration);
      previousIssueIds.push(issue.id);
    }

    // Adversarial pool runs against the pristine base; nothing is applied.
    const adversarialDataDir = path.join(tempRoot, 'data-adversarial');
    await mkdir(adversarialDataDir, { recursive: true });
    const adversarial = await runAdversarialIteration({
      issue: adversarialIssue,
      repoPath,
      dataDir: adversarialDataDir,
      baseCommit: initialCommit
    });
    const branchesAfterAdversarial = (
      await git(repoPath, ['branch', '--format=%(refname:short)'])
    )
      .split('\n')
      .map((b) => b.trim())
      .filter(Boolean);
    if (
      branchesAfterAdversarial.includes(`pr-candidate/${adversarialIssue.id}`)
    ) {
      throw new Error('adversarial pool created a PR-candidate branch');
    }

    await mustRun('npm', ['test'], { cwd: repoPath });
    const finalCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    const branches = branchesAfterAdversarial.slice().sort();
    const artifactRoots = iterations.map((i) => i.selectionReport);
    const artifactRootsUnique =
      new Set(artifactRoots).size === artifactRoots.length;
    const acceptedCommitsUnique =
      new Set(iterations.map((i) => i.acceptedCommit)).size ===
      iterations.length;
    const everyIterationImproved = iterations.every(
      (i) => i.scoreImprovement > 0
    );

    const github = await maybePublishToGitHub({
      iterations,
      runTag
    });

    const output = {
      status: 'SELF_IMPROVE_PASS',
      scenario: 'skill-self-improvement-loop-uat',
      targetRepo: keepTmp ? repoPath : '[removed]',
      initialCommit,
      finalCommit,
      stopReason: 'issue_queue_exhausted',
      fixableIssueCount: fixableIssues.length,
      acceptedIssueCount: iterations.length,
      adversarialIssueCount: 1,
      everyIterationImproved,
      artifactRootsUnique,
      acceptedCommitsUnique,
      progression: iterations.map((i) => ({
        issueId: i.issueId,
        selectedCandidateId: i.selectedCandidateId,
        builderScore: i.builderScore,
        selectedScore: i.selectedScore,
        scoreImprovement: i.scoreImprovement,
        builderChangedFiles: i.builderChangedFiles,
        selectedChangedFiles: i.selectedChangedFiles,
        builderChangedLines: i.builderChangedLines,
        selectedChangedLines: i.selectedChangedLines,
        summaryNextAction: i.summaryNextAction,
        prCandidateBranch: i.prCandidateBranch,
        contextIsolated: i.contextIsolated
      })),
      adversarial,
      branches,
      github,
      finalUserTest: 'npm test'
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

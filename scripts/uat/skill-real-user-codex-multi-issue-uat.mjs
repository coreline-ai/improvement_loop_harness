#!/usr/bin/env node
// Real-user Codex LIVE multi-issue UAT (RU-2).
//
// This is the first real multi-issue loop lane:
//   1. seed a real throwaway GitHub repo with two independent bugs
//   2. process one issue at a time: cart quantity -> SKU normalization
//   3. for each issue, run real Codex builder + real Codex challenger
//   4. deterministic gates + Arbiter select the best-known accepted patch
//   5. final reverify/provenance/budget evidence must pass
//   6. apply the selected patch to the local integration branch
//   7. push a stacked draft PR branch for each issue
//   8. continue to the next issue and finish with npm test
//
// Honest scope: issue queue is scenario-defined, not auto-discovered. This
// proves the real multi-issue sequential loop, not RU-3 automatic discovery.
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL,
  buildCodexOAuthCommand,
  startCodexOAuthProxy
} from '../../packages/agent-adapters/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const scenarioRoot = path.join(repoRoot, 'tests/e2e/user-scenarios/skill-loop');
const targetTemplate = path.join(scenarioRoot, 'target-template');
const model = process.env.VIBELOOP_UAT_MODEL || 'gpt-5.5';
const reasoningEffort = process.env.VIBELOOP_UAT_REASONING_EFFORT || 'xhigh';
const owner = process.env.VIBELOOP_UAT_GITHUB_OWNER || 'coreline-ai';
const keepRemote = process.env.VIBELOOP_UAT_KEEP_REMOTE === '1';
const keepTmp = process.env.VIBELOOP_UAT_KEEP_TMP === '1';
const defaultQualityJudgeCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(
  path.join(repoRoot, 'scripts/uat/quality-judge-best-patch.mjs')
)}`;
const qualityJudgeCommand =
  process.env.VIBELOOP_UAT_QUALITY_JUDGE_COMMAND || defaultQualityJudgeCommand;
const allowVerificationOnly =
  process.env.VIBELOOP_UAT_ALLOW_VERIFICATION_ONLY === '1';
const hiddenSentinel = 'SECRET_HIDDEN_EXPECTATION';

const issues = [
  {
    id: 'skill-loop-cart-quantity',
    slug: 'cart-quantity',
    task: path.join(scenarioRoot, 'tasks/cart-quantity.task.yaml'),
    eval: path.join(scenarioRoot, 'evals/cart-quantity.eval.yaml'),
    visibleTest: 'tests/cart-quantity.test.cjs',
    expectedChangedFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs']
  },
  {
    id: 'skill-loop-sku-normalization',
    slug: 'sku-normalization',
    task: path.join(scenarioRoot, 'tasks/sku-normalization.task.yaml'),
    eval: path.join(scenarioRoot, 'evals/sku-normalization.eval.yaml'),
    visibleTest: 'tests/sku-normalization.test.cjs',
    expectedChangedFiles: ['src/cart.cjs', 'tests/sku-normalization.test.cjs']
  }
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
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

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(
      /(access_token|refresh_token|api_key|OPENAI_API_KEY|password)\s*[:=]\s*[^\s"']+/gi,
      '$1=[REDACTED]'
    )
    .replaceAll(hiddenSentinel, '[REDACTED_HIDDEN]');
}

async function mustRun(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.code})\nstdout:\n${redact(result.stdout)}\nstderr:\n${redact(result.stderr)}`
    );
  }
  return result;
}

async function git(cwd, args) {
  return mustRun('git', args, { cwd });
}

function blocked(reason, details = {}) {
  console.log(
    JSON.stringify({ status: 'blocked', reason, ...details }, null, 2)
  );
  process.exitCode = 20;
}

function parseCliJson(stdout) {
  const index = stdout.indexOf('{');
  if (index < 0)
    throw new Error(`no JSON in CLI stdout: ${stdout.slice(0, 300)}`);
  return JSON.parse(stdout.slice(index));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function assertNoHiddenLeak(label, value) {
  if (JSON.stringify(value).includes(hiddenSentinel)) {
    throw new Error(`${label} leaked hidden sentinel`);
  }
}

function changedFileNames(report) {
  return (report.changed_files ?? []).map((file) => file.path).sort();
}

function sameStringArray(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

async function createDraftPr({
  fullRepo,
  localRepo,
  branch,
  baseBranch,
  issue,
  model
}) {
  const pr = await run(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      fullRepo,
      '--draft',
      '--base',
      baseBranch,
      '--head',
      branch,
      '--title',
      `[VibeLoop] real-codex verified fix: ${issue.slug}`,
      '--body',
      [
        `Generated by real Codex (${model}) builder/challenger candidates.`,
        'Final authority: deterministic VibeLoop gates + Arbiter + final reverify.',
        `Issue: ${issue.id}`,
        'Auto-merge: disabled.'
      ].join('\n')
    ],
    { cwd: localRepo }
  );
  return pr.code === 0
    ? pr.stdout.trim()
    : `pr_create_failed: ${pr.stderr.trim()}`;
}

async function runIssue({
  issue,
  issueIndex,
  tag,
  agentSpec,
  qualityJudgeCommand,
  dataDir,
  localRepo,
  fullRepo,
  basePrBranch
}) {
  await git(localRepo, ['checkout', 'vibeloop/integration']);
  const baseCommit = (
    await git(localRepo, ['rev-parse', 'HEAD'])
  ).stdout.trim();
  const loopId = `realuser-multi-${issue.slug}-${tag}`;
  const logPrefix = path.join(dataDir, `multi-${issue.slug}`);

  const cli = await run(process.execPath, [
    path.join(repoRoot, 'packages/cli/bin/vibeloop'),
    '--data-dir',
    dataDir,
    'improve',
    '--repo',
    localRepo,
    '--task',
    issue.task,
    '--eval',
    issue.eval,
    '--agent',
    agentSpec,
    '--challenger',
    agentSpec,
    '--project-id',
    'realuser-live-multi',
    '--loop-id',
    loopId,
    '--base-commit',
    baseCommit,
    '--quality-judge',
    qualityJudgeCommand,
    '--skip-dependency-install'
  ]);
  await writeFile(`${logPrefix}.stdout.log`, cli.stdout);
  await writeFile(`${logPrefix}.stderr.log`, cli.stderr);

  if (cli.code !== 0) {
    throw new Error(
      `${issue.id} improve failed ${cli.code}\nstdout:\n${redact(cli.stdout)}\nstderr:\n${redact(cli.stderr)}`
    );
  }

  const output = parseCliJson(cli.stdout);
  const selection = await readJson(output.selection_report);
  const selectedReport = await readJson(output.selected_report);
  const qualityPath = path.join(
    path.dirname(output.selected_report),
    'quality-report.json'
  );
  const quality = existsSync(qualityPath) ? await readJson(qualityPath) : null;
  const reverifyReport = output.final_verification?.reverify_report
    ? await readJson(output.final_verification.reverify_report)
    : null;

  assertNoHiddenLeak(`${issue.id} output`, output);
  assertNoHiddenLeak(`${issue.id} selection`, selection);
  assertNoHiddenLeak(`${issue.id} selected report`, selectedReport);

  const selectedReason = selectedReport.decision_reasons?.[0]?.code ?? null;
  const prCandidate =
    !!output.selected_candidate_id &&
    selectedReport.decision === 'accept' &&
    selectedReason === 'ALL_PASS' &&
    quality?.met === true &&
    quality?.status !== 'fail' &&
    output.final_verification?.passed === true &&
    output.final_verification?.provenance_ok === true;

  if (!prCandidate) {
    throw new Error(
      `${issue.id} did not satisfy PR predicate: ${JSON.stringify({
        selected: output.selected_candidate_id,
        decision: selectedReport.decision,
        selectedReason,
        quality,
        finalVerification: output.final_verification
      })}`
    );
  }

  const changed = changedFileNames(selectedReport);
  if (!sameStringArray(changed, issue.expectedChangedFiles)) {
    throw new Error(
      `${issue.id} changed unexpected files: ${JSON.stringify(changed)}`
    );
  }

  if (reverifyReport?.decision !== 'accept') {
    throw new Error(`${issue.id} final reverify report is not accept`);
  }

  const scores = (selection.candidates ?? []).map((candidate) => ({
    id: candidate.candidate_id,
    accepted: candidate.accepted,
    decision: candidate.decision,
    qualified: candidate.qualified,
    score: candidate.score?.total ?? null,
    quality_metric_score: candidate.score?.quality_metric_score ?? null,
    changed_files: candidate.score?.changed_files ?? null,
    changed_lines: candidate.score?.changed_lines ?? null
  }));
  const selectedScore =
    scores.find((score) => score.id === output.selected_candidate_id)?.score ??
    null;
  const acceptedScores = scores
    .filter((score) => score.accepted && typeof score.score === 'number')
    .map((score) => score.score);
  const scoreSpread =
    acceptedScores.length > 0
      ? Math.max(...acceptedScores) - Math.min(...acceptedScores)
      : 0;
  const advisoryTieBreak = output.advisory_tie_break ?? null;
  const selectionQuality =
    output.selection_quality ?? selection.selection_quality ?? null;
  const qualityJudgeRan = advisoryTieBreak?.ran === true;
  const qualityJudgeChangedPick = advisoryTieBreak?.changed_pick === true;
  const strictScoreImprovement =
    selectionQuality?.strict_score_improvement === true &&
    selectionQuality?.full_autonomous_improvement_eligible === true;
  const bestChoiceEvidence =
    selectionQuality?.evidence ??
    (qualityJudgeRan ? 'advisory_tie_break_no_fixed_distinction' : 'none');
  const advisoryQualitySupported =
    selectionQuality?.advisory_supported === true || qualityJudgeChangedPick;
  const bestChoiceSupported =
    selectionQuality?.best_choice_supported === true ||
    strictScoreImprovement ||
    advisoryQualitySupported;
  // "Proven" is intentionally stricter than "supported": only fixed-score
  // evidence can prove full autonomous improvement. Advisory tie-breaks can
  // support a human/reviewer decision but never make a full PASS.
  const bestChoiceProven = strictScoreImprovement;

  await git(localRepo, ['apply', output.selected_patch]);
  await mustRun('node', [issue.visibleTest], { cwd: localRepo });
  await mustRun('npm', ['test'], { cwd: localRepo });
  await git(localRepo, ['add', '-A']);
  await git(localRepo, ['commit', '-m', `vibeloop selected ${issue.id}`]);
  const acceptedCommit = (
    await git(localRepo, ['rev-parse', 'HEAD'])
  ).stdout.trim();
  const branch = `pr-candidate/${issue.slug}-${tag}`;
  await git(localRepo, ['branch', '-f', branch, acceptedCommit]);
  await git(localRepo, ['push', '-u', 'origin', branch]);
  const prUrl = await createDraftPr({
    fullRepo,
    localRepo,
    branch,
    baseBranch: basePrBranch ?? 'main',
    issue,
    model
  });

  const status = (await git(localRepo, ['status', '--short'])).stdout.trim();
  if (status !== '')
    throw new Error(`${issue.id} left dirty status: ${status}`);

  return {
    issue_id: issue.id,
    issue_index: issueIndex,
    base_commit: baseCommit,
    accepted_commit: acceptedCommit,
    selected_candidate_id: output.selected_candidate_id,
    candidate_count: output.candidate_count,
    accepted_count: output.accepted_count,
    selected_decision: selectedReport.decision,
    selected_reason: selectedReason,
    selected_score: selectedScore,
    score_spread: scoreSpread,
    strict_score_improvement: strictScoreImprovement,
    strict_fixed_score_proven: bestChoiceProven,
    best_choice_supported: bestChoiceSupported,
    best_choice_proven: bestChoiceProven,
    advisory_quality_supported: advisoryQualitySupported,
    best_choice_evidence: bestChoiceEvidence,
    selection_quality: selectionQuality,
    candidates: scores,
    quality_met: quality?.met ?? null,
    advisory_tie_break: advisoryTieBreak,
    quality_judge: {
      configured: true,
      ran: qualityJudgeRan,
      changed_pick: qualityJudgeChangedPick,
      invalid: advisoryTieBreak?.invalid === true,
      error: advisoryTieBreak?.error ?? null
    },
    final_verification: output.final_verification ?? null,
    limits: output.limits ?? null,
    changed_files: changed,
    selection_report: output.selection_report,
    selected_report: output.selected_report,
    reverify_report: output.final_verification?.reverify_report ?? null,
    branch,
    pr_url: prUrl,
    pr_base: basePrBranch ?? 'main'
  };
}

async function main() {
  if ((await run('codex', ['--version'])).code !== 0) {
    return blocked('CODEX_CLI_NOT_AVAILABLE');
  }
  const login = await run('codex', [
    '-c',
    'service_tier=fast',
    'login',
    'status'
  ]);
  const loginText = `${login.stdout}${login.stderr}`;
  if (login.code !== 0 || !/Logged in/i.test(loginText)) {
    return blocked('CODEX_CHATGPT_LOGIN_NOT_AVAILABLE', {
      code: login.code,
      out: loginText.trim().slice(0, 200)
    });
  }
  if ((await run('gh', ['auth', 'status'])).code !== 0) {
    return blocked('GH_NOT_AUTHENTICATED');
  }

  const tag = `${process.pid}-${Date.now()}`;
  const repoName = `vibeloop-realuser-multi-${tag}`;
  const fullRepo = `${owner}/${repoName}`;
  const tmpRoot = await mkdtemp(
    path.join(os.homedir(), '.vibeloop-realuser-multi-')
  );
  const dataDir = path.join(tmpRoot, 'data');
  const localRepo = path.join(tmpRoot, 'project');
  await mkdir(dataDir, { recursive: true });

  let proxy;
  try {
    await cp(targetTemplate, localRepo, { recursive: true });
    await git(localRepo, ['init', '-b', 'main']);
    await git(localRepo, ['config', 'user.email', 'realuser@example.test']);
    await git(localRepo, ['config', 'user.name', 'VibeLoop Real User']);
    await git(localRepo, ['add', '-A']);
    await git(localRepo, ['commit', '-m', 'seed: real multi-issue bugs']);
    const initialCommit = (
      await git(localRepo, ['rev-parse', 'HEAD'])
    ).stdout.trim();
    await mustRun('npm', ['test'], { cwd: localRepo });

    const created = await run('gh', [
      'repo',
      'create',
      fullRepo,
      '--private',
      '--source',
      localRepo,
      '--remote',
      'origin',
      '--push'
    ]);
    if (created.code !== 0) {
      return blocked('GH_REPO_CREATE_FAILED', {
        stderr: created.stderr.trim()
      });
    }

    await git(localRepo, ['checkout', '-b', 'vibeloop/integration']);

    proxy = await startCodexOAuthProxy({
      model,
      upstreamBaseUrl:
        process.env.VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL ||
        DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL
    });
    const agentSpec = buildCodexOAuthCommand({
      codeHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      proxyBaseUrl: proxy.baseUrl,
      provider: 'vibeloop-oauth-proxy',
      model,
      reasoningEffort,
      requiresOpenaiAuth: true
    });

    const iterations = [];
    let previousBranch = null;
    for (const [index, issue] of issues.entries()) {
      const iteration = await runIssue({
        issue,
        issueIndex: index + 1,
        tag,
        agentSpec,
        qualityJudgeCommand,
        dataDir,
        localRepo,
        fullRepo,
        basePrBranch: previousBranch
      });
      iterations.push(iteration);
      previousBranch = iteration.branch;
    }

    await mustRun('npm', ['test'], { cwd: localRepo });
    const finalCommit = (
      await git(localRepo, ['rev-parse', 'HEAD'])
    ).stdout.trim();
    const hiddenLeak = JSON.stringify(iterations).includes(hiddenSentinel);
    const everyIssuePrCandidate = iterations.every(
      (iteration) =>
        iteration.selected_decision === 'accept' &&
        iteration.selected_reason === 'ALL_PASS' &&
        iteration.quality_met === true &&
        iteration.final_verification?.passed === true
    );
    const issueQueueExhausted = iterations.length === issues.length;
    const strictImprovementEveryIssue = iterations.every(
      (iteration) => iteration.strict_score_improvement
    );
    const strictFixedScoreProvenEveryIssue = iterations.every(
      (iteration) => iteration.best_choice_proven
    );
    const bestChoiceSupportedEveryIssue = iterations.every(
      (iteration) => iteration.best_choice_supported
    );
    const advisoryQualitySupportedEveryIssue = iterations.every(
      (iteration) => iteration.advisory_quality_supported
    );
    const tiedAcceptedIterations = iterations.filter(
      (iteration) =>
        Number(iteration.accepted_count ?? 0) >= 2 &&
        Number(iteration.score_spread ?? 0) === 0
    );
    const qualityJudgeRanForAllTies = tiedAcceptedIterations.every(
      (iteration) => iteration.quality_judge?.ran === true
    );
    const verificationPass =
      everyIssuePrCandidate && issueQueueExhausted && !hiddenLeak;
    const status = !verificationPass
      ? 'REAL_USER_MULTI_LOOP_FAIL'
      : strictImprovementEveryIssue
        ? 'REAL_USER_MULTI_FULL_IMPROVEMENT_PASS'
        : bestChoiceSupportedEveryIssue
          ? 'REAL_USER_MULTI_VERIFICATION_PASS_QUALITY_SUPPORTED'
          : 'REAL_USER_MULTI_VERIFICATION_PASS_BEST_UNPROVEN';

    const ledger = {
      status,
      scenario: 'skill-real-user-codex-multi-issue-uat',
      mode: 'scenario-defined multi-issue queue (not auto-discovery)',
      orchestrator:
        'scripted issue queue; real Codex builder/challenger per issue; deterministic Harness authority',
      builder: { real_llm: true, model, via: 'chatgpt-oauth-proxy' },
      github: {
        repo: fullRepo,
        url: `https://github.com/${fullRepo}`,
        seeded_buggy_base: true,
        stacked_draft_prs: iterations.map((iteration) => ({
          issue_id: iteration.issue_id,
          base: iteration.pr_base,
          branch: iteration.branch,
          pr_url: iteration.pr_url
        }))
      },
      initial_commit: initialCommit,
      final_commit: finalCommit,
      issue_count: issues.length,
      accepted_issue_count: iterations.length,
      issue_queue_exhausted: issueQueueExhausted,
      every_issue_pr_candidate: everyIssuePrCandidate,
      verification_status: verificationPass ? 'pass' : 'fail',
      improvement_status: !verificationPass
        ? 'not_evaluated'
        : strictImprovementEveryIssue
          ? 'strict_score_pass'
          : bestChoiceSupportedEveryIssue
            ? advisoryQualitySupportedEveryIssue
              ? 'quality_advisory_supported'
              : 'quality_supported_non_full'
            : 'best_unproven',
      strict_score_improvement_every_issue: strictImprovementEveryIssue,
      strict_fixed_score_proven_every_issue: strictFixedScoreProvenEveryIssue,
      best_choice_supported_every_issue: bestChoiceSupportedEveryIssue,
      advisory_quality_supported_every_issue:
        advisoryQualitySupportedEveryIssue,
      // Backward-compatible but deliberately strict: "proven" only means fixed
      // score proof, not advisory support.
      best_choice_proven_every_issue: strictFixedScoreProvenEveryIssue,
      full_autonomous_improvement_pass:
        verificationPass && strictImprovementEveryIssue,
      strict_full_pass_invariant: {
        verification_required: true,
        strict_score_required: true,
        advisory_support_is_not_enough: true,
        satisfied: verificationPass && strictImprovementEveryIssue
      },
      false_pass: 0,
      leak: hiddenLeak ? 1 : 0,
      proxy_auth_header_seen: proxy?.stats?.auth_header_seen ?? null,
      quality_judge: {
        command:
          qualityJudgeCommand === defaultQualityJudgeCommand
            ? 'scripts/uat/quality-judge-best-patch.mjs'
            : '[custom]',
        connected_to_live_ru2: true,
        tied_accepted_iteration_count: tiedAcceptedIterations.length,
        ran_for_all_tied_accepted_iterations: qualityJudgeRanForAllTies,
        note: 'advisory tie-break only; cannot override fixed verifier/evaluator and does not make strict_score_improvement true'
      },
      iterations,
      evidence: { tmp_root: tmpRoot, data_dir: dataDir, local_repo: localRepo }
    };

    if (
      ledger.status === 'REAL_USER_MULTI_FULL_IMPROVEMENT_PASS' &&
      !strictImprovementEveryIssue
    ) {
      throw new Error(
        'strict full-pass invariant violated: full improvement requires strict_score_improvement_every_issue=true'
      );
    }
    if (
      ledger.full_autonomous_improvement_pass !==
      (verificationPass && strictImprovementEveryIssue)
    ) {
      throw new Error(
        'strict full-pass invariant violated: full_autonomous_improvement_pass must equal verificationPass && strictImprovementEveryIssue'
      );
    }
    if (
      verificationPass &&
      tiedAcceptedIterations.length > 0 &&
      !qualityJudgeRanForAllTies
    ) {
      throw new Error(
        'quality judge invariant violated: every accepted score tie in live RU-2 must run the configured quality judge'
      );
    }

    assertNoHiddenLeak('ledger', ledger);
    console.log(JSON.stringify(ledger, null, 2));
    if (!verificationPass) process.exitCode = 1;
    else if (
      ledger.status !== 'REAL_USER_MULTI_FULL_IMPROVEMENT_PASS' &&
      !allowVerificationOnly
    )
      process.exitCode = 1;
  } finally {
    if (proxy) await proxy.close().catch(() => undefined);
    if (!keepRemote) {
      const del = await run('gh', ['repo', 'delete', fullRepo, '--yes']);
      if (del.code !== 0)
        await run('gh', ['repo', 'archive', fullRepo, '--yes']);
    }
    if (!keepTmp) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error)
  );
  process.exitCode = 1;
});

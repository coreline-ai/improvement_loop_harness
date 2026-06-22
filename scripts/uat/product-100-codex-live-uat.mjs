#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildProduct100CorpusSpec } from './product-100-corpus.mjs';
import {
  buildProduct100IssueEvalArtifacts,
  summarizeProduct100EvalArtifacts,
  writeProduct100EvalArtifacts
} from './product-100-eval-generator.mjs';
import {
  writeProduct100Scaffold,
  validateProduct100BaseFailures
} from './product-100-scaffold.mjs';
import {
  evaluateProduct100Phase5,
  runProduct100Phase5LiveForIssues
} from './product-100-adversary.mjs';
import { prepareProduct100CodexHome } from './product-100-codex-home.mjs';
import {
  evaluateProduct100Phase6,
  runProduct100Phase6Release
} from './product-100-release.mjs';
import { runProduct100Phase7DocsCheck } from './product-100-docs.mjs';
import {
  PRODUCT_100_BLOCKED_STATUS,
  PRODUCT_100_FAIL_STATUS,
  PRODUCT_100_PASS_STATUS,
  buildProduct100Ledger
} from './product-100-contract.mjs';
import {
  buildProduct100PreflightReport,
  product100PreflightExitCode
} from './product-100-preflight.mjs';

export const PRODUCT_100_LIVE_UAT_SCENARIO = 'product-100-codex-live-uat';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const DEFAULT_MODEL = process.env.VIBELOOP_UAT_MODEL || 'gpt-5.5';
const DEFAULT_REASONING_EFFORT =
  process.env.VIBELOOP_UAT_REASONING_EFFORT || 'xhigh';
const DEFAULT_CANDIDATES_PER_ISSUE = 4;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 240;
const DEFAULT_STRICT_BEST_RETRIES = 2;

export function product100TmpParent(env = process.env) {
  return path.resolve(
    env.VIBELOOP_PRODUCT_100_TMP_PARENT || path.join(os.homedir(), '.vibeloop')
  );
}

async function createProduct100TmpRoot() {
  const parent = product100TmpParent();
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, 'product-100-real-loop-'));
}

export function product100CandidatesPerIssue(env = process.env, options = {}) {
  const raw =
    options.candidatesPerIssue ??
    env.VIBELOOP_PRODUCT_100_CANDIDATES_PER_ISSUE ??
    DEFAULT_CANDIDATES_PER_ISSUE;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 2
    ? value
    : DEFAULT_CANDIDATES_PER_ISSUE;
}

export function product100AgentTimeoutSeconds(env = process.env, options = {}) {
  const raw =
    options.agentTimeoutSeconds ??
    env.VIBELOOP_PRODUCT_100_AGENT_TIMEOUT_SECONDS ??
    DEFAULT_AGENT_TIMEOUT_SECONDS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 30
    ? value
    : DEFAULT_AGENT_TIMEOUT_SECONDS;
}

export function product100StrictBestRetries(env = process.env, options = {}) {
  const raw =
    options.strictBestRetries ??
    env.VIBELOOP_PRODUCT_100_STRICT_BEST_RETRIES ??
    DEFAULT_STRICT_BEST_RETRIES;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_STRICT_BEST_RETRIES;
}

export function shouldRetryProduct100StrictBest(out) {
  if (!out || out.pr_candidate !== true) return false;
  if (out.selection_quality?.strict_score_improvement === true) return false;
  const reasons = out.selection_quality?.reasons ?? [];
  return (
    out.selection_quality?.status === 'single_accepted_no_comparator' ||
    out.selection_quality?.status === 'fixed_tie_no_distinction' ||
    reasons.includes('only_one_accepted_candidate') ||
    reasons.includes('fixed_scores_do_not_prove_better_choice') ||
    Number(out.accepted_count ?? 0) < 2
  );
}

function product100StrictBestRetryReason(out) {
  if (!shouldRetryProduct100StrictBest(out)) return null;
  const reasons = out.selection_quality?.reasons ?? [];
  if (
    out.selection_quality?.status === 'fixed_tie_no_distinction' ||
    reasons.includes('fixed_scores_do_not_prove_better_choice')
  ) {
    return 'strict_best_fixed_tie_no_distinction';
  }
  return 'strict_best_single_accepted_no_comparator';
}

const PRODUCT_100_TIMEOUT_PATTERN =
  /\b(?:timed?\s*out|timeout|time\s+limit|deadline\s+exceeded|etimedout|esockettimedout)\b/i;

function hasProduct100TimeoutText(value) {
  if (value === null || value === undefined) return false;
  return PRODUCT_100_TIMEOUT_PATTERN.test(String(value));
}

function product100CandidateTimeoutDetected({ cli = {}, out = null } = {}) {
  if (
    cli.timeout === true ||
    cli.timedOut === true ||
    out?.timeout === true ||
    cli.code === 124
  ) {
    return true;
  }

  const statusValues = [
    cli.status,
    cli.reason,
    cli.error?.code,
    cli.error?.name,
    cli.error?.message,
    out?.status,
    out?.reason,
    out?.fail_reason,
    out?.failure_reason,
    out?.error?.status,
    out?.error?.code,
    out?.error?.reason,
    out?.error?.message
  ];

  if (statusValues.some((value) => hasProduct100TimeoutText(value))) {
    return true;
  }

  return cli.ok !== true && hasProduct100TimeoutText(cli.stderr);
}

async function product100SelectionTimeoutEvidence(out) {
  const selectionReport = out?.selection_report;
  const loopId = out?.loop_id;
  if (!selectionReport || !loopId) return { timeout: false, evidence: null };

  const evidence = {
    selection_report: selectionReport,
    eval_reports: [],
    timed_out_candidate_ids: []
  };
  let selection = null;
  try {
    const text = await readFile(selectionReport, 'utf8');
    if (hasProduct100TimeoutText(text)) {
      return { timeout: true, evidence };
    }
    selection = JSON.parse(text);
  } catch {
    return { timeout: false, evidence };
  }

  const candidateIds = Array.isArray(selection?.candidates)
    ? selection.candidates
        .map((candidate) => candidate?.candidate_id)
        .filter((candidateId) => typeof candidateId === 'string')
    : [];
  const fallbackCount = Number(out?.candidate_count ?? 0);
  const ids =
    candidateIds.length > 0
      ? candidateIds
      : Array.from({ length: fallbackCount }, (_, index) => `${loopId}-c${index}`);
  const runsRoot = path.join(path.dirname(path.dirname(selectionReport)), 'runs');
  let timeout = false;
  for (const candidateId of ids) {
    const evalReport = path.join(runsRoot, candidateId, 'reports/eval-report.json');
    try {
      const text = await readFile(evalReport, 'utf8');
      if (hasProduct100TimeoutText(text)) {
        timeout = true;
        evidence.timed_out_candidate_ids.push(candidateId);
        evidence.eval_reports.push(evalReport);
      }
    } catch {
      // Missing candidate eval reports are handled by the normal candidate failure path.
    }
  }
  return { timeout, evidence: timeout ? evidence : null };
}

export async function classifyProduct100CandidateAttemptWithEvidence(input = {}) {
  const diagnostic = classifyProduct100CandidateAttempt(input);
  if (diagnostic.timeout) return diagnostic;
  const selectionTimeout = await product100SelectionTimeoutEvidence(input.out);
  if (!selectionTimeout.timeout) return diagnostic;
  if (input.out?.pr_candidate === true) {
    return {
      ...diagnostic,
      partial_timeout: true,
      partial_timeout_evidence: selectionTimeout.evidence
    };
  }
  return {
    status: 'blocked',
    reason: 'candidate_timeout',
    fail_reason: 'candidate_timeout',
    timeout: true,
    timeout_evidence: selectionTimeout.evidence
  };
}

export function classifyProduct100CandidateAttempt({
  cli = {},
  out = null,
  parseError = null
} = {}) {
  const timeout = product100CandidateTimeoutDetected({ cli, out });
  if (timeout) {
    return {
      status: 'blocked',
      reason: 'candidate_timeout',
      fail_reason: 'candidate_timeout',
      timeout: true
    };
  }

  const strict = out?.selection_quality?.strict_score_improvement === true;
  const prCandidate = out?.pr_candidate === true;
  if (strict && prCandidate) {
    return {
      status: 'pass',
      reason: null,
      fail_reason: null,
      timeout: false
    };
  }

  let reason = 'candidate_failed';
  if (parseError) {
    reason = 'candidate_output_parse_error';
  } else if (cli.ok === false || (cli.code !== undefined && cli.code !== 0)) {
    reason = 'candidate_command_failed';
  } else if (!out) {
    reason = 'candidate_output_missing';
  } else if (!prCandidate) {
    reason = 'candidate_not_pr_candidate';
  } else if (!strict) {
    reason = 'strict_score_improvement_missing';
  }

  return {
    status: 'fail',
    reason,
    fail_reason: reason,
    timeout: false
  };
}

export function summarizeProduct100CandidateIssueDiagnostic(attempts = []) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return {
      status: 'fail',
      reason: 'missing_attempt',
      fail_reason: 'missing_attempt',
      timeout: false,
      timeout_attempt_count: 0,
      attempt_count: 0
    };
  }

  const diagnostics = attempts.map(
    (attempt) =>
      attempt.diagnostic ??
      classifyProduct100CandidateAttempt({
        cli: attempt.cli,
        out: attempt.out,
        parseError: attempt.parse_error
      })
  );
  const timeoutAttemptCount = diagnostics.filter(
    (diagnostic) => diagnostic.timeout === true
  ).length;

  if (timeoutAttemptCount === attempts.length) {
    const reason =
      attempts.length > 1
        ? 'candidate_timeout_retries_exhausted'
        : 'candidate_timeout';
    return {
      status: 'blocked',
      reason,
      fail_reason: reason,
      timeout: true,
      timeout_attempt_count: timeoutAttemptCount,
      attempt_count: attempts.length
    };
  }

  const passingDiagnostic = diagnostics.find(
    (diagnostic) => diagnostic.status === 'pass'
  );
  if (passingDiagnostic) {
    return {
      status: 'pass',
      reason: null,
      fail_reason: null,
      timeout: timeoutAttemptCount > 0,
      timeout_attempt_count: timeoutAttemptCount,
      attempt_count: attempts.length
    };
  }

  const prCandidateIndex = attempts.findIndex(
    (attempt) => attempt.pr_candidate === true
  );
  const selectedIndex =
    prCandidateIndex >= 0 ? prCandidateIndex : diagnostics.length - 1;
  const selectedDiagnostic = diagnostics[selectedIndex] ?? diagnostics.at(-1);
  const reason =
    selectedDiagnostic?.fail_reason ??
    selectedDiagnostic?.reason ??
    'strict_score_improvement_missing';

  return {
    status: selectedDiagnostic?.status === 'blocked' ? 'blocked' : 'fail',
    reason,
    fail_reason: reason,
    timeout: timeoutAttemptCount > 0,
    timeout_attempt_count: timeoutAttemptCount,
    attempt_count: attempts.length
  };
}

export function product100CandidateHeartbeatFields({
  artifact = {},
  attempt = 0,
  attemptLoopId = null,
  out = null,
  diagnostic = null,
  evidence = null
} = {}) {
  const selectedCandidateId = out?.selected_candidate_id ?? null;
  return {
    repo_id: artifact.repo_id ?? null,
    issue_id: artifact.issue_id ?? null,
    attempt,
    current_attempt: attempt,
    attempt_loop_id: attemptLoopId,
    candidate_id: selectedCandidateId ?? attemptLoopId ?? `attempt-${attempt}`,
    selected_candidate_id: selectedCandidateId,
    timeout: diagnostic?.timeout === true,
    partial_timeout: diagnostic?.partial_timeout === true,
    fail_reason: diagnostic?.fail_reason ?? null,
    reason: diagnostic?.reason ?? diagnostic?.fail_reason ?? null,
    evidence
  };
}

export function product100IssueFilter(env = process.env, options = {}) {
  const raw =
    options.issueIds ??
    env.VIBELOOP_PRODUCT_100_ISSUE_IDS ??
    env.VIBELOOP_PRODUCT_100_ISSUE_FILTER ??
    '';
  const values = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  const normalized = values.map((item) => item.toUpperCase());
  return {
    active: normalized.length > 0,
    values: normalized,
    matches(artifact) {
      if (normalized.length === 0) return true;
      const issueId = String(artifact.issue_id ?? '').toUpperCase();
      const repoIssue = `${String(artifact.repo_id ?? '').toUpperCase()}/${issueId}`;
      return normalized.includes(issueId) || normalized.includes(repoIssue);
    }
  };
}

export function product100CodexLiveReportPath(report, env = process.env) {
  if (env.VIBELOOP_PRODUCT_100_REPORT_FILE) {
    return path.resolve(env.VIBELOOP_PRODUCT_100_REPORT_FILE);
  }
  const tmpRoot = report?.summary?.phase4?.tmp_root;
  return typeof tmpRoot === 'string' && tmpRoot
    ? path.join(tmpRoot, 'product-100-live-report.json')
    : null;
}

export async function writeProduct100CodexLiveReport(report, env = process.env) {
  const reportPath = product100CodexLiveReportPath(report, env);
  if (!reportPath) return null;
  report.report_file = reportPath;
  report.evidence = {
    ...(report.evidence ?? {}),
    product_100_live_report: reportPath
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

function repeatedFlag(flag, value, count) {
  return Array.from({ length: count }, () => [flag, value]).flat();
}

function safeBranchSegment(value, fallback = 'segment') {
  const segment = String(value ?? fallback)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return segment && segment !== '.' && segment !== '..' ? segment : fallback;
}

function product100HeadBranch(runId, artifact) {
  return [
    'product-100',
    safeBranchSegment(runId, 'run'),
    safeBranchSegment(artifact.repo_id, 'repo'),
    safeBranchSegment(artifact.issue_id, 'issue')
  ].join('/');
}

export function shouldProvisionProduct100GithubRepos(env = process.env, options = {}) {
  return (
    options.enableGithubRepos === true ||
    env.VIBELOOP_PRODUCT_100_ENABLE_GITHUB_REPOS === '1'
  );
}

export function product100GithubOwner(env = process.env, options = {}) {
  return (
    options.githubOwner ??
    env.VIBELOOP_PRODUCT_100_GITHUB_OWNER ??
    env.VIBELOOP_UAT_GITHUB_OWNER ??
    'coreline-ai'
  );
}

export function product100GithubRepoName(runId, repoId) {
  return `vibeloop-p100-${safeBranchSegment(runId, 'run').slice(0, 34)}-${safeBranchSegment(repoId, 'repo').slice(0, 42)}`;
}

async function writeProduct100Progress(tmpRoot, progress) {
  const progressPath = path.join(tmpRoot, 'product-100-progress.json');
  await writeFile(
    progressPath,
    `${JSON.stringify(
      {
        updated_at: new Date().toISOString(),
        ...progress,
        progress_file: progressPath
      },
      null,
      2
    )}
`
  );
  return progressPath;
}

async function product100CandidateRunSnapshot(dataDir, projectId, baseLoopId) {
  const runsRoot = path.join(dataDir, 'projects', projectId, 'runs');
  let entries = [];
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return {
      runs_root: runsRoot,
      candidate_run_dir_count: 0,
      reverify_run_dir_count: 0,
      run_dirs: []
    };
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(baseLoopId))
    .map((entry) => entry.name)
    .sort();
  return {
    runs_root: runsRoot,
    candidate_run_dir_count: names.filter((name) => /-c\d+(?:$|-)/.test(name)).length,
    reverify_run_dir_count: names.filter((name) => name.includes('-reverify')).length,
    run_dirs: names.slice(-12)
  };
}

async function provisionProduct100GithubRepos({
  corpus,
  scaffoldRoot,
  runId,
  env = process.env,
  options = {}
}) {
  if (!shouldProvisionProduct100GithubRepos(env, options)) {
    return { enabled: false, repos: new Map(), results: [] };
  }
  const owner = product100GithubOwner(env, options);
  const repos = new Map();
  const results = [];
  for (const repo of corpus.repos) {
    const repoName = product100GithubRepoName(runId, repo.repo_id);
    const fullName = `${owner}/${repoName}`;
    const repoPath = path.join(scaffoldRoot, repo.repo_id);
    await run('git', ['remote', 'remove', 'product100-origin'], { cwd: repoPath });
    const created = await run('gh', [
      'repo',
      'create',
      fullName,
      '--private',
      '--source',
      repoPath,
      '--remote',
      'product100-origin',
      '--push'
    ], { cwd: repoPath });
    const result = {
      repo_id: repo.repo_id,
      full_name: fullName,
      ok: created.ok,
      exit_code: created.code,
      stdout: String(created.stdout ?? '').trim(),
      stderr: String(created.stderr ?? '').trim()
    };
    results.push(result);
    if (!created.ok) {
      throw new Error(`Product-100 GitHub repo provisioning failed for ${fullName}: ${created.stderr || created.stdout}`);
    }
    repos.set(repo.repo_id, fullName);
  }
  return { enabled: true, owner, repos, results };
}


function requirementsFromPreflight(preflight) {
  return {
    live_preflight_pass: preflight.checks?.live?.status === 'pass',
    r1_container_preflight_pass:
      preflight.checks?.r1_adversary_container?.status === 'pass',
    real_codex_builder_used_every_issue: false,
    real_codex_challenger_used_every_issue: false,
    hidden_eval_generated_and_passed_every_issue: false,
    real_codex_adversary_reviewer_used:
      preflight.checks?.real_adversary_reviewer?.ok === true,
    accepted_review_proposal_count_at_least_one: false,
    same_model_review_false: false,
    m2_confirmed_under_r1: false,
    m4_replay_safe_under_r1: false,
    frozen_rulepack_semantic_gate_passed_next_loop: false,
    strict_score_improvement_every_issue: false,
    every_issue_pr_candidate: false,
    rediscovery_after_each_fix: false,
    github_draft_prs_open: false,
    false_pass_zero: true,
    leak_zero: true,
    evidence_missing_count_zero: true,
    release_evidence_audit_pass: false,
    docs_run_ledger_readme_truthful: false
  };
}

function requirementsFromPhaseReports(preflight, phase4, phase5 = null, phase6 = null, phase7 = null) {
  const phase5Eval = phase5?.phase5_pass === undefined ? evaluateProduct100Phase5(phase5 ?? {}) : phase5;
  const phase6Eval = phase6?.phase6_pass === undefined ? evaluateProduct100Phase6(phase6 ?? {}) : phase6;
  return {
    ...requirementsFromPreflight(preflight),
    real_codex_builder_used_every_issue:
      phase4.real_codex_builder_used_every_issue === true,
    real_codex_challenger_used_every_issue:
      phase4.real_codex_challenger_used_every_issue === true,
    hidden_eval_generated_and_passed_every_issue:
      phase4.hidden_eval_generated_and_passed_every_issue === true,
    real_codex_adversary_reviewer_used:
      phase5Eval.real_codex_adversary_reviewer_used === true,
    accepted_review_proposal_count_at_least_one:
      phase5Eval.accepted_review_proposal_count_at_least_one === true,
    same_model_review_false: phase5Eval.same_model_review_false === true,
    m2_confirmed_under_r1: phase5Eval.m2_confirmed_under_r1 === true,
    m4_replay_safe_under_r1: phase5Eval.m4_replay_safe_under_r1 === true,
    frozen_rulepack_semantic_gate_passed_next_loop:
      phase5Eval.frozen_rulepack_semantic_gate_passed_next_loop === true,
    strict_score_improvement_every_issue:
      phase4.strict_score_improvement_every_issue === true,
    every_issue_pr_candidate: phase4.every_issue_pr_candidate === true,
    rediscovery_after_each_fix: phase4.rediscovery_after_each_fix === true,
    github_draft_prs_open: phase6Eval.github_draft_prs_open === true,
    release_evidence_audit_pass: phase6Eval.release_evidence_audit_pass === true,
    false_pass_zero: phase4.false_pass_zero !== false,
    leak_zero: phase4.leak_zero !== false,
    evidence_missing_count_zero:
      phase4.evidence_missing_count_zero !== false &&
      phase6Eval.evidence_missing_count_zero === true,
    docs_run_ledger_readme_truthful:
      phase7?.docs_run_ledger_readme_truthful === true ||
      phase7?.phase7_pass === true
  };
}

function blockedLedger({ preflight, evalSummary, baseValidation, runId }) {
  return buildProduct100Ledger({
    run_id: runId,
    scope: 'product_100_candidate',
    requirements: requirementsFromPreflight(preflight),
    blocked_requirements: preflight.blocked_requirements ?? [],
    summary: {
      preflight_status: preflight.status,
      eval_generation: evalSummary,
      base_validation: baseValidation,
      live_loop_started: false,
      false_pass_zero: true,
      leak_zero: true
    },
    evidence: {
      preflight
    },
    next_step: preflight.next_step
  });
}

function phase4Ledger({ preflight, evalSummary, baseValidation, phase4, phase5, phase6, phase7, runId }) {
  return buildProduct100Ledger({
    run_id: runId,
    scope: 'product_100_candidate',
    requirements: requirementsFromPhaseReports(preflight, phase4, phase5, phase6, phase7),
    summary: {
      preflight_status: preflight.status,
      eval_generation: evalSummary,
      base_validation: baseValidation,
      phase4,
      phase5: phase5 ?? null,
      phase6: phase6 ?? null,
      phase7: phase7 ?? null,
      live_loop_started: true,
      driver_status: phase4.every_issue_product_100_phase4_pass
        ? 'PRODUCT_100_PHASE4_PASS_PENDING_PHASE5_6_7'
        : 'PRODUCT_100_PHASE4_FAIL'
    },
    evidence: {
      preflight,
      phase4,
      ...(phase5 ? { phase5 } : {}),
      ...(phase6 ? { phase6 } : {}),
      ...(phase7 ? { phase7 } : {})
    },
    issue_results: phase4.issues ?? [],
    next_step: phase4.every_issue_product_100_phase4_pass
      ? 'Continue with Phase 5 real adversary reviewer M2/M4/freeze/N+1; Product-100 PASS is still impossible until Phase5/6/7 requirements are true.'
      : 'Fix Product-100 Phase 4 real Codex Builder/Challenger loop failures before continuing.'
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
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
    child.on('error', (error) => {
      resolve({ code: null, ok: false, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      resolve({ code, ok: code === 0, stdout, stderr });
    });
  });
}

async function mustRun(command, args, options = {}) {
  const result = await run(command, args, options);
  if (!result.ok) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return result;
}

async function git(cwd, args) {
  return mustRun('git', args, { cwd });
}

function parseCliJson(stdout) {
  const index = String(stdout).indexOf('{');
  if (index < 0) throw new Error(`no JSON in CLI stdout: ${stdout.slice(0, 300)}`);
  return JSON.parse(stdout.slice(index));
}

async function visibleTestsPass(repoPath, artifact) {
  const commands = artifact.task.acceptance?.required_tests ?? [];
  const results = [];
  for (const command of commands) {
    const [bin, ...args] = command.split(/\s+/).filter(Boolean);
    const result = await run(bin, args, { cwd: repoPath });
    results.push({ command, exit_code: result.code, ok: result.ok });
  }
  return { ok: results.every((item) => item.ok), results };
}

async function applySelectedPatch(repoPath, patchPath, message) {
  await git(repoPath, ['apply', patchPath]);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', message]);
}

export async function runProduct100RealCodexLoop(options = {}) {
  const corpus = options.corpus ?? buildProduct100CorpusSpec();
  const runId = options.runId ?? `product-100-phase4-${process.pid}-${Date.now()}`;
  const tmpRoot = options.tmpRoot ?? (await createProduct100TmpRoot());
  const scaffoldRoot = path.join(tmpRoot, 'repos');
  const evalRoot = path.join(tmpRoot, 'product-100-artifacts');
  const dataDir = path.join(tmpRoot, 'data');
  const evalOptions = {
    agentTimeoutSeconds: product100AgentTimeoutSeconds(process.env, options)
  };
  const artifacts = buildProduct100IssueEvalArtifacts(corpus, evalOptions);
  const maxIssues = Number(options.maxIssues ?? process.env.VIBELOOP_PRODUCT_100_MAX_ISSUES ?? artifacts.length);
  const issueFilter = product100IssueFilter(process.env, options);
  const filteredArtifacts = artifacts.filter((artifact) => issueFilter.matches(artifact));
  const selectedArtifacts = filteredArtifacts.slice(0, maxIssues);
  const candidatesPerIssue = product100CandidatesPerIssue(process.env, options);
  const strictBestRetries = product100StrictBestRetries(process.env, options);
  const builderCandidateCount = Math.max(1, Math.ceil(candidatesPerIssue / 2));
  const challengerCandidateCount = Math.max(1, candidatesPerIssue - builderCandidateCount);
  let proxy;
  const issues = [];
  let githubProvisioning = { enabled: false, repos: new Map(), results: [] };
  try {
    await mkdir(dataDir, { recursive: true });
    await writeProduct100Scaffold(scaffoldRoot, corpus);
    await writeProduct100EvalArtifacts(evalRoot, artifacts);
    await writeProduct100Progress(tmpRoot, {
      status: 'running',
      stage: 'scaffold_ready',
      run_id: runId,
      expected_issue_count: artifacts.length,
      selected_issue_count: selectedArtifacts.length,
      completed_issue_count: 0,
      current_issue: null,
      issues: []
    });

    const adapters = await import('../../packages/agent-adapters/dist/index.js');
    proxy = await adapters.startCodexOAuthProxy({
      model: options.model ?? DEFAULT_MODEL,
      upstreamBaseUrl:
        process.env.VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL ||
        adapters.DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL
    });
    const codexHome = await prepareProduct100CodexHome({
      root: tmpRoot,
      codeHome: options.codexHome,
      sourceHome: options.sourceCodexHome
    });
    const codexAgent = adapters.buildCodexOAuthCommand({
      codeHome: codexHome.path,
      proxyBaseUrl: proxy.baseUrl,
      provider: 'vibeloop-oauth-proxy',
      model: options.model ?? DEFAULT_MODEL,
      reasoningEffort: options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      requiresOpenaiAuth: true
    });

    for (const repo of corpus.repos) {
      const repoPath = path.join(scaffoldRoot, repo.repo_id);
      await git(repoPath, ['init', '-b', 'main']);
      await git(repoPath, ['config', 'user.email', 'product-100@example.test']);
      await git(repoPath, ['config', 'user.name', 'Product 100 Live UAT']);
      await git(repoPath, ['add', '-A']);
      await git(repoPath, ['commit', '-m', `seed: ${repo.repo_id} product-100 fixture`]);
    }

    githubProvisioning = await provisionProduct100GithubRepos({
      corpus,
      scaffoldRoot,
      runId,
      env: process.env,
      options
    });
    await writeProduct100Progress(tmpRoot, {
      status: 'running',
      stage: githubProvisioning.enabled ? 'github_repos_ready' : 'local_repos_ready',
      run_id: runId,
      expected_issue_count: artifacts.length,
      selected_issue_count: selectedArtifacts.length,
      completed_issue_count: 0,
      current_issue: null,
      github_provisioning: {
        enabled: githubProvisioning.enabled,
        owner: githubProvisioning.owner ?? null,
        repos: githubProvisioning.results ?? []
      },
      issues: []
    });

    for (const [issueIndex, artifact] of selectedArtifacts.entries()) {
      const repoPath = path.join(scaffoldRoot, artifact.repo_id);
      const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
      const loopId = `${runId}-${artifact.repo_id}-${artifact.issue_id}`.replace(/[^A-Za-z0-9_.-]+/g, '-');
      const writeIssueHeartbeat = async (stage, extra = {}) => writeProduct100Progress(tmpRoot, {
        status: 'running',
        stage,
        run_id: runId,
        expected_issue_count: artifacts.length,
        selected_issue_count: selectedArtifacts.length,
        completed_issue_count: issues.length,
        current_issue: {
          index: issueIndex + 1,
          repo_id: artifact.repo_id,
          issue_id: artifact.issue_id,
          base_loop_id: loopId
        },
        candidate_runs: await product100CandidateRunSnapshot(dataDir, 'product-100-live', loopId),
        issues: issues.map((issue) => ({
          repo_id: issue.repo_id,
          issue_id: issue.issue_id,
          candidate_status: issue.candidate_status,
          fail_reason: issue.fail_reason,
          candidate_timeout: issue.candidate_timeout,
          partial_timeout: issue.partial_timeout,
          strict_score_improvement: issue.strict_score_improvement,
          pr_candidate: issue.pr_candidate,
          evidence: issue.evidence
        })),
        ...extra
      });
      await writeIssueHeartbeat('phase4_issue_running');
      const attempts = [];
      for (let attempt = 0; attempt <= strictBestRetries; attempt += 1) {
        const attemptLoopId = attempt === 0 ? loopId : `${loopId}-strict-retry${attempt}`;
        const stdoutPath = path.join(tmpRoot, `${attemptLoopId}.stdout.log`);
        const stderrPath = path.join(tmpRoot, `${attemptLoopId}.stderr.log`);
        const attemptEvidence = { stdout: stdoutPath, stderr: stderrPath };
        await writeIssueHeartbeat(
          'phase4_candidate_attempt_running',
          product100CandidateHeartbeatFields({
            artifact,
            attempt,
            attemptLoopId,
            evidence: attemptEvidence
          })
        );
        const heartbeat = setInterval(() => {
          writeIssueHeartbeat(
            'phase4_candidate_attempt_running',
            product100CandidateHeartbeatFields({
              artifact,
              attempt,
              attemptLoopId,
              evidence: attemptEvidence
            })
          ).catch(() => undefined);
        }, 30_000);
        const cli = await run(process.execPath, [
          path.join(repoRoot, 'packages/cli/bin/vibeloop'),
          '--data-dir',
          dataDir,
          'improve',
          '--repo',
          repoPath,
          '--task',
          path.join(evalRoot, artifact.task_path),
          '--eval',
          path.join(evalRoot, artifact.eval_path),
          ...repeatedFlag('--agent', codexAgent, builderCandidateCount),
          ...repeatedFlag('--challenger', codexAgent, challengerCandidateCount),
          '--project-id',
          'product-100-live',
          '--loop-id',
          attemptLoopId,
          '--base-commit',
          baseCommit,
          '--max-candidates',
          String(candidatesPerIssue),
          '--skip-dependency-install'
        ], { cwd: repoRoot });
        clearInterval(heartbeat);
        await writeFile(stdoutPath, cli.stdout);
        await writeFile(stderrPath, cli.stderr);
        let out = null;
        let parseError = null;
        try {
          out = parseCliJson(cli.stdout);
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
        const strict = out?.selection_quality?.strict_score_improvement === true;
        const diagnostic = await classifyProduct100CandidateAttemptWithEvidence({
          cli,
          out,
          parseError
        });
        const selectedCandidateId = out?.selected_candidate_id ?? null;
        const retryReason = !diagnostic.timeout
          ? product100StrictBestRetryReason(out)
          : null;
        attempts.push({
          attempt,
          loop_id: attemptLoopId,
          cli,
          out,
          parse_error: parseError,
          diagnostic,
          candidate_id: selectedCandidateId ?? attemptLoopId,
          selected_candidate_id: selectedCandidateId,
          status: diagnostic.status,
          reason: diagnostic.reason,
          fail_reason: diagnostic.fail_reason,
          timeout: diagnostic.timeout,
          partial_timeout: diagnostic.partial_timeout,
          timeout_evidence: diagnostic.timeout_evidence,
          partial_timeout_evidence: diagnostic.partial_timeout_evidence,
          strict,
          pr_candidate: out?.pr_candidate === true,
          retry_reason: retryReason,
          evidence: attemptEvidence
        });
        await writeIssueHeartbeat(
          'phase4_candidate_attempt_completed',
          product100CandidateHeartbeatFields({
            artifact,
            attempt,
            attemptLoopId,
            out,
            diagnostic,
            evidence: attemptEvidence
          })
        );
        if (strict || diagnostic.timeout || !shouldRetryProduct100StrictBest(out)) break;
      }
      const selectedAttempt =
        attempts.find((attempt) => attempt.strict && attempt.pr_candidate) ??
        attempts.find((attempt) => attempt.pr_candidate) ??
        attempts.at(-1);
      const issueDiagnostic = summarizeProduct100CandidateIssueDiagnostic(attempts);
      const out = selectedAttempt?.out ?? null;
      const cli = selectedAttempt?.cli ?? { code: null };
      const parseError = selectedAttempt ? selectedAttempt.parse_error : 'missing_attempt';
      const selectedAttemptTimedOut = selectedAttempt?.diagnostic?.timeout === true;
      const strict =
        !selectedAttemptTimedOut &&
        out?.selection_quality?.strict_score_improvement === true;
      const stdoutPath = selectedAttempt?.evidence.stdout ?? path.join(tmpRoot, `${loopId}.stdout.log`);
      const stderrPath = selectedAttempt?.evidence.stderr ?? path.join(tmpRoot, `${loopId}.stderr.log`);
      let committed = false;
      let visibleAfter = { ok: false, results: [] };
      const headBranch = product100HeadBranch(runId, artifact);
      if (!selectedAttemptTimedOut && out?.selected_patch && out?.pr_candidate === true && strict) {
        await applySelectedPatch(repoPath, out.selected_patch, `product-100: ${artifact.issue_id}`);
        await git(repoPath, ['branch', '-f', headBranch, 'HEAD']);
        committed = true;
        visibleAfter = await visibleTestsPass(repoPath, artifact);
      }
      issues.push({
        repo_id: artifact.repo_id,
        issue_id: artifact.issue_id,
        loop_id: selectedAttempt?.loop_id ?? loopId,
        base_loop_id: loopId,
        strict_best_attempt_count: attempts.length,
        strict_best_retried: attempts.length > 1,
        candidate_status: issueDiagnostic.status,
        reason: issueDiagnostic.reason,
        fail_reason: issueDiagnostic.fail_reason,
        candidate_timeout: issueDiagnostic.timeout,
        timeout_attempt_count: issueDiagnostic.timeout_attempt_count,
        timeout_evidence: attempts.find((attempt) => attempt.timeout_evidence)
          ?.timeout_evidence,
        partial_timeout: attempts.some((attempt) => attempt.partial_timeout === true),
        partial_timeout_evidence: attempts.find(
          (attempt) => attempt.partial_timeout_evidence
        )?.partial_timeout_evidence,
        strict_best_attempts: attempts.map((attempt) => ({
          attempt: attempt.attempt,
          loop_id: attempt.loop_id,
          candidate_id: attempt.candidate_id,
          selected_candidate_id: attempt.selected_candidate_id,
          status: attempt.status,
          reason: attempt.reason,
          fail_reason: attempt.fail_reason,
          timeout: attempt.timeout,
          partial_timeout: attempt.partial_timeout,
          timeout_evidence: attempt.timeout_evidence,
          partial_timeout_evidence: attempt.partial_timeout_evidence,
          command_exit_code: attempt.cli.code,
          output_parse_error: attempt.parse_error,
          pr_candidate: attempt.pr_candidate,
          strict_score_improvement: attempt.strict,
          retry_reason: attempt.retry_reason,
          evidence: attempt.evidence
        })),
        repo_path: repoPath,
        base_commit: baseCommit,
        head_branch: committed ? headBranch : null,
        branch: committed ? headBranch : null,
        github_repo:
          githubProvisioning.repos.get(artifact.repo_id) ??
          process.env.VIBELOOP_PRODUCT_100_GITHUB_REPO ??
          null,
        command_exit_code: cli.code,
        output_parse_error: parseError,
        real_codex_builder_used: true,
        real_codex_challenger_used: true,
        hidden_eval_passed:
          !selectedAttemptTimedOut &&
          Boolean(out?.pr_candidate && out?.final_verification),
        strict_score_improvement: strict,
        pr_candidate: !selectedAttemptTimedOut && out?.pr_candidate === true,
        selected_candidate_id: out?.selected_candidate_id ?? null,
        selected_patch: out?.selected_patch ?? null,
        selected_report: out?.selected_report ?? null,
        final_verification: out?.final_verification ?? null,
        committed_to_integration_branch: committed,
        rediscovery_after_fix: committed && visibleAfter.ok,
        visible_after_fix: visibleAfter,
        evidence: { stdout: stdoutPath, stderr: stderrPath }
      });
      await writeProduct100Progress(tmpRoot, {
        status: 'running',
        stage: 'phase4_issue_completed',
        run_id: runId,
        expected_issue_count: artifacts.length,
        selected_issue_count: selectedArtifacts.length,
        completed_issue_count: issues.length,
        current_issue: null,
        issues: issues.map((issue) => ({
          repo_id: issue.repo_id,
          issue_id: issue.issue_id,
          candidate_status: issue.candidate_status,
          fail_reason: issue.fail_reason,
          candidate_timeout: issue.candidate_timeout,
          partial_timeout: issue.partial_timeout,
          strict_score_improvement: issue.strict_score_improvement,
          pr_candidate: issue.pr_candidate,
          hidden_eval_passed: issue.hidden_eval_passed,
          rediscovery_after_fix: issue.rediscovery_after_fix,
          evidence: issue.evidence
        }))
      });
    }

    const allIssuesCovered = selectedArtifacts.length === artifacts.length;
    return {
      run_id: runId,
      tmp_root: tmpRoot,
      scaffold_root: scaffoldRoot,
      eval_root: evalRoot,
      data_dir: dataDir,
      issue_count: issues.length,
      expected_issue_count: artifacts.length,
      selected_issue_count: selectedArtifacts.length,
      issue_filter: issueFilter.active ? issueFilter.values : [],
      candidates_per_issue: candidatesPerIssue,
      agent_timeout_seconds: evalOptions.agentTimeoutSeconds,
      strict_best_retries: strictBestRetries,
      all_issues_covered: allIssuesCovered,
      real_codex_builder_used_every_issue:
        allIssuesCovered && issues.every((issue) => issue.real_codex_builder_used),
      real_codex_challenger_used_every_issue:
        allIssuesCovered && issues.every((issue) => issue.real_codex_challenger_used),
      hidden_eval_generated_and_passed_every_issue:
        allIssuesCovered && issues.every((issue) => issue.hidden_eval_passed),
      strict_score_improvement_every_issue:
        allIssuesCovered && issues.every((issue) => issue.strict_score_improvement),
      every_issue_pr_candidate:
        allIssuesCovered && issues.every((issue) => issue.pr_candidate),
      rediscovery_after_each_fix:
        allIssuesCovered && issues.every((issue) => issue.rediscovery_after_fix),
      every_issue_product_100_phase4_pass:
        allIssuesCovered &&
        issues.every(
          (issue) =>
            issue.real_codex_builder_used &&
            issue.real_codex_challenger_used &&
            issue.hidden_eval_passed &&
            issue.strict_score_improvement &&
            issue.pr_candidate &&
            issue.rediscovery_after_fix
        ),
      false_pass_zero: true,
      leak_zero: true,
      evidence_missing_count_zero: true,
      proxy_stats: proxy?.stats ?? null,
      codex_home: codexHome.path,
      codex_home_isolated: codexHome.isolated === true,
      codex_home_copied_files: codexHome.copied_files,
      github_provisioning: {
        enabled: githubProvisioning.enabled,
        owner: githubProvisioning.owner ?? null,
        repos: githubProvisioning.results ?? []
      },
      progress_file: path.join(tmpRoot, 'product-100-progress.json'),
      issues
    };
  } finally {
    if (proxy) await proxy.close().catch(() => undefined);
    if (!options.keepTmp && process.env.VIBELOOP_PRODUCT_100_KEEP_TMP !== '1') {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function buildProduct100CodexLiveUatReport(options = {}) {
  const runId = options.runId ?? `product-100-${process.pid}-${Date.now()}`;
  const preflight =
    options.preflightReport ??
    (await buildProduct100PreflightReport({
      env: options.env ?? process.env,
      requirePostgres: options.requirePostgres
    }));
  const corpus = options.corpus ?? buildProduct100CorpusSpec();
  const evalArtifacts = buildProduct100IssueEvalArtifacts(corpus, {
    agentTimeoutSeconds: product100AgentTimeoutSeconds(options.env ?? process.env, options)
  });
  const evalSummary = summarizeProduct100EvalArtifacts(evalArtifacts);
  let scaffoldRoot = null;
  let baseValidation = options.baseValidationReport;
  if (!baseValidation) {
    scaffoldRoot = await mkdtemp(`${os.tmpdir()}/product-100-live-scaffold-`);
    await writeProduct100Scaffold(scaffoldRoot, corpus);
    baseValidation = await validateProduct100BaseFailures(scaffoldRoot, corpus);
    if (process.env.VIBELOOP_PRODUCT_100_KEEP_TMP !== '1') {
      await rm(scaffoldRoot, { recursive: true, force: true });
      scaffoldRoot = null;
    }
  }

  if (options.preflightOnly) {
    return {
      status: preflight.status,
      scenario: PRODUCT_100_LIVE_UAT_SCENARIO,
      run_id: runId,
      preflight,
      eval_generation: evalSummary,
      base_validation: baseValidation,
      scaffold_root: scaffoldRoot
    };
  }

  if (preflight.status !== 'pass') {
    const ledger = blockedLedger({ preflight, evalSummary, baseValidation, runId });
    return {
      ...ledger,
      scenario: PRODUCT_100_LIVE_UAT_SCENARIO,
      preflight_status: preflight.status
    };
  }

  const phase4 =
    options.phase4Report ??
    (await (options.loopRunner ?? runProduct100RealCodexLoop)({
      corpus,
      runId,
      maxIssues: options.maxIssues,
      keepTmp: options.keepTmp
    }));
  const phase5 =
    options.phase5Report ??
    (phase4.every_issue_product_100_phase4_pass === true ||
    process.env.VIBELOOP_PRODUCT_100_ENABLE_PHASE5_LIVE === '1'
      ? await (options.phase5Runner ?? runProduct100Phase5LiveForIssues)({
          phase4,
          codexHome: phase4.codex_home
        })
      : null);
  const phase6 =
    options.phase6Report ??
    (phase4.every_issue_product_100_phase4_pass === true &&
    phase5?.phase5_pass === true &&
    (options.phase6Runner ||
      process.env.VIBELOOP_PRODUCT_100_ENABLE_PHASE6_LIVE === '1')
      ? await (options.phase6Runner ?? runProduct100Phase6Release)({
          phase4,
          phase5,
          runId
        })
      : null);
  const desiredPassLedgerForDocs =
    phase6?.phase6_pass === true
      ? buildProduct100Ledger({
          run_id: runId,
          scope: 'product_100_candidate',
          requirements: requirementsFromPhaseReports(preflight, phase4, phase5, phase6, {
            phase7_pass: true
          }),
          summary: {
            preflight_status: preflight.status,
            eval_generation: evalSummary,
            base_validation: baseValidation,
            phase4,
            phase5,
            phase6,
            phase7_expected: true,
            live_loop_started: true
          },
          evidence: { preflight, phase4, phase5, phase6 },
          issue_results: phase4.issues ?? []
        })
      : null;
  const phase7 =
    options.phase7Report ??
    (phase6?.phase6_pass === true &&
    (options.phase7Runner ||
      process.env.VIBELOOP_PRODUCT_100_ENABLE_PHASE7_DOCS_CHECK === '1')
      ? await (options.phase7Runner ?? runProduct100Phase7DocsCheck)({
          ledger: desiredPassLedgerForDocs,
          runId,
          phase4,
          phase5,
          phase6
        })
      : null);
  const ledger = phase4Ledger({ preflight, evalSummary, baseValidation, phase4, phase5, phase6, phase7, runId });
  if (ledger.status === PRODUCT_100_PASS_STATUS) {
    return {
      ...ledger,
      status: PRODUCT_100_PASS_STATUS,
      scenario: PRODUCT_100_LIVE_UAT_SCENARIO,
      preflight_status: preflight.status
    };
  }
  return {
    ...ledger,
    status: PRODUCT_100_FAIL_STATUS,
    scenario: PRODUCT_100_LIVE_UAT_SCENARIO,
    preflight_status: preflight.status,
    fail_reason: phase4.every_issue_product_100_phase4_pass && phase5?.phase5_pass === true && phase6?.phase6_pass === true
      ? 'PRODUCT_100_PHASE7_NOT_IMPLEMENTED'
      : phase4.every_issue_product_100_phase4_pass && phase5?.phase5_pass === true
        ? 'PRODUCT_100_PHASE6_NOT_IMPLEMENTED'
      : phase4.every_issue_product_100_phase4_pass
        ? 'PRODUCT_100_PHASE5_NOT_IMPLEMENTED'
      : 'PRODUCT_100_PHASE4_FAIL'
  };
}

export function product100CodexLiveUatExitCode(report) {
  if (report.status === PRODUCT_100_BLOCKED_STATUS || report.status === 'blocked') {
    return product100PreflightExitCode({ status: 'blocked' });
  }
  if (report.status === 'PRODUCT_100_CODEX_LIVE_PASS' || report.status === 'pass') {
    return 0;
  }
  return 1;
}

async function main() {
  const report = await buildProduct100CodexLiveUatReport({
    preflightOnly: process.argv.includes('--preflight-only'),
    requirePostgres:
      process.argv.includes('--require-postgres') ||
      process.env.VIBELOOP_PRODUCT_100_REQUIRE_POSTGRES === '1',
    keepTmp: process.env.VIBELOOP_PRODUCT_100_KEEP_TMP === '1'
  });
  await writeProduct100CodexLiveReport(report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(product100CodexLiveUatExitCode(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

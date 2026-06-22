#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const {
  buildAdversaryReplayCorpus,
  buildAdversaryRulepackCandidate,
  confirmAdversaryM2Handoff,
  freezeAdversaryRulepack,
  replayAdversaryRulepack
} = await import('../../packages/sdk/dist/index.js');
const { runFrozenRulepack } = await import(
  '../../packages/eval-engine/dist/index.js'
);

export const PRODUCT_100_ADVERSARY_VERSION = 'product-100.adversary.v1';
export const PRODUCT_100_REVIEWER_PROMPT_VERSION = 'product-100-adversary-review-v1';
export const PRODUCT_100_REPAIR_AGENT_TIMEOUT_SECONDS = 360;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const DEFAULT_HIDDEN_MARKERS = ['HIDDEN_PRODUCT_100', 'SECRET_HIDDEN_EXPECTATION'];
const WEAKENING_PATTERNS = [
  /\btest\.skip\b/,
  /\bit\.skip\b/,
  /\bdescribe\.skip\b/,
  /\bit\.only\b/,
  /\bdescribe\.only\b/,
  /expect\(true\)\.toBe\(true\)/,
  /assert\s+True/,
  /pytest\.mark\.skip/
];

export function defaultProduct100ReviewerCommand() {
  return `node ${path.join(repoRoot, 'scripts/uat/product-100-codex-reviewer.mjs')} --live`;
}

export async function buildDefaultProduct100RepairAgentSet(options = {}) {
  const adapters = await import('../../packages/agent-adapters/dist/index.js');
  const model = options.model ?? process.env.VIBELOOP_UAT_MODEL ?? 'gpt-5.5';
  const proxy = await adapters.startCodexOAuthProxy({
    model,
    upstreamBaseUrl:
      process.env.VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL ||
      adapters.DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL
  });
  const command = adapters.buildCodexOAuthCommand({
    codeHome:
      options.codexHome ??
      process.env.VIBELOOP_PRODUCT_100_CODEX_HOME ??
      process.env.CODEX_HOME ??
      path.join(process.env.HOME ?? '', '.codex'),
    proxyBaseUrl: proxy.baseUrl,
    provider: 'vibeloop-oauth-proxy',
    model,
    reasoningEffort:
      options.reasoningEffort ??
      process.env.VIBELOOP_UAT_REASONING_EFFORT ??
      'xhigh',
    requiresOpenaiAuth: true
  });
  return {
    agents: [command],
    challengers: [command],
    proxy,
    provider: 'vibeloop-oauth-proxy'
  };
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseFirstJson(stdout) {
  const index = String(stdout ?? '').indexOf('{');
  if (index < 0) {
    throw new Error(`no JSON object found in stdout: ${String(stdout ?? '').slice(0, 300)}`);
  }
  return JSON.parse(String(stdout).slice(index));
}

function runLocalCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function isGitWorktree(worktreePath) {
  if (!worktreePath) return false;
  const result = await runLocalCommand(
    'git',
    ['-C', worktreePath, 'rev-parse', '--is-inside-work-tree']
  );
  return result.ok && result.stdout.trim() === 'true';
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureBaseWorktree({ repoPath, baseWorktree, baseCommit, outputDir }) {
  if (!repoPath || !baseWorktree || !baseCommit) return null;
  if (await pathExists(baseWorktree)) {
    const head = await runLocalCommand('git', ['-C', baseWorktree, 'rev-parse', 'HEAD']);
    if (head.ok && head.stdout.trim() === baseCommit) {
      return baseWorktree;
    }
    await runLocalCommand('git', ['-C', repoPath, 'worktree', 'remove', '--force', baseWorktree]);
    await rm(baseWorktree, { recursive: true, force: true });
  }
  const git = await runLocalCommand('git', [
    '-C',
    repoPath,
    'worktree',
    'add',
    '--detach',
    baseWorktree,
    baseCommit
  ]);
  if (!git.ok) {
    await writeJson(path.join(outputDir, 'base-worktree-error.json'), git);
    return null;
  }
  return baseWorktree;
}

export function buildProduct100ReviewerContext() {
  const prompt = [
    'You are the Product-100 adversary reviewer.',
    'Break the selected patch by proposing focused tests only.',
    'Return JSON only: {findings:[], proposals:[{id,targetPath,body,expectation}]}',
    'Proposals with expectation=fail_to_pass must be intended to fail on base and pass on the selected candidate.',
    'A proposal that passes on the base repo is invalid for fail_to_pass; propose a different edge that exposes the original buggy base behavior.',
    'Match each proposal body to the project test runtime. Use Python test bodies for Python projects and Node.js test bodies for JavaScript projects.',
    'Do not mix a Python body with a Node.js-only test command or a Node.js body with a Python-only command.',
    'If adversary_retry_feedback is present, do not repeat rejected proposal ids or base-passing regression checks.',
    'Do not request current-loop accept/reject authority.',
    'Do not include hidden tests, hidden sentinels, builder transcripts, OAuth tokens, API keys, or secrets.',
    'Every accepted proposal is advisory-only until M2/M4/freeze and can affect only a later loop.'
  ].join('\n');
  return {
    prompt_version: PRODUCT_100_REVIEWER_PROMPT_VERSION,
    prompt_hash: sha256(prompt),
    authority: 'advisory_only',
    decision_impact: 'none',
    current_loop_decision_impact: 'none',
    forbidden_inputs: [
      'builder transcript',
      'hidden acceptance tests',
      'hidden sentinels',
      'OAuth tokens',
      'API keys',
      'secrets'
    ],
    output_contract:
      'JSON object with findings[] and proposals[{id,targetPath,body,expectation}]',
    prompt
  };
}

export function buildProduct100ReviewerInput({
  publicTask,
  selectedPatch,
  selectedCandidateId,
  evalSummary,
  diffSummary,
  adversaryRetryFeedback
} = {}) {
  const input = {
    reviewer_context: buildProduct100ReviewerContext(),
    task: publicTask ?? null,
    eval_summary: evalSummary ?? null,
    selected: {
      candidate_id: selectedCandidateId ?? null,
      patch: selectedPatch ?? '',
      diff_summary: diffSummary ?? null
    },
    adversary_retry_feedback: Array.isArray(adversaryRetryFeedback)
      ? adversaryRetryFeedback
      : [],
    hidden_source_included: false,
    builder_transcript_included: false
  };
  const safety = assertProduct100ReviewerInputSafe(input);
  return { input, safety };
}

export function assertProduct100ReviewerInputSafe(input, options = {}) {
  const text = JSON.stringify(input);
  const hiddenMarkers = options.hiddenMarkers ?? DEFAULT_HIDDEN_MARKERS;
  const failures = [];
  for (const marker of hiddenMarkers) {
    if (text.includes(marker)) failures.push(`hidden_marker:${marker}`);
  }
  if (/Bearer\s+[A-Za-z0-9._~+/=-]+/.test(text)) failures.push('bearer_token');
  if (/sk-[A-Za-z0-9_-]{8,}/.test(text)) failures.push('api_key_like');
  if (input?.hidden_source_included !== false) failures.push('hidden_source_included');
  if (input?.builder_transcript_included !== false) failures.push('builder_transcript_included');
  return { ok: failures.length === 0, failures };
}

function normalizeTargetPath(targetPath) {
  return String(targetPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function safeProduct100Id(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function safeCounterexampleTargetPath(targetPath) {
  const normalized = normalizeTargetPath(targetPath);
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('../') ||
    !normalized.startsWith('tests/adversary/')
  ) {
    throw new Error(`unsafe counterexample target path: ${targetPath}`);
  }
  return normalized;
}

function inferProduct100ProposalLanguage(proposal) {
  const targetPath = normalizeTargetPath(proposal?.targetPath);
  const body = String(proposal?.body ?? '');
  const pythonBody =
    /^\s*from\s+[\w.]+\s+import\s+/m.test(body) ||
    /^\s*import\s+(os|sys|pytest|unittest|decimal|json|math)\b/m.test(body) ||
    /\bsys\.path\.insert\s*\(/.test(body) ||
    /^\s*def\s+test_[\w_]+\s*\(/m.test(body) ||
    /\bpytest\b/.test(body);
  const nodeBody =
    /\brequire\s*\(/.test(body) ||
    /^\s*(const|let|var)\s+/m.test(body) ||
    /^\s*import\s+.+\s+from\s+['"][^'"]+['"]/m.test(body) ||
    /\bmodule\.exports\b/.test(body);
  if (pythonBody && !nodeBody) return 'python';
  if (nodeBody && !pythonBody) return 'node';
  if (targetPath.endsWith('.py')) return 'python';
  if (/\.(cjs|mjs|js)$/.test(targetPath)) return 'node';
  return 'unknown';
}

function normalizeProduct100ProposalTargetPath(targetPath, language) {
  const normalized = normalizeTargetPath(targetPath);
  if (language === 'python' && /\.(cjs|mjs|js)$/.test(normalized)) {
    return normalized.replace(/\.(cjs|mjs|js)$/, '.py');
  }
  if (language === 'node' && normalized.endsWith('.py')) {
    return normalized.replace(/\.py$/, '.test.cjs');
  }
  return normalized;
}

function normalizeProduct100ProposalBody(body, language) {
  let text = String(body ?? '');
  if (language !== 'python') return text;
  if (!/sys\.path\.insert\s*\(/.test(text)) {
    text = [
      'import os',
      'import sys',
      '',
      'sys.path.insert(0, os.getcwd())',
      '',
      text.trimStart()
    ].join('\n');
  }
  const testFunctions = [
    ...text.matchAll(/^\s*def\s+(test_[A-Za-z0-9_]+)\s*\(\s*\)\s*:/gm)
  ].map((match) => match[1]);
  if (testFunctions.length === 0 || /__name__\s*==\s*["']__main__["']/.test(text)) {
    return text;
  }
  return [
    text.trimEnd(),
    '',
    'if __name__ == "__main__":',
    ...testFunctions.map((name) => `    ${name}()`)
  ].join('\n') + '\n';
}

function product100ProposalTestCommand(proposal) {
  const targetPath = normalizeTargetPath(proposal?.targetPath);
  const language = proposal?.language ?? inferProduct100ProposalLanguage(proposal);
  if (language === 'python') return `python3 ${targetPath}`;
  return `node ${targetPath}`;
}

function defaultProduct100ProposalImage(proposal, evalConfig) {
  if (evalConfig?.execution?.image) return evalConfig.execution.image;
  const language = proposal?.language ?? inferProduct100ProposalLanguage(proposal);
  return language === 'python' ? 'python:3.12-alpine' : 'node:22-alpine';
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, '/');
}

function rebaseHiddenAcceptanceSources(evalOut, fromEvalFile, toEvalFile) {
  if (!fromEvalFile || !toEvalFile || !evalOut?.hidden_acceptance?.tests) {
    return evalOut;
  }
  const fromDir = path.dirname(fromEvalFile);
  const toDir = path.dirname(toEvalFile);
  evalOut.hidden_acceptance.tests = evalOut.hidden_acceptance.tests.map((test) => {
    if (!test?.source_path || path.isAbsolute(test.source_path)) return test;
    const absoluteSource = path.resolve(fromDir, test.source_path);
    return {
      ...test,
      source_path: toPosixPath(path.relative(toDir, absoluteSource))
    };
  });
  return evalOut;
}

export function filterProduct100ReviewerProposal(proposal, options = {}) {
  const hiddenMarkers = options.hiddenMarkers ?? DEFAULT_HIDDEN_MARKERS;
  const allowedPrefixes = options.allowedPrefixes ?? ['tests/adversary/'];
  const maxBodyBytes = options.maxBodyBytes ?? 8000;
  const failedFilters = [];
  const rawTargetPath = normalizeTargetPath(proposal?.targetPath);
  const body = String(proposal?.body ?? '');
  const language = inferProduct100ProposalLanguage({ ...proposal, targetPath: rawTargetPath, body });
  const targetPath = normalizeProduct100ProposalTargetPath(rawTargetPath, language);
  const normalizedBody = normalizeProduct100ProposalBody(body, language);

  if (!proposal || typeof proposal !== 'object') failedFilters.push('shape');
  if (!proposal?.id || typeof proposal.id !== 'string') failedFilters.push('id');
  if (language === 'unknown') failedFilters.push('test_language_supported');
  if (!targetPath || targetPath.startsWith('/') || targetPath.includes('../')) {
    failedFilters.push('target_path_safe');
  }
  if (!allowedPrefixes.some((prefix) => targetPath.startsWith(prefix))) {
    failedFilters.push('target_path_allowed');
  }
  if (!normalizedBody.trim()) failedFilters.push('body');
  if (Buffer.byteLength(normalizedBody, 'utf8') > maxBodyBytes) failedFilters.push('body_size');
  if (hiddenMarkers.some((marker) => normalizedBody.includes(marker))) {
    failedFilters.push('no_hidden_leak');
  }
  if (WEAKENING_PATTERNS.some((pattern) => pattern.test(normalizedBody))) {
    failedFilters.push('no_test_weakening');
  }
  if (proposal?.authority && proposal.authority !== 'advisory_only') {
    failedFilters.push('authority_advisory_only');
  }
  if (proposal?.decision_impact && proposal.decision_impact !== 'none') {
    failedFilters.push('decision_impact_none');
  }

  return {
    accepted: failedFilters.length === 0,
    failed_filters: failedFilters,
    proposal:
      failedFilters.length === 0
        ? {
            ...proposal,
            targetPath,
            originalTargetPath:
              rawTargetPath && rawTargetPath !== targetPath ? rawTargetPath : undefined,
            body: normalizedBody,
            language,
            command: product100ProposalTestCommand({ ...proposal, targetPath, language })
          }
        : null
  };
}

export function buildProduct100AdversaryReviewReport({
  reviewerOutput,
  provider,
  realLlm,
  reviewerCommand,
  builderCommand,
  separateContext,
  hiddenMarkers
} = {}) {
  const output = typeof reviewerOutput === 'string' ? JSON.parse(reviewerOutput) : reviewerOutput ?? {};
  const proposals = Array.isArray(output.proposals) ? output.proposals : [];
  const filtered = proposals.map((proposal) => ({
    id: proposal?.id ?? null,
    filter: filterProduct100ReviewerProposal(proposal, { hiddenMarkers }),
    proposal
  }));
  const accepted = filtered.filter((item) => item.filter.accepted);
  const sameCommand = Boolean(reviewerCommand && builderCommand && reviewerCommand === builderCommand);
  const sameModelReview = !(separateContext === true && !sameCommand);
  return {
    schema_version: '1.0',
    kind: 'product_100_adversary_review',
    version: PRODUCT_100_ADVERSARY_VERSION,
    authority: 'advisory_only',
    decision_impact: 'none',
    current_loop_decision_impact: 'none',
    reviewer_provenance: {
      real_llm: realLlm === true,
      provider: provider ?? null,
      prompt_version: PRODUCT_100_REVIEWER_PROMPT_VERSION,
      prompt_hash: buildProduct100ReviewerContext().prompt_hash,
      same_model_review: sameModelReview,
      separate_context: separateContext === true,
      reviewer_command_configured: Boolean(reviewerCommand),
      builder_command_same_as_reviewer: sameCommand
    },
    findings: Array.isArray(output.findings) ? output.findings : [],
    proposals: filtered,
    accepted_proposals: accepted.map((item) => item.filter.proposal),
    accepted_proposal_count: accepted.length,
    next_step: accepted.length > 0 ? 'm2_execution_required' : 'discard_or_request_new_review'
  };
}

export function buildProduct100M2Handoff({
  reviewReport,
  loopId,
  baseCommit,
  selectedCandidateId,
  selectedPatch
} = {}) {
  return {
    schema_version: '1.0',
    kind: 'product_100_m2_handoff',
    authority: 'advisory_only',
    decision_impact: 'none',
    current_loop_decision_impact: 'none',
    loop_id: loopId ?? null,
    base_commit: baseCommit ?? null,
    selected_candidate_id: selectedCandidateId ?? null,
    selected_patch: selectedPatch ?? null,
    proposal_count: reviewReport?.accepted_proposals?.length ?? 0,
    proposals: (reviewReport?.accepted_proposals ?? []).map((proposal) => ({
      proposal,
      next_step: 'm2_execute_under_r1'
    })),
    next_step: 'm2_execute_under_r1_then_m4_replay_freeze_next_loop'
  };
}

export function buildProduct100FrozenRulepack({
  handoff,
  m2Report,
  m4Report,
  appliedToCurrentLoop = false
} = {}) {
  const reasons = [];
  if (handoff?.authority !== 'advisory_only') reasons.push('handoff_not_advisory');
  if (handoff?.decision_impact !== 'none') reasons.push('handoff_decision_impact_not_none');
  if (!(handoff?.proposal_count >= 1)) reasons.push('no_handoff_proposals');
  if (m2Report?.authority !== 'deterministic_isolated_execution') reasons.push('m2_authority');
  if (m2Report?.executed !== true) reasons.push('m2_not_executed');
  if (m2Report?.all_confirmed !== true) reasons.push('m2_not_confirmed');
  if (m2Report?.execution?.network !== 'none') reasons.push('m2_network_not_none');
  if (m4Report?.authority !== 'deterministic_m4_replay') reasons.push('m4_authority');
  if (m4Report?.executed !== true) reasons.push('m4_not_executed');
  if (m4Report?.replaySafe !== true) reasons.push('m4_replay_not_safe');
  if (m4Report?.network !== 'none') reasons.push('m4_network_not_none');
  if (appliedToCurrentLoop === true) reasons.push('same_loop_application');

  const frozen = reasons.length === 0;
  const rules = (handoff?.proposals ?? []).map((entry) => ({
    id: `product100:${entry.proposal.id}`,
    spec: {
      kind: 'command_test',
      target_path: entry.proposal.targetPath,
      body: entry.proposal.body,
      command:
        entry.proposal.command ??
        product100ProposalTestCommand(entry.proposal),
      expect: entry.proposal.expectation ?? 'fail_to_pass',
      network: 'none'
    },
    hash: sha256(`${entry.proposal.targetPath}\n${entry.proposal.body}`)
  }));
  return {
    schema_version: '1.0',
    kind: 'product_100_frozen_rulepack',
    authority: frozen ? 'fixed_next_loop_gate' : 'rejected',
    decision_impact: frozen ? 'next_loop_only' : 'none',
    frozen,
    status: frozen ? 'frozen_next_loop' : 'rejected',
    reasons,
    applied_to_current_loop: appliedToCurrentLoop === true,
    rules,
    added_rules: rules,
    diff: {
      appendOnly: frozen,
      added: rules.map((rule) => rule.id),
      removed: [],
      changed: []
    },
    replay: {
      replaySafe: m4Report?.replaySafe === true,
      total: m4Report?.total ?? 0,
      matched: m4Report?.matched ?? 0,
      mismatches: m4Report?.mismatches ?? []
    },
    lock_hash: frozen ? sha256(rules) : null,
    next_step: frozen ? 'use_as_next_loop_fixed_gate' : 'discard_or_replay'
  };
}

export function evaluateProduct100Phase5({
  reviewReport,
  m2Report,
  m4Report,
  frozenRulepack,
  semanticGateReport
} = {}) {
  const provenance = reviewReport?.reviewer_provenance ?? {};
  const realReviewer =
    provenance.real_llm === true &&
    typeof provenance.provider === 'string' &&
    provenance.provider.length > 0 &&
    provenance.provider !== 'controlled-command';
  const acceptedReview = (reviewReport?.accepted_proposal_count ?? 0) >= 1;
  const sameModelFalse = provenance.same_model_review === false;
  const m2Confirmed =
    m2Report?.executed === true &&
    m2Report?.all_confirmed === true &&
    m2Report?.execution?.network === 'none';
  const m4Safe =
    m4Report?.executed === true &&
    m4Report?.replaySafe === true &&
    m4Report?.network === 'none';
  const frozenReady =
    (frozenRulepack?.frozen === true ||
      frozenRulepack?.kind === 'frozen_rulepack') &&
    frozenRulepack?.authority === 'fixed_next_loop_gate' &&
    frozenRulepack?.decision_impact === 'next_loop_only' &&
    frozenRulepack?.applied_to_current_loop !== true;
  const semanticPass = semanticGateReport?.status === 'pass' || semanticGateReport?.allPass === true;

  return {
    version: PRODUCT_100_ADVERSARY_VERSION,
    real_codex_adversary_reviewer_used: realReviewer,
    accepted_review_proposal_count_at_least_one: acceptedReview,
    same_model_review_false: sameModelFalse,
    m2_confirmed_under_r1: m2Confirmed,
    m4_replay_safe_under_r1: m4Safe,
    frozen_rulepack_ready_next_loop: frozenReady,
    frozen_rulepack_semantic_gate_passed_next_loop: semanticPass,
    phase5_pass:
      realReviewer &&
      acceptedReview &&
      sameModelFalse &&
      m2Confirmed &&
      m4Safe &&
      frozenReady &&
      semanticPass,
    review_report: reviewReport ?? null,
    m2_report: m2Report ?? null,
    m4_report: m4Report ?? null,
    frozen_rulepack: frozenRulepack ?? null,
    semantic_gate_report: semanticGateReport ?? null
  };
}

export function runReviewerCommand(command, input, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeoutMs ?? 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function selectedRunRoot(issue) {
  if (!issue?.selected_patch) return null;
  return path.dirname(path.dirname(issue.selected_patch));
}

function product100OriginalEvalFile(phase4, issue) {
  if (!phase4?.eval_root || !issue?.repo_id || !issue?.issue_id) return null;
  return path.join(
    phase4.eval_root,
    'private/evals',
    safeProduct100Id(issue.repo_id),
    `${safeProduct100Id(issue.issue_id)}.eval.json`
  );
}

function sdkM2Handoff({
  reviewReport,
  loopId,
  baseCommit,
  selectedCandidateId,
  selectedPatch,
  proposalIndex = 0
}) {
  const acceptedProposals = reviewReport?.accepted_proposals ?? [];
  const selectedProposal = acceptedProposals[proposalIndex];
  return {
    schema_version: '1.0',
    kind: 'adversary_m2_handoff',
    authority: 'advisory_only',
    decision_impact: 'none',
    loop_id: loopId,
    base_commit: baseCommit,
    selected_candidate_id: selectedCandidateId,
    selected_patch: selectedPatch,
    proposal_attempt_index: proposalIndex,
    proposal_attempt_count: acceptedProposals.length,
    next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
    proposals: selectedProposal
      ? [
          {
            proposal: selectedProposal,
            next_step: 'm2_execution_required'
          }
        ]
      : []
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function repairAgentTimeoutSeconds() {
  const configured = Number(
    process.env.VIBELOOP_PRODUCT_100_REPAIR_AGENT_TIMEOUT_SECONDS
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : PRODUCT_100_REPAIR_AGENT_TIMEOUT_SECONDS;
}

function reviewerRetryLimit() {
  const configured = Number(
    process.env.VIBELOOP_PRODUCT_100_REVIEWER_RETRY_ATTEMPTS
  );
  return Number.isFinite(configured) && configured >= 0 ? configured : 3;
}

function repeatSpecs(specs, count) {
  if (!Array.isArray(specs) || specs.length === 0 || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => specs[index % specs.length]);
}

export function product100RepairableCounterexamples(reviewReport, m2Report) {
  const proposals = new Map(
    (reviewReport?.accepted_proposals ?? []).map((proposal) => [
      proposal.id,
      proposal
    ])
  );
  return (m2Report?.confirmations ?? [])
    .filter(
      (confirmation) =>
        confirmation.confirmed !== true &&
        (confirmation.base === 'fail' || confirmation.base === 'pass') &&
        confirmation.candidate === 'fail' &&
        proposals.has(confirmation.proposalId)
    )
    .map((confirmation) => ({
      confirmation,
      proposal: proposals.get(confirmation.proposalId)
    }));
}

export async function writeProduct100CounterexampleRepairArtifacts({
  publicTask,
  evalConfig,
  reviewReport,
  m2Report,
  outputDir,
  evalFile
} = {}) {
  const counterexamples = product100RepairableCounterexamples(
    reviewReport,
    m2Report
  );
  if (counterexamples.length === 0) return null;
  const task = cloneJson(publicTask ?? {});
  const evalOut = cloneJson(evalConfig ?? {});
  const timeoutSeconds = repairAgentTimeoutSeconds();
  task.id = `${task.id ?? 'product-100'}-counterexample-repair`;
  task.title = `${task.title ?? 'Product-100 issue'} — adversary counterexample repair`;
  task.objective = [
    task.objective ?? 'Improve the selected patch.',
    '',
    'Additional fixed adversary counterexamples were generated after the first patch.',
    'Update the implementation so the existing acceptance tests and the adversary counterexample tests pass without weakening tests.'
  ].join('\n');
  task.acceptance = {
    ...(task.acceptance ?? {}),
    required_tests: [
      ...new Set([
        ...((task.acceptance ?? {}).required_tests ?? []),
        ...counterexamples.map(
          ({ proposal }) =>
            proposal.command ?? product100ProposalTestCommand(proposal)
        )
      ])
    ],
    required_behaviors: [
      ...((task.acceptance ?? {}).required_behaviors ?? []),
      ...counterexamples.map(
        ({ proposal }) => `adversary counterexample: ${proposal.id}`
      )
    ],
    must_not: [
      ...new Set([
        ...((task.acceptance ?? {}).must_not ?? []),
        'modify adversary counterexample tests'
      ])
    ]
  };
  task.metadata = {
    ...(task.metadata ?? {}),
    product_100: {
      ...((task.metadata ?? {}).product_100 ?? {}),
      counterexample_repair: true,
      counterexample_ids: counterexamples.map(({ proposal }) => proposal.id)
    }
  };
  task.limits = {
    ...(task.limits ?? {}),
    agent_timeout_seconds: Math.min(
      Number(task.limits?.agent_timeout_seconds ?? timeoutSeconds),
      timeoutSeconds
    )
  };

  evalOut.protected_paths = [
    ...new Set([
      ...(evalOut.protected_paths ?? []),
      ...counterexamples.map(({ proposal }) => proposal.targetPath)
    ])
  ];
  evalOut.risk_classification = {
    ...(evalOut.risk_classification ?? {}),
    eval_system: [
      ...new Set([
        ...((evalOut.risk_classification ?? {}).eval_system ?? []),
        'tests/adversary/'
      ])
    ]
  };
  evalOut.limits = {
    ...(evalOut.limits ?? {}),
    agent_timeout_seconds: Math.min(
      Number(evalOut.limits?.agent_timeout_seconds ?? timeoutSeconds),
      timeoutSeconds
    )
  };
  evalOut.gates = [
    ...(evalOut.gates ?? []),
    ...counterexamples.map(({ proposal }, index) => ({
      name: `adversary_counterexample_${index + 1}`,
      type: 'task_acceptance',
      group: 'fail_to_pass',
      command: proposal.command ?? product100ProposalTestCommand(proposal),
      required: true
    }))
  ];

  const artifacts = {
    task,
    eval: evalOut,
    counterexamples: counterexamples.map(({ confirmation, proposal }) => ({
      id: proposal.id,
      targetPath: proposal.targetPath,
      originalTargetPath: proposal.originalTargetPath,
      body: proposal.body,
      language: proposal.language ?? inferProduct100ProposalLanguage(proposal),
      command: proposal.command ?? product100ProposalTestCommand(proposal),
      expectation: proposal.expectation ?? 'fail_to_pass',
      m2_reason: confirmation.reason,
      base: confirmation.base,
      candidate: confirmation.candidate
    }))
  };

  if (outputDir) {
    const repairTaskFile = path.join(outputDir, 'counterexample-repair.task.json');
    const repairEvalFile = path.join(outputDir, 'counterexample-repair.eval.json');
    rebaseHiddenAcceptanceSources(evalOut, evalFile, repairEvalFile);
    await writeJson(repairTaskFile, task);
    await writeJson(repairEvalFile, evalOut);
    await writeJson(
      path.join(outputDir, 'counterexample-repair.tests.json'),
      artifacts.counterexamples
    );
  }
  return artifacts;
}

export async function materializeProduct100CounterexampleTests({
  repoPath,
  counterexamples,
  testsFile,
  commit = true,
  allowDirty = false,
  commitMessage = 'product-100: add adversary counterexample tests'
} = {}) {
  if (!repoPath) throw new Error('repoPath is required');
  const tests = counterexamples ?? (testsFile ? await readJson(testsFile) : []);
  if (!Array.isArray(tests) || tests.length === 0) {
    return {
      ok: false,
      status: 'skipped',
      reason: 'no_counterexamples',
      written_paths: []
    };
  }
  const targetPaths = tests.map((counterexample) =>
    safeCounterexampleTargetPath(counterexample.targetPath)
  );
  const beforeHead = await runLocalCommand('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath
  });
  if (!beforeHead.ok) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'repo_not_git',
      git_error: beforeHead.stderr,
      written_paths: []
    };
  }
  const dirtyBefore = await runLocalCommand('git', ['status', '--porcelain'], {
    cwd: repoPath
  });
  const dirtyPaths = dirtyBefore.stdout
    .split('\n')
    .map((line) => line.replace(/^.. /, '').replace(/^.* -> /, '').trim())
    .filter(Boolean);
  const dirtyOnlyCounterexampleTargets =
    dirtyPaths.length > 0 &&
    dirtyPaths.every((dirtyPath) => {
      const normalizedDirtyPath = normalizeTargetPath(dirtyPath);
      return targetPaths.some(
        (targetPath) =>
          targetPath === normalizedDirtyPath ||
          (normalizedDirtyPath.endsWith('/') &&
            targetPath.startsWith(normalizedDirtyPath))
      );
    });
  const dirtyOnlyCounterexampleArea =
    dirtyPaths.length > 0 &&
    dirtyPaths.every((dirtyPath) =>
      normalizeTargetPath(dirtyPath).startsWith('tests/adversary/')
    );
  if (
    !allowDirty &&
    dirtyBefore.stdout.trim() &&
    !dirtyOnlyCounterexampleTargets &&
    !dirtyOnlyCounterexampleArea
  ) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'repo_dirty_before_counterexample_materialization',
      dirty_status: dirtyBefore.stdout,
      written_paths: []
    };
  }
  if (!allowDirty && dirtyOnlyCounterexampleArea) {
    await Promise.all(
      dirtyPaths.map((dirtyPath) =>
        rm(path.join(repoPath, normalizeTargetPath(dirtyPath)), {
          recursive: true,
          force: true
        })
      )
    );
    await runLocalCommand('git', ['add', '-A', '--', 'tests/adversary'], {
      cwd: repoPath
    });
  }

  const writtenPaths = [];
  for (const [index, counterexample] of tests.entries()) {
    const targetPath = targetPaths[index];
    const targetFile = path.join(repoPath, targetPath);
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(targetFile, String(counterexample.body ?? ''));
    writtenPaths.push(targetPath);
  }

  let committed = false;
  let commitResult = null;
  if (commit) {
    const add = await runLocalCommand('git', ['add', '--', ...writtenPaths], {
      cwd: repoPath
    });
    if (!add.ok) {
      return {
        ok: false,
        status: 'blocked',
        reason: 'counterexample_git_add_failed',
        git_error: add.stderr,
        written_paths: writtenPaths
      };
    }
    const changed = await runLocalCommand(
      'git',
      ['status', '--porcelain', '--', ...writtenPaths],
      { cwd: repoPath }
    );
    if (changed.stdout.trim()) {
      commitResult = await runLocalCommand('git', ['commit', '-m', commitMessage], {
        cwd: repoPath
      });
      if (!commitResult.ok) {
        return {
          ok: false,
          status: 'blocked',
          reason: 'counterexample_git_commit_failed',
          git_error: commitResult.stderr,
          written_paths: writtenPaths
        };
      }
      committed = true;
    }
  }
  const afterHead = await runLocalCommand('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath
  });
  return {
    ok: true,
    status: 'materialized',
    written_paths: writtenPaths,
    committed,
    commit_stdout: commitResult?.stdout ?? null,
    base_commit_before: beforeHead.stdout.trim(),
    base_commit_after: afterHead.stdout.trim()
  };
}

export async function runProduct100CounterexampleRepairLoop({
  repoPath,
  dataDir,
  repairTaskFile,
  repairEvalFile,
  repairTestsFile,
  counterexamples,
  agents,
  challengers = [],
  projectId = 'product-100-live',
  loopId,
  maxCandidates,
  skipDependencyInstall = true,
  commitSelectedPatch = true,
  materializeTests = true,
  outputDir,
  runImprove,
  codexHome,
  defaultRepairAgentFactory = buildDefaultProduct100RepairAgentSet
} = {}) {
  if (!repoPath) throw new Error('repoPath is required');
  if (!repairTaskFile) throw new Error('repairTaskFile is required');
  if (!repairEvalFile) throw new Error('repairEvalFile is required');
  const repairOutputDir = outputDir ?? path.dirname(repairTaskFile);
  await mkdir(repairOutputDir, { recursive: true });

  const materialization = materializeTests
    ? await materializeProduct100CounterexampleTests({
        repoPath,
        counterexamples,
        testsFile: repairTestsFile
      })
    : {
        ok: true,
        status: 'skipped',
        reason: 'materialize_tests_disabled',
        written_paths: []
      };
  await writeJson(
    path.join(repairOutputDir, 'counterexample-repair-materialization.json'),
    materialization
  );
  if (materialization.ok !== true) {
    return {
      executed: false,
      status: 'blocked',
      reason: materialization.reason,
      materialization,
      repair_pass: false
    };
  }

  let defaultRepairAgentSet = null;
  let defaultRepairAgentUsed = false;
  let repairAgents =
    agents ??
    (process.env.VIBELOOP_PRODUCT_100_REPAIR_AGENT
      ? [process.env.VIBELOOP_PRODUCT_100_REPAIR_AGENT]
      : []);
  let repairChallengers = challengers;
  if (!Array.isArray(repairAgents) || repairAgents.length === 0) {
    try {
      defaultRepairAgentSet = await defaultRepairAgentFactory({ codexHome });
      repairAgents = defaultRepairAgentSet.agents ?? [];
      repairChallengers =
        Array.isArray(challengers) && challengers.length > 0
          ? challengers
          : (defaultRepairAgentSet.challengers ?? []);
      defaultRepairAgentUsed = repairAgents.length > 0;
    } catch (error) {
      await writeJson(
        path.join(repairOutputDir, 'counterexample-repair-default-agent-error.json'),
        { message: error instanceof Error ? error.message : String(error) }
      );
    }
  }
  if (!Array.isArray(repairAgents) || repairAgents.length === 0) {
    return {
      executed: false,
      status: 'skipped',
      reason: 'repair_agent_not_configured',
      materialization,
      repair_pass: false
    };
  }

  const repairLoopId =
    loopId ??
    `product-100-counterexample-repair-${process.pid}-${Date.now()}`;
  const repairDataDir =
    dataDir ?? path.join(repairOutputDir, 'counterexample-repair-data');
  if (dataDir || repairDataDir.includes('counterexample-repair-data')) {
    await rm(repairDataDir, { recursive: true, force: true });
  }
  const baseCommit =
    materialization.base_commit_after ??
    (await runLocalCommand('git', ['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim();
  const candidateLimit =
    maxCandidates ?? Math.max(4, repairAgents.length + repairChallengers.length);
  const repairAgentSpecs = repeatSpecs(
    repairAgents,
    Math.max(1, Math.ceil(candidateLimit / 2))
  );
  const repairChallengerSpecs = repeatSpecs(
    repairChallengers.length > 0 ? repairChallengers : repairAgents,
    Math.max(1, candidateLimit - repairAgentSpecs.length)
  );

  const args = [
    path.join(repoRoot, 'packages/cli/bin/vibeloop'),
    '--data-dir',
    repairDataDir,
    'improve',
    '--repo',
    repoPath,
    '--task',
    repairTaskFile,
    '--eval',
    repairEvalFile,
    ...repairAgentSpecs.map((agent) => ['--agent', agent]).flat(),
    ...repairChallengerSpecs.map((challenger) => ['--challenger', challenger]).flat(),
    '--project-id',
    projectId,
    '--loop-id',
    repairLoopId,
    '--base-commit',
    baseCommit,
    '--max-candidates',
    String(candidateLimit),
    ...(skipDependencyInstall ? ['--skip-dependency-install'] : [])
  ];
  const cli =
    runImprove ??
    (async () => runLocalCommand(process.execPath, args, { cwd: repoRoot }));
  let result;
  try {
    result = await cli({
      command: process.execPath,
      args,
      cwd: repoRoot,
      repoPath,
      repairTaskFile,
      repairEvalFile,
      repairDataDir,
      loopId: repairLoopId,
      baseCommit
    });
  } finally {
    if (defaultRepairAgentSet?.proxy) {
      await defaultRepairAgentSet.proxy.close().catch(() => undefined);
    }
  }
  await writeJson(path.join(repairOutputDir, 'counterexample-repair-cli-result.json'), {
    code: result.code,
    ok: result.ok,
    stdout_bytes: Buffer.byteLength(result.stdout ?? '', 'utf8'),
    stderr: result.stderr
  });

  let parsed = null;
  let parseError = null;
  try {
    parsed = parseFirstJson(result.stdout);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const repairPass =
    parsed?.pr_candidate === true &&
    parsed?.final_verification &&
    parsed?.selection_quality?.strict_score_improvement === true;

  let committed = false;
  let commitResult = null;
  if (repairPass && commitSelectedPatch && parsed?.selected_patch) {
    const apply = await runLocalCommand('git', ['apply', parsed.selected_patch], {
      cwd: repoPath
    });
    if (apply.ok) {
      await runLocalCommand('git', ['add', '-A'], { cwd: repoPath });
      commitResult = await runLocalCommand(
        'git',
        ['commit', '-m', `product-100: repair adversary counterexample ${repairLoopId}`],
        { cwd: repoPath }
      );
      committed = commitResult.ok;
    } else {
      commitResult = apply;
    }
  }

  const repairReport = {
    executed: true,
    status: repairPass ? 'pass' : 'fail',
    repair_pass: repairPass,
    default_repair_agent_used: defaultRepairAgentUsed,
    proxy_stats: defaultRepairAgentSet?.proxy?.stats ?? null,
    command_exit_code: result.code,
    output_parse_error: parseError,
    loop_id: repairLoopId,
    base_commit: baseCommit,
    materialization,
    selected_candidate_id: parsed?.selected_candidate_id ?? null,
    selected_patch: parsed?.selected_patch ?? null,
    selected_report: parsed?.selected_report ?? null,
    pr_candidate: parsed?.pr_candidate === true,
    final_verification: parsed?.final_verification ?? null,
    selection_quality: parsed?.selection_quality ?? null,
    committed_to_integration_branch: committed,
    candidate_worktree_for_followup: committed ? repoPath : null,
    selected_base_commit_for_followup: baseCommit,
    commit_result: commitResult
      ? {
          ok: commitResult.ok,
          code: commitResult.code,
          stdout: commitResult.stdout,
          stderr: commitResult.stderr
        }
      : null,
    evidence: {
      cli_result: path.join(repairOutputDir, 'counterexample-repair-cli-result.json'),
      data_dir: repairDataDir
    }
  };
  await writeJson(
    path.join(repairOutputDir, 'counterexample-repair-loop-report.json'),
    repairReport
  );
  return repairReport;
}

export async function runProduct100Phase5Live(options = {}) {
  const issue =
    options.issue ??
    options.phase4?.issues?.find(
      (candidate) =>
        candidate?.pr_candidate === true &&
        candidate?.selected_patch &&
        candidate?.selected_candidate_id
    );
  if (!issue) {
    return evaluateProduct100Phase5({
      reviewReport: null,
      m2Report: null,
      m4Report: null,
      frozenRulepack: null,
      semanticGateReport: {
        status: 'error',
        reason: 'no_phase4_pr_candidate_issue'
      }
    });
  }

  const runRoot = selectedRunRoot(issue);
  const workspaceRef =
    options.workspaceRef ??
    (runRoot ? await readJson(path.join(runRoot, 'workspace', 'workspace-ref.json')) : {});
  const publicTask =
    options.publicTask ??
    (runRoot ? await readJson(path.join(runRoot, 'input', 'task.yaml')) : null);
  const evalFile =
    options.evalFile ??
    product100OriginalEvalFile(options.phase4, issue) ??
    (runRoot ? path.join(runRoot, 'input', 'eval.yaml') : null);
  const selectedPatch =
    options.selectedPatchText ??
    (issue.selected_patch ? await readFile(issue.selected_patch, 'utf8') : '');
  const selectedReport =
    options.selectedReport ??
    (issue.selected_report ? await readJson(issue.selected_report).catch(() => null) : null);
  const evalConfig =
    options.evalConfig ??
    (evalFile ? await readJson(evalFile).catch(() => null) : null);
  const changedFiles =
    runRoot ? await readJson(path.join(runRoot, 'patches', 'changed-files.json')).catch(() => null) : null;
  const outputDir =
    options.outputDir ??
    path.join(
      options.phase4?.tmp_root ?? process.cwd(),
      'product-100-phase5',
      `${issue.repo_id ?? 'repo'}-${issue.issue_id ?? 'issue'}`
    );
  await mkdir(outputDir, { recursive: true });

  const { input: reviewerInput, safety } = buildProduct100ReviewerInput({
    publicTask,
    selectedPatch,
    selectedCandidateId: issue.selected_candidate_id,
    evalSummary: selectedReport
      ? {
          decision: selectedReport.decision,
          gates: selectedReport.gate_runs?.map((gate) => ({
            name: gate.name,
            status: gate.status
          }))
        }
      : null,
    diffSummary: changedFiles,
    adversaryRetryFeedback: options.reviewerFeedback
  });
  await writeJson(path.join(outputDir, 'reviewer-input.json'), reviewerInput);
  if (!safety.ok) {
    const reviewReport = buildProduct100AdversaryReviewReport({
      reviewerOutput: { findings: [], proposals: [] },
      provider: options.provider,
      realLlm: options.realLlm,
      reviewerCommand: options.reviewerCommand,
      builderCommand: options.builderCommand,
      separateContext: options.separateContext
    });
    reviewReport.input_safety = safety;
    await writeJson(path.join(outputDir, 'review-report.json'), reviewReport);
    return {
      ...evaluateProduct100Phase5({ reviewReport }),
      phase5_artifact_dir: outputDir
    };
  }

  const reviewerCommand =
    options.reviewerCommand ??
    process.env.VIBELOOP_ADVERSARY_REVIEWER_COMMAND ??
    defaultProduct100ReviewerCommand();
  const reviewerRunner = options.runReviewerCommand ?? runReviewerCommand;
  const reviewerResult = options.reviewerOutput
    ? {
        ok: true,
        code: 0,
        stdout: JSON.stringify(options.reviewerOutput),
        stderr: ''
      }
    : reviewerCommand
      ? await reviewerRunner(reviewerCommand, reviewerInput, {
          timeoutMs: options.reviewerTimeoutMs,
          env: options.codexHome
            ? {
                ...(options.env ?? process.env),
                VIBELOOP_PRODUCT_100_REVIEWER_CODEX_HOME: options.codexHome
              }
            : options.env
        })
      : {
          ok: false,
          code: null,
          stdout: '',
          stderr: 'VIBELOOP_ADVERSARY_REVIEWER_COMMAND is not configured'
        };
  await writeJson(path.join(outputDir, 'reviewer-command-result.json'), {
    ok: reviewerResult.ok,
    code: reviewerResult.code,
    stdout_bytes: Buffer.byteLength(reviewerResult.stdout ?? '', 'utf8'),
    stdout: reviewerResult.ok
      ? undefined
      : String(reviewerResult.stdout ?? '').slice(0, 4000),
    stderr: reviewerResult.stderr
  });

  const reviewReport = buildProduct100AdversaryReviewReport({
    reviewerOutput: reviewerResult.ok
      ? reviewerResult.stdout
      : { findings: [], proposals: [] },
    provider: options.provider ?? process.env.VIBELOOP_ADVERSARY_REVIEWER_PROVIDER ?? 'codex',
    realLlm:
      options.realLlm ??
      (process.env.VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM === '1' ||
        !process.env.VIBELOOP_ADVERSARY_REVIEWER_COMMAND),
    reviewerCommand,
    builderCommand: options.builderCommand ?? 'product-100-codex-builder',
    separateContext: options.separateContext ?? true
  });
  await writeJson(path.join(outputDir, 'review-report.json'), reviewReport);
  if (!reviewerResult.ok || reviewReport.accepted_proposal_count < 1) {
    if (!reviewerResult.ok) {
      reviewReport.reviewer_error = {
        code: reviewerResult.code,
        stdout: String(reviewerResult.stdout ?? '').slice(0, 4000),
        stderr: reviewerResult.stderr
      };
      await writeJson(path.join(outputDir, 'review-report.json'), reviewReport);
    }
    return {
      ...evaluateProduct100Phase5({ reviewReport }),
      phase5_artifact_dir: outputDir
    };
  }

  const proposalAttemptIndex = Math.max(
    0,
    Number.isInteger(Number(options.proposalAttemptIndex))
      ? Number(options.proposalAttemptIndex)
      : 0
  );
  const handoff = sdkM2Handoff({
    reviewReport,
    loopId: issue.loop_id,
    baseCommit: workspaceRef.base_commit ?? 'unknown-base',
    selectedCandidateId: issue.selected_candidate_id,
    selectedPatch: issue.selected_patch,
    proposalIndex: proposalAttemptIndex
  });
  const handoffFile = path.join(outputDir, 'm2-handoff.json');
  const confirmationFile = path.join(outputDir, 'm2-confirmation.json');
  const candidateFile = path.join(outputDir, 'rulepack-candidate.json');
  const corpusFile = path.join(outputDir, 'm4-replay-corpus.json');
  const replayFile = path.join(outputDir, 'm4-replay.json');
  const freezeFile = path.join(outputDir, 'm4-freeze.json');
  const rulepackFile = path.join(outputDir, 'frozen-rulepack.json');
  const semanticFile = path.join(outputDir, 'n-plus-one-semantic.json');
  await writeJson(handoffFile, handoff);

  const firstProposal = handoff.proposals[0]?.proposal;
  if (!firstProposal) {
    return {
      ...evaluateProduct100Phase5({
        reviewReport,
        m2Report: null,
        m4Report: null,
        frozenRulepack: null,
        semanticGateReport: {
          status: 'fail',
          allPass: false,
          reason: 'no_proposal_for_attempt'
        }
      }),
      phase5_artifact_dir: outputDir,
      proposal_attempt_index: proposalAttemptIndex,
      proposal_attempt_count: reviewReport.accepted_proposal_count
    };
  }
  const testCommand =
    firstProposal.command ?? product100ProposalTestCommand(firstProposal);
  const image = options.image ?? defaultProduct100ProposalImage(firstProposal, evalConfig);
  const network = options.network ?? 'none';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const proposalRetryRoot = options.proposalRetryRoot ?? outputDir;
  const reviewerRetryRoot = options.reviewerRetryRoot ?? outputDir;
  let candidateWorktree = options.candidateWorktree ?? workspaceRef.worktree_path;
  if (
    !options.candidateWorktree &&
    candidateWorktree &&
    !(await isGitWorktree(candidateWorktree)) &&
    workspaceRef.repo_path
  ) {
    candidateWorktree = workspaceRef.repo_path;
  }
  let baseWorktree = options.baseWorktree;
  if (
    !baseWorktree &&
    workspaceRef.repo_path &&
    workspaceRef.base_commit
  ) {
    baseWorktree = await ensureBaseWorktree({
      repoPath: workspaceRef.repo_path,
      baseWorktree: path.join(outputDir, 'base-worktree'),
      baseCommit: workspaceRef.base_commit,
      outputDir
    });
  }
  const confirmFn = options.confirmHandoff ?? confirmAdversaryM2Handoff;
  const candidateFn = options.buildRulepackCandidate ?? buildAdversaryRulepackCandidate;
  const corpusFn = options.buildReplayCorpus ?? buildAdversaryReplayCorpus;
  const replayFn = options.replayRulepack ?? replayAdversaryRulepack;
  const freezeFn = options.freezeRulepack ?? freezeAdversaryRulepack;
  const semanticFn = options.runSemanticRulepack ?? runFrozenRulepack;

  const runM2M4FreezePipeline = async ({
    pipelineHandoffFile,
    pipelineConfirmationFile,
    pipelineCandidateFile,
    pipelineCorpusFile,
    pipelineReplayFile,
    pipelineFreezeFile,
    pipelineRulepackFile,
    pipelineSemanticFile,
    pipelineCandidateWorktree,
    pipelineBaseWorktree,
    semanticLoopId
  }) => {
    const m2Report = await confirmFn({
      handoffFile: pipelineHandoffFile,
      candidateWorktree: pipelineCandidateWorktree,
      ...(pipelineBaseWorktree ? { baseWorktree: pipelineBaseWorktree } : {}),
      execute: true,
      filterConfig: {
        testDirs: ['tests/adversary/'],
        hiddenMarkers: DEFAULT_HIDDEN_MARKERS,
        maxBodyBytes: 8000
      },
      execution: {
        image,
        testCommand,
        network,
        timeoutMs
      },
      outputFile: pipelineConfirmationFile
    });
    const rulepackCandidate = await candidateFn({
      handoffFile: pipelineHandoffFile,
      confirmationFile: pipelineConfirmationFile,
      outputFile: pipelineCandidateFile
    });
    if (
      m2Report.all_confirmed !== true ||
      rulepackCandidate.candidate_created !== true
    ) {
      return {
        m2Report,
        rulepackCandidate,
        m4Report: null,
        frozenRulepack: null,
        semanticGateReport: {
          status: 'fail',
          allPass: false,
          reason: 'm2_confirmation_failed_or_rulepack_candidate_rejected'
        }
      };
    }

    await corpusFn({
      handoffFile: pipelineHandoffFile,
      candidateFile: pipelineCandidateFile,
      testCommand,
      outputFile: pipelineCorpusFile
    });
    const m4Report = await replayFn({
      corpusFile: pipelineCorpusFile,
      execute: true,
      worktreePath: pipelineCandidateWorktree,
      image,
      network,
      timeoutMs,
      outputFile: pipelineReplayFile
    });
    const freezeReport = await freezeFn({
      candidateFile: pipelineCandidateFile,
      replayFile: pipelineReplayFile,
      outputFile: pipelineFreezeFile,
      rulepackOutFile: pipelineRulepackFile
    });
    const frozenRulepack = freezeReport.frozen_rulepack
      ? { ...freezeReport.frozen_rulepack, frozen: freezeReport.frozen === true }
      : (rulepackCandidate.frozen_rulepack ?? null);
    const semanticGateReport = frozenRulepack
      ? await semanticFn(frozenRulepack, {
          worktreePath: pipelineCandidateWorktree,
          image,
          network,
          timeoutMs,
          currentLoopId: semanticLoopId
        })
      : { status: 'error', allPass: false, reason: 'freeze_failed' };
    await writeJson(pipelineSemanticFile, semanticGateReport);
    return {
      m2Report,
      rulepackCandidate,
      m4Report,
      frozenRulepack,
      semanticGateReport
    };
  };

  const tryNextReviewProposal = async ({
    reason,
    candidateWorktreeForRetry,
    baseWorktreeForRetry,
    previousReport
  } = {}) => {
    const nextProposalAttemptIndex = proposalAttemptIndex + 1;
    if (
      options.disableProposalRetry === true ||
      nextProposalAttemptIndex >= (reviewReport.accepted_proposal_count ?? 0)
    ) {
      return null;
    }
    const retryReport = await runProduct100Phase5Live({
      ...options,
      issue,
      outputDir: path.join(
        proposalRetryRoot,
        `proposal-attempt-${nextProposalAttemptIndex + 1}`
      ),
      proposalRetryRoot,
      reviewerRetryRoot,
      reviewerOutput: {
        findings: reviewReport.findings ?? [],
        proposals: reviewReport.accepted_proposals ?? []
      },
      provider:
        options.provider ??
        reviewReport.reviewer_provenance?.provider ??
        'codex',
      realLlm:
        options.realLlm ??
        reviewReport.reviewer_provenance?.real_llm === true,
      reviewerCommand:
        options.reviewerCommand ??
        reviewReport.reviewer_provenance?.reviewer_command ??
        'product-100-adversary-reviewer-retry',
      builderCommand: options.builderCommand ?? 'product-100-codex-builder',
      separateContext: options.separateContext ?? true,
      proposalAttemptIndex: nextProposalAttemptIndex,
      candidateWorktree: candidateWorktreeForRetry ?? candidateWorktree,
      baseWorktree: baseWorktreeForRetry ?? baseWorktree,
      repairDataDir: undefined,
      postRepairCandidateWorktree: undefined
    });
    return {
      ...retryReport,
      proposal_retry_from: {
        reason,
        proposal_attempt_index: proposalAttemptIndex,
        proposal_attempt_count: reviewReport.accepted_proposal_count,
        phase5_artifact_dir: outputDir,
        previous_report: previousReport ?? null
      }
    };
  };

  const tryRegeneratedReviewerProposal = async ({
    reason,
    candidateWorktreeForRetry,
    baseWorktreeForRetry,
    previousReport
  } = {}) => {
    const reviewerRetryAttempt = Number(options.reviewerRetryAttempt ?? 0);
    if (
      options.disableReviewerRetry === true ||
      options.reviewerOutput ||
      reviewerRetryAttempt >= reviewerRetryLimit()
    ) {
      return null;
    }
    const feedback = {
      reason,
      reviewer_retry_attempt: reviewerRetryAttempt + 1,
      proposal_attempt_index: proposalAttemptIndex,
      proposal_attempt_count: reviewReport.accepted_proposal_count,
      rejected_proposal_ids: [
        ...new Set(
          [
            ...(previousReport?.confirmations ?? []),
            ...(previousReport?.post_repair_confirmations ?? [])
          ]
            .map((confirmation) => confirmation?.proposalId)
            .filter(Boolean)
        )
      ],
      confirmations: previousReport?.confirmations ?? [],
      post_repair_confirmations:
        previousReport?.post_repair_confirmations ?? [],
      artifact_refs: previousReport?.artifact_refs ?? {}
    };
    const reviewerRetryOutputDir = path.join(
      reviewerRetryRoot,
      `reviewer-retry-${reviewerRetryAttempt + 1}`
    );
    const retryReport = await runProduct100Phase5Live({
      ...options,
      issue,
      outputDir: reviewerRetryOutputDir,
      proposalRetryRoot: reviewerRetryOutputDir,
      reviewerRetryRoot,
      reviewerOutput: undefined,
      reviewerFeedback: [...(options.reviewerFeedback ?? []), feedback],
      reviewerRetryAttempt: reviewerRetryAttempt + 1,
      proposalAttemptIndex: 0,
      candidateWorktree: candidateWorktreeForRetry ?? candidateWorktree,
      baseWorktree: baseWorktreeForRetry ?? baseWorktree,
      repairDataDir: undefined,
      postRepairCandidateWorktree: undefined
    });
    return {
      ...retryReport,
      reviewer_retry_from: {
        reason,
        reviewer_retry_attempt: reviewerRetryAttempt,
        phase5_artifact_dir: outputDir,
        previous_report: previousReport ?? null
      }
    };
  };

  const initialPipeline = await runM2M4FreezePipeline({
    pipelineHandoffFile: handoffFile,
    pipelineConfirmationFile: confirmationFile,
    pipelineCandidateFile: candidateFile,
    pipelineCorpusFile: corpusFile,
    pipelineReplayFile: replayFile,
    pipelineFreezeFile: freezeFile,
    pipelineRulepackFile: rulepackFile,
    pipelineSemanticFile: semanticFile,
    pipelineCandidateWorktree: candidateWorktree,
    pipelineBaseWorktree: baseWorktree,
    semanticLoopId: `${issue.loop_id}-n-plus-one`
  });
  const { m2Report, rulepackCandidate } = initialPipeline;
  if (m2Report.all_confirmed !== true || rulepackCandidate.candidate_created !== true) {
    const repairArtifacts = await writeProduct100CounterexampleRepairArtifacts({
      publicTask,
      evalConfig,
      reviewReport,
      m2Report,
      outputDir,
      evalFile
    });
    const repairTaskFile = repairArtifacts
      ? path.join(outputDir, 'counterexample-repair.task.json')
      : null;
    const repairEvalFile = repairArtifacts
      ? path.join(outputDir, 'counterexample-repair.eval.json')
      : null;
    const repairTestsFile = repairArtifacts
      ? path.join(outputDir, 'counterexample-repair.tests.json')
      : null;
    const enableRepairLoop =
      options.enableCounterexampleRepair === true ||
      process.env.VIBELOOP_PRODUCT_100_ENABLE_COUNTEREXAMPLE_REPAIR === '1';
    const repairLoop =
      enableRepairLoop && repairTaskFile && repairEvalFile && repairTestsFile
        ? await runProduct100CounterexampleRepairLoop({
            repoPath: options.repairRepoPath ?? workspaceRef.repo_path,
            dataDir:
              options.repairDataDir ??
              path.join(outputDir, 'counterexample-repair-data'),
            repairTaskFile,
            repairEvalFile,
            repairTestsFile,
            agents: options.repairAgents,
            challengers: options.repairChallengers ?? [],
            projectId: options.repairProjectId ?? 'product-100-live',
            loopId: `${issue.loop_id}-counterexample-repair`,
            maxCandidates: options.repairMaxCandidates,
            outputDir,
            codexHome: options.codexHome ?? options.phase4?.codex_home,
            runImprove: options.runCounterexampleRepairImprove
          })
        : null;
    if (repairLoop?.repair_pass === true) {
      const postRepairHandoff = {
        ...handoff,
        loop_id: repairLoop.loop_id ?? `${issue.loop_id}-counterexample-repair`,
        base_commit:
          repairLoop.selected_base_commit_for_followup ??
          repairLoop.base_commit ??
          handoff.base_commit,
        selected_candidate_id:
          repairLoop.selected_candidate_id ?? handoff.selected_candidate_id,
        selected_patch: repairLoop.selected_patch ?? handoff.selected_patch
      };
      const postRepairHandoffFile = path.join(
        outputDir,
        'post-repair-m2-handoff.json'
      );
      const postRepairConfirmationFile = path.join(
        outputDir,
        'post-repair-m2-confirmation.json'
      );
      const postRepairCandidateFile = path.join(
        outputDir,
        'post-repair-rulepack-candidate.json'
      );
      const postRepairCorpusFile = path.join(
        outputDir,
        'post-repair-m4-replay-corpus.json'
      );
      const postRepairReplayFile = path.join(
        outputDir,
        'post-repair-m4-replay.json'
      );
      const postRepairFreezeFile = path.join(
        outputDir,
        'post-repair-m4-freeze.json'
      );
      const postRepairRulepackFile = path.join(
        outputDir,
        'post-repair-frozen-rulepack.json'
      );
      const postRepairSemanticFile = path.join(
        outputDir,
        'post-repair-n-plus-one-semantic.json'
      );
      await writeJson(postRepairHandoffFile, postRepairHandoff);
      const postRepairCandidateWorktree =
        options.postRepairCandidateWorktree ??
        repairLoop.candidate_worktree_for_followup ??
        options.repairRepoPath ??
        workspaceRef.repo_path ??
        candidateWorktree;
      const postRepairPipeline = await runM2M4FreezePipeline({
        pipelineHandoffFile: postRepairHandoffFile,
        pipelineConfirmationFile: postRepairConfirmationFile,
        pipelineCandidateFile: postRepairCandidateFile,
        pipelineCorpusFile: postRepairCorpusFile,
        pipelineReplayFile: postRepairReplayFile,
        pipelineFreezeFile: postRepairFreezeFile,
        pipelineRulepackFile: postRepairRulepackFile,
        pipelineSemanticFile: postRepairSemanticFile,
        pipelineCandidateWorktree: postRepairCandidateWorktree,
        pipelineBaseWorktree: baseWorktree,
        semanticLoopId: `${postRepairHandoff.loop_id}-n-plus-one`
      });
      const postRepairEvaluation = evaluateProduct100Phase5({
        reviewReport,
        m2Report: postRepairPipeline.m2Report,
        m4Report: postRepairPipeline.m4Report,
        frozenRulepack: postRepairPipeline.frozenRulepack,
        semanticGateReport: postRepairPipeline.semanticGateReport
      });
      const postRepairReport = {
        ...postRepairEvaluation,
        phase5_artifact_dir: outputDir,
        proposal_attempt_index: proposalAttemptIndex,
        proposal_attempt_count: reviewReport.accepted_proposal_count,
        handoff_file: postRepairHandoffFile,
        initial_handoff_file: handoffFile,
        initial_m2_confirmation_file: confirmationFile,
        initial_rulepack_candidate_file: candidateFile,
        initial_m2_report: m2Report,
        m2_confirmation_file: postRepairConfirmationFile,
        rulepack_candidate_file: postRepairCandidateFile,
        m4_replay_corpus_file: postRepairCorpusFile,
        m4_replay_file: postRepairReplayFile,
        m4_freeze_file: postRepairFreezeFile,
        frozen_rulepack_file: postRepairRulepackFile,
        semantic_gate_file: postRepairSemanticFile,
        counterexample_repair_task_file: repairTaskFile,
        counterexample_repair_eval_file: repairEvalFile,
        counterexample_repair_tests_file: repairTestsFile,
        counterexample_repair_loop: repairLoop,
        counterexample_repair_loop_executed: true,
        counterexample_repair_loop_pass: true,
        counterexample_repair_resolved: postRepairEvaluation.phase5_pass === true,
        improvement_required: postRepairEvaluation.phase5_pass !== true,
        next_step:
          postRepairEvaluation.phase5_pass === true
            ? 'continue_product_100_phase6_draft_pr_evidence_audit'
            : 'run_builder_again_with_counterexample_repair_task_and_eval'
      };
      if (postRepairReport.phase5_pass !== true) {
        const retryReport = await tryNextReviewProposal({
          reason: 'post_repair_m2_m4_freeze_not_confirmed',
          candidateWorktreeForRetry: postRepairCandidateWorktree,
          baseWorktreeForRetry: baseWorktree,
          previousReport: {
            handoff_file: postRepairHandoffFile,
            m2_confirmation_file: postRepairConfirmationFile,
            rulepack_candidate_file: postRepairCandidateFile,
            confirmations: m2Report.confirmations ?? [],
            post_repair_confirmations:
              postRepairPipeline.m2Report?.confirmations ?? [],
            counterexample_repair_loop_pass: true,
            next_step: postRepairReport.next_step,
            artifact_refs: {
              handoff_file: postRepairHandoffFile,
              m2_confirmation_file: postRepairConfirmationFile,
              rulepack_candidate_file: postRepairCandidateFile,
              counterexample_repair_loop:
                repairLoop.evidence?.cli_result ?? null
            }
          }
        });
        if (retryReport?.phase5_pass === true) return retryReport;
        if (retryReport) {
          const regeneratedReport = await tryRegeneratedReviewerProposal({
            reason: 'all_review_proposals_exhausted_after_retry',
            candidateWorktreeForRetry:
              retryReport.counterexample_repair_loop?.candidate_worktree_for_followup ??
              postRepairCandidateWorktree,
            baseWorktreeForRetry: baseWorktree,
            previousReport: {
              confirmations: m2Report.confirmations ?? [],
              post_repair_confirmations:
                postRepairPipeline.m2Report?.confirmations ?? [],
              artifact_refs: {
                retry_phase5_artifact_dir: retryReport.phase5_artifact_dir,
                phase5_artifact_dir: outputDir
              }
            }
          });
          if (regeneratedReport) return regeneratedReport;
          return retryReport;
        }
        const regeneratedReport = await tryRegeneratedReviewerProposal({
          reason: 'all_review_proposals_exhausted_after_repair',
          candidateWorktreeForRetry: postRepairCandidateWorktree,
          baseWorktreeForRetry: baseWorktree,
          previousReport: {
            confirmations: m2Report.confirmations ?? [],
            post_repair_confirmations:
              postRepairPipeline.m2Report?.confirmations ?? [],
            artifact_refs: {
              handoff_file: postRepairHandoffFile,
              m2_confirmation_file: postRepairConfirmationFile,
              rulepack_candidate_file: postRepairCandidateFile,
              phase5_artifact_dir: outputDir
            }
          }
        });
        if (regeneratedReport) return regeneratedReport;
      }
      return postRepairReport;
    }
    const failedReport = {
      ...evaluateProduct100Phase5({
        reviewReport,
        m2Report,
        m4Report: null,
        frozenRulepack: null,
        semanticGateReport: {
          status: 'fail',
          allPass: false,
          reason: 'm2_confirmation_failed_or_rulepack_candidate_rejected'
        }
      }),
      phase5_artifact_dir: outputDir,
      proposal_attempt_index: proposalAttemptIndex,
      proposal_attempt_count: reviewReport.accepted_proposal_count,
      handoff_file: handoffFile,
      m2_confirmation_file: confirmationFile,
      rulepack_candidate_file: candidateFile,
      counterexample_repair_task_file: repairTaskFile,
      counterexample_repair_eval_file: repairEvalFile,
      counterexample_repair_tests_file: repairTestsFile,
      counterexample_repair_loop: repairLoop,
      counterexample_repair_loop_executed: repairLoop?.executed === true,
      counterexample_repair_loop_pass: repairLoop?.repair_pass === true,
      counterexample_repair_resolved: false,
      improvement_required: true,
      next_step:
        repairLoop?.repair_pass === true
          ? 'rerun_phase5_m2_m4_freeze_after_counterexample_repair'
          : 'run_builder_again_with_counterexample_repair_task_and_eval'
    };
    const retryReport = await tryNextReviewProposal({
      reason: 'm2_m4_freeze_not_confirmed',
      candidateWorktreeForRetry: candidateWorktree,
      baseWorktreeForRetry: baseWorktree,
      previousReport: {
        handoff_file: handoffFile,
        m2_confirmation_file: confirmationFile,
        rulepack_candidate_file: candidateFile,
        confirmations: m2Report.confirmations ?? [],
        counterexample_repair_loop_executed:
          failedReport.counterexample_repair_loop_executed,
        next_step: failedReport.next_step,
        artifact_refs: {
          handoff_file: handoffFile,
          m2_confirmation_file: confirmationFile,
          rulepack_candidate_file: candidateFile,
          phase5_artifact_dir: outputDir
        }
      }
    });
    if (retryReport?.phase5_pass === true) return retryReport;
    if (retryReport) {
      const regeneratedReport = await tryRegeneratedReviewerProposal({
        reason: 'all_review_proposals_exhausted_after_retry',
        candidateWorktreeForRetry:
          retryReport.counterexample_repair_loop?.candidate_worktree_for_followup ??
          candidateWorktree,
        baseWorktreeForRetry: baseWorktree,
        previousReport: {
          confirmations: m2Report.confirmations ?? [],
          artifact_refs: {
            retry_phase5_artifact_dir: retryReport.phase5_artifact_dir,
            phase5_artifact_dir: outputDir
          }
        }
      });
      if (regeneratedReport) return regeneratedReport;
      return retryReport;
    }
    const regeneratedReport = await tryRegeneratedReviewerProposal({
      reason: 'all_review_proposals_exhausted',
      candidateWorktreeForRetry: candidateWorktree,
      baseWorktreeForRetry: baseWorktree,
      previousReport: {
        confirmations: m2Report.confirmations ?? [],
        artifact_refs: {
          handoff_file: handoffFile,
          m2_confirmation_file: confirmationFile,
          rulepack_candidate_file: candidateFile,
          phase5_artifact_dir: outputDir
        }
      }
    });
    if (regeneratedReport) return regeneratedReport;
    return failedReport;
  }

  return {
    ...evaluateProduct100Phase5({
      reviewReport,
      m2Report,
      m4Report: initialPipeline.m4Report,
      frozenRulepack: initialPipeline.frozenRulepack,
      semanticGateReport: initialPipeline.semanticGateReport
    }),
    phase5_artifact_dir: outputDir,
    proposal_attempt_index: proposalAttemptIndex,
    proposal_attempt_count: reviewReport.accepted_proposal_count,
    handoff_file: handoffFile,
    m2_confirmation_file: confirmationFile,
    rulepack_candidate_file: candidateFile,
    m4_replay_corpus_file: corpusFile,
    m4_replay_file: replayFile,
    m4_freeze_file: freezeFile,
    frozen_rulepack_file: rulepackFile,
    semantic_gate_file: semanticFile
  };
}

export async function runProduct100Phase5LiveForIssues(options = {}) {
  const phase4 = options.phase4 ?? {};
  const allIssues = Array.isArray(phase4.issues) ? phase4.issues : [];
  const candidateIssues = allIssues.filter(
    (issue) =>
      issue?.pr_candidate === true &&
      issue?.selected_patch &&
      issue?.selected_candidate_id
  );
  const expectedIssueCount =
    Number(phase4.expected_issue_count ?? phase4.issue_count ?? allIssues.length) || 0;
  const outputRoot =
    options.outputDir ??
    path.join(phase4.tmp_root ?? process.cwd(), 'product-100-phase5-all');
  await mkdir(outputRoot, { recursive: true });

  const issueReports = [];
  const issueRunner = options.issueRunner ?? runProduct100Phase5Live;
  const enableCounterexampleRepair =
    options.enableCounterexampleRepair ??
    (process.env.VIBELOOP_PRODUCT_100_ENABLE_COUNTEREXAMPLE_REPAIR === '0'
      ? false
      : true);
  for (const issue of candidateIssues) {
    const issueOutputDir = path.join(
      outputRoot,
      `${issue.repo_id ?? 'repo'}-${issue.issue_id ?? 'issue'}`
    );
    await mkdir(issueOutputDir, { recursive: true });
    const report = await issueRunner({
      ...options,
      phase4,
      issue,
      outputDir: issueOutputDir,
      enableCounterexampleRepair
    });
    const issueReportFile = path.join(issueOutputDir, 'phase5-report.json');
    await writeJson(issueReportFile, report);
    issueReports.push({
      repo_id: issue.repo_id ?? null,
      issue_id: issue.issue_id ?? null,
      loop_id: issue.loop_id ?? null,
      phase5_pass: report.phase5_pass === true,
      real_codex_adversary_reviewer_used:
        report.real_codex_adversary_reviewer_used === true,
      accepted_review_proposal_count_at_least_one:
        report.accepted_review_proposal_count_at_least_one === true,
      same_model_review_false: report.same_model_review_false === true,
      m2_confirmed_under_r1: report.m2_confirmed_under_r1 === true,
      m4_replay_safe_under_r1: report.m4_replay_safe_under_r1 === true,
      frozen_rulepack_ready_next_loop:
        report.frozen_rulepack_ready_next_loop === true,
      frozen_rulepack_semantic_gate_passed_next_loop:
        report.frozen_rulepack_semantic_gate_passed_next_loop === true,
      counterexample_repair_loop_executed:
        report.counterexample_repair_loop_executed === true,
      counterexample_repair_loop_pass:
        report.counterexample_repair_loop_pass === true,
      counterexample_repair_resolved:
        report.counterexample_repair_resolved === true,
      improvement_required: report.improvement_required === true,
      phase5_artifact_dir: report.phase5_artifact_dir ?? issueOutputDir,
      phase5_report_file: issueReportFile,
      report
    });
  }

  const allIssuesCovered =
    expectedIssueCount > 0 &&
    candidateIssues.length === expectedIssueCount &&
    issueReports.length === expectedIssueCount;
  const everyIssuePhase5Pass =
    allIssuesCovered && issueReports.every((issue) => issue.phase5_pass);
  const totalAcceptedReviewProposalIssues = issueReports.filter(
    (issue) => issue.accepted_review_proposal_count_at_least_one
  ).length;
  return {
    schema_version: '1.0',
    kind: 'product_100_phase5_issue_aggregate',
    version: PRODUCT_100_ADVERSARY_VERSION,
    phase5_artifact_dir: outputRoot,
    issue_count: issueReports.length,
    expected_issue_count: expectedIssueCount,
    candidate_issue_count: candidateIssues.length,
    all_issues_covered: allIssuesCovered,
    phase5_pass: everyIssuePhase5Pass,
    real_codex_adversary_reviewer_used:
      allIssuesCovered &&
      issueReports.every((issue) => issue.real_codex_adversary_reviewer_used),
    accepted_review_proposal_count_at_least_one:
      allIssuesCovered &&
      issueReports.every(
        (issue) => issue.accepted_review_proposal_count_at_least_one
      ),
    accepted_review_proposal_issue_count: totalAcceptedReviewProposalIssues,
    same_model_review_false:
      allIssuesCovered &&
      issueReports.every((issue) => issue.same_model_review_false),
    m2_confirmed_under_r1:
      allIssuesCovered &&
      issueReports.every((issue) => issue.m2_confirmed_under_r1),
    m4_replay_safe_under_r1:
      allIssuesCovered &&
      issueReports.every((issue) => issue.m4_replay_safe_under_r1),
    frozen_rulepack_ready_next_loop:
      allIssuesCovered &&
      issueReports.every((issue) => issue.frozen_rulepack_ready_next_loop),
    frozen_rulepack_semantic_gate_passed_next_loop:
      allIssuesCovered &&
      issueReports.every(
        (issue) => issue.frozen_rulepack_semantic_gate_passed_next_loop
      ),
    improvement_required_issue_count: issueReports.filter(
      (issue) => issue.improvement_required
    ).length,
    issues: issueReports,
    next_step: everyIssuePhase5Pass
      ? 'continue_product_100_phase6_draft_pr_evidence_audit'
      : 'complete_phase5_for_every_product_100_issue'
  };
}

function samplePhase5() {
  const proposal = {
    id: 'semantic-edge',
    targetPath: 'tests/adversary/semantic-edge.test.cjs',
    body: "const assert = require('node:assert/strict');\nassert.equal(2 + 2, 4);\n",
    expectation: 'fail_to_pass'
  };
  const reviewReport = buildProduct100AdversaryReviewReport({
    reviewerOutput: { findings: [], proposals: [proposal] },
    provider: 'codex',
    realLlm: true,
    reviewerCommand: 'codex-reviewer',
    builderCommand: 'codex-builder',
    separateContext: true
  });
  const handoff = buildProduct100M2Handoff({
    reviewReport,
    loopId: 'sample-loop-n',
    baseCommit: 'sample-base',
    selectedCandidateId: 'sample-candidate',
    selectedPatch: 'diff --git sample'
  });
  const m2Report = {
    authority: 'deterministic_isolated_execution',
    executed: true,
    all_confirmed: true,
    execution: { network: 'none' }
  };
  const m4Report = {
    authority: 'deterministic_m4_replay',
    executed: true,
    replaySafe: true,
    network: 'none',
    total: 1,
    matched: 1,
    mismatches: []
  };
  const frozenRulepack = buildProduct100FrozenRulepack({ handoff, m2Report, m4Report });
  const semanticGateReport = { status: 'pass', allPass: true };
  return evaluateProduct100Phase5({
    reviewReport,
    m2Report,
    m4Report,
    frozenRulepack,
    semanticGateReport
  });
}

async function main() {
  if (process.argv.includes('--sample')) {
    console.log(JSON.stringify({
      status: 'PRODUCT_100_PHASE5_CONTRACT_SAMPLE_PASS',
      scope: 'contract_sample_not_live',
      product_100_live_pass: false,
      evaluation: samplePhase5()
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({ status: 'ok', version: PRODUCT_100_ADVERSARY_VERSION }, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

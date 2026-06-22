#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  PRODUCT_100_PASS_STATUS,
  PRODUCT_100_REQUIRED_REQUIREMENTS
} from './product-100-contract.mjs';
import {
  REQUIRED_ATTACK_SCENARIOS,
  buildAdversaryLiveAttackScenarios
} from './adversary-live-safety.mjs';
import {
  validateAdversaryReviewerProvenance,
  validateCommandAdversaryReviewerProvenance
} from './adversary-live-contract.mjs';

export const BLOCKED_EXIT = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
const SEMANTIC_ATTACK_SCENARIOS = new Set([
  'visible_only_hardcode',
  'default_quantity_hardcode',
  'zero_quantity_truthiness_hardcode'
]);

export const PREFLIGHTS = [
  {
    gate: 'P0',
    name: 'live environment',
    command: ['corepack', 'pnpm', 'uat:live-preflight']
  },
  {
    gate: 'P2',
    name: 'Postgres contract',
    command: ['corepack', 'pnpm', 'uat:postgres-contract-preflight']
  },
  {
    gate: 'P4',
    name: 'adversary live runtime',
    command: ['corepack', 'pnpm', 'uat:adversary-live-preflight']
  }
];

export const EVIDENCE_SCENARIOS = [
  {
    gate: 'P2',
    name: 'Postgres contract evidence',
    scenario: 'postgres-contract-uat',
    require_manifest: true,
    expected_status: 'POSTGRES_CONTRACT_PASS',
    require_when_preflight_gate_passes: 'P2',
    expected_ledger: {
      required_checks: [
        'test_database_url',
        'database_connection',
        'prisma_store_smoke'
      ],
      expected_test_result_status: 'pass'
    }
  },
  {
    gate: 'P3',
    name: 'live Codex evidence bundle',
    scenario: 'skill-real-user-codex-live-uat',
    require_manifest: true,
    expected_status: 'REAL_USER_RUN_PASS'
  },
  {
    gate: 'P4',
    name: 'adversary live evidence bundle',
    scenario: 'adversary-live-uat',
    require_manifest: true,
    expected_status: 'ADVERSARY_LIVE_PASS',
    require_when_preflight_gate_passes: 'P4',
    expected_ledger: {
      required_attack_scenarios: REQUIRED_ATTACK_SCENARIOS,
      required_adversary_safety: true,
      required_adversary_reviewer_provenance: true
    }
  },
  {
    gate: 'P5',
    name: 'controlled repo matrix evidence',
    scenario: 'repo-matrix-uat',
    require_manifest: true,
    expected_status: 'REPO_MATRIX_PASS',
    expected_ledger: {
      min_cell_count: 19,
      min_pass_count: 16,
      max_fail_count: 0,
      min_dependency_checked_count: 16,
      min_dependency_cache_miss_count: 3,
      required_cells: [
        { id: 'node-single', status: 'pass', provisioning_status: 'skipped' },
        {
          id: 'node-lockfile-provisioning',
          status: 'pass',
          provisioning_status: 'cache_miss',
          provisioning_manager: 'npm'
        },
        {
          id: 'node-pnpm-lockfile-provisioning',
          status: 'pass',
          provisioning_status: 'cache_miss',
          provisioning_manager: 'pnpm'
        },
        {
          id: 'node-yarn-lockfile-provisioning',
          status: 'pass',
          provisioning_status: 'cache_miss',
          provisioning_manager: 'yarn'
        },
        { id: 'python-stdlib', status: 'pass' },
        { id: 'ruby-stdlib', status: 'pass' },
        { id: 'java-stdlib', status: 'pass' },
        { id: 'swift-stdlib', allowed_statuses: ['pass', 'unsupported'] },
        {
          id: 'typescript-esm',
          status: 'pass',
          provisioning_status: 'skipped'
        },
        { id: 'js-monorepo-scope', status: 'pass' },
        { id: 'react-next-like', status: 'pass' },
        { id: 'django-like-service', status: 'pass' },
        { id: 'rails-like-service', status: 'pass' },
        { id: 'android-gradle-like', status: 'pass' },
        { id: 'cli-tool', status: 'pass' },
        {
          id: 'no-package-manager',
          status: 'pass',
          provisioning_status: 'skipped'
        },
        { id: 'large-file-count', status: 'pass' },
        {
          id: 'dirty-worktree',
          status: 'blocked',
          provisioning_status: 'not_run'
        },
        {
          id: 'network-restricted-r1',
          allowed_statuses: ['pass', 'unsupported'],
          allowed_provisioning_statuses: ['skipped', 'unsupported']
        }
      ]
    }
  },
  {
    gate: 'P5',
    name: 'Python representative live evidence',
    scenario: 'repo-matrix-python-codex-live-uat',
    require_manifest: true,
    expected_status: 'PYTHON_LIVE_REPRESENTATIVE_PASS'
  },
  {
    gate: 'P5',
    name: 'monorepo representative live evidence',
    scenario: 'repo-matrix-monorepo-codex-live-uat',
    require_manifest: true,
    expected_status: 'MONOREPO_LIVE_REPRESENTATIVE_PASS'
  },
  {
    gate: 'P5',
    name: 'broad framework representative live evidence',
    scenario: 'repo-matrix-broad-codex-live-uat',
    require_manifest: true,
    expected_status: 'BROAD_LIVE_REPRESENTATIVE_PASS',
    expected_ledger: {
      min_cell_count: 3,
      min_pass_count: 3,
      max_fail_count: 0,
      required_cells: [
        { id: 'django-like-service', status: 'pass' },
        { id: 'rails-like-service', status: 'pass' },
        { id: 'android-gradle-like', status: 'pass' }
      ]
    }
  }
];

export const PRODUCT_100_EVIDENCE_SCENARIO = {
  gate: 'P6',
  name: 'Product-100 Codex live evidence',
  scenario: 'product-100-codex-live-uat',
  require_manifest: true,
  expected_status: PRODUCT_100_PASS_STATUS,
  expected_ledger: {
    required_product_100: true
  }
};

export const ADVERSARY_REAL_REVIEWER_EVIDENCE_SCENARIO = {
  gate: 'P4',
  name: 'adversary live real reviewer evidence bundle',
  scenario: 'adversary-live-real-reviewer-uat',
  require_manifest: true,
  expected_status: 'ADVERSARY_LIVE_PASS',
  require_when_preflight_gate_passes: 'P4',
  expected_ledger: {
    required_attack_scenarios: REQUIRED_ATTACK_SCENARIOS,
    required_adversary_safety: true,
    required_adversary_reviewer_provenance: true,
    required_adversary_real_reviewer: true
  }
};

export function defaultEvidenceRoot(env = process.env) {
  return (
    env.VIBELOOP_UAT_EVIDENCE_DIR ??
    path.join(os.homedir(), '.vibeloop', 'uat-evidence')
  );
}

function trimOutput(value) {
  return String(value).trim().slice(0, 4_000);
}

export function parseJsonTail(text) {
  const input = String(text);
  for (
    let start = input.indexOf('{');
    start >= 0;
    start = input.indexOf('{', start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
      const char = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(input.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        status: 'timeout',
        exit_code: null,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        report: null
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        status: 'spawn_error',
        exit_code: null,
        stdout: trimOutput(stdout),
        stderr: trimOutput(`${stderr}\n${error.message}`),
        report: null
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        status:
          code === 0 ? 'pass' : code === BLOCKED_EXIT ? 'blocked' : 'fail',
        exit_code: code,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        report: parseJsonTail(stdout)
      });
    });
  });
}

function summarizeMatrixCells(cells) {
  if (!Array.isArray(cells)) return [];
  return cells.map((cell) => ({
    id: cell.id ?? null,
    status: cell.status ?? null,
    corpus_axis: Array.isArray(cell.corpus_axis) ? cell.corpus_axis : [],
    provisioning_status:
      cell.dependency_provisioning?.status ?? cell.provisioning?.status ?? null,
    provisioning_manager: cell.dependency_provisioning?.manager ?? null
  }));
}

function summarizeChecks(checks) {
  if (!checks || typeof checks !== 'object') return {};
  return Object.fromEntries(
    Object.entries(checks).map(([name, check]) => [
      name,
      {
        ok: check?.ok === true,
        status: check?.status ?? null,
        ...(check?.checks ? { checks: check.checks } : {})
      }
    ])
  );
}

function requiredCheckFailures(checkSummaries, requiredChecks = []) {
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) return [];
  const failures = [];
  for (const required of requiredChecks) {
    const check = checkSummaries?.[required];
    if (!check) {
      failures.push(`checks.${required}`);
      continue;
    }
    if (check.ok !== true || check.status !== 'pass') {
      failures.push(`checks.${required}.status`);
    }
    if (required === 'prisma_store_smoke') {
      for (const detail of [
        'candidate_roundtrip',
        'security_metadata_roundtrip',
        'duplicate_fingerprint_rejected'
      ]) {
        if (check.checks?.[detail] !== 'pass') {
          failures.push(`checks.${required}.${detail}`);
        }
      }
    }
  }
  return failures;
}

function summarizeAttackScenarios(attackScenarios) {
  const results = Array.isArray(attackScenarios?.results)
    ? attackScenarios.results
    : [];
  return {
    checked_count: attackScenarios?.checked_count ?? results.length,
    passed_count:
      attackScenarios?.passed_count ??
      results.filter((result) => result?.passed === true).length,
    check_ok: attackScenarios?.check?.ok ?? null,
    results: results.map((result) => ({
      id: result.id ?? null,
      passed: result.passed === true,
      live_required: result.live_required === true,
      required_signal: result.required_signal ?? null,
      expected_outcome: result.expected_outcome ?? null,
      stage: result.stage ?? null,
      mechanism: result.mechanism ?? null,
      executed: result.executed === true,
      blocked: result.blocked === true,
      current_loop_impact: result.current_loop_impact ?? null,
      pr_created: result.pr_created ?? null,
      promotion_allowed: result.promotion_allowed ?? null
    }))
  };
}

function summarizeAdversarySafety(ledgerJson) {
  const safety = ledgerJson.safety ?? {};
  return {
    safety_check: {
      ok: ledgerJson.safety_check?.ok === true,
      failures: Array.isArray(ledgerJson.safety_check?.failures)
        ? ledgerJson.safety_check.failures
        : []
    },
    host_execution_allowed: safety.host_execution_allowed ?? null,
    current_loop_decision_impact: safety.current_loop_decision_impact ?? null,
    proposal_authority: safety.proposal_authority ?? null,
    required_preflights: Array.isArray(safety.required_preflights)
      ? safety.required_preflights
      : [],
    m2: {
      planned_execute: safety.m2?.execute === true,
      isolation: safety.m2?.isolation ?? null,
      network: safety.m2?.network ?? null,
      run_executed: ledgerJson.m2?.executed === true,
      runtime_available: ledgerJson.m2?.runtime_available === true,
      all_confirmed: ledgerJson.m2?.all_confirmed === true
    },
    m4: {
      planned_execute: safety.m4?.execute === true,
      isolation: safety.m4?.isolation ?? null,
      network: safety.m4?.network ?? null,
      run_executed: ledgerJson.m4?.executed === true,
      replay_safe: ledgerJson.m4?.replay_safe === true
    },
    frozen_rulepack: {
      authority: safety.frozen_rulepack?.authority ?? null,
      decision_impact: safety.frozen_rulepack?.decision_impact ?? null,
      same_loop_application_allowed:
        safety.frozen_rulepack?.same_loop_application_allowed ?? null
    },
    n_plus_one: {
      gate: safety.n_plus_one?.gate ?? null,
      required: safety.n_plus_one?.required === true,
      expected_bad_status: safety.n_plus_one?.expected_bad_status ?? null
    }
  };
}

function summarizeAdversaryReviewer(ledgerJson) {
  const reviewer = ledgerJson.adversary_reviewer ?? {};
  return {
    kind: reviewer.kind ?? null,
    real_llm: reviewer.real_llm ?? null,
    provider: reviewer.provider ?? null,
    proposal_source: reviewer.proposal_source ?? null,
    authority: reviewer.authority ?? null,
    decision_impact: reviewer.decision_impact ?? null,
    current_loop_decision_impact:
      reviewer.current_loop_decision_impact ?? null,
    same_model_review: reviewer.same_model_review ?? null,
    prompt_version: reviewer.prompt_version ?? null,
    prompt_hash: reviewer.prompt_hash ?? null,
    accepted_proposal_count: reviewer.accepted_proposal_count ?? null,
    limitation: reviewer.limitation ?? null
  };
}

function requiredAttackScenarioFailures(
  attackScenarios,
  requiredScenarios = []
) {
  if (!Array.isArray(requiredScenarios) || requiredScenarios.length === 0) {
    return [];
  }
  const failures = [];
  const expectedById = new Map(
    buildAdversaryLiveAttackScenarios().map((scenario) => [
      scenario.id,
      scenario
    ])
  );
  const byId = new Map(
    (attackScenarios?.results ?? []).map((result) => [result.id, result])
  );
  for (const required of requiredScenarios) {
    const scenario = byId.get(required);
    const expected = expectedById.get(required);
    if (!scenario) {
      failures.push(`attack_scenarios.${required}`);
      continue;
    }
    if (scenario.passed !== true) {
      failures.push(`attack_scenarios.${required}.passed`);
    }
    if (scenario.live_required !== true) {
      failures.push(`attack_scenarios.${required}.live_required`);
    }
    if (
      expected?.expected_outcome &&
      scenario.expected_outcome !== expected.expected_outcome
    ) {
      failures.push(`attack_scenarios.${required}.expected_outcome`);
    }
    if (
      expected?.required_signal &&
      scenario.required_signal !== expected.required_signal
    ) {
      failures.push(`attack_scenarios.${required}.required_signal`);
    }
    if (scenario.current_loop_impact !== 'none') {
      failures.push(`attack_scenarios.${required}.current_loop_impact`);
    }
    if (scenario.pr_created !== false) {
      failures.push(`attack_scenarios.${required}.pr_created`);
    }
    if (scenario.promotion_allowed !== false) {
      failures.push(`attack_scenarios.${required}.promotion_allowed`);
    }
    if (expected?.expected_outcome === 'reject_or_no_pr' && scenario.blocked !== true) {
      failures.push(`attack_scenarios.${required}.blocked`);
    }
    if (SEMANTIC_ATTACK_SCENARIOS.has(required) && scenario.executed !== true) {
      failures.push(`attack_scenarios.${required}.executed`);
    }
  }
  if (attackScenarios?.check_ok === false) {
    failures.push('attack_scenarios.check');
  }
  return failures;
}

function requiredAdversaryReviewerFailures(reviewer, required = false) {
  if (!required) return [];
  return validateAdversaryReviewerProvenance(reviewer).failures;
}

function requiredAdversaryRealReviewerFailures(reviewer, required = false) {
  if (!required) return [];
  return validateCommandAdversaryReviewerProvenance(reviewer).failures;
}

function requiredAdversarySafetyFailures(adversarySafety, required = false) {
  if (!required) return [];
  const failures = [];
  if (adversarySafety?.safety_check?.ok !== true) {
    failures.push('adversary_safety.safety_check');
  }
  if (adversarySafety?.host_execution_allowed !== false) {
    failures.push('adversary_safety.host_execution_allowed');
  }
  if (adversarySafety?.current_loop_decision_impact !== 'none') {
    failures.push('adversary_safety.current_loop_decision_impact');
  }
  if (adversarySafety?.proposal_authority !== 'advisory_only') {
    failures.push('adversary_safety.proposal_authority');
  }
  for (const preflight of ['container_runtime', 'container_smoke']) {
    if (!adversarySafety?.required_preflights?.includes(preflight)) {
      failures.push(`adversary_safety.required_preflights.${preflight}`);
    }
  }
  for (const phase of ['m2', 'm4']) {
    const summary = adversarySafety?.[phase] ?? {};
    if (summary.planned_execute !== true) {
      failures.push(`adversary_safety.${phase}.planned_execute`);
    }
    if (summary.isolation !== 'container') {
      failures.push(`adversary_safety.${phase}.isolation`);
    }
    if (summary.network !== 'none') {
      failures.push(`adversary_safety.${phase}.network`);
    }
    if (summary.run_executed !== true) {
      failures.push(`adversary_safety.${phase}.run_executed`);
    }
  }
  if (adversarySafety?.m2?.runtime_available !== true) {
    failures.push('adversary_safety.m2.runtime_available');
  }
  if (adversarySafety?.m2?.all_confirmed !== true) {
    failures.push('adversary_safety.m2.all_confirmed');
  }
  if (adversarySafety?.m4?.replay_safe !== true) {
    failures.push('adversary_safety.m4.replay_safe');
  }
  if (adversarySafety?.frozen_rulepack?.authority !== 'fixed_next_loop_gate') {
    failures.push('adversary_safety.frozen_rulepack.authority');
  }
  if (adversarySafety?.frozen_rulepack?.decision_impact !== 'next_loop_only') {
    failures.push('adversary_safety.frozen_rulepack.decision_impact');
  }
  if (
    adversarySafety?.frozen_rulepack?.same_loop_application_allowed !== false
  ) {
    failures.push(
      'adversary_safety.frozen_rulepack.same_loop_application_allowed'
    );
  }
  if (adversarySafety?.n_plus_one?.gate !== 'builtin:rulepack-semantic') {
    failures.push('adversary_safety.n_plus_one.gate');
  }
  if (adversarySafety?.n_plus_one?.required !== true) {
    failures.push('adversary_safety.n_plus_one.required');
  }
  if (adversarySafety?.n_plus_one?.expected_bad_status !== 'fail') {
    failures.push('adversary_safety.n_plus_one.expected_bad_status');
  }
  return failures;
}

function summarizeProduct100Ledger(ledgerJson) {
  const evaluation = ledgerJson.evaluation ?? {};
  const requirements = evaluation.requirements ?? {};
  const summary = ledgerJson.summary ?? {};
  const normalizedRequirements = Object.fromEntries(
    PRODUCT_100_REQUIRED_REQUIREMENTS.map((name) => [
      name,
      requirements[name] === true
    ])
  );
  return {
    contract_version: ledgerJson.product_100_contract_version ?? null,
    evaluation_status: evaluation.status ?? null,
    evaluation_pass: evaluation.pass === true,
    missing_requirements: Array.isArray(evaluation.missing_requirements)
      ? evaluation.missing_requirements
      : [],
    blocked_requirements: Array.isArray(evaluation.blocked_requirements)
      ? evaluation.blocked_requirements
      : [],
    required_count: PRODUCT_100_REQUIRED_REQUIREMENTS.length,
    satisfied_count: Array.isArray(evaluation.satisfied)
      ? evaluation.satisfied.length
      : null,
    requirements: normalizedRequirements,
    live_loop_started: summary.live_loop_started === true,
    phase4_pass:
      summary.phase4?.every_issue_product_100_phase4_pass === true,
    phase5_pass: summary.phase5?.phase5_pass === true,
    phase6_pass: summary.phase6?.phase6_pass === true,
    phase7_pass:
      summary.phase7?.phase7_pass === true ||
      normalizedRequirements.docs_run_ledger_readme_truthful === true,
    issue_count:
      summary.phase4?.issue_count ??
      (Array.isArray(ledgerJson.issue_results)
        ? ledgerJson.issue_results.length
        : null)
  };
}

function requiredProduct100Failures(product100, required = false) {
  if (!required) return [];
  const failures = [];
  if (product100?.evaluation_status !== PRODUCT_100_PASS_STATUS) {
    failures.push('product_100.evaluation.status');
  }
  if (product100?.evaluation_pass !== true) {
    failures.push('product_100.evaluation.pass');
  }
  if ((product100?.missing_requirements ?? []).length > 0) {
    failures.push('product_100.missing_requirements');
  }
  for (const requirement of PRODUCT_100_REQUIRED_REQUIREMENTS) {
    if (product100?.requirements?.[requirement] !== true) {
      failures.push(`product_100.requirements.${requirement}`);
    }
  }
  if (product100?.live_loop_started !== true) {
    failures.push('product_100.live_loop_started');
  }
  for (const phase of ['phase4', 'phase5', 'phase6', 'phase7']) {
    if (product100?.[`${phase}_pass`] !== true) {
      failures.push(`product_100.${phase}`);
    }
  }
  return failures;
}

function requiredCellFailures(cellSummaries, requiredCells = []) {
  if (!Array.isArray(requiredCells) || requiredCells.length === 0) return [];
  const byId = new Map(cellSummaries.map((cell) => [cell.id, cell]));
  const failures = [];
  for (const required of requiredCells) {
    const cell = byId.get(required.id);
    if (!cell) {
      failures.push(`cells.${required.id}`);
      continue;
    }
    if (required.status && cell.status !== required.status) {
      failures.push(`cells.${required.id}.status`);
    }
    if (
      Array.isArray(required.allowed_statuses) &&
      !required.allowed_statuses.includes(cell.status)
    ) {
      failures.push(`cells.${required.id}.status`);
    }
    if (
      required.provisioning_status &&
      cell.provisioning_status !== required.provisioning_status
    ) {
      failures.push(`cells.${required.id}.provisioning_status`);
    }
    if (
      Array.isArray(required.allowed_provisioning_statuses) &&
      !required.allowed_provisioning_statuses.includes(cell.provisioning_status)
    ) {
      failures.push(`cells.${required.id}.provisioning_status`);
    }
    if (
      required.provisioning_manager &&
      cell.provisioning_manager !== required.provisioning_manager
    ) {
      failures.push(`cells.${required.id}.provisioning_manager`);
    }
  }
  return failures;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function sha256(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function validateManifestCopiedEntries(manifestJson, bundleDir) {
  const failures = [];
  const copiedEntries = Array.isArray(manifestJson.copied)
    ? manifestJson.copied
    : [];
  const ledgerRef =
    typeof manifestJson.ledger_ref === 'string'
      ? manifestJson.ledger_ref
      : null;
  const seenBundlePaths = new Set();
  let ledgerRefCopied = false;

  for (const [index, entry] of copiedEntries.entries()) {
    const prefix = `copied[${index}]`;
    if (!entry || typeof entry !== 'object') {
      failures.push(prefix);
      continue;
    }

    if (
      typeof entry.bundle_path !== 'string' ||
      entry.bundle_path.trim().length === 0
    ) {
      failures.push(`${prefix}.bundle_path`);
      continue;
    }

    const target = path.resolve(bundleDir, entry.bundle_path);
    if (!isInside(bundleDir, target)) {
      failures.push(`${prefix}.bundle_path`);
      continue;
    }
    const relativeTarget = path
      .relative(bundleDir, target)
      .split(path.sep)
      .join('/');
    if (seenBundlePaths.has(relativeTarget)) {
      failures.push(`${prefix}.bundle_path_duplicate`);
    }
    seenBundlePaths.add(relativeTarget);
    if (ledgerRef && relativeTarget === ledgerRef) {
      ledgerRefCopied = true;
    }

    let fileStat;
    try {
      fileStat = await stat(target);
    } catch {
      failures.push(`${prefix}.missing`);
      continue;
    }
    if (!fileStat.isFile()) {
      failures.push(`${prefix}.file`);
      continue;
    }

    if (typeof entry.size_bytes !== 'number') {
      failures.push(`${prefix}.size_bytes`);
    } else if (entry.size_bytes !== fileStat.size) {
      failures.push(`${prefix}.size_bytes`);
    }

    if (
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      failures.push(`${prefix}.sha256`);
    } else if (entry.sha256 !== (await sha256(target))) {
      failures.push(`${prefix}.sha256`);
    }
  }
  if (ledgerRef && !ledgerRefCopied) {
    failures.push('ledger_ref_copied');
  }

  return {
    checked_count: copiedEntries.length,
    failures
  };
}

export async function latestEvidenceBundle(
  scenario,
  evidenceRoot = defaultEvidenceRoot(),
  options = {}
) {
  const scenarioDir = path.join(evidenceRoot, scenario);
  let entries;
  try {
    entries = await readdir(scenarioDir);
  } catch {
    return {
      ok: false,
      status: 'missing',
      scenario,
      scenario_dir: scenarioDir
    };
  }

  const candidates = [];
  for (const entry of entries) {
    const ledger = path.join(scenarioDir, entry, 'ledger.json');
    try {
      const info = await stat(ledger);
      candidates.push({ run_id: entry, ledger, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore partial directories without a ledger.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = candidates[0];
  if (!latest) {
    return {
      ok: false,
      status: 'missing_ledger',
      scenario,
      scenario_dir: scenarioDir
    };
  }
  let ledgerSummary = null;
  if (options.expectedStatus) {
    try {
      const ledgerJson = JSON.parse(await readFile(latest.ledger, 'utf8'));
      ledgerSummary = {
        status: ledgerJson.status ?? null,
        scenario: ledgerJson.scenario ?? null,
        run_id: ledgerJson.run_id ?? null,
        cell_count: ledgerJson.cell_count ?? null,
        pass_count: ledgerJson.pass_count ?? null,
        blocked_count: ledgerJson.blocked_count ?? null,
        unsupported_count: ledgerJson.unsupported_count ?? null,
        fail_count: ledgerJson.fail_count ?? null,
        dependency_provisioning: ledgerJson.dependency_provisioning ?? null,
        ...(ledgerJson.checks
          ? { checks: summarizeChecks(ledgerJson.checks) }
          : {}),
        ...(ledgerJson.test_result
          ? { test_result: ledgerJson.test_result }
          : {}),
        cells: summarizeMatrixCells(ledgerJson.cells),
        ...(ledgerJson.attack_scenarios
          ? {
              attack_scenarios: summarizeAttackScenarios(
                ledgerJson.attack_scenarios
              )
            }
          : {}),
        ...(options.expectedLedger?.required_adversary_safety
          ? { adversary_safety: summarizeAdversarySafety(ledgerJson) }
          : {}),
        ...(options.expectedLedger?.required_adversary_reviewer_provenance
          ? { adversary_reviewer: summarizeAdversaryReviewer(ledgerJson) }
          : {}),
        ...(options.expectedLedger?.required_product_100
          ? { product_100: summarizeProduct100Ledger(ledgerJson) }
          : {}),
        evidence_missing_count:
          ledgerJson.evidence_missing_count ??
          ledgerJson.evidence?.evidence_missing_count ??
          null,
        evidence_copied_count:
          ledgerJson.evidence_copied_count ??
          ledgerJson.evidence?.evidence_copied_count ??
          null
      };
    } catch (error) {
      return {
        ok: false,
        status: 'missing_or_invalid_ledger',
        scenario,
        run_id: latest.run_id,
        ledger: latest.ledger,
        ledger_mtime_ms: latest.mtimeMs,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    const ledgerFailures = [];
    if (ledgerSummary.status !== options.expectedStatus) {
      ledgerFailures.push('status');
    }
    if (ledgerSummary.scenario !== scenario) {
      ledgerFailures.push('scenario');
    }
    if (
      ledgerSummary.evidence_missing_count !== null &&
      ledgerSummary.evidence_missing_count !== 0
    ) {
      ledgerFailures.push('evidence_missing_count');
    }
    if (
      options.expectedLedger?.min_cell_count !== undefined &&
      !(ledgerSummary.cell_count >= options.expectedLedger.min_cell_count)
    ) {
      ledgerFailures.push('cell_count');
    }
    if (
      options.expectedLedger?.min_pass_count !== undefined &&
      !(ledgerSummary.pass_count >= options.expectedLedger.min_pass_count)
    ) {
      ledgerFailures.push('pass_count');
    }
    if (
      options.expectedLedger?.max_fail_count !== undefined &&
      !(ledgerSummary.fail_count <= options.expectedLedger.max_fail_count)
    ) {
      ledgerFailures.push('fail_count');
    }
    if (
      options.expectedLedger?.min_dependency_checked_count !== undefined &&
      !(
        ledgerSummary.dependency_provisioning?.checked_count >=
        options.expectedLedger.min_dependency_checked_count
      )
    ) {
      ledgerFailures.push('dependency_provisioning.checked_count');
    }
    if (
      options.expectedLedger?.min_dependency_cache_miss_count !== undefined &&
      !(
        (ledgerSummary.dependency_provisioning?.statuses?.cache_miss ?? 0) >=
        options.expectedLedger.min_dependency_cache_miss_count
      )
    ) {
      ledgerFailures.push('dependency_provisioning.cache_miss');
    }
    ledgerFailures.push(
      ...requiredCellFailures(
        ledgerSummary.cells,
        options.expectedLedger?.required_cells
      )
    );
    ledgerFailures.push(
      ...requiredCheckFailures(
        ledgerSummary.checks,
        options.expectedLedger?.required_checks
      )
    );
    if (
      options.expectedLedger?.expected_test_result_status &&
      ledgerSummary.test_result?.status !==
        options.expectedLedger.expected_test_result_status
    ) {
      ledgerFailures.push('test_result.status');
    }
    ledgerFailures.push(
      ...requiredAttackScenarioFailures(
        ledgerSummary.attack_scenarios,
        options.expectedLedger?.required_attack_scenarios
      )
    );
    ledgerFailures.push(
      ...requiredAdversarySafetyFailures(
        ledgerSummary.adversary_safety,
        options.expectedLedger?.required_adversary_safety
      )
    );
    ledgerFailures.push(
      ...requiredAdversaryReviewerFailures(
        ledgerSummary.adversary_reviewer,
        options.expectedLedger?.required_adversary_reviewer_provenance
      )
    );
    ledgerFailures.push(
      ...requiredAdversaryRealReviewerFailures(
        ledgerSummary.adversary_reviewer,
        options.expectedLedger?.required_adversary_real_reviewer
      )
    );
    ledgerFailures.push(
      ...requiredProduct100Failures(
        ledgerSummary.product_100,
        options.expectedLedger?.required_product_100
      )
    );
    if (ledgerFailures.length > 0) {
      return {
        ok: false,
        status: 'invalid_ledger',
        scenario,
        run_id: latest.run_id,
        ledger: latest.ledger,
        ledger_mtime_ms: latest.mtimeMs,
        expected_status: options.expectedStatus,
        ...(options.expectedLedger
          ? { expected_ledger: options.expectedLedger }
          : {}),
        ledger_summary: ledgerSummary,
        ledger_failures: ledgerFailures
      };
    }
  }
  const manifest = path.join(
    scenarioDir,
    latest.run_id,
    'uat-evidence-manifest.json'
  );
  let manifestSummary = null;
  if (options.requireManifest) {
    let manifestIntegrity = null;
    try {
      const parsed = JSON.parse(await readFile(manifest, 'utf8'));
      const bundleDir = path.join(scenarioDir, latest.run_id);
      manifestIntegrity = await validateManifestCopiedEntries(
        parsed,
        bundleDir
      );
      manifestSummary = {
        path: manifest,
        schema_version: parsed.schema_version ?? null,
        scenario: parsed.scenario ?? null,
        run_id: parsed.run_id ?? null,
        ledger_ref: parsed.ledger_ref ?? null,
        copied_count: Array.isArray(parsed.copied) ? parsed.copied.length : 0,
        missing_count: Array.isArray(parsed.missing)
          ? parsed.missing.length
          : 0,
        copied_integrity_checked_count: manifestIntegrity.checked_count
      };
    } catch (error) {
      return {
        ok: false,
        status: 'missing_or_invalid_manifest',
        scenario,
        run_id: latest.run_id,
        ledger: latest.ledger,
        ledger_mtime_ms: latest.mtimeMs,
        manifest,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    const manifestFailures = [];
    if (manifestSummary.schema_version !== '1.0') {
      manifestFailures.push('schema_version');
    }
    if (manifestSummary.scenario !== scenario) {
      manifestFailures.push('scenario');
    }
    if (manifestSummary.run_id !== latest.run_id) {
      manifestFailures.push('run_id');
    }
    if (manifestSummary.ledger_ref !== 'ledger.json') {
      manifestFailures.push('ledger_ref');
    }
    if (manifestSummary.missing_count !== 0) {
      manifestFailures.push('missing_count');
    }
    if (manifestSummary.copied_count <= 0) {
      manifestFailures.push('copied_count');
    }
    manifestFailures.push(...(manifestIntegrity?.failures ?? []));
    if (manifestFailures.length > 0) {
      return {
        ok: false,
        status: 'invalid_manifest',
        scenario,
        run_id: latest.run_id,
        ledger: latest.ledger,
        ledger_mtime_ms: latest.mtimeMs,
        manifest,
        manifest_summary: manifestSummary,
        manifest_failures: manifestFailures
      };
    }
  }
  return {
    ok: true,
    status: 'present',
    scenario,
    run_id: latest.run_id,
    ledger: latest.ledger,
    ledger_mtime_ms: latest.mtimeMs,
    ...(ledgerSummary
      ? {
          expected_status: options.expectedStatus,
          ...(options.expectedLedger
            ? { expected_ledger: options.expectedLedger }
            : {}),
          ledger_summary: ledgerSummary
        }
      : {}),
    ...(manifestSummary
      ? {
          manifest,
          manifest_summary: manifestSummary
        }
      : {})
  };
}

export async function buildReleaseGatePreflightReport(options = {}) {
  const evidenceRoot = options.evidenceRoot ?? defaultEvidenceRoot();
  const preflights = options.preflights ?? PREFLIGHTS;
  const evidenceScenarios = options.evidenceScenarios ?? EVIDENCE_SCENARIOS;
  const runCommand = options.runCommand ?? run;

  const preflightResults = [];
  for (const preflight of preflights) {
    const [command, ...args] = preflight.command;
    const result = await runCommand(command, args);
    const safetyFailed = result.report?.safety_check?.ok === false;
    const status = safetyFailed ? 'fail' : result.status;
    preflightResults.push({
      gate: preflight.gate,
      name: preflight.name,
      command: preflight.command.join(' '),
      status,
      exit_code: result.exit_code,
      reason:
        result.report?.reason ??
        (safetyFailed ? 'SAFETY_CHECK_FAILED' : undefined),
      required_failures: result.report?.required_failures ?? [],
      ...(status !== 'pass' && result.report?.checks
        ? { checks: result.report.checks }
        : {}),
      ...(status !== 'pass' && result.report?.next_step
        ? { next_step: result.report.next_step }
        : {}),
      ...(result.report?.safety ? { safety: result.report.safety } : {}),
      ...(result.report?.safety_check
        ? { safety_check: result.report.safety_check }
        : {}),
      ...(status === 'pass' || result.report
        ? {}
        : { stdout: result.stdout, stderr: result.stderr })
    });
  }

  const evidenceResults = [];
  for (const evidence of evidenceScenarios) {
    const requiredPreflight = evidence.require_when_preflight_gate_passes
      ? preflightResults.find(
          (result) =>
            result.gate === evidence.require_when_preflight_gate_passes
        )
      : null;
    if (requiredPreflight && requiredPreflight.status !== 'pass') {
      evidenceResults.push({
        gate: evidence.gate,
        name: evidence.name,
        ok: true,
        status: 'blocked_by_preflight',
        scenario: evidence.scenario,
        required_preflight_gate: evidence.require_when_preflight_gate_passes,
        preflight_status: requiredPreflight.status,
        reason:
          requiredPreflight.reason ??
          `${evidence.require_when_preflight_gate_passes}_PREFLIGHT_NOT_PASS`,
        next_step:
          'Resolve the required preflight before requiring this live evidence bundle.'
      });
      continue;
    }
    evidenceResults.push({
      gate: evidence.gate,
      name: evidence.name,
      ...(await latestEvidenceBundle(evidence.scenario, evidenceRoot, {
        requireManifest: evidence.require_manifest === true,
        expectedStatus: evidence.expected_status,
        expectedLedger: evidence.expected_ledger
      }))
    });
  }

  const blocked = preflightResults.filter(
    (result) => result.status === 'blocked'
  );
  const failed = [
    ...preflightResults.filter(
      (result) => !['pass', 'blocked'].includes(result.status)
    ),
    ...evidenceResults.filter((result) => !result.ok)
  ];
  const status =
    failed.length > 0 ? 'fail' : blocked.length > 0 ? 'blocked' : 'pass';

  return {
    status,
    scenario: 'release-gates-preflight',
    evidence_root: evidenceRoot,
    blocked_gates: blocked.map((result) => result.gate),
    failed_gates: failed.map((result) => result.gate),
    preflights: preflightResults,
    evidence: evidenceResults,
    next_step:
      status === 'blocked'
        ? 'Resolve blocked preflights, then rerun corepack pnpm uat:release-gates-preflight before claiming release-gate completion.'
        : undefined
  };
}

export function releaseGateExitCode(report) {
  if (report.failed_gates.length > 0) return 1;
  if (report.blocked_gates.length > 0) return BLOCKED_EXIT;
  return 0;
}

async function main() {
  const report = await buildReleaseGatePreflightReport();
  console.log(JSON.stringify(report, null, 2));
  process.exit(releaseGateExitCode(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

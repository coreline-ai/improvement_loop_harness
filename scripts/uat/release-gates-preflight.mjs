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
  'zero_quantity_truthiness_hardcode',
  'discount_hardcode',
  'tax_hardcode',
  'rounding_hardcode',
  'profile_visibility_hardcode',
  'profile_suspension_hardcode',
  'order_approval_hardcode',
  'inventory_reservation_hardcode',
  'shipping_eligibility_hardcode',
  'payment_authorization_hardcode',
  'refund_eligibility_hardcode',
  'coupon_application_hardcode',
  'loyalty_points_hardcode',
  'subscription_renewal_hardcode',
  'entitlement_access_hardcode',
  'gift_card_redemption_hardcode',
  'seller_payout_hardcode',
  'appointment_cancellation_hardcode',
  'warranty_claim_hardcode',
  'support_ticket_routing_hardcode',
  'payment_dispute_hardcode',
  'warehouse_allocation_hardcode',
  'insurance_claim_hardcode',
  'payroll_overtime_hardcode',
  'vendor_invoice_hardcode',
  'expense_reimbursement_hardcode',
  'loan_underwriting_hardcode',
  'account_closure_hardcode',
  'merchant_onboarding_hardcode',
  'data_retention_deletion_hardcode',
  'content_moderation_appeal_hardcode'
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
      min_cell_count: 4,
      min_pass_count: 4,
      max_fail_count: 0,
      required_cells: [
        { id: 'react-next-like', status: 'pass' },
        { id: 'django-like-service', status: 'pass' },
        { id: 'rails-like-service', status: 'pass' },
        { id: 'android-gradle-like', status: 'pass' }
      ]
    }
  }
];

export const SKILL_PROMPT_LIVE_EVIDENCE_SCENARIO = {
  gate: 'P1',
  name: 'Skill prompt live real-builder evidence',
  scenario: 'skill-real-user-codex-skill-prompt-uat',
  require_manifest: true,
  expected_statuses: [
    'SKILL_PROMPT_LIVE_UAT_PASS',
    'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
  ],
  required_statuses: [
    'SKILL_PROMPT_LIVE_UAT_PASS',
    'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
  ],
  expected_ledger: {
    required_skill_prompt_real_builder: true,
    required_skill_prompt_ux: true
  }
};

export const SKILL_PROMPT_GITHUB_DRAFT_PR_EVIDENCE_SCENARIO = {
  gate: 'P1',
  name: 'Skill prompt live real-builder GitHub draft PR evidence',
  scenario: 'skill-real-user-codex-skill-prompt-github-draft-pr-uat',
  require_manifest: true,
  expected_statuses: [
    'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
    'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
  ],
  required_statuses: [
    'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
    'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
  ],
  expected_ledger: {
    required_skill_prompt_real_builder: true,
    required_skill_prompt_github_draft_pr: true,
    required_github_draft_pr: true
  }
};

export const SKILL_PROMPT_MATRIX_EVIDENCE_SCENARIO = {
  gate: 'P1',
  name: 'Skill natural-language prompt routing matrix evidence',
  scenario: 'skill-real-user-prompt-matrix-uat',
  require_manifest: true,
  expected_status: 'SKILL_PROMPT_MATRIX_UAT_PASS',
  expected_ledger: {
    required_skill_prompt_matrix: true
  }
};

export const SKILL_PROMPT_JOURNEY_EVIDENCE_SCENARIO = {
  gate: 'P1',
  name: 'Skill natural-language prompt journey evidence',
  scenario: 'skill-real-user-prompt-journey-uat',
  require_manifest: true,
  expected_status: 'SKILL_PROMPT_JOURNEY_UAT_PASS',
  expected_ledger: {
    required_skill_prompt_journey: true
  }
};

export const SKILL_PROMPT_CORPUS_LIVE_EVIDENCE_SCENARIO = {
  gate: 'P1',
  name: 'Skill natural-language prompt corpus live evidence',
  scenario: 'skill-real-user-prompt-corpus-live-uat',
  require_manifest: true,
  expected_status: 'SKILL_PROMPT_CORPUS_LIVE_UAT_PASS',
  expected_ledger: {
    required_skill_prompt_corpus_live: true,
    min_skill_prompt_corpus_variant_count: 16,
    min_skill_prompt_corpus_user_issue_count: 8,
    min_skill_prompt_corpus_auto_discovery_count: 8
  }
};

export const SKILL_FULL_UAT_EVIDENCE_SCENARIO = {
  gate: 'P1',
  name: 'Skill full fixture UAT evidence',
  scenario: 'skill-real-user-full-uat',
  require_manifest: true,
  expected_status: 'FULL_UAT_PASS',
  expected_ledger: {
    required_skill_full_uat: true
  }
};

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

export const REAL_PROJECT_CORPUS_EVIDENCE_SCENARIO = {
  gate: 'P5',
  name: 'read-only broad real project corpus evidence',
  scenario: 'repo-matrix-real-project-corpus-uat',
  require_manifest: true,
  expected_status: 'REAL_PROJECT_CORPUS_PASS',
  expected_ledger: {
    min_cell_count: 2,
    min_pass_count: 2,
    max_fail_count: 0
  }
};

export const REAL_PROJECT_MODIFIABLE_CORPUS_EVIDENCE_SCENARIO = {
  gate: 'P5',
  name: 'safe modifiable-copy broad real project corpus evidence',
  scenario: 'repo-matrix-real-project-modifiable-corpus-uat',
  require_manifest: true,
  expected_status: 'REAL_PROJECT_MODIFIABLE_CORPUS_PASS',
  expected_ledger: {
    min_cell_count: 2,
    min_pass_count: 2,
    max_fail_count: 0,
    required_modifiable_copy_smoke: true
  }
};

export const REAL_PROJECT_CODEX_COPY_CORPUS_EVIDENCE_SCENARIO = {
  gate: 'P5',
  name: 'real Codex temp-clone broad real project corpus evidence',
  scenario: 'repo-matrix-real-project-codex-copy-uat',
  require_manifest: true,
  expected_status: 'REAL_PROJECT_CODEX_COPY_PASS',
  expected_ledger: {
    min_cell_count: 2,
    min_pass_count: 2,
    max_fail_count: 0,
    required_codex_copy_smoke: true,
    required_real_llm_modification: true,
    required_hidden_acceptance: true,
    required_source_repos_read_only: true,
    required_no_draft_pr: true
  }
};

export const REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO = {
  gate: 'P5',
  name: 'real Codex temp-clone broad real project source repair evidence',
  scenario: 'repo-matrix-real-project-codex-repair-uat',
  require_manifest: true,
  expected_status: 'REAL_PROJECT_CODEX_REPAIR_PASS',
  expected_ledger: {
    min_cell_count: 2,
    min_pass_count: 2,
    max_fail_count: 0,
    required_codex_repair_smoke: true,
    required_source_code_repair: true,
    required_real_llm_modification: true,
    required_hidden_acceptance: true,
    required_source_repos_read_only: true,
    required_no_draft_pr: true
  }
};

export const REAL_PROJECT_BUSINESS_REPAIR_CORPUS_EVIDENCE_SCENARIO = {
  gate: 'P5',
  name: 'real Codex temp-clone broad real project business bug repair fixture evidence',
  scenario: 'repo-matrix-real-project-business-repair-uat',
  require_manifest: true,
  expected_status: 'REAL_PROJECT_BUSINESS_REPAIR_PASS',
  expected_ledger: {
    min_cell_count: 2,
    min_pass_count: 2,
    max_fail_count: 0,
    required_codex_repair_smoke: true,
    required_business_bug_repair: true,
    required_source_code_repair: true,
    required_real_llm_modification: true,
    required_hidden_acceptance: true,
    required_source_repos_read_only: true,
    required_no_draft_pr: true
  }
};

export const REAL_PROJECT_BUSINESS_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO = {
  gate: 'P5',
  name: 'real Codex temp-clone targeted existing business source repair evidence',
  scenario: 'repo-matrix-real-project-business-source-repair-uat',
  require_manifest: true,
  expected_status: 'REAL_PROJECT_BUSINESS_SOURCE_REPAIR_PASS',
  expected_ledger: {
    min_cell_count: 12,
    min_pass_count: 12,
    min_distinct_semantic_target_count: 12,
    max_fail_count: 0,
    required_codex_repair_smoke: true,
    required_business_source_repair: true,
    required_business_bug_repair: true,
    required_existing_source_repair: true,
    required_semantic_source_repair: true,
    required_semantic_bug_repair: true,
    required_source_code_repair: true,
    required_real_llm_modification: true,
    required_hidden_acceptance: true,
    required_source_repos_read_only: true,
    required_no_draft_pr: true
  }
};

export const REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO = {
  gate: 'P5',
  name: 'real Codex temp-clone broad real project existing source repair evidence',
  scenario: 'repo-matrix-real-project-existing-source-repair-uat',
  require_manifest: true,
  expected_status: 'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS',
  expected_ledger: {
    min_cell_count: 8,
    min_pass_count: 8,
    max_fail_count: 0,
    required_codex_repair_smoke: true,
    required_existing_source_repair: true,
    required_source_code_repair: true,
    required_real_llm_modification: true,
    required_hidden_acceptance: true,
    required_source_repos_read_only: true,
    required_no_draft_pr: true
  }
};

export const REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO = {
  gate: 'P5',
  name: 'real Codex temp-clone curated broad real project semantic source repair evidence',
  scenario: 'repo-matrix-real-project-semantic-source-repair-uat',
  require_manifest: true,
  expected_status: 'REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_PASS',
  expected_ledger: {
    min_cell_count: 12,
    min_pass_count: 12,
    max_fail_count: 0,
    required_codex_repair_smoke: true,
    required_existing_source_repair: true,
    required_semantic_source_repair: true,
    required_semantic_bug_repair: true,
    required_source_code_repair: true,
    required_real_llm_modification: true,
    required_hidden_acceptance: true,
    required_source_repos_read_only: true,
    required_no_draft_pr: true
  }
};

export const REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO = {
  gate: 'P5',
  name: 'real Codex temp-clone broad real project existing source repair GitHub draft PR evidence',
  scenario: 'repo-matrix-real-project-existing-source-repair-pr-uat',
  require_manifest: true,
  expected_status: 'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_PASS',
  expected_ledger: {
    min_cell_count: 2,
    min_pass_count: 2,
    max_fail_count: 0,
    required_codex_repair_smoke: true,
    required_existing_source_repair: true,
    required_source_code_repair: true,
    required_real_llm_modification: true,
    required_hidden_acceptance: true,
    required_source_repos_read_only: true,
    required_draft_pr: true,
    required_github_draft_pr: true
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
    provisioning_manager: cell.dependency_provisioning?.manager ?? null,
    modifiable_copy_status: cell.modifiable_copy?.status ?? null,
    codex_copy_status: cell.codex_copy?.status ?? null,
    codex_copy_hidden_acceptance_status:
      cell.codex_copy?.hidden_acceptance?.status ?? null,
    codex_copy_diff_scope_status: cell.codex_copy?.diff_scope?.status ?? null,
    codex_repair_status: cell.codex_repair?.status ?? null,
    codex_repair_visible_acceptance_status:
      cell.codex_repair?.visible_acceptance?.status ?? null,
    codex_repair_hidden_acceptance_status:
      cell.codex_repair?.hidden_acceptance?.status ?? null,
    codex_repair_diff_scope_status:
      cell.codex_repair?.diff_scope?.status ?? null,
    codex_repair_repair_source: cell.codex_repair?.repair_source ?? null,
    codex_repair_source_changed: cell.codex_repair?.source_changed ?? null,
    codex_repair_business_bug_repair:
      cell.codex_repair?.business_bug_repair ?? null,
    codex_repair_business_source_repair:
      cell.codex_repair?.business_source_repair ?? null,
    codex_repair_business_domain: cell.codex_repair?.business_domain ?? null,
    codex_repair_semantic_source_repair:
      cell.codex_repair?.semantic_source_repair ?? null,
    codex_repair_semantic_bug_repair:
      cell.codex_repair?.semantic_bug_repair ?? null,
    codex_repair_semantic_domain: cell.codex_repair?.semantic_domain ?? null,
    codex_repair_semantic_target_id:
      cell.codex_repair?.semantic_target_id ?? null,
    codex_repair_existing_source: cell.codex_repair?.existing_source ?? null,
    codex_repair_existing_source_language:
      cell.codex_repair?.existing_source_language ?? null,
    codex_repair_github_draft_pr_verified:
      cell.codex_repair?.github?.draft_pr_verified ?? null,
    codex_repair_github_main_unchanged:
      cell.codex_repair?.github?.main_unchanged ?? null,
    codex_repair_github_pr_url: cell.codex_repair?.github?.pr_url ?? null,
    codex_repair_visible_test_unchanged:
      cell.codex_repair?.visible_test_unchanged ?? null,
    codex_repair_source_repo_integrity_status:
      cell.codex_repair?.source_repo_integrity?.status ?? null
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

function distinctSemanticTargetCount(cellSummaries) {
  const targets = new Set();
  for (const cell of cellSummaries ?? []) {
    const target =
      cell.codex_repair_semantic_target_id ??
      (cell.codex_repair_semantic_domain &&
      cell.codex_repair_repair_source
        ? `${cell.codex_repair_semantic_domain}:${cell.codex_repair_repair_source}`
        : null);
    if (typeof target === 'string' && target.length > 0) {
      targets.add(target);
    }
  }
  return targets.size;
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
    current_loop_decision_impact: reviewer.current_loop_decision_impact ?? null,
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
    if (
      expected?.expected_outcome === 'reject_or_no_pr' &&
      scenario.blocked !== true
    ) {
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
    phase4_pass: summary.phase4?.every_issue_product_100_phase4_pass === true,
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

function requiredCodexCopyCellFailures(cellSummaries, required = false) {
  if (!required) return [];
  const failures = [];
  for (const cell of cellSummaries ?? []) {
    const id = cell.id ?? 'unknown';
    if (cell.status !== 'pass') {
      failures.push(`cells.${id}.status`);
    }
    if (cell.codex_copy_status !== 'pass') {
      failures.push(`cells.${id}.codex_copy.status`);
    }
    if (cell.codex_copy_hidden_acceptance_status !== 'pass') {
      failures.push(`cells.${id}.codex_copy.hidden_acceptance`);
    }
    if (cell.codex_copy_diff_scope_status !== 'pass') {
      failures.push(`cells.${id}.codex_copy.diff_scope`);
    }
  }
  return failures;
}

function requiredCodexRepairCellFailures(
  cellSummaries,
  required = false,
  requireExistingSource = false,
  requireGithubDraftPr = false,
  requireBusinessBugRepair = false,
  requireBusinessSourceRepair = false,
  requireSemanticSourceRepair = false,
  requireSemanticBugRepair = false
) {
  if (!required) return [];
  const failures = [];
  for (const cell of cellSummaries ?? []) {
    const id = cell.id ?? 'unknown';
    if (cell.status !== 'pass') {
      failures.push(`cells.${id}.status`);
    }
    if (cell.codex_repair_status !== 'pass') {
      failures.push(`cells.${id}.codex_repair.status`);
    }
    if (cell.codex_repair_visible_acceptance_status !== 'pass') {
      failures.push(`cells.${id}.codex_repair.visible_acceptance`);
    }
    if (cell.codex_repair_hidden_acceptance_status !== 'pass') {
      failures.push(`cells.${id}.codex_repair.hidden_acceptance`);
    }
    if (cell.codex_repair_diff_scope_status !== 'pass') {
      failures.push(`cells.${id}.codex_repair.diff_scope`);
    }
    if (cell.codex_repair_source_changed !== true) {
      failures.push(`cells.${id}.codex_repair.source_changed`);
    }
    if (requireExistingSource && cell.codex_repair_existing_source !== true) {
      failures.push(`cells.${id}.codex_repair.existing_source`);
    }
    if (
      requireBusinessBugRepair &&
      cell.codex_repair_business_bug_repair !== true
    ) {
      failures.push(`cells.${id}.codex_repair.business_bug_repair`);
    }
    if (
      requireBusinessSourceRepair &&
      cell.codex_repair_business_source_repair !== true
    ) {
      failures.push(`cells.${id}.codex_repair.business_source_repair`);
    }
    if (
      requireBusinessSourceRepair &&
      !(
        typeof cell.codex_repair_business_domain === 'string' &&
        cell.codex_repair_business_domain.length > 0
      )
    ) {
      failures.push(`cells.${id}.codex_repair.business_domain`);
    }
    if (
      requireSemanticSourceRepair &&
      cell.codex_repair_semantic_source_repair !== true
    ) {
      failures.push(`cells.${id}.codex_repair.semantic_source_repair`);
    }
    if (
      requireSemanticBugRepair &&
      cell.codex_repair_semantic_bug_repair !== true
    ) {
      failures.push(`cells.${id}.codex_repair.semantic_bug_repair`);
    }
    if (
      requireSemanticBugRepair &&
      !(
        typeof cell.codex_repair_semantic_domain === 'string' &&
        cell.codex_repair_semantic_domain.length > 0
      )
    ) {
      failures.push(`cells.${id}.codex_repair.semantic_domain`);
    }
    if (
      requireExistingSource &&
      !(
        typeof cell.codex_repair_repair_source === 'string' &&
        cell.codex_repair_repair_source.length > 0
      )
    ) {
      failures.push(`cells.${id}.codex_repair.repair_source`);
    }
    if (
      requireGithubDraftPr &&
      cell.codex_repair_github_draft_pr_verified !== true
    ) {
      failures.push(`cells.${id}.codex_repair.github.draft_pr_verified`);
    }
    if (
      requireGithubDraftPr &&
      cell.codex_repair_github_main_unchanged !== true
    ) {
      failures.push(`cells.${id}.codex_repair.github.main_unchanged`);
    }
    if (
      requireGithubDraftPr &&
      !(
        typeof cell.codex_repair_github_pr_url === 'string' &&
        cell.codex_repair_github_pr_url.startsWith('https://github.com/')
      )
    ) {
      failures.push(`cells.${id}.codex_repair.github.pr_url`);
    }
    if (cell.codex_repair_visible_test_unchanged !== true) {
      failures.push(`cells.${id}.codex_repair.visible_test_unchanged`);
    }
    if (cell.codex_repair_source_repo_integrity_status !== 'pass') {
      failures.push(`cells.${id}.codex_repair.source_repo_integrity`);
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

function summarizeSkillPromptRequiredLedger(ledgerJson) {
  return {
    status: ledgerJson.status ?? null,
    scenario: ledgerJson.scenario ?? null,
    run_id: ledgerJson.run_id ?? null,
    orchestrator: ledgerJson.orchestrator
      ? {
          real_llm: ledgerJson.orchestrator.real_llm ?? null,
          codex_cli: ledgerJson.orchestrator.codex_cli ?? null,
          required_child_skill_file_read:
            ledgerJson.orchestrator.required_child_skill_file_read ?? null,
          reported_skill_file_read:
            ledgerJson.orchestrator.reported_skill_file_read ?? null,
          reported_skill_name:
            ledgerJson.orchestrator.reported_skill_name ?? null
        }
      : null,
    builder: ledgerJson.builder
      ? {
          real_llm: ledgerJson.builder.real_llm ?? null,
          provider: ledgerJson.builder.provider ?? null,
          model: ledgerJson.builder.model ?? null,
          via: ledgerJson.builder.via ?? null
        }
      : null,
    helper: ledgerJson.helper
      ? {
          invoked: ledgerJson.helper.invoked ?? null,
          mode: ledgerJson.helper.mode ?? null,
          command_kind: ledgerJson.helper.command_kind ?? null,
          executed: ledgerJson.helper.executed ?? null,
          execution_code: ledgerJson.helper.execution_code ?? null
        }
      : null,
    prompt_ux: ledgerJson.prompt_ux
      ? {
          variant_id: ledgerJson.prompt_ux.variant_id ?? null,
          variant_source: ledgerJson.prompt_ux.variant_source ?? null,
          language: ledgerJson.prompt_ux.language ?? null,
          prompt_present: ledgerJson.prompt_ux.prompt_present ?? null,
          prompt_sha256: ledgerJson.prompt_ux.prompt_sha256 ?? null,
          prompt_char_count: ledgerJson.prompt_ux.prompt_char_count ?? null,
          classification: ledgerJson.prompt_ux.classification
            ? {
                mode: ledgerJson.prompt_ux.classification.mode ?? null,
                confidence:
                  ledgerJson.prompt_ux.classification.confidence ?? null
              }
            : null,
          expected_mode: ledgerJson.prompt_ux.expected_mode ?? null,
          matched_expected_mode:
            ledgerJson.prompt_ux.matched_expected_mode ?? null
        }
      : null,
    pr_candidate: ledgerJson.pr_candidate ?? null,
    final_verification: ledgerJson.final_verification
      ? {
          provenance_ok: ledgerJson.final_verification.provenance_ok ?? null,
          reverify_attempted:
            ledgerJson.final_verification.reverify_attempted ?? null,
          reverified: ledgerJson.final_verification.reverified ?? null,
          passed: ledgerJson.final_verification.passed ?? null
        }
      : null,
    promotion: ledgerJson.promotion
      ? {
          branch_name: ledgerJson.promotion.branch_name ?? null,
          pushed: ledgerJson.promotion.pushed ?? null
        }
      : null,
    github_draft_pr: ledgerJson.github_draft_pr ?? false,
    github_draft_pr_verified: ledgerJson.github_draft_pr_verified ?? false,
    draft_pr: ledgerJson.draft_pr ?? null,
    github: ledgerJson.github
      ? {
          repo: ledgerJson.github.repo ?? null,
          url: ledgerJson.github.url ?? null,
          seeded_buggy_base: ledgerJson.github.seeded_buggy_base ?? null,
          draft_pr_count: ledgerJson.github.draft_pr_count ?? null,
          draft_prs: Array.isArray(ledgerJson.github.draft_prs)
            ? ledgerJson.github.draft_prs.map((draftPr) => ({
                branch_name: draftPr.branch_name ?? null,
                head_sha: draftPr.head_sha ?? null,
                github_repo: draftPr.github_repo ?? null,
                pr_url: draftPr.pr_url ?? null,
                pr_number: draftPr.pr_number ?? null,
                pushed: draftPr.pushed ?? null,
                pr_reused: draftPr.pr_reused ?? null,
                base_ref: draftPr.base_ref ?? null,
                live_pr_view: draftPr.live_pr_view
                  ? {
                      confirmed: draftPr.live_pr_view.confirmed ?? null,
                      state: draftPr.live_pr_view.state ?? null,
                      is_draft: draftPr.live_pr_view.is_draft ?? null,
                      auto_merge_disabled:
                        draftPr.live_pr_view.auto_merge_disabled ?? null,
                      base_ref_matches:
                        draftPr.live_pr_view.base_ref_matches ?? null,
                      head_ref_matches:
                        draftPr.live_pr_view.head_ref_matches ?? null,
                      head_sha_matches:
                        draftPr.live_pr_view.head_sha_matches ?? null,
                      body_freshness:
                        draftPr.live_pr_view.body_freshness ?? null,
                      body_sha256: draftPr.live_pr_view.body_sha256 ?? null,
                      body_char_count:
                        draftPr.live_pr_view.body_char_count ?? null,
                      failures: Array.isArray(draftPr.live_pr_view.failures)
                        ? draftPr.live_pr_view.failures
                        : []
                    }
                  : null
              }))
            : []
        }
      : null,
    false_pass: ledgerJson.false_pass ?? null,
    leak: ledgerJson.leak ?? null,
    proof_scope: ledgerJson.proof_scope ?? null,
    not_live_codex_or_github_pass:
      ledgerJson.not_live_codex_or_github_pass ?? null,
    actual_user_environment: ledgerJson.actual_user_environment ?? null,
    prompt_journey: ledgerJson.prompt_journey ?? null,
    total_cases: ledgerJson.total_cases ?? null,
    passed_cases: ledgerJson.passed_cases ?? null,
    failed_cases: ledgerJson.failed_cases ?? null,
    critical_failures: ledgerJson.critical_failures ?? null,
    unexpected_unknown: ledgerJson.unexpected_unknown ?? null,
    failure_reasons_count: Array.isArray(ledgerJson.failure_reasons)
      ? ledgerJson.failure_reasons.length
      : null,
    evidence_missing_count:
      ledgerJson.evidence_missing_count ??
      ledgerJson.evidence?.evidence_missing_count ??
      null
  };
}

function summarizeSkillPromptCorpus(corpus) {
  if (!corpus || typeof corpus !== 'object') return null;
  return {
    proof_scope: corpus.proof_scope ?? null,
    builder_mode: corpus.builder_mode ?? null,
    github_draft_pr_requested: corpus.github_draft_pr_requested ?? null,
    requested_variant_count: corpus.requested_variant_count ?? null,
    executed_variant_count: corpus.executed_variant_count ?? null,
    passed_variant_count: corpus.passed_variant_count ?? null,
    failed_variant_count: corpus.failed_variant_count ?? null,
    blocked_variant_count: corpus.blocked_variant_count ?? null,
    modes: corpus.modes ?? {},
    variants: Array.isArray(corpus.variants)
      ? corpus.variants.map((variant) => ({
          id: variant.id ?? null,
          mode: variant.mode ?? null,
          variant_id: variant.variant_id ?? null,
          language: variant.language ?? null,
          expected_status: variant.expected_status ?? null,
          status: variant.status ?? null,
          pass: variant.pass === true,
          failures: Array.isArray(variant.failures) ? variant.failures : [],
          orchestrator: variant.orchestrator
            ? {
                real_llm: variant.orchestrator.real_llm ?? null,
                codex_cli: variant.orchestrator.codex_cli ?? null,
                reported_skill_file_read:
                  variant.orchestrator.reported_skill_file_read ?? null,
                reported_skill_name:
                  variant.orchestrator.reported_skill_name ?? null
              }
            : null,
          builder: variant.builder
            ? {
                real_llm: variant.builder.real_llm ?? null,
                via: variant.builder.via ?? null,
                model: variant.builder.model ?? null
              }
            : null,
          helper: variant.helper
            ? {
                mode: variant.helper.mode ?? null,
                command_kind: variant.helper.command_kind ?? null,
                executed: variant.helper.executed ?? null,
                execution_code: variant.helper.execution_code ?? null
              }
            : null,
          prompt_ux: variant.prompt_ux
            ? {
                expected_mode: variant.prompt_ux.expected_mode ?? null,
                matched_expected_mode:
                  variant.prompt_ux.matched_expected_mode ?? null,
                prompt_present: variant.prompt_ux.prompt_present ?? null,
                prompt_sha256: variant.prompt_ux.prompt_sha256 ?? null
              }
            : null,
          pr_candidate: variant.pr_candidate ?? null,
          final_verification: variant.final_verification
            ? {
                provenance_ok:
                  variant.final_verification.provenance_ok ?? null,
                reverify_attempted:
                  variant.final_verification.reverify_attempted ?? null,
                reverified: variant.final_verification.reverified ?? null,
                passed: variant.final_verification.passed ?? null
              }
            : null,
          promotion: variant.promotion
            ? {
                branch_name: variant.promotion.branch_name ?? null,
                pushed: variant.promotion.pushed ?? null
              }
            : null,
          github_draft_pr: variant.github_draft_pr ?? null,
          github_draft_pr_verified: variant.github_draft_pr_verified ?? null,
          leak: variant.leak ?? null
        }))
      : []
  };
}

function requiredSkillPromptLedgerFailures(ledgerSummary) {
  const failures = [];
  if (ledgerSummary.orchestrator?.real_llm !== true) {
    failures.push('skill_prompt.orchestrator.real_llm');
  }
  if (ledgerSummary.orchestrator?.codex_cli !== true) {
    failures.push('skill_prompt.orchestrator.codex_cli');
  }
  if (ledgerSummary.orchestrator?.reported_skill_file_read !== true) {
    failures.push('skill_prompt.orchestrator.skill_file_read');
  }
  if (ledgerSummary.orchestrator?.reported_skill_name !== 'vibeloop-harness') {
    failures.push('skill_prompt.orchestrator.skill_name');
  }
  if (
    ledgerSummary.builder?.real_llm !== true ||
    ledgerSummary.builder?.via !== 'chatgpt-oauth-proxy'
  ) {
    failures.push('skill_prompt.builder.real_llm');
  }
  if (
    ledgerSummary.helper?.invoked !== true ||
    ledgerSummary.helper?.executed !== true ||
    ledgerSummary.helper?.execution_code !== 0
  ) {
    failures.push('skill_prompt.helper');
  }
  if (
    !['vibeloop_improve', 'vibeloop_orchestrate'].includes(
      ledgerSummary.helper?.command_kind
    )
  ) {
    failures.push('skill_prompt.helper.command_kind');
  }
  if (ledgerSummary.pr_candidate !== true) {
    failures.push('skill_prompt.pr_candidate');
  }
  if (
    ledgerSummary.final_verification?.provenance_ok !== true ||
    ledgerSummary.final_verification?.reverify_attempted !== true ||
    ledgerSummary.final_verification?.reverified !== true ||
    ledgerSummary.final_verification?.passed !== true
  ) {
    failures.push('skill_prompt.final_verification');
  }
  if (!ledgerSummary.promotion?.branch_name) {
    failures.push('skill_prompt.promotion');
  }
  if (ledgerSummary.promotion?.pushed !== false) {
    failures.push('skill_prompt.promotion.pushed');
  }
  if (ledgerSummary.false_pass !== 0) {
    failures.push('skill_prompt.false_pass');
  }
  if (ledgerSummary.leak !== 0) {
    failures.push('skill_prompt.leak');
  }
  if (ledgerSummary.failure_reasons_count !== 0) {
    failures.push('skill_prompt.failure_reasons');
  }
  return failures;
}

function requiredSkillPromptUxFailures(ledgerSummary) {
  const failures = [];
  const promptUx = ledgerSummary.prompt_ux;
  if (!promptUx) {
    failures.push('skill_prompt.prompt_ux');
    return failures;
  }
  if (typeof promptUx.variant_id !== 'string' || promptUx.variant_id.length === 0) {
    failures.push('skill_prompt.prompt_ux.variant_id');
  }
  if (promptUx.prompt_present !== true) {
    failures.push('skill_prompt.prompt_ux.prompt_present');
  }
  if (
    typeof promptUx.prompt_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(promptUx.prompt_sha256)
  ) {
    failures.push('skill_prompt.prompt_ux.prompt_sha256');
  }
  if (!(promptUx.prompt_char_count > 0)) {
    failures.push('skill_prompt.prompt_ux.prompt_char_count');
  }
  if (promptUx.classification?.mode !== ledgerSummary.helper?.mode) {
    failures.push('skill_prompt.prompt_ux.classification');
  }
  if (promptUx.expected_mode !== ledgerSummary.helper?.mode) {
    failures.push('skill_prompt.prompt_ux.expected_mode');
  }
  if (promptUx.matched_expected_mode !== true) {
    failures.push('skill_prompt.prompt_ux.matched_expected_mode');
  }
  return failures;
}

function requiredSkillPromptGithubDraftPrFailures(ledgerSummary) {
  const failures = [];
  if (ledgerSummary.github_draft_pr !== true) {
    failures.push('skill_prompt.github_draft_pr');
  }
  if (ledgerSummary.github_draft_pr_verified !== true) {
    failures.push('skill_prompt.github_draft_pr_verified');
  }
  const draftPrs = ledgerSummary.github?.draft_prs ?? [];
  if (!(draftPrs.length > 0)) {
    failures.push('skill_prompt.github.draft_prs');
  }
  if (
    draftPrs.some(
      (draftPr) =>
        draftPr.pushed !== true ||
        typeof draftPr.pr_url !== 'string' ||
        !draftPr.pr_url.includes('/pull/') ||
        typeof draftPr.branch_name !== 'string' ||
        draftPr.branch_name.length === 0 ||
        typeof draftPr.head_sha !== 'string' ||
        !/^[a-f0-9]{40}$/.test(draftPr.head_sha) ||
        draftPr.pr_reused !== false ||
        draftPr.base_ref !== 'main' ||
        draftPr.live_pr_view?.confirmed !== true ||
        draftPr.live_pr_view?.state !== 'OPEN' ||
        draftPr.live_pr_view?.is_draft !== true ||
        draftPr.live_pr_view?.auto_merge_disabled !== true ||
        draftPr.live_pr_view?.base_ref_matches !== true ||
        draftPr.live_pr_view?.head_ref_matches !== true ||
        draftPr.live_pr_view?.head_sha_matches !== true ||
        draftPr.live_pr_view?.body_freshness !== 'created_for_this_run' ||
        typeof draftPr.live_pr_view?.body_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(draftPr.live_pr_view.body_sha256) ||
        !(draftPr.live_pr_view?.body_char_count > 0) ||
        !draftPr.github_repo
    )
  ) {
    failures.push('skill_prompt.github.draft_prs.verified');
  }
  return failures;
}

function requiredSkillFullUatFailures(ledgerSummary) {
  const failures = [];
  if (ledgerSummary.proof_scope !== 'fixture_baseline_only') {
    failures.push('skill_full_uat.proof_scope');
  }
  if (ledgerSummary.not_live_codex_or_github_pass !== true) {
    failures.push('skill_full_uat.not_live_codex_or_github_pass');
  }
  if (ledgerSummary.actual_user_environment?.copied_skill_install !== true) {
    failures.push('skill_full_uat.copied_skill_install');
  }
  if (ledgerSummary.actual_user_environment?.clean_codex_home !== true) {
    failures.push('skill_full_uat.clean_codex_home');
  }
  if (
    JSON.stringify(
      ledgerSummary.actual_user_environment?.codex_home_skills_entries ?? null
    ) !== JSON.stringify(['vibeloop-harness'])
  ) {
    failures.push('skill_full_uat.codex_home_skills_entries');
  }
  if (
    ledgerSummary.actual_user_environment?.copied_skill_path !==
    'CODEX_HOME/skills/vibeloop-harness'
  ) {
    failures.push('skill_full_uat.copied_skill_path');
  }
  if (
    ledgerSummary.actual_user_environment?.copied_skill_wrapper !==
    'CODEX_HOME/skills/vibeloop-harness/scripts/vibeloop-run.mjs'
  ) {
    failures.push('skill_full_uat.copied_skill_wrapper');
  }
  if (
    ledgerSummary.actual_user_environment?.vendor_cli !==
    'CODEX_HOME/skills/vibeloop-harness/vendor/vibeloop.mjs'
  ) {
    failures.push('skill_full_uat.vendor_cli');
  }
  if (ledgerSummary.actual_user_environment?.external_user_repo !== true) {
    failures.push('skill_full_uat.external_user_repo');
  }
  if (
    ledgerSummary.actual_user_environment
      ?.task_eval_created_by_copied_skill_script !== true
  ) {
    failures.push('skill_full_uat.task_eval_created_by_copied_skill_script');
  }
  if (ledgerSummary.actual_user_environment?.command_agents !== true) {
    failures.push('skill_full_uat.command_agents');
  }
  if (!(ledgerSummary.required_cases > 0)) {
    failures.push('skill_full_uat.required_cases');
  }
  if (!(ledgerSummary.total_cases >= ledgerSummary.required_cases)) {
    failures.push('skill_full_uat.total_cases');
  }
  if (ledgerSummary.passed_cases !== ledgerSummary.total_cases) {
    failures.push('skill_full_uat.passed_cases');
  }
  if (ledgerSummary.failure_rate?.unexpectedAccept !== 0) {
    failures.push('skill_full_uat.unexpected_accept');
  }
  if (ledgerSummary.failure_rate?.unexpectedReject !== 0) {
    failures.push('skill_full_uat.unexpected_reject');
  }
  if (ledgerSummary.failure_rate?.hiddenLeak !== 0) {
    failures.push('skill_full_uat.hidden_leak');
  }
  if (!(ledgerSummary.positive?.pr_candidate_branch_count >= 2)) {
    failures.push('skill_full_uat.pr_candidate_branch_count');
  }
  if (ledgerSummary.negative?.unexpected_accept !== 0) {
    failures.push('skill_full_uat.negative_unexpected_accept');
  }
  if (!(ledgerSummary.self_improvement?.case_count > 0)) {
    failures.push('skill_full_uat.self_improvement.case_count');
  }
  return failures;
}

function requiredSkillPromptMatrixFailures(ledgerSummary) {
  const failures = [];
  if (ledgerSummary.proof_scope !== 'copied_skill_prompt_routing_matrix') {
    failures.push('skill_prompt_matrix.proof_scope');
  }
  if (ledgerSummary.not_live_codex_or_github_pass !== true) {
    failures.push('skill_prompt_matrix.not_live_codex_or_github_pass');
  }
  if (ledgerSummary.actual_user_environment?.copied_skill_install !== true) {
    failures.push('skill_prompt_matrix.copied_skill_install');
  }
  if (ledgerSummary.actual_user_environment?.clean_codex_home !== true) {
    failures.push('skill_prompt_matrix.clean_codex_home');
  }
  if (
    JSON.stringify(
      ledgerSummary.actual_user_environment?.codex_home_skills_entries ?? null
    ) !== JSON.stringify(['vibeloop-harness'])
  ) {
    failures.push('skill_prompt_matrix.codex_home_skills_entries');
  }
  if (
    ledgerSummary.actual_user_environment?.classifier !==
    'CODEX_HOME/skills/vibeloop-harness/scripts/classify-intent.mjs'
  ) {
    failures.push('skill_prompt_matrix.classifier');
  }
  if (!(ledgerSummary.total_cases >= 12)) {
    failures.push('skill_prompt_matrix.total_cases');
  }
  if (ledgerSummary.passed_cases !== ledgerSummary.total_cases) {
    failures.push('skill_prompt_matrix.passed_cases');
  }
  if (ledgerSummary.failed_cases !== 0) {
    failures.push('skill_prompt_matrix.failed_cases');
  }
  if (ledgerSummary.critical_failures !== 0) {
    failures.push('skill_prompt_matrix.critical_failures');
  }
  if (ledgerSummary.unexpected_unknown !== 0) {
    failures.push('skill_prompt_matrix.unexpected_unknown');
  }
  if (ledgerSummary.false_pass !== 0) {
    failures.push('skill_prompt_matrix.false_pass');
  }
  if (ledgerSummary.leak !== 0) {
    failures.push('skill_prompt_matrix.leak');
  }
  return failures;
}

function requiredSkillPromptJourneyFailures(ledgerSummary) {
  const failures = [];
  const journey = ledgerSummary.prompt_journey;
  if (
    ledgerSummary.proof_scope !==
    'copied_skill_prompt_runner_end_to_end_journey'
  ) {
    failures.push('skill_prompt_journey.proof_scope');
  }
  if (ledgerSummary.not_live_codex_or_github_pass !== true) {
    failures.push('skill_prompt_journey.not_live_codex_or_github_pass');
  }
  if (ledgerSummary.actual_user_environment?.copied_skill_install !== true) {
    failures.push('skill_prompt_journey.copied_skill_install');
  }
  if (ledgerSummary.actual_user_environment?.clean_codex_home !== true) {
    failures.push('skill_prompt_journey.clean_codex_home');
  }
  if (
    JSON.stringify(
      ledgerSummary.actual_user_environment?.codex_home_skills_entries ?? null
    ) !== JSON.stringify(['vibeloop-harness'])
  ) {
    failures.push('skill_prompt_journey.codex_home_skills_entries');
  }
  if (
    ledgerSummary.actual_user_environment?.copied_skill_path !==
    'CODEX_HOME/skills/vibeloop-harness'
  ) {
    failures.push('skill_prompt_journey.copied_skill_path');
  }
  if (
    ledgerSummary.actual_user_environment?.prompt_runner !==
    'CODEX_HOME/skills/vibeloop-harness/scripts/run-from-prompt.mjs'
  ) {
    failures.push('skill_prompt_journey.prompt_runner');
  }
  if (
    ledgerSummary.actual_user_environment?.vendor_cli !==
    'CODEX_HOME/skills/vibeloop-harness/vendor/vibeloop.mjs'
  ) {
    failures.push('skill_prompt_journey.vendor_cli');
  }
  if (!(ledgerSummary.actual_user_environment?.external_user_repos >= 2)) {
    failures.push('skill_prompt_journey.external_user_repos');
  }
  if (ledgerSummary.actual_user_environment?.command_agents !== true) {
    failures.push('skill_prompt_journey.command_agents');
  }
  if (journey?.deterministic_command_agent !== true) {
    failures.push('skill_prompt_journey.deterministic_command_agent');
  }
  if (!(journey?.step_count >= 3)) {
    failures.push('skill_prompt_journey.step_count');
  }
  if (journey?.executed_step_count !== journey?.step_count) {
    failures.push('skill_prompt_journey.executed_step_count');
  }
  if (journey?.passed_step_count !== journey?.step_count) {
    failures.push('skill_prompt_journey.passed_step_count');
  }
  if (!(journey?.pr_candidate_steps >= 2)) {
    failures.push('skill_prompt_journey.pr_candidate_steps');
  }
  if (!(journey?.final_reverify_passed_steps >= 2)) {
    failures.push('skill_prompt_journey.final_reverify_passed_steps');
  }
  if (!(journey?.promotion_branch_count >= 2)) {
    failures.push('skill_prompt_journey.promotion_branch_count');
  }
  if (!(journey?.generated_task_eval_count >= 1)) {
    failures.push('skill_prompt_journey.generated_task_eval_count');
  }
  if (!(journey?.report_summary_steps >= 1)) {
    failures.push('skill_prompt_journey.report_summary_steps');
  }
  if (
    journey?.user_issue?.mode !== 'user_issue' ||
    journey?.user_issue?.command_kind !== 'vibeloop_improve' ||
    journey?.user_issue?.pr_candidate !== true ||
    journey?.user_issue?.final_verification_passed !== true ||
    !journey?.user_issue?.promotion_branch
  ) {
    failures.push('skill_prompt_journey.user_issue');
  }
  if (
    journey?.auto_discovery?.mode !== 'auto_discovery' ||
    journey?.auto_discovery?.command_kind !== 'vibeloop_orchestrate' ||
    journey?.auto_discovery?.pr_candidate !== true ||
    journey?.auto_discovery?.final_verification_passed !== true ||
    !journey?.auto_discovery?.promotion_branch
  ) {
    failures.push('skill_prompt_journey.auto_discovery');
  }
  if (
    journey?.report_summary?.mode !== 'report' ||
    journey?.report_summary?.command_kind !== 'summarize_report' ||
    journey?.report_summary?.next_action !== 'prepare_pr_candidate'
  ) {
    failures.push('skill_prompt_journey.report_summary');
  }
  if (ledgerSummary.passed_cases !== ledgerSummary.total_cases) {
    failures.push('skill_prompt_journey.passed_cases');
  }
  if (ledgerSummary.failed_cases !== 0) {
    failures.push('skill_prompt_journey.failed_cases');
  }
  if (ledgerSummary.false_pass !== 0) {
    failures.push('skill_prompt_journey.false_pass');
  }
  if (ledgerSummary.leak !== 0) {
    failures.push('skill_prompt_journey.leak');
  }
  return failures;
}

function requiredSkillPromptCorpusLiveFailures(
  ledgerSummary,
  expectedLedger = {}
) {
  const failures = [];
  const corpus = ledgerSummary.prompt_corpus;
  const minVariantCount =
    expectedLedger.min_skill_prompt_corpus_variant_count ?? 1;
  const minUserIssueCount =
    expectedLedger.min_skill_prompt_corpus_user_issue_count ?? 1;
  const minAutoDiscoveryCount =
    expectedLedger.min_skill_prompt_corpus_auto_discovery_count ?? 1;

  if (!corpus) {
    failures.push('skill_prompt_corpus');
    return failures;
  }
  if (
    ledgerSummary.proof_scope !== 'natural_language_skill_prompt_live_corpus' ||
    corpus.proof_scope !== 'natural_language_skill_prompt_live_corpus'
  ) {
    failures.push('skill_prompt_corpus.proof_scope');
  }
  if (corpus.builder_mode !== 'codex') {
    failures.push('skill_prompt_corpus.builder_mode');
  }
  if (
    ledgerSummary.orchestrator?.real_llm !== true ||
    ledgerSummary.orchestrator?.codex_cli !== true ||
    ledgerSummary.orchestrator?.required_child_skill_file_read !== true
  ) {
    failures.push('skill_prompt_corpus.orchestrator');
  }
  if (
    ledgerSummary.builder?.real_llm !== true ||
    ledgerSummary.builder?.provider !== 'codex' ||
    ledgerSummary.builder?.via !== 'chatgpt-oauth-proxy'
  ) {
    failures.push('skill_prompt_corpus.builder');
  }
  if (!(corpus.requested_variant_count >= minVariantCount)) {
    failures.push('skill_prompt_corpus.requested_variant_count');
  }
  if (corpus.executed_variant_count !== corpus.requested_variant_count) {
    failures.push('skill_prompt_corpus.executed_variant_count');
  }
  if (corpus.passed_variant_count !== corpus.requested_variant_count) {
    failures.push('skill_prompt_corpus.passed_variant_count');
  }
  if (corpus.failed_variant_count !== 0) {
    failures.push('skill_prompt_corpus.failed_variant_count');
  }
  if (corpus.blocked_variant_count !== 0) {
    failures.push('skill_prompt_corpus.blocked_variant_count');
  }
  if (!(corpus.modes?.user_issue?.variant_count >= minUserIssueCount)) {
    failures.push('skill_prompt_corpus.user_issue.variant_count');
  }
  if (
    corpus.modes?.user_issue?.passed_count !==
    corpus.modes?.user_issue?.variant_count
  ) {
    failures.push('skill_prompt_corpus.user_issue.passed_count');
  }
  if (corpus.modes?.user_issue?.failed_count !== 0) {
    failures.push('skill_prompt_corpus.user_issue.failed_count');
  }
  if (
    !(corpus.modes?.auto_discovery?.variant_count >= minAutoDiscoveryCount)
  ) {
    failures.push('skill_prompt_corpus.auto_discovery.variant_count');
  }
  if (
    corpus.modes?.auto_discovery?.passed_count !==
    corpus.modes?.auto_discovery?.variant_count
  ) {
    failures.push('skill_prompt_corpus.auto_discovery.passed_count');
  }
  if (corpus.modes?.auto_discovery?.failed_count !== 0) {
    failures.push('skill_prompt_corpus.auto_discovery.failed_count');
  }
  if (ledgerSummary.false_pass !== 0) {
    failures.push('skill_prompt_corpus.false_pass');
  }
  if (ledgerSummary.leak !== 0) {
    failures.push('skill_prompt_corpus.leak');
  }
  if (ledgerSummary.failure_reasons_count !== 0) {
    failures.push('skill_prompt_corpus.failure_reasons');
  }
  if (
    corpus.github_draft_pr_requested === true &&
    ledgerSummary.github_draft_pr_verified !== true
  ) {
    failures.push('skill_prompt_corpus.github_draft_pr_verified');
  }
  if (expectedLedger.required_skill_prompt_corpus_github_draft_pr) {
    if (corpus.github_draft_pr_requested !== true) {
      failures.push('skill_prompt_corpus.github_draft_pr_requested');
    }
    if (
      ledgerSummary.github_draft_pr !== true ||
      ledgerSummary.github_draft_pr_verified !== true ||
      ledgerSummary.draft_pr !== true
    ) {
      failures.push('skill_prompt_corpus.github_draft_pr_verified');
    }
  }

  if (corpus.variants.length !== corpus.executed_variant_count) {
    failures.push('skill_prompt_corpus.variants.count');
  }
  if (
    corpus.variants.some((variant) => {
      const expectedCommand =
        variant.mode === 'user_issue'
          ? 'vibeloop_improve'
          : variant.mode === 'auto_discovery'
            ? 'vibeloop_orchestrate'
            : null;
      return (
        variant.pass !== true ||
        variant.status !== variant.expected_status ||
        !String(variant.status ?? '').endsWith('_PASS') ||
        variant.failures.length !== 0 ||
        variant.orchestrator?.real_llm !== true ||
        variant.orchestrator?.codex_cli !== true ||
        variant.orchestrator?.reported_skill_file_read !== true ||
        variant.orchestrator?.reported_skill_name !== 'vibeloop-harness' ||
        variant.builder?.real_llm !== true ||
        variant.builder?.via !== 'chatgpt-oauth-proxy' ||
        variant.helper?.mode !== variant.mode ||
        variant.helper?.command_kind !== expectedCommand ||
        variant.helper?.executed !== true ||
        variant.helper?.execution_code !== 0 ||
        variant.prompt_ux?.expected_mode !== variant.mode ||
        variant.prompt_ux?.matched_expected_mode !== true ||
        variant.prompt_ux?.prompt_present !== true ||
        typeof variant.prompt_ux?.prompt_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(variant.prompt_ux.prompt_sha256) ||
        variant.pr_candidate !== true ||
        variant.final_verification?.provenance_ok !== true ||
        variant.final_verification?.reverify_attempted !== true ||
        variant.final_verification?.reverified !== true ||
        variant.final_verification?.passed !== true ||
        !variant.promotion?.branch_name ||
        variant.promotion?.pushed !== false ||
        (corpus.github_draft_pr_requested === true &&
          variant.github_draft_pr_verified !== true) ||
        variant.leak !== 0
      );
    })
  ) {
    failures.push('skill_prompt_corpus.variants');
  }

  return failures;
}

async function validateRequiredStatusEvidence({
  scenario,
  scenarioDir,
  candidates,
  requiredStatus,
  options
}) {
  for (const candidate of candidates) {
    let ledgerJson;
    try {
      ledgerJson = JSON.parse(await readFile(candidate.ledger, 'utf8'));
    } catch {
      continue;
    }

    if (ledgerJson.status !== requiredStatus) continue;

    const ledgerSummary = summarizeSkillPromptRequiredLedger(ledgerJson);
    const ledgerFailures = [];
    if (ledgerSummary.scenario !== scenario) {
      ledgerFailures.push('scenario');
    }
    if (
      ledgerSummary.evidence_missing_count !== null &&
      ledgerSummary.evidence_missing_count !== 0
    ) {
      ledgerFailures.push('evidence_missing_count');
    }
    if (options.expectedLedger?.required_skill_prompt_real_builder) {
      ledgerFailures.push(...requiredSkillPromptLedgerFailures(ledgerSummary));
    }
    if (options.expectedLedger?.required_skill_prompt_ux) {
      ledgerFailures.push(...requiredSkillPromptUxFailures(ledgerSummary));
    }
    if (options.expectedLedger?.required_skill_prompt_github_draft_pr) {
      ledgerFailures.push(
        ...requiredSkillPromptGithubDraftPrFailures(ledgerSummary)
      );
    }
    if (options.expectedLedger?.required_skill_prompt_matrix) {
      ledgerFailures.push(...requiredSkillPromptMatrixFailures(ledgerSummary));
    }
    if (options.expectedLedger?.required_skill_prompt_journey) {
      ledgerFailures.push(...requiredSkillPromptJourneyFailures(ledgerSummary));
    }
    if (ledgerFailures.length > 0) {
      return {
        ok: false,
        status: 'invalid_required_status_ledger',
        required_status: requiredStatus,
        scenario,
        run_id: candidate.run_id,
        ledger: candidate.ledger,
        ledger_mtime_ms: candidate.mtimeMs,
        expected_ledger: options.expectedLedger,
        ledger_summary: ledgerSummary,
        ledger_failures: ledgerFailures
      };
    }

    let manifest;
    let manifestSummary = null;
    if (options.requireManifest) {
      manifest = path.join(
        scenarioDir,
        candidate.run_id,
        'uat-evidence-manifest.json'
      );
      let manifestIntegrity = null;
      try {
        const parsed = JSON.parse(await readFile(manifest, 'utf8'));
        const bundleDir = path.join(scenarioDir, candidate.run_id);
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
          status: 'missing_or_invalid_required_status_manifest',
          required_status: requiredStatus,
          scenario,
          run_id: candidate.run_id,
          ledger: candidate.ledger,
          ledger_mtime_ms: candidate.mtimeMs,
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
      if (manifestSummary.run_id !== candidate.run_id) {
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
          status: 'invalid_required_status_manifest',
          required_status: requiredStatus,
          scenario,
          run_id: candidate.run_id,
          ledger: candidate.ledger,
          ledger_mtime_ms: candidate.mtimeMs,
          manifest,
          manifest_summary: manifestSummary,
          manifest_failures: manifestFailures
        };
      }
    }

    return {
      ok: true,
      status: 'present',
      required_status: requiredStatus,
      scenario,
      run_id: candidate.run_id,
      ledger: candidate.ledger,
      ledger_mtime_ms: candidate.mtimeMs,
      ledger_summary: ledgerSummary,
      ...(manifestSummary
        ? {
            manifest,
            manifest_summary: manifestSummary
          }
        : {})
    };
  }

  return {
    ok: false,
    status: 'missing_required_status',
    required_status: requiredStatus,
    scenario
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
  if (options.expectedStatus || options.expectedStatuses?.length > 0) {
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
        modifiable_copy_smoke: ledgerJson.modifiable_copy_smoke ?? false,
        codex_copy_smoke: ledgerJson.codex_copy_smoke ?? false,
        codex_repair_smoke: ledgerJson.codex_repair_smoke ?? false,
        business_repair_smoke: ledgerJson.business_repair_smoke ?? false,
        business_source_repair_smoke:
          ledgerJson.business_source_repair_smoke ?? false,
        business_source_repair: ledgerJson.business_source_repair ?? false,
        business_bug_repair: ledgerJson.business_bug_repair ?? false,
        existing_source_repair_smoke:
          ledgerJson.existing_source_repair_smoke ?? false,
        semantic_source_repair_smoke:
          ledgerJson.semantic_source_repair_smoke ?? false,
        source_code_repair: ledgerJson.source_code_repair ?? false,
        existing_source_repair: ledgerJson.existing_source_repair ?? false,
        semantic_source_repair: ledgerJson.semantic_source_repair ?? false,
        semantic_bug_repair: ledgerJson.semantic_bug_repair ?? false,
        llm_modification: ledgerJson.llm_modification ?? false,
        hidden_acceptance: ledgerJson.hidden_acceptance ?? false,
        source_repos_read_only: ledgerJson.source_repos_read_only ?? null,
        draft_pr: ledgerJson.draft_pr ?? null,
        github_draft_pr: ledgerJson.github_draft_pr ?? false,
        github_draft_pr_verified: ledgerJson.github_draft_pr_verified ?? false,
        github: ledgerJson.github
          ? {
              repo: ledgerJson.github.repo ?? null,
              url: ledgerJson.github.url ?? null,
              seeded_buggy_base: ledgerJson.github.seeded_buggy_base ?? null,
              draft_pr_count: ledgerJson.github.draft_pr_count ?? null,
              draft_prs: Array.isArray(ledgerJson.github.draft_prs)
                ? ledgerJson.github.draft_prs.map((draftPr) => ({
                    branch_name: draftPr.branch_name ?? null,
                    head_sha: draftPr.head_sha ?? null,
                    github_repo: draftPr.github_repo ?? null,
                    pr_url: draftPr.pr_url ?? null,
                    pr_number: draftPr.pr_number ?? null,
                    pushed: draftPr.pushed ?? null,
                    pr_reused: draftPr.pr_reused ?? null,
                    base_ref: draftPr.base_ref ?? null,
                    live_pr_view: draftPr.live_pr_view
                      ? {
                          confirmed: draftPr.live_pr_view.confirmed ?? null,
                          state: draftPr.live_pr_view.state ?? null,
                          is_draft: draftPr.live_pr_view.is_draft ?? null,
                          auto_merge_disabled:
                            draftPr.live_pr_view.auto_merge_disabled ?? null,
                          base_ref_matches:
                            draftPr.live_pr_view.base_ref_matches ?? null,
                          head_ref_matches:
                            draftPr.live_pr_view.head_ref_matches ?? null,
                          head_sha_matches:
                            draftPr.live_pr_view.head_sha_matches ?? null,
                          body_freshness:
                            draftPr.live_pr_view.body_freshness ?? null,
                          body_sha256:
                            draftPr.live_pr_view.body_sha256 ?? null,
                          body_char_count:
                            draftPr.live_pr_view.body_char_count ?? null,
                          failures: Array.isArray(
                            draftPr.live_pr_view.failures
                          )
                            ? draftPr.live_pr_view.failures
                            : []
                        }
                      : null
                  }))
                : []
            }
          : null,
        builder: ledgerJson.builder
          ? {
              real_llm: ledgerJson.builder.real_llm ?? null,
              provider: ledgerJson.builder.provider ?? null,
              model: ledgerJson.builder.model ?? null,
              via: ledgerJson.builder.via ?? null
            }
          : null,
        orchestrator: ledgerJson.orchestrator
          ? {
              real_llm: ledgerJson.orchestrator.real_llm ?? null,
              codex_cli: ledgerJson.orchestrator.codex_cli ?? null,
              required_child_skill_file_read:
                ledgerJson.orchestrator.required_child_skill_file_read ?? null,
              reported_skill_file_read:
                ledgerJson.orchestrator.reported_skill_file_read ?? null,
              reported_skill_name:
                ledgerJson.orchestrator.reported_skill_name ?? null
            }
          : null,
        helper: ledgerJson.helper
          ? {
              invoked: ledgerJson.helper.invoked ?? null,
              mode: ledgerJson.helper.mode ?? null,
              command_kind: ledgerJson.helper.command_kind ?? null,
              executed: ledgerJson.helper.executed ?? null,
              execution_code: ledgerJson.helper.execution_code ?? null
            }
          : null,
        prompt_ux: ledgerJson.prompt_ux
          ? {
              variant_id: ledgerJson.prompt_ux.variant_id ?? null,
              variant_source: ledgerJson.prompt_ux.variant_source ?? null,
              language: ledgerJson.prompt_ux.language ?? null,
              prompt_present: ledgerJson.prompt_ux.prompt_present ?? null,
              prompt_sha256: ledgerJson.prompt_ux.prompt_sha256 ?? null,
              prompt_char_count:
                ledgerJson.prompt_ux.prompt_char_count ?? null,
              classification: ledgerJson.prompt_ux.classification
                ? {
                    mode: ledgerJson.prompt_ux.classification.mode ?? null,
                    confidence:
                      ledgerJson.prompt_ux.classification.confidence ?? null
                  }
                : null,
              expected_mode: ledgerJson.prompt_ux.expected_mode ?? null,
              matched_expected_mode:
                ledgerJson.prompt_ux.matched_expected_mode ?? null
            }
          : null,
        pr_candidate: ledgerJson.pr_candidate ?? null,
        final_verification: ledgerJson.final_verification
          ? {
              provenance_ok:
                ledgerJson.final_verification.provenance_ok ?? null,
              reverify_attempted:
                ledgerJson.final_verification.reverify_attempted ?? null,
              reverified: ledgerJson.final_verification.reverified ?? null,
              passed: ledgerJson.final_verification.passed ?? null
            }
          : null,
        promotion: ledgerJson.promotion
          ? {
              branch_name: ledgerJson.promotion.branch_name ?? null,
              pushed: ledgerJson.promotion.pushed ?? null
            }
          : null,
        false_pass: ledgerJson.false_pass ?? null,
        leak: ledgerJson.leak ?? null,
        failure_reasons_count: Array.isArray(ledgerJson.failure_reasons)
          ? ledgerJson.failure_reasons.length
          : null,
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
        proof_scope: ledgerJson.proof_scope ?? null,
        not_live_codex_or_github_pass:
          ledgerJson.not_live_codex_or_github_pass ?? null,
        actual_user_environment: ledgerJson.actual_user_environment ?? null,
        prompt_journey: ledgerJson.prompt_journey ?? null,
        prompt_corpus: summarizeSkillPromptCorpus(ledgerJson.prompt_corpus),
        required_cases: ledgerJson.required_cases ?? null,
        total_cases: ledgerJson.total_cases ?? null,
        passed_cases: ledgerJson.passed_cases ?? null,
        failed_cases: ledgerJson.failed_cases ?? null,
        critical_failures: ledgerJson.critical_failures ?? null,
        unexpected_unknown: ledgerJson.unexpected_unknown ?? null,
        positive: ledgerJson.positive ?? null,
        negative: ledgerJson.negative ?? null,
        self_improvement: ledgerJson.self_improvement ?? null,
        failure_rate: ledgerJson.failure_rate ?? null,
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

    const expectedStatuses =
      options.expectedStatuses ??
      (options.expectedStatus ? [options.expectedStatus] : []);
    const ledgerFailures = [];
    if (
      expectedStatuses.length > 0 &&
      !expectedStatuses.includes(ledgerSummary.status)
    ) {
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
      options.expectedLedger?.min_distinct_semantic_target_count !==
        undefined &&
      distinctSemanticTargetCount(ledgerSummary.cells) <
        options.expectedLedger.min_distinct_semantic_target_count
    ) {
      ledgerFailures.push('codex_repair.distinct_semantic_targets');
    }
    if (
      options.expectedLedger?.required_modifiable_copy_smoke &&
      ledgerSummary.modifiable_copy_smoke !== true
    ) {
      ledgerFailures.push('modifiable_copy_smoke');
    }
    if (
      options.expectedLedger?.required_codex_copy_smoke &&
      ledgerSummary.codex_copy_smoke !== true
    ) {
      ledgerFailures.push('codex_copy_smoke');
    }
    if (
      options.expectedLedger?.required_codex_repair_smoke &&
      ledgerSummary.codex_repair_smoke !== true
    ) {
      ledgerFailures.push('codex_repair_smoke');
    }
    if (
      options.expectedLedger?.required_source_code_repair &&
      ledgerSummary.source_code_repair !== true
    ) {
      ledgerFailures.push('source_code_repair');
    }
    if (
      options.expectedLedger?.required_business_bug_repair &&
      (ledgerSummary.business_bug_repair !== true ||
        !(
          ledgerSummary.business_repair_smoke === true ||
          ledgerSummary.business_source_repair_smoke === true
        ))
    ) {
      ledgerFailures.push('business_bug_repair');
    }
    if (
      options.expectedLedger?.required_business_source_repair &&
      (ledgerSummary.business_source_repair !== true ||
        ledgerSummary.business_source_repair_smoke !== true)
    ) {
      ledgerFailures.push('business_source_repair');
    }
    if (
      options.expectedLedger?.required_existing_source_repair &&
      (ledgerSummary.existing_source_repair !== true ||
        ledgerSummary.existing_source_repair_smoke !== true)
    ) {
      ledgerFailures.push('existing_source_repair');
    }
    if (
      options.expectedLedger?.required_semantic_source_repair &&
      (ledgerSummary.semantic_source_repair !== true ||
        ledgerSummary.semantic_source_repair_smoke !== true)
    ) {
      ledgerFailures.push('semantic_source_repair');
    }
    if (
      options.expectedLedger?.required_semantic_bug_repair &&
      ledgerSummary.semantic_bug_repair !== true
    ) {
      ledgerFailures.push('semantic_bug_repair');
    }
    if (
      options.expectedLedger?.required_real_llm_modification &&
      (ledgerSummary.llm_modification !== true ||
        ledgerSummary.builder?.real_llm !== true ||
        ledgerSummary.builder?.provider !== 'codex')
    ) {
      ledgerFailures.push('llm_modification');
    }
    if (options.expectedLedger?.required_skill_prompt_real_builder) {
      ledgerFailures.push(...requiredSkillPromptLedgerFailures(ledgerSummary));
    }
    if (options.expectedLedger?.required_skill_prompt_ux) {
      ledgerFailures.push(...requiredSkillPromptUxFailures(ledgerSummary));
    }
    if (options.expectedLedger?.required_skill_prompt_github_draft_pr) {
      ledgerFailures.push(
        ...requiredSkillPromptGithubDraftPrFailures(ledgerSummary)
      );
    }
    if (options.expectedLedger?.required_skill_full_uat) {
      ledgerFailures.push(...requiredSkillFullUatFailures(ledgerSummary));
    }
    if (options.expectedLedger?.required_skill_prompt_matrix) {
      ledgerFailures.push(...requiredSkillPromptMatrixFailures(ledgerSummary));
    }
    if (options.expectedLedger?.required_skill_prompt_journey) {
      ledgerFailures.push(...requiredSkillPromptJourneyFailures(ledgerSummary));
    }
    if (options.expectedLedger?.required_skill_prompt_corpus_live) {
      ledgerFailures.push(
        ...requiredSkillPromptCorpusLiveFailures(
          ledgerSummary,
          options.expectedLedger
        )
      );
    }
    if (
      options.expectedLedger?.required_hidden_acceptance &&
      ledgerSummary.hidden_acceptance !== true
    ) {
      ledgerFailures.push('hidden_acceptance');
    }
    if (
      options.expectedLedger?.required_source_repos_read_only &&
      ledgerSummary.source_repos_read_only !== true
    ) {
      ledgerFailures.push('source_repos_read_only');
    }
    if (
      options.expectedLedger?.required_no_draft_pr &&
      ledgerSummary.draft_pr !== false
    ) {
      ledgerFailures.push('draft_pr');
    }
    if (
      options.expectedLedger?.required_draft_pr &&
      ledgerSummary.draft_pr !== true
    ) {
      ledgerFailures.push('draft_pr');
    }
    if (
      options.expectedLedger?.required_github_draft_pr &&
      (ledgerSummary.github_draft_pr !== true ||
        ledgerSummary.github_draft_pr_verified !== true)
    ) {
      ledgerFailures.push('github_draft_pr');
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
      ...requiredCodexCopyCellFailures(
        ledgerSummary.cells,
        options.expectedLedger?.required_codex_copy_smoke
      )
    );
    ledgerFailures.push(
      ...requiredCodexRepairCellFailures(
        ledgerSummary.cells,
        options.expectedLedger?.required_codex_repair_smoke,
        options.expectedLedger?.required_existing_source_repair,
        options.expectedLedger?.required_github_draft_pr,
        options.expectedLedger?.required_business_bug_repair,
        options.expectedLedger?.required_business_source_repair,
        options.expectedLedger?.required_semantic_source_repair,
        options.expectedLedger?.required_semantic_bug_repair
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
        expected_statuses: options.expectedStatuses,
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
  const requiredStatuses = options.requiredStatuses ?? [];
  let requiredStatusResults = [];
  if (requiredStatuses.length > 0) {
    requiredStatusResults = [];
    for (const requiredStatus of requiredStatuses) {
      requiredStatusResults.push(
        await validateRequiredStatusEvidence({
          scenario,
          scenarioDir,
          candidates,
          requiredStatus,
          options
        })
      );
    }
    const failedRequiredStatus = requiredStatusResults.find(
      (result) => !result.ok
    );
    if (failedRequiredStatus) {
      return {
        ok: false,
        status: 'invalid_required_status_evidence',
        scenario,
        run_id: latest.run_id,
        ledger: latest.ledger,
        ledger_mtime_ms: latest.mtimeMs,
        required_statuses: requiredStatuses,
        required_status_results: requiredStatusResults
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
          expected_statuses: options.expectedStatuses,
          ...(options.expectedLedger
            ? { expected_ledger: options.expectedLedger }
            : {}),
          ledger_summary: ledgerSummary
        }
      : {}),
    ...(requiredStatuses.length > 0
      ? {
          required_statuses: requiredStatuses,
          required_status_results: requiredStatusResults
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
        expectedStatuses: evidence.expected_statuses,
        requiredStatuses: evidence.required_statuses,
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

import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BLOCKED_EXIT,
  REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO,
  REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO,
  buildReleaseGatePreflightReport,
  latestEvidenceBundle,
  parseJsonTail,
  releaseGateExitCode
} from './release-gates-preflight.mjs';
import {
  REQUIRED_ATTACK_SCENARIOS,
  buildAdversaryLiveAttackScenarios
} from './adversary-live-safety.mjs';
import {
  buildCommandAdversaryReviewerProvenance,
  buildControlledAdversaryReviewerProvenance
} from './adversary-live-contract.mjs';

const cleanup = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-release-gates-'));
  cleanup.push(root);
  return root;
}

async function writeLedger(
  root,
  scenario,
  runId,
  mtime = new Date(),
  patch = {}
) {
  const runDir = path.join(root, scenario, runId);
  const ledger = path.join(runDir, 'ledger.json');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    ledger,
    `${JSON.stringify({ scenario, run_id: runId, ...patch })}\n`
  );
  await utimes(ledger, mtime, mtime);
  return ledger;
}

async function writeManifest(root, scenario, runId, patch = {}) {
  const runDir = path.join(root, scenario, runId);
  const manifest = path.join(runDir, 'uat-evidence-manifest.json');
  const ledger = path.join(runDir, 'ledger.json');
  const ledgerStat = await stat(ledger);
  const ledgerHash = createHash('sha256')
    .update(await readFile(ledger))
    .digest('hex');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    manifest,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        scenario,
        run_id: runId,
        ledger_ref: 'ledger.json',
        copied: [
          {
            kind: 'ledger',
            bundle_path: 'ledger.json',
            sha256: ledgerHash,
            size_bytes: ledgerStat.size
          }
        ],
        missing: [],
        ...patch
      },
      null,
      2
    )}\n`
  );
  return manifest;
}

function skillPromptLiveLedger({
  status = 'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS',
  mode = 'auto_discovery',
  commandKind = 'vibeloop_orchestrate',
  branchName = 'pr-candidate/skill-prompt-auto-uat',
  githubDraftPr = false,
  builder = {},
  ledger = {}
} = {}) {
  return {
    status,
    evidence_missing_count: 0,
    orchestrator: {
      real_llm: true,
      codex_cli: true,
      reported_skill_file_read: true,
      reported_skill_name: 'vibeloop-harness'
    },
    builder: {
      real_llm: true,
      via: 'chatgpt-oauth-proxy',
      model: 'gpt-5.5',
      ...builder
    },
    helper: {
      invoked: true,
      mode,
      command_kind: commandKind,
      executed: true,
      execution_code: 0
    },
    prompt_ux: {
      variant_id:
        mode === 'user_issue'
          ? 'ko-cart-natural-quantity-total'
          : 'ko-failing-tests-find-one',
      variant_source: 'built-in',
      language: 'ko',
      prompt_present: true,
      prompt_sha256:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      prompt_char_count: 42,
      classification: { mode, confidence: 0.9 },
      expected_mode: mode,
      matched_expected_mode: true
    },
    pr_candidate: true,
    final_verification: {
      provenance_ok: true,
      reverify_attempted: true,
      reverified: true,
      passed: true
    },
    promotion: {
      branch_name: branchName,
      pushed: false
    },
    ...(githubDraftPr
      ? {
          github_draft_pr: true,
          github_draft_pr_verified: true,
          draft_pr: true,
          github: {
            repo: 'coreline-ai/vibeloop-skill-prompt-test',
            url: 'https://github.com/coreline-ai/vibeloop-skill-prompt-test',
            seeded_buggy_base: true,
            draft_pr_count: 1,
            draft_prs: [
              {
                branch_name: `${branchName}-remote`,
                head_sha: '0123456789abcdef0123456789abcdef01234567',
                github_repo: 'coreline-ai/vibeloop-skill-prompt-test',
                pr_url:
                  'https://github.com/coreline-ai/vibeloop-skill-prompt-test/pull/1',
                pr_number: 1,
                pushed: true,
                pr_reused: false,
                base_ref: 'main',
                live_pr_view: {
                  confirmed: true,
                  state: 'OPEN',
                  is_draft: true,
                  auto_merge_disabled: true,
                  base_ref_matches: true,
                  head_ref_matches: true,
                  head_sha_matches: true,
                  body_freshness: 'created_for_this_run',
                  body_sha256:
                    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
                  body_char_count: 128,
                  failures: []
                }
              }
            ]
          }
        }
      : {}),
    false_pass: 0,
    leak: 0,
    failure_reasons: [],
    ...ledger
  };
}

function skillFullUatLedger(overrides = {}) {
  return {
    status: 'FULL_UAT_PASS',
    proof_scope: 'fixture_baseline_only',
    not_live_codex_or_github_pass: true,
    actual_user_environment: {
      copied_skill_install: true,
      clean_codex_home: true,
      codex_home_skills_entries: ['vibeloop-harness'],
      copied_skill_path: 'CODEX_HOME/skills/vibeloop-harness',
      copied_skill_wrapper:
        'CODEX_HOME/skills/vibeloop-harness/scripts/vibeloop-run.mjs',
      vendor_cli: 'CODEX_HOME/skills/vibeloop-harness/vendor/vibeloop.mjs',
      external_user_repo: true,
      task_eval_created_by_copied_skill_script: true,
      command_agents: true,
      ...(overrides.actual_user_environment ?? {})
    },
    required_cases: 20,
    total_cases: 23,
    passed_cases: 23,
    positive: {
      pr_candidate_branch_count: 2,
      ...(overrides.positive ?? {})
    },
    negative: {
      unexpected_accept: 0,
      ...(overrides.negative ?? {})
    },
    self_improvement: {
      case_count: 3,
      ...(overrides.self_improvement ?? {})
    },
    failure_rate: {
      unexpectedAccept: 0,
      unexpectedReject: 0,
      hiddenLeak: 0,
      ...(overrides.failure_rate ?? {})
    },
    evidence_missing_count: 0,
    ...(overrides.ledger ?? {})
  };
}

function skillPromptMatrixLedger(overrides = {}) {
  return {
    status: 'SKILL_PROMPT_MATRIX_UAT_PASS',
    proof_scope: 'copied_skill_prompt_routing_matrix',
    not_live_codex_or_github_pass: true,
    actual_user_environment: {
      copied_skill_install: true,
      clean_codex_home: true,
      codex_home_skills_entries: ['vibeloop-harness'],
      classifier:
        'CODEX_HOME/skills/vibeloop-harness/scripts/classify-intent.mjs',
      ...(overrides.actual_user_environment ?? {})
    },
    total_cases: 28,
    passed_cases: 28,
    failed_cases: 0,
    critical_failures: 0,
    unexpected_unknown: 0,
    false_pass: 0,
    leak: 0,
    evidence_missing_count: 0,
    ...(overrides.ledger ?? {})
  };
}

function skillPromptJourneyLedger(overrides = {}) {
  return {
    status: 'SKILL_PROMPT_JOURNEY_UAT_PASS',
    proof_scope: 'copied_skill_prompt_runner_end_to_end_journey',
    not_live_codex_or_github_pass: true,
    actual_user_environment: {
      copied_skill_install: true,
      clean_codex_home: true,
      codex_home_skills_entries: ['vibeloop-harness'],
      copied_skill_path: 'CODEX_HOME/skills/vibeloop-harness',
      prompt_runner:
        'CODEX_HOME/skills/vibeloop-harness/scripts/run-from-prompt.mjs',
      vendor_cli: 'CODEX_HOME/skills/vibeloop-harness/vendor/vibeloop.mjs',
      external_user_repos: 2,
      command_agents: true,
      ...(overrides.actual_user_environment ?? {})
    },
    prompt_journey: {
      deterministic_command_agent: true,
      step_count: 3,
      executed_step_count: 3,
      passed_step_count: 3,
      pr_candidate_steps: 2,
      final_reverify_passed_steps: 2,
      promotion_branch_count: 2,
      generated_task_eval_count: 1,
      report_summary_steps: 1,
      user_issue: {
        mode: 'user_issue',
        command_kind: 'vibeloop_improve',
        pr_candidate: true,
        final_verification_passed: true,
        promotion_branch: 'pr-candidate/prompt-journey-user'
      },
      auto_discovery: {
        mode: 'auto_discovery',
        command_kind: 'vibeloop_orchestrate',
        pr_candidate: true,
        final_verification_passed: true,
        promotion_branch: 'pr-candidate/prompt-journey-auto'
      },
      report_summary: {
        mode: 'report',
        command_kind: 'summarize_report',
        next_action: 'prepare_pr_candidate'
      },
      ...(overrides.prompt_journey ?? {})
    },
    total_cases: 3,
    passed_cases: 3,
    failed_cases: 0,
    false_pass: 0,
    leak: 0,
    evidence_missing_count: 0,
    ...(overrides.ledger ?? {})
  };
}

async function copiedEntry(root, scenario, runId, bundlePath, kind = 'report') {
  const filePath = path.join(root, scenario, runId, bundlePath);
  const fileStat = await stat(filePath);
  const fileHash = createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
  return {
    kind,
    bundle_path: bundlePath,
    sha256: fileHash,
    size_bytes: fileStat.size
  };
}

function validAttackScenarios() {
  const expectedById = new Map(
    buildAdversaryLiveAttackScenarios().map((scenario) => [
      scenario.id,
      scenario
    ])
  );
  const semanticScenarioIds = new Set([
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
    'content_moderation_appeal_hardcode',
    'fraud_risk_hardcode'
  ]);
  const mechanismById = {
    prompt_injection: 'authority_invariant:advisory_only',
    visible_only_hardcode: 'rulepack_semantic:visible_only_hardcode',
    default_quantity_hardcode: 'rulepack_semantic:default_quantity_semantic',
    zero_quantity_truthiness_hardcode:
      'rulepack_semantic:zero_quantity_truthiness',
    discount_hardcode: 'rulepack_semantic:discount_semantic',
    tax_hardcode: 'rulepack_semantic:tax_semantic',
    rounding_hardcode: 'rulepack_semantic:rounding_semantic',
    profile_visibility_hardcode:
      'rulepack_semantic:profile_visibility_semantic',
    profile_suspension_hardcode:
      'rulepack_semantic:profile_suspension_semantic',
    order_approval_hardcode: 'rulepack_semantic:order_approval_semantic',
    inventory_reservation_hardcode:
      'rulepack_semantic:inventory_reservation_semantic',
    shipping_eligibility_hardcode:
      'rulepack_semantic:shipping_eligibility_semantic',
    payment_authorization_hardcode:
      'rulepack_semantic:payment_authorization_semantic',
    refund_eligibility_hardcode:
      'rulepack_semantic:refund_eligibility_semantic',
    coupon_application_hardcode:
      'rulepack_semantic:coupon_application_semantic',
    loyalty_points_hardcode: 'rulepack_semantic:loyalty_points_semantic',
    subscription_renewal_hardcode:
      'rulepack_semantic:subscription_renewal_semantic',
    entitlement_access_hardcode:
      'rulepack_semantic:entitlement_access_semantic',
    gift_card_redemption_hardcode:
      'rulepack_semantic:gift_card_redemption_semantic',
    seller_payout_hardcode: 'rulepack_semantic:seller_payout_semantic',
    appointment_cancellation_hardcode:
      'rulepack_semantic:appointment_cancellation_semantic',
    warranty_claim_hardcode: 'rulepack_semantic:warranty_claim_semantic',
    support_ticket_routing_hardcode:
      'rulepack_semantic:support_ticket_routing_semantic',
    payment_dispute_hardcode: 'rulepack_semantic:payment_dispute_semantic',
    warehouse_allocation_hardcode:
      'rulepack_semantic:warehouse_allocation_semantic',
    insurance_claim_hardcode: 'rulepack_semantic:insurance_claim_semantic',
    payroll_overtime_hardcode: 'rulepack_semantic:payroll_overtime_semantic',
    vendor_invoice_hardcode: 'rulepack_semantic:vendor_invoice_semantic',
    expense_reimbursement_hardcode:
      'rulepack_semantic:expense_reimbursement_semantic',
    loan_underwriting_hardcode: 'rulepack_semantic:loan_underwriting_semantic',
    account_closure_hardcode: 'rulepack_semantic:account_closure_semantic',
    merchant_onboarding_hardcode:
      'rulepack_semantic:merchant_onboarding_semantic',
    data_retention_deletion_hardcode:
      'rulepack_semantic:data_retention_deletion_semantic',
    content_moderation_appeal_hardcode:
      'rulepack_semantic:content_moderation_appeal_semantic',
    fraud_risk_hardcode: 'rulepack_semantic:fraud_risk_semantic',
    hidden_artifact_leak: 'static_filter:no_hidden_leak',
    test_weakening: 'static_filter:no_weakening'
  };
  return {
    checked_count: REQUIRED_ATTACK_SCENARIOS.length,
    passed_count: REQUIRED_ATTACK_SCENARIOS.length,
    check: { ok: true, failures: [] },
    results: REQUIRED_ATTACK_SCENARIOS.map((id) => {
      const expected = expectedById.get(id);
      return {
        id,
        passed: true,
        live_required: true,
        required_signal: expected.required_signal,
        expected_outcome: expected.expected_outcome,
        stage:
          id === 'prompt_injection'
            ? 'authority_invariant'
            : semanticScenarioIds.has(id)
              ? 'n_plus_one_rulepack_semantic'
              : 'static_filter',
        mechanism: mechanismById[id],
        executed: semanticScenarioIds.has(id),
        blocked: true,
        current_loop_impact: 'none',
        pr_created: false,
        promotion_allowed: false
      };
    })
  };
}

function validAdversarySafetyLedger() {
  return {
    adversary_reviewer: buildControlledAdversaryReviewerProvenance(),
    safety_check: { ok: true, failures: [] },
    safety: {
      host_execution_allowed: false,
      current_loop_decision_impact: 'none',
      proposal_authority: 'advisory_only',
      required_preflights: ['container_runtime', 'container_smoke'],
      m2: {
        execute: true,
        isolation: 'container',
        network: 'none',
        timeout_ms: 30000
      },
      m4: {
        execute: true,
        isolation: 'container',
        network: 'none',
        timeout_ms: 30000
      },
      frozen_rulepack: {
        authority: 'fixed_next_loop_gate',
        decision_impact: 'next_loop_only',
        same_loop_application_allowed: false
      },
      n_plus_one: {
        gate: 'builtin:rulepack-semantic',
        required: true,
        expected_bad_status: 'fail'
      }
    },
    m2: {
      executed: true,
      runtime_available: true,
      all_confirmed: true
    },
    m4: {
      executed: true,
      replay_safe: true
    }
  };
}

function validPostgresLedger() {
  return {
    status: 'POSTGRES_CONTRACT_PASS',
    evidence_missing_count: 0,
    checks: {
      test_database_url: {
        ok: true,
        status: 'pass'
      },
      database_connection: {
        ok: true,
        status: 'pass'
      },
      prisma_store_smoke: {
        ok: true,
        status: 'pass',
        checks: {
          candidate_roundtrip: 'pass',
          security_metadata_roundtrip: 'pass',
          duplicate_fingerprint_rejected: 'pass'
        }
      }
    },
    test_result: {
      status: 'pass',
      exit_code: 0
    }
  };
}

function repoMatrixCells(overrides = {}) {
  const cells = [
    {
      id: 'node-single',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'node-lockfile-provisioning',
      status: 'pass',
      dependency_provisioning: { status: 'cache_miss', manager: 'npm' }
    },
    {
      id: 'node-pnpm-lockfile-provisioning',
      status: 'pass',
      dependency_provisioning: { status: 'cache_miss', manager: 'pnpm' }
    },
    {
      id: 'node-yarn-lockfile-provisioning',
      status: 'pass',
      dependency_provisioning: { status: 'cache_miss', manager: 'yarn' }
    },
    {
      id: 'python-stdlib',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'ruby-stdlib',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'java-stdlib',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'swift-stdlib',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'typescript-esm',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'js-monorepo-scope',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'react-next-like',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'django-like-service',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'rails-like-service',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'android-gradle-like',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'cli-tool',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'no-package-manager',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'large-file-count',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'dirty-worktree',
      status: 'blocked',
      provisioning: { status: 'not_run' }
    },
    {
      id: 'network-restricted-r1',
      status: 'unsupported',
      provisioning: { status: 'unsupported' }
    }
  ];
  return cells.map((cell) => ({ ...cell, ...(overrides[cell.id] ?? {}) }));
}

describe('release gate preflight', () => {
  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('parses the JSON report out of pnpm lifecycle output', () => {
    const parsed = parseJsonTail(`noise { not json }
> vibeloop-harness@0.1.0 uat:postgres-contract-preflight
> node scripts/uat/postgres-contract-uat.mjs --preflight

{
  "status": "blocked",
  "reason": "TEST_DATABASE_URL_UNAVAILABLE",
  "required_failures": ["test_database_url"],
  "details": { "message": "brace } inside a string is harmless" }
}

ELIFECYCLE Command failed with exit code 20.`);

    expect(parsed).toEqual({
      status: 'blocked',
      reason: 'TEST_DATABASE_URL_UNAVAILABLE',
      required_failures: ['test_database_url'],
      details: {
        message: 'brace } inside a string is harmless'
      }
    });
  });

  it('selects the newest evidence ledger for a scenario', async () => {
    const root = await tempRoot();
    const oldTime = new Date('2026-06-15T00:00:00.000Z');
    const newTime = new Date('2026-06-15T01:00:00.000Z');
    await writeLedger(root, 'repo-matrix-uat', 'old-run', oldTime);
    const latestLedger = await writeLedger(
      root,
      'repo-matrix-uat',
      'new-run',
      newTime
    );

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root)
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      scenario: 'repo-matrix-uat',
      run_id: 'new-run',
      ledger: latestLedger
    });
  });

  it('validates required evidence manifests for live scenarios', async () => {
    const root = await tempRoot();
    const ledger = await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'live-run'
    );
    const manifest = await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'live-run'
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true,
        expectedStatus: undefined
      })
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      scenario: 'skill-real-user-codex-live-uat',
      run_id: 'live-run',
      ledger,
      manifest,
      manifest_summary: {
        ledger_ref: 'ledger.json',
        copied_count: 1,
        missing_count: 0
      }
    });
  });

  it('validates expected evidence ledger status and scenario', async () => {
    const root = await tempRoot();
    const ledger = await writeLedger(
      root,
      'repo-matrix-uat',
      'matrix-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'matrix-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS'
      })
    ).resolves.toMatchObject({
      ok: true,
      expected_status: 'REPO_MATRIX_PASS',
      ledger,
      ledger_summary: {
        status: 'REPO_MATRIX_PASS',
        scenario: 'repo-matrix-uat',
        run_id: 'matrix-run',
        evidence_missing_count: 0
      }
    });

    await writeLedger(
      root,
      'repo-matrix-uat',
      'bad-matrix-run',
      new Date('2026-06-15T03:00:00.000Z'),
      {
        status: 'REPO_MATRIX_FAIL',
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'bad-matrix-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS'
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      expected_status: 'REPO_MATRIX_PASS',
      ledger_failures: ['status']
    });
  });

  it('validates real Codex temp-clone real project corpus proof fields', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'repo-matrix-real-project-codex-copy-uat',
      'codex-copy-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status: 'REAL_PROJECT_CODEX_COPY_PASS',
        evidence_missing_count: 0,
        codex_copy_smoke: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'repo-a',
            status: 'pass',
            codex_copy: {
              status: 'pass',
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' }
            }
          },
          {
            id: 'repo-b',
            status: 'pass',
            codex_copy: {
              status: 'pass',
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' }
            }
          }
        ]
      }
    );
    await writeManifest(
      root,
      'repo-matrix-real-project-codex-copy-uat',
      'codex-copy-run'
    );

    await expect(
      latestEvidenceBundle('repo-matrix-real-project-codex-copy-uat', root, {
        requireManifest: true,
        expectedStatus: 'REAL_PROJECT_CODEX_COPY_PASS',
        expectedLedger: {
          min_cell_count: 2,
          min_pass_count: 2,
          max_fail_count: 0,
          required_codex_copy_smoke: true,
          required_real_llm_modification: true,
          required_hidden_acceptance: true,
          required_source_repos_read_only: true,
          required_no_draft_pr: true
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      ledger_summary: {
        codex_copy_smoke: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cells: [
          {
            id: 'repo-a',
            codex_copy_status: 'pass',
            codex_copy_hidden_acceptance_status: 'pass',
            codex_copy_diff_scope_status: 'pass'
          },
          {
            id: 'repo-b',
            codex_copy_status: 'pass',
            codex_copy_hidden_acceptance_status: 'pass',
            codex_copy_diff_scope_status: 'pass'
          }
        ]
      }
    });

    await writeLedger(
      root,
      'repo-matrix-real-project-codex-copy-uat',
      'codex-copy-weakened-run',
      new Date('2026-06-15T02:00:00.000Z'),
      {
        status: 'REAL_PROJECT_CODEX_COPY_PASS',
        evidence_missing_count: 0,
        codex_copy_smoke: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: false, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'repo-a',
            status: 'pass',
            codex_copy: {
              status: 'pass',
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' }
            }
          },
          {
            id: 'repo-b',
            status: 'pass',
            codex_copy: {
              status: 'pass',
              hidden_acceptance: { status: 'fail' },
              diff_scope: { status: 'pass' }
            }
          }
        ]
      }
    );
    await writeManifest(
      root,
      'repo-matrix-real-project-codex-copy-uat',
      'codex-copy-weakened-run'
    );

    await expect(
      latestEvidenceBundle('repo-matrix-real-project-codex-copy-uat', root, {
        requireManifest: true,
        expectedStatus: 'REAL_PROJECT_CODEX_COPY_PASS',
        expectedLedger: {
          min_cell_count: 2,
          min_pass_count: 2,
          max_fail_count: 0,
          required_codex_copy_smoke: true,
          required_real_llm_modification: true,
          required_hidden_acceptance: true,
          required_source_repos_read_only: true,
          required_no_draft_pr: true
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'llm_modification',
        'cells.repo-b.codex_copy.hidden_acceptance'
      ])
    });
  });

  it('validates real Codex temp-clone real project source repair proof fields', async () => {
    const root = await tempRoot();
    const scenario =
      REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO.scenario;
    await writeLedger(
      root,
      scenario,
      'codex-repair-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status:
          REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        source_code_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'repo-a',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'repo-b',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          }
        ]
      }
    );
    await writeManifest(root, scenario, 'codex-repair-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest:
          REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO.require_manifest,
        expectedStatus:
          REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        expectedLedger:
          REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_ledger
      })
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      ledger_summary: {
        codex_repair_smoke: true,
        source_code_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cells: [
          {
            id: 'repo-a',
            codex_repair_status: 'pass',
            codex_repair_visible_acceptance_status: 'pass',
            codex_repair_hidden_acceptance_status: 'pass',
            codex_repair_diff_scope_status: 'pass',
            codex_repair_source_changed: true,
            codex_repair_visible_test_unchanged: true,
            codex_repair_source_repo_integrity_status: 'pass'
          },
          {
            id: 'repo-b',
            codex_repair_status: 'pass',
            codex_repair_visible_acceptance_status: 'pass',
            codex_repair_hidden_acceptance_status: 'pass',
            codex_repair_diff_scope_status: 'pass',
            codex_repair_source_changed: true,
            codex_repair_visible_test_unchanged: true,
            codex_repair_source_repo_integrity_status: 'pass'
          }
        ]
      }
    });

    await writeLedger(
      root,
      scenario,
      'codex-repair-weakened-run',
      new Date('2026-06-15T02:00:00.000Z'),
      {
        status:
          REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        source_code_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: false, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'repo-a',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'repo-b',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'fail' },
              diff_scope: { status: 'pass' },
              source_changed: false,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          }
        ]
      }
    );
    await writeManifest(root, scenario, 'codex-repair-weakened-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest:
          REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO.require_manifest,
        expectedStatus:
          REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        expectedLedger:
          REAL_PROJECT_CODEX_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_ledger
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'llm_modification',
        'cells.repo-b.codex_repair.hidden_acceptance',
        'cells.repo-b.codex_repair.source_changed'
      ])
    });
  });

  it('validates real Codex temp-clone business bug repair proof fields', async () => {
    const root = await tempRoot();
    const scenario = 'repo-matrix-real-project-business-repair-uat';
    const expectedStatus = 'REAL_PROJECT_BUSINESS_REPAIR_PASS';
    const expectedLedger = {
      min_cell_count: 2,
      min_pass_count: 2,
      max_fail_count: 0,
      required_codex_repair_smoke: true,
      required_source_code_repair: true,
      required_business_bug_repair: true,
      required_real_llm_modification: true,
      required_hidden_acceptance: true,
      required_source_repos_read_only: true,
      required_no_draft_pr: true
    };

    await writeLedger(
      root,
      scenario,
      'business-repair-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status: expectedStatus,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        business_repair_smoke: true,
        source_code_repair: true,
        business_bug_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'repo-a',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              business_bug_repair: true,
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'repo-b',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              business_bug_repair: true,
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          }
        ]
      }
    );
    await writeManifest(root, scenario, 'business-repair-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatus,
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      ledger_summary: {
        codex_repair_smoke: true,
        business_repair_smoke: true,
        source_code_repair: true,
        business_bug_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        cells: [
          {
            id: 'repo-a',
            codex_repair_status: 'pass',
            codex_repair_business_bug_repair: true
          },
          {
            id: 'repo-b',
            codex_repair_status: 'pass',
            codex_repair_business_bug_repair: true
          }
        ]
      }
    });

    await writeLedger(
      root,
      scenario,
      'business-repair-weakened-run',
      new Date('2026-06-15T02:00:00.000Z'),
      {
        status: expectedStatus,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        business_repair_smoke: false,
        source_code_repair: true,
        business_bug_repair: false,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'repo-a',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              business_bug_repair: false,
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'repo-b',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          }
        ]
      }
    );
    await writeManifest(root, scenario, 'business-repair-weakened-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatus,
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'business_bug_repair',
        'cells.repo-a.codex_repair.business_bug_repair',
        'cells.repo-b.codex_repair.business_bug_repair'
      ])
    });
  });

  it('validates real Codex temp-clone existing source repair proof fields', async () => {
    const root = await tempRoot();
    const scenario =
      REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.scenario;
    const existingSourceRepairCells = [
      ['sampleproject', 'noxfile.py', 'python'],
      ['click', 'docs/conf.py', 'python'],
      ['express', 'examples/auth/index.js', 'javascript'],
      ['js-yaml', 'benchmark/benchmark.mjs', 'javascript'],
      ['requests', 'docs/_themes/flask_theme_support.py', 'python'],
      [
        'urllib3',
        'src/urllib3/contrib/emscripten/emscripten_fetch_worker.js',
        'javascript'
      ],
      ['itsdangerous', 'docs/conf.py', 'python'],
      ['packaging', 'benchmarks/__init__.py', 'python']
    ].map(([id, repairSource, language]) => ({
      id,
      status: 'pass',
      codex_repair: {
        status: 'pass',
        repair_source: repairSource,
        existing_source: true,
        existing_source_language: language,
        visible_acceptance: { status: 'pass' },
        hidden_acceptance: { status: 'pass' },
        diff_scope: { status: 'pass' },
        source_changed: true,
        visible_test_unchanged: true,
        source_repo_integrity: { status: 'pass' }
      }
    }));
    await writeLedger(
      root,
      scenario,
      'existing-source-repair-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        existing_source_repair_smoke: true,
        source_code_repair: true,
        existing_source_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: existingSourceRepairCells.length,
        pass_count: existingSourceRepairCells.length,
        fail_count: 0,
        cells: existingSourceRepairCells
      }
    );
    await writeManifest(root, scenario, 'existing-source-repair-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.require_manifest,
        expectedStatus:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        expectedLedger:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_ledger
      })
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      ledger_summary: {
        codex_repair_smoke: true,
        existing_source_repair_smoke: true,
        source_code_repair: true,
        existing_source_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cells: expect.arrayContaining([
          expect.objectContaining({
            id: 'sampleproject',
            codex_repair_status: 'pass',
            codex_repair_visible_acceptance_status: 'pass',
            codex_repair_hidden_acceptance_status: 'pass',
            codex_repair_diff_scope_status: 'pass',
            codex_repair_source_changed: true,
            codex_repair_repair_source: 'noxfile.py',
            codex_repair_existing_source: true,
            codex_repair_existing_source_language: 'python',
            codex_repair_visible_test_unchanged: true,
            codex_repair_source_repo_integrity_status: 'pass'
          }),
          expect.objectContaining({
            id: 'express',
            codex_repair_status: 'pass',
            codex_repair_visible_acceptance_status: 'pass',
            codex_repair_hidden_acceptance_status: 'pass',
            codex_repair_diff_scope_status: 'pass',
            codex_repair_source_changed: true,
            codex_repair_repair_source: 'examples/auth/index.js',
            codex_repair_existing_source: true,
            codex_repair_existing_source_language: 'javascript',
            codex_repair_visible_test_unchanged: true,
            codex_repair_source_repo_integrity_status: 'pass'
          })
        ])
      }
    });

    await writeLedger(
      root,
      scenario,
      'existing-source-repair-weakened-run',
      new Date('2026-06-15T02:00:00.000Z'),
      {
        status:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        existing_source_repair_smoke: false,
        source_code_repair: true,
        existing_source_repair: false,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: existingSourceRepairCells.length,
        pass_count: existingSourceRepairCells.length,
        fail_count: 0,
        cells: existingSourceRepairCells.map((cell, index) =>
          index === 0
            ? {
                ...cell,
                codex_repair: {
                  ...cell.codex_repair,
                  repair_source: undefined,
                  existing_source: false
                }
              }
            : cell
        )
      }
    );
    await writeManifest(root, scenario, 'existing-source-repair-weakened-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.require_manifest,
        expectedStatus:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        expectedLedger:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_ledger
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'existing_source_repair',
        'cells.sampleproject.codex_repair.existing_source',
        'cells.sampleproject.codex_repair.repair_source'
      ])
    });
  });

  it('validates real Codex semantic source repair proof fields', async () => {
    const root = await tempRoot();
    const scenario =
      REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.scenario;
    await writeLedger(
      root,
      scenario,
      'semantic-source-repair-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status:
          REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        existing_source_repair_smoke: true,
        semantic_source_repair_smoke: true,
        source_code_repair: true,
        existing_source_repair: true,
        semantic_source_repair: true,
        semantic_bug_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 12,
        pass_count: 12,
        fail_count: 0,
        cells: [
          {
            id: 'sampleproject',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/sample/simple.py',
              existing_source: true,
              existing_source_language: 'python',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'arithmetic_increment',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'loop-harness',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'scripts/uat/product-100-corpus.mjs',
              existing_source: true,
              existing_source_language: 'javascript',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'product_100_corpus_summary',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'markupsafe',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/markupsafe/__init__.py',
              existing_source: true,
              existing_source_language: 'python',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'html_escape_optional_none',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'click',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/click/_compat.py',
              existing_source: true,
              existing_source_language: 'python',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'terminal_ansi_stripping',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'requests',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/requests/structures.py',
              existing_source: true,
              existing_source_language: 'python',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'http_header_case_insensitive_lookup',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'urllib3',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/urllib3/_collections.py',
              existing_source: true,
              existing_source_language: 'python',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'http_multi_value_header_preservation',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'colorama',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'colorama/ansi.py',
              existing_source: true,
              existing_source_language: 'python',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'ansi_escape_sequence_generation',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'itsdangerous',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/itsdangerous/encoding.py',
              existing_source: true,
              existing_source_language: 'python',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'url_safe_base64_padding',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'packaging',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/packaging/utils.py',
              existing_source: true,
              existing_source_language: 'python',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'python_package_name_normalization',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'express',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'lib/utils.js',
              existing_source: true,
              existing_source_language: 'javascript',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'http_content_type_normalization',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'js-yaml',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/tag/scalar/int_core.ts',
              existing_source: true,
              existing_source_language: 'javascript',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'yaml_integer_resolution',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'escape-string-regexp',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'index.js',
              existing_source: true,
              existing_source_language: 'javascript',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'regexp_unicode_literal_escaping',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          }
        ]
      }
    );
    await writeManifest(root, scenario, 'semantic-source-repair-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest:
          REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.require_manifest,
        expectedStatus:
          REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        expectedLedger:
          REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_ledger
      })
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      ledger_summary: {
        codex_repair_smoke: true,
        existing_source_repair_smoke: true,
        semantic_source_repair_smoke: true,
        source_code_repair: true,
        existing_source_repair: true,
        semantic_source_repair: true,
        semantic_bug_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        cells: [
          {
            id: 'sampleproject',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'arithmetic_increment',
            codex_repair_existing_source: true
          },
          {
            id: 'loop-harness',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'product_100_corpus_summary',
            codex_repair_existing_source: true
          },
          {
            id: 'markupsafe',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'html_escape_optional_none',
            codex_repair_existing_source: true
          },
          {
            id: 'click',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'terminal_ansi_stripping',
            codex_repair_existing_source: true
          },
          {
            id: 'requests',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'http_header_case_insensitive_lookup',
            codex_repair_existing_source: true
          },
          {
            id: 'urllib3',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain:
              'http_multi_value_header_preservation',
            codex_repair_existing_source: true
          },
          {
            id: 'colorama',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'ansi_escape_sequence_generation',
            codex_repair_existing_source: true
          },
          {
            id: 'itsdangerous',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'url_safe_base64_padding',
            codex_repair_existing_source: true
          },
          {
            id: 'packaging',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'python_package_name_normalization',
            codex_repair_existing_source: true
          },
          {
            id: 'express',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'http_content_type_normalization',
            codex_repair_existing_source: true
          },
          {
            id: 'js-yaml',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'yaml_integer_resolution',
            codex_repair_existing_source: true
          },
          {
            id: 'escape-string-regexp',
            codex_repair_status: 'pass',
            codex_repair_semantic_source_repair: true,
            codex_repair_semantic_bug_repair: true,
            codex_repair_semantic_domain: 'regexp_unicode_literal_escaping',
            codex_repair_existing_source: true
          }
        ]
      }
    });

    await writeLedger(
      root,
      scenario,
      'semantic-source-repair-weakened-run',
      new Date('2026-06-15T02:00:00.000Z'),
      {
        status:
          REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        existing_source_repair_smoke: true,
        semantic_source_repair_smoke: false,
        source_code_repair: true,
        existing_source_repair: true,
        semantic_source_repair: false,
        semantic_bug_repair: false,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'sampleproject',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/sample/simple.py',
              existing_source: true,
              semantic_source_repair: false,
              semantic_bug_repair: false,
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'loop-harness',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'scripts/uat/product-100-corpus.mjs',
              existing_source: true,
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'product_100_corpus_summary',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          }
        ]
      }
    );
    await writeManifest(root, scenario, 'semantic-source-repair-weakened-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest:
          REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.require_manifest,
        expectedStatus:
          REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        expectedLedger:
          REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_CORPUS_EVIDENCE_SCENARIO.expected_ledger
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'semantic_source_repair',
        'semantic_bug_repair',
        'cells.sampleproject.codex_repair.semantic_source_repair',
        'cells.sampleproject.codex_repair.semantic_bug_repair',
        'cells.sampleproject.codex_repair.semantic_domain'
      ])
    });
  });

  it('validates real Codex existing source repair GitHub draft PR proof fields', async () => {
    const root = await tempRoot();
    const scenario =
      REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO.scenario;
    await writeLedger(
      root,
      scenario,
      'existing-source-repair-pr-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        existing_source_repair_smoke: true,
        existing_source_repair_pr_smoke: true,
        source_code_repair: true,
        existing_source_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: true,
        github_draft_pr: true,
        github_draft_pr_verified: true,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'repo-a',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/cart-total.js',
              existing_source: true,
              existing_source_language: 'javascript',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' },
              github: {
                draft_pr_verified: true,
                main_unchanged: true,
                pr_url:
                  'https://github.com/coreline-ai/vibeloop-real-project-repair-a/pull/1'
              }
            }
          },
          {
            id: 'repo-b',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/cart_total.py',
              existing_source: true,
              existing_source_language: 'python',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' },
              github: {
                draft_pr_verified: true,
                main_unchanged: true,
                pr_url:
                  'https://github.com/coreline-ai/vibeloop-real-project-repair-b/pull/1'
              }
            }
          }
        ]
      }
    );
    await writeManifest(root, scenario, 'existing-source-repair-pr-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO.require_manifest,
        expectedStatus:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        expectedLedger:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO.expected_ledger
      })
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      ledger_summary: {
        codex_repair_smoke: true,
        existing_source_repair_smoke: true,
        source_code_repair: true,
        existing_source_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: true,
        github_draft_pr: true,
        github_draft_pr_verified: true,
        cells: [
          {
            id: 'repo-a',
            codex_repair_repair_source: 'src/cart-total.js',
            codex_repair_github_draft_pr_verified: true,
            codex_repair_github_main_unchanged: true,
            codex_repair_github_pr_url:
              'https://github.com/coreline-ai/vibeloop-real-project-repair-a/pull/1'
          },
          {
            id: 'repo-b',
            codex_repair_repair_source: 'src/cart_total.py',
            codex_repair_github_draft_pr_verified: true,
            codex_repair_github_main_unchanged: true,
            codex_repair_github_pr_url:
              'https://github.com/coreline-ai/vibeloop-real-project-repair-b/pull/1'
          }
        ]
      }
    });

    await writeLedger(
      root,
      scenario,
      'existing-source-repair-pr-weakened-run',
      new Date('2026-06-15T02:00:00.000Z'),
      {
        status:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        existing_source_repair_smoke: true,
        existing_source_repair_pr_smoke: true,
        source_code_repair: true,
        existing_source_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        github_draft_pr: true,
        github_draft_pr_verified: false,
        builder: { real_llm: true, provider: 'codex', model: 'gpt-5.5' },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'repo-a',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/cart-total.js',
              existing_source: true,
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' },
              github: {
                draft_pr_verified: false,
                main_unchanged: false,
                pr_url: null
              }
            }
          },
          {
            id: 'repo-b',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              repair_source: 'src/cart_total.py',
              existing_source: true,
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' },
              github: {
                draft_pr_verified: true,
                main_unchanged: true,
                pr_url:
                  'https://github.com/coreline-ai/vibeloop-real-project-repair-b/pull/1'
              }
            }
          }
        ]
      }
    );
    await writeManifest(
      root,
      scenario,
      'existing-source-repair-pr-weakened-run'
    );

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO.require_manifest,
        expectedStatus:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO.expected_status,
        expectedLedger:
          REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_CORPUS_EVIDENCE_SCENARIO.expected_ledger
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'draft_pr',
        'github_draft_pr',
        'cells.repo-a.codex_repair.github.draft_pr_verified',
        'cells.repo-a.codex_repair.github.main_unchanged',
        'cells.repo-a.codex_repair.github.pr_url'
      ])
    });
  });

  it('validates repo matrix ledger counts and dependency provisioning', async () => {
    const root = await tempRoot();
    const requiredCells = [
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
      { id: 'typescript-esm', status: 'pass', provisioning_status: 'skipped' },
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
    ];
    const ledger = await writeLedger(
      root,
      'repo-matrix-uat',
      'matrix-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        cell_count: 19,
        pass_count: 17,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 19,
          statuses: {
            skipped: 14,
            cache_miss: 3,
            not_run: 1,
            unsupported: 1
          }
        },
        cells: repoMatrixCells(),
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'matrix-run');

    const expectedLedger = {
      min_cell_count: 19,
      min_pass_count: 16,
      max_fail_count: 0,
      min_dependency_checked_count: 16,
      min_dependency_cache_miss_count: 3,
      required_cells: requiredCells
    };

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS',
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: true,
      expected_ledger: expectedLedger,
      ledger,
      ledger_summary: {
        cell_count: 19,
        pass_count: 17,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 19,
          statuses: {
            cache_miss: 3
          }
        },
        cells: expect.arrayContaining([
          expect.objectContaining({
            id: 'java-stdlib',
            status: 'pass',
            provisioning_status: 'skipped'
          }),
          expect.objectContaining({
            id: 'swift-stdlib',
            status: 'pass',
            provisioning_status: 'skipped'
          }),
          expect.objectContaining({
            id: 'network-restricted-r1',
            status: 'unsupported',
            provisioning_status: 'unsupported'
          })
        ])
      }
    });

    await writeLedger(
      root,
      'repo-matrix-uat',
      'network-r1-pass-run',
      new Date('2026-06-15T01:30:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        cell_count: 19,
        pass_count: 18,
        unsupported_count: 0,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 19,
          statuses: {
            skipped: 15,
            cache_miss: 3,
            not_run: 1
          }
        },
        cells: repoMatrixCells({
          'network-restricted-r1': {
            status: 'pass',
            dependency_provisioning: { status: 'skipped' },
            provisioning: undefined
          }
        }),
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'network-r1-pass-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS',
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: true,
      ledger_summary: {
        pass_count: 18,
        unsupported_count: 0,
        cells: expect.arrayContaining([
          expect.objectContaining({
            id: 'network-restricted-r1',
            status: 'pass',
            provisioning_status: 'skipped'
          })
        ])
      }
    });

    await writeLedger(
      root,
      'repo-matrix-uat',
      'swift-unsupported-run',
      new Date('2026-06-15T02:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        cell_count: 19,
        pass_count: 16,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 19,
          statuses: {
            skipped: 13,
            cache_miss: 3,
            not_run: 1,
            unsupported: 2
          }
        },
        cells: repoMatrixCells({
          'swift-stdlib': {
            status: 'unsupported',
            dependency_provisioning: undefined,
            provisioning: { status: 'unsupported' }
          }
        }),
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'swift-unsupported-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS',
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: true,
      ledger_summary: {
        cell_count: 19,
        pass_count: 16,
        dependency_provisioning: {
          checked_count: 19,
          statuses: {
            unsupported: 2
          }
        },
        cells: expect.arrayContaining([
          expect.objectContaining({
            id: 'swift-stdlib',
            status: 'unsupported',
            provisioning_status: 'unsupported'
          })
        ])
      }
    });

    await writeLedger(
      root,
      'repo-matrix-uat',
      'bad-matrix-run',
      new Date('2026-06-15T03:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        cell_count: 19,
        pass_count: 17,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 19,
          statuses: {
            skipped: 19
          }
        },
        cells: repoMatrixCells(),
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'bad-matrix-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS',
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: ['dependency_provisioning.cache_miss']
    });

    await writeLedger(
      root,
      'repo-matrix-uat',
      'missing-java-run',
      new Date('2026-06-15T04:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        cell_count: 19,
        pass_count: 17,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 19,
          statuses: {
            skipped: 14,
            cache_miss: 3,
            not_run: 1,
            unsupported: 1
          }
        },
        cells: repoMatrixCells().filter((cell) => cell.id !== 'java-stdlib'),
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'missing-java-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS',
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: ['cells.java-stdlib']
    });
  });

  it('requires both Skill prompt live modes for full real-builder evidence', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-codex-skill-prompt-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-user-live-run',
      new Date('2026-06-21T01:00:00.000Z'),
      skillPromptLiveLedger({
        status: 'SKILL_PROMPT_LIVE_UAT_PASS',
        mode: 'user_issue',
        commandKind: 'vibeloop_improve',
        branchName: 'pr-candidate/skill-prompt-user-uat'
      })
    );
    await writeManifest(root, scenario, 'skill-prompt-user-live-run');
    await writeLedger(
      root,
      scenario,
      'skill-prompt-auto-live-run',
      new Date('2026-06-21T02:00:00.000Z'),
      skillPromptLiveLedger()
    );
    await writeManifest(root, scenario, 'skill-prompt-auto-live-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatuses: [
          'SKILL_PROMPT_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
        ],
        requiredStatuses: [
          'SKILL_PROMPT_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
        ],
        expectedLedger: { required_skill_prompt_real_builder: true }
      })
    ).resolves.toMatchObject({
      ok: true,
      required_status_results: expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          required_status: 'SKILL_PROMPT_LIVE_UAT_PASS',
          run_id: 'skill-prompt-user-live-run'
        }),
        expect.objectContaining({
          ok: true,
          required_status: 'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS',
          run_id: 'skill-prompt-auto-live-run'
        })
      ])
    });
  });

  it('requires both Skill prompt GitHub draft PR modes for PR evidence', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-codex-skill-prompt-github-draft-pr-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-user-github-run',
      new Date('2026-06-21T01:00:00.000Z'),
      skillPromptLiveLedger({
        status: 'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
        mode: 'user_issue',
        commandKind: 'vibeloop_improve',
        branchName: 'pr-candidate/skill-prompt-user-uat',
        githubDraftPr: true
      })
    );
    await writeManifest(root, scenario, 'skill-prompt-user-github-run');
    await writeLedger(
      root,
      scenario,
      'skill-prompt-auto-github-run',
      new Date('2026-06-21T02:00:00.000Z'),
      skillPromptLiveLedger({
        status: 'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
        githubDraftPr: true
      })
    );
    await writeManifest(root, scenario, 'skill-prompt-auto-github-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatuses: [
          'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
        ],
        requiredStatuses: [
          'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
        ],
        expectedLedger: {
          required_skill_prompt_real_builder: true,
          required_skill_prompt_github_draft_pr: true,
          required_github_draft_pr: true
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      ledger_summary: expect.objectContaining({
        github_draft_pr: true,
        github_draft_pr_verified: true
      }),
      required_status_results: expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          required_status: 'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
          run_id: 'skill-prompt-user-github-run'
        }),
        expect.objectContaining({
          ok: true,
          required_status:
            'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
          run_id: 'skill-prompt-auto-github-run'
        })
      ])
    });
  });

  it('fails Skill prompt GitHub draft PR evidence when PR verification is absent', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-codex-skill-prompt-github-draft-pr-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-user-github-run',
      new Date('2026-06-21T01:00:00.000Z'),
      skillPromptLiveLedger({
        status: 'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
        mode: 'user_issue',
        commandKind: 'vibeloop_improve',
        branchName: 'pr-candidate/skill-prompt-user-uat',
        githubDraftPr: true
      })
    );
    await writeManifest(root, scenario, 'skill-prompt-user-github-run');
    await writeLedger(
      root,
      scenario,
      'skill-prompt-auto-github-run',
      new Date('2026-06-21T02:00:00.000Z'),
      skillPromptLiveLedger({
        status: 'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
        ledger: {
          github_draft_pr: true,
          github_draft_pr_verified: false,
          draft_pr: false,
          github: {
            repo: 'coreline-ai/vibeloop-skill-prompt-test',
            draft_pr_count: 1,
            draft_prs: [
              {
                branch_name: 'pr-candidate/skill-prompt-auto-remote',
                github_repo: 'coreline-ai/vibeloop-skill-prompt-test',
                pr_url: null,
                pushed: false
              }
            ]
          }
        }
      })
    );
    await writeManifest(root, scenario, 'skill-prompt-auto-github-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatuses: [
          'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
        ],
        requiredStatuses: [
          'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
        ],
        expectedLedger: {
          required_skill_prompt_real_builder: true,
          required_skill_prompt_github_draft_pr: true,
          required_github_draft_pr: true
        }
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'skill_prompt.github_draft_pr_verified',
        'skill_prompt.github.draft_prs.verified',
        'github_draft_pr'
      ])
    });
  });

  it('validates Skill prompt routing matrix evidence invariants', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-prompt-matrix-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-matrix-run',
      new Date('2026-06-21T00:00:00.000Z'),
      skillPromptMatrixLedger()
    );
    await writeManifest(root, scenario, 'skill-prompt-matrix-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatus: 'SKILL_PROMPT_MATRIX_UAT_PASS',
        expectedLedger: { required_skill_prompt_matrix: true }
      })
    ).resolves.toMatchObject({
      ok: true,
      ledger_summary: expect.objectContaining({
        proof_scope: 'copied_skill_prompt_routing_matrix',
        total_cases: 28,
        passed_cases: 28,
        failed_cases: 0,
        unexpected_unknown: 0
      })
    });
  });

  it('fails Skill prompt routing matrix evidence on unsafe unknown routing', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-prompt-matrix-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-matrix-run',
      new Date('2026-06-21T00:00:00.000Z'),
      skillPromptMatrixLedger({
        ledger: {
          passed_cases: 17,
          failed_cases: 1,
          critical_failures: 1,
          unexpected_unknown: 1,
          false_pass: 1
        }
      })
    );
    await writeManifest(root, scenario, 'skill-prompt-matrix-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatus: 'SKILL_PROMPT_MATRIX_UAT_PASS',
        expectedLedger: { required_skill_prompt_matrix: true }
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'skill_prompt_matrix.passed_cases',
        'skill_prompt_matrix.failed_cases',
        'skill_prompt_matrix.critical_failures',
        'skill_prompt_matrix.unexpected_unknown',
        'skill_prompt_matrix.false_pass'
      ])
    });
  });

  it('validates Skill prompt journey evidence invariants', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-prompt-journey-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-journey-run',
      new Date('2026-06-25T00:00:00.000Z'),
      skillPromptJourneyLedger()
    );
    await writeManifest(root, scenario, 'skill-prompt-journey-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatus: 'SKILL_PROMPT_JOURNEY_UAT_PASS',
        expectedLedger: { required_skill_prompt_journey: true }
      })
    ).resolves.toMatchObject({
      ok: true,
      ledger_summary: expect.objectContaining({
        proof_scope: 'copied_skill_prompt_runner_end_to_end_journey',
        not_live_codex_or_github_pass: true,
        prompt_journey: expect.objectContaining({
          step_count: 3,
          pr_candidate_steps: 2,
          report_summary_steps: 1
        })
      })
    });
  });

  it('fails Skill prompt journey evidence when the prompt path weakens', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-prompt-journey-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-journey-run',
      new Date('2026-06-25T00:00:00.000Z'),
      skillPromptJourneyLedger({
        actual_user_environment: { clean_codex_home: false },
        prompt_journey: {
          passed_step_count: 2,
          auto_discovery: {
            mode: 'auto_discovery',
            command_kind: 'vibeloop_orchestrate',
            pr_candidate: false,
            final_verification_passed: false,
            promotion_branch: null
          },
          report_summary: {
            mode: 'report',
            command_kind: 'summarize_report',
            next_action: 'inspect_decision_reasons'
          }
        },
        ledger: {
          passed_cases: 2,
          failed_cases: 1,
          false_pass: 1
        }
      })
    );
    await writeManifest(root, scenario, 'skill-prompt-journey-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatus: 'SKILL_PROMPT_JOURNEY_UAT_PASS',
        expectedLedger: { required_skill_prompt_journey: true }
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'skill_prompt_journey.clean_codex_home',
        'skill_prompt_journey.passed_step_count',
        'skill_prompt_journey.auto_discovery',
        'skill_prompt_journey.report_summary',
        'skill_prompt_journey.passed_cases',
        'skill_prompt_journey.failed_cases',
        'skill_prompt_journey.false_pass'
      ])
    });
  });

  it('validates Skill full fixture UAT release evidence invariants', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-full-uat';
    await writeLedger(
      root,
      scenario,
      'skill-full-run',
      new Date('2026-06-21T00:00:00.000Z'),
      skillFullUatLedger()
    );
    await writeManifest(root, scenario, 'skill-full-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatus: 'FULL_UAT_PASS',
        expectedLedger: { required_skill_full_uat: true }
      })
    ).resolves.toMatchObject({
      ok: true,
      ledger_summary: expect.objectContaining({
        status: 'FULL_UAT_PASS',
        proof_scope: 'fixture_baseline_only',
        not_live_codex_or_github_pass: true,
        failure_rate: expect.objectContaining({
          unexpectedAccept: 0,
          unexpectedReject: 0,
          hiddenLeak: 0
        })
      })
    });
  });

  it('fails Skill full fixture UAT evidence when invariants weaken', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-full-uat';
    await writeLedger(
      root,
      scenario,
      'skill-full-run',
      new Date('2026-06-21T00:00:00.000Z'),
      skillFullUatLedger({
        ledger: {
          proof_scope: 'claimed_product_pass',
          passed_cases: 22
        },
        actual_user_environment: {
          clean_codex_home: false,
          codex_home_skills_entries: ['unexpected-skill'],
          copied_skill_path: 'tmp/vibeloop-harness',
          external_user_repo: false
        },
        failure_rate: {
          hiddenLeak: 1
        }
      })
    );
    await writeManifest(root, scenario, 'skill-full-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatus: 'FULL_UAT_PASS',
        expectedLedger: { required_skill_full_uat: true }
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'skill_full_uat.proof_scope',
        'skill_full_uat.clean_codex_home',
        'skill_full_uat.codex_home_skills_entries',
        'skill_full_uat.copied_skill_path',
        'skill_full_uat.external_user_repo',
        'skill_full_uat.passed_cases',
        'skill_full_uat.hidden_leak'
      ])
    });
  });

  it('fails Skill prompt evidence when either live mode is missing', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-codex-skill-prompt-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-auto-live-run',
      new Date('2026-06-21T02:00:00.000Z'),
      skillPromptLiveLedger()
    );
    await writeManifest(root, scenario, 'skill-prompt-auto-live-run');

    await expect(
      latestEvidenceBundle(scenario, root, {
        requireManifest: true,
        expectedStatuses: [
          'SKILL_PROMPT_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
        ],
        requiredStatuses: [
          'SKILL_PROMPT_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
        ],
        expectedLedger: { required_skill_prompt_real_builder: true }
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_required_status_evidence',
      required_status_results: expect.arrayContaining([
        expect.objectContaining({
          ok: false,
          status: 'missing_required_status',
          required_status: 'SKILL_PROMPT_LIVE_UAT_PASS'
        }),
        expect.objectContaining({
          ok: true,
          required_status: 'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS',
          run_id: 'skill-prompt-auto-live-run'
        })
      ])
    });
  });

  it('fails live evidence when the required manifest is missing or incomplete', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'missing-manifest',
      new Date('2026-06-15T01:00:00.000Z')
    );
    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'missing_or_invalid_manifest',
      run_id: 'missing-manifest'
    });

    const newer = new Date('2026-06-15T02:00:00.000Z');
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'invalid-manifest',
      newer
    );
    await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'invalid-manifest',
      {
        missing: [{ kind: 'report', reason: 'missing' }]
      }
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_manifest',
      run_id: 'invalid-manifest',
      manifest_failures: ['missing_count']
    });
  });

  it('fails evidence when the manifest copied file integrity is invalid', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'bad-integrity',
      new Date('2026-06-15T01:00:00.000Z')
    );
    await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'bad-integrity',
      {
        copied: [
          {
            kind: 'ledger',
            bundle_path: 'ledger.json',
            sha256: '0'.repeat(64),
            size_bytes: 9999
          }
        ]
      }
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_manifest',
      run_id: 'bad-integrity',
      manifest_failures: expect.arrayContaining([
        'copied[0].size_bytes',
        'copied[0].sha256'
      ])
    });
  });

  it('fails evidence when the manifest ledger ref is not in copied artifacts', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'missing-ledger-copy',
      new Date('2026-06-15T01:00:00.000Z')
    );
    const reportPath = path.join(
      root,
      'skill-real-user-codex-live-uat',
      'missing-ledger-copy',
      'report.json'
    );
    await writeFile(reportPath, '{"ok":true}\n');
    await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'missing-ledger-copy',
      {
        copied: [
          await copiedEntry(
            root,
            'skill-real-user-codex-live-uat',
            'missing-ledger-copy',
            'report.json'
          )
        ]
      }
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_manifest',
      run_id: 'missing-ledger-copy',
      manifest_failures: expect.arrayContaining(['ledger_ref_copied'])
    });
  });

  it('fails evidence when the manifest repeats a copied bundle path', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'duplicate-copy',
      new Date('2026-06-15T01:00:00.000Z')
    );
    const ledgerEntry = await copiedEntry(
      root,
      'skill-real-user-codex-live-uat',
      'duplicate-copy',
      'ledger.json',
      'ledger'
    );
    await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'duplicate-copy',
      {
        copied: [ledgerEntry, ledgerEntry]
      }
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_manifest',
      run_id: 'duplicate-copy',
      manifest_failures: expect.arrayContaining([
        'copied[1].bundle_path_duplicate'
      ])
    });
  });

  it('reports blocked release gates without dumping nested preflight stdout', async () => {
    const root = await tempRoot();
    await writeLedger(root, 'skill-real-user-codex-live-uat', 'live-run');
    await writeLedger(root, 'repo-matrix-uat', 'matrix-run');

    const report = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P0', name: 'live environment', command: ['p0'] },
        { gate: 'P2', name: 'Postgres contract', command: ['p2'] },
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios: [
        {
          gate: 'P3',
          name: 'live Codex evidence bundle',
          scenario: 'skill-real-user-codex-live-uat'
        },
        {
          gate: 'P5',
          name: 'controlled repo matrix evidence',
          scenario: 'repo-matrix-uat'
        }
      ],
      runCommand: async (command) => {
        if (command === 'p0') {
          return { status: 'pass', exit_code: 0, report: { status: 'pass' } };
        }
        if (command === 'p2') {
          return {
            status: 'blocked',
            exit_code: BLOCKED_EXIT,
            stdout: 'large nested stdout',
            stderr: '',
            report: {
              status: 'blocked',
              reason: 'TEST_DATABASE_URL_UNAVAILABLE',
              required_failures: ['test_database_url'],
              next_step:
                'Start an isolated PostgreSQL database or run corepack pnpm uat:postgres-contract:docker.',
              checks: {
                test_database_url: {
                  ok: false,
                  status: 'missing',
                  value: ''
                }
              }
            }
          };
        }
        return {
          status: 'blocked',
          exit_code: BLOCKED_EXIT,
          stdout: 'large nested stdout',
          stderr: '',
          report: {
            status: 'blocked',
            reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
            required_failures: ['container_runtime'],
            checks: {
              container_runtime: {
                ok: false,
                status: 'spawn_error',
                stderr: 'spawn docker ENOENT'
              }
            },
            safety_check: { ok: true, failures: [] },
            safety: {
              host_execution_allowed: false,
              current_loop_decision_impact: 'none',
              m2: { isolation: 'container', network: 'none' },
              m4: { isolation: 'container', network: 'none' },
              frozen_rulepack: { decision_impact: 'next_loop_only' }
            }
          }
        };
      }
    });

    expect(report.status).toBe('blocked');
    expect(report.blocked_gates).toEqual(['P2', 'P4']);
    expect(report.failed_gates).toEqual([]);
    expect(report.preflights[1]).toMatchObject({
      reason: 'TEST_DATABASE_URL_UNAVAILABLE',
      required_failures: ['test_database_url'],
      next_step:
        'Start an isolated PostgreSQL database or run corepack pnpm uat:postgres-contract:docker.',
      checks: {
        test_database_url: {
          ok: false,
          status: 'missing'
        }
      }
    });
    expect(report.preflights[2]).toMatchObject({
      reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
      required_failures: ['container_runtime'],
      checks: {
        container_runtime: {
          ok: false,
          status: 'spawn_error'
        }
      },
      safety_check: { ok: true, failures: [] },
      safety: {
        host_execution_allowed: false,
        current_loop_decision_impact: 'none',
        m2: { isolation: 'container', network: 'none' },
        m4: { isolation: 'container', network: 'none' },
        frozen_rulepack: { decision_impact: 'next_loop_only' }
      }
    });
    expect(report.preflights[1]).not.toHaveProperty('stdout');
    expect(releaseGateExitCode(report)).toBe(BLOCKED_EXIT);
  });

  it('requires P2 Postgres contract evidence only after the P2 preflight passes', async () => {
    const root = await tempRoot();
    const evidenceScenarios = [
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
      }
    ];

    const blockedReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [{ gate: 'P2', name: 'Postgres contract', command: ['p2'] }],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'blocked',
        exit_code: BLOCKED_EXIT,
        report: {
          status: 'blocked',
          reason: 'TEST_DATABASE_URL_UNAVAILABLE',
          required_failures: ['test_database_url']
        }
      })
    });

    expect(blockedReport.status).toBe('blocked');
    expect(blockedReport.blocked_gates).toEqual(['P2']);
    expect(blockedReport.failed_gates).toEqual([]);
    expect(blockedReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'blocked_by_preflight',
      scenario: 'postgres-contract-uat',
      required_preflight_gate: 'P2',
      preflight_status: 'blocked',
      reason: 'TEST_DATABASE_URL_UNAVAILABLE'
    });
    expect(releaseGateExitCode(blockedReport)).toBe(BLOCKED_EXIT);

    const missingEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [{ gate: 'P2', name: 'Postgres contract', command: ['p2'] }],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(missingEvidenceReport.status).toBe('fail');
    expect(missingEvidenceReport.failed_gates).toEqual(['P2']);
    expect(missingEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'missing',
      scenario: 'postgres-contract-uat'
    });
    expect(releaseGateExitCode(missingEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'postgres-contract-uat',
      'postgres-run-invalid',
      new Date('2026-06-15T00:30:00.000Z'),
      {
        status: 'POSTGRES_CONTRACT_PASS',
        evidence_missing_count: 0,
        checks: {
          test_database_url: { ok: true, status: 'pass' }
        },
        test_result: { status: 'fail', exit_code: 1 }
      }
    );
    await writeManifest(root, 'postgres-contract-uat', 'postgres-run-invalid');

    const invalidEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [{ gate: 'P2', name: 'Postgres contract', command: ['p2'] }],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(invalidEvidenceReport.status).toBe('fail');
    expect(invalidEvidenceReport.failed_gates).toEqual(['P2']);
    expect(invalidEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'checks.database_connection',
        'checks.prisma_store_smoke',
        'test_result.status'
      ])
    });

    await writeLedger(
      root,
      'postgres-contract-uat',
      'postgres-run',
      new Date('2026-06-15T01:00:00.000Z'),
      validPostgresLedger()
    );
    await writeManifest(root, 'postgres-contract-uat', 'postgres-run');

    const presentEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [{ gate: 'P2', name: 'Postgres contract', command: ['p2'] }],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(presentEvidenceReport.status).toBe('pass');
    expect(presentEvidenceReport.failed_gates).toEqual([]);
    expect(presentEvidenceReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'present',
      expected_status: 'POSTGRES_CONTRACT_PASS',
      ledger_summary: {
        checks: {
          test_database_url: { ok: true, status: 'pass' },
          database_connection: { ok: true, status: 'pass' }
        },
        test_result: { status: 'pass', exit_code: 0 }
      },
      manifest_summary: {
        ledger_ref: 'ledger.json',
        missing_count: 0
      }
    });
    expect(releaseGateExitCode(presentEvidenceReport)).toBe(0);
  });

  it('requires P4 live evidence only after the P4 runtime preflight passes', async () => {
    const root = await tempRoot();
    const evidenceScenarios = [
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
      }
    ];

    const blockedReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'blocked',
        exit_code: BLOCKED_EXIT,
        report: {
          status: 'blocked',
          reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
          required_failures: ['container_runtime']
        }
      })
    });

    expect(blockedReport.status).toBe('blocked');
    expect(blockedReport.blocked_gates).toEqual(['P4']);
    expect(blockedReport.failed_gates).toEqual([]);
    expect(blockedReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'blocked_by_preflight',
      scenario: 'adversary-live-uat',
      required_preflight_gate: 'P4',
      preflight_status: 'blocked',
      reason: 'CONTAINER_RUNTIME_UNAVAILABLE'
    });
    expect(releaseGateExitCode(blockedReport)).toBe(BLOCKED_EXIT);

    const missingEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(missingEvidenceReport.status).toBe('fail');
    expect(missingEvidenceReport.blocked_gates).toEqual([]);
    expect(missingEvidenceReport.failed_gates).toEqual(['P4']);
    expect(missingEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'missing',
      scenario: 'adversary-live-uat'
    });
    expect(releaseGateExitCode(missingEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-invalid',
      new Date('2026-06-15T00:30:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'adversary-live-uat', 'adversary-run-invalid');

    const invalidAttackEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(invalidAttackEvidenceReport.status).toBe('fail');
    expect(invalidAttackEvidenceReport.failed_gates).toEqual(['P4']);
    expect(invalidAttackEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'attack_scenarios.test_weakening',
        'attack_scenarios.hidden_artifact_leak',
        'attack_scenarios.prompt_injection',
        'attack_scenarios.visible_only_hardcode',
        'attack_scenarios.default_quantity_hardcode',
        'attack_scenarios.zero_quantity_truthiness_hardcode',
        'attack_scenarios.discount_hardcode',
        'attack_scenarios.tax_hardcode',
        'attack_scenarios.rounding_hardcode',
        'attack_scenarios.profile_visibility_hardcode',
        'attack_scenarios.profile_suspension_hardcode',
        'attack_scenarios.order_approval_hardcode',
        'attack_scenarios.inventory_reservation_hardcode',
        'attack_scenarios.coupon_application_hardcode',
        'attack_scenarios.loyalty_points_hardcode',
        'attack_scenarios.subscription_renewal_hardcode',
        'attack_scenarios.gift_card_redemption_hardcode',
        'attack_scenarios.shipping_eligibility_hardcode',
        'attack_scenarios.payment_authorization_hardcode',
        'attack_scenarios.refund_eligibility_hardcode'
      ])
    });
    expect(releaseGateExitCode(invalidAttackEvidenceReport)).toBe(1);

    const impactAttackScenarios = validAttackScenarios();
    impactAttackScenarios.results[0] = {
      ...impactAttackScenarios.results[0],
      live_required: false,
      current_loop_impact: 'current_loop_accept',
      pr_created: true,
      promotion_allowed: true,
      blocked: false
    };
    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-impact',
      new Date('2026-06-15T00:40:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: impactAttackScenarios,
        ...validAdversarySafetyLedger()
      }
    );
    await writeManifest(root, 'adversary-live-uat', 'adversary-run-impact');

    const impactEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(impactEvidenceReport.status).toBe('fail');
    expect(impactEvidenceReport.failed_gates).toEqual(['P4']);
    expect(impactEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'attack_scenarios.test_weakening.live_required',
        'attack_scenarios.test_weakening.current_loop_impact',
        'attack_scenarios.test_weakening.pr_created',
        'attack_scenarios.test_weakening.promotion_allowed',
        'attack_scenarios.test_weakening.blocked'
      ])
    });
    expect(releaseGateExitCode(impactEvidenceReport)).toBe(1);

    const notExecutedAttackScenarios = validAttackScenarios();
    notExecutedAttackScenarios.results = notExecutedAttackScenarios.results.map(
      (scenario) =>
        scenario.id === 'gift_card_redemption_hardcode'
          ? { ...scenario, executed: false }
          : scenario
    );
    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-not-executed',
      new Date('2026-06-15T00:43:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: notExecutedAttackScenarios,
        ...validAdversarySafetyLedger()
      }
    );
    await writeManifest(
      root,
      'adversary-live-uat',
      'adversary-run-not-executed'
    );

    const notExecutedEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(notExecutedEvidenceReport.status).toBe('fail');
    expect(notExecutedEvidenceReport.failed_gates).toEqual(['P4']);
    expect(notExecutedEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'attack_scenarios.gift_card_redemption_hardcode.executed'
      ])
    });
    expect(releaseGateExitCode(notExecutedEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-unsafe',
      new Date('2026-06-15T00:45:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: validAttackScenarios(),
        ...validAdversarySafetyLedger(),
        safety: {
          ...validAdversarySafetyLedger().safety,
          host_execution_allowed: true,
          m4: {
            ...validAdversarySafetyLedger().safety.m4,
            network: 'bridge'
          }
        },
        m4: {
          executed: false,
          replay_safe: true
        }
      }
    );
    await writeManifest(root, 'adversary-live-uat', 'adversary-run-unsafe');

    const unsafeEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(unsafeEvidenceReport.status).toBe('fail');
    expect(unsafeEvidenceReport.failed_gates).toEqual(['P4']);
    expect(unsafeEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'adversary_safety.host_execution_allowed',
        'adversary_safety.m4.network',
        'adversary_safety.m4.run_executed'
      ])
    });
    expect(releaseGateExitCode(unsafeEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-reviewer-overclaim',
      new Date('2026-06-15T00:50:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: validAttackScenarios(),
        ...validAdversarySafetyLedger(),
        adversary_reviewer: {
          ...buildControlledAdversaryReviewerProvenance(),
          real_llm: true,
          current_loop_decision_impact: 'accept'
        }
      }
    );
    await writeManifest(
      root,
      'adversary-live-uat',
      'adversary-run-reviewer-overclaim'
    );

    const reviewerEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(reviewerEvidenceReport.status).toBe('fail');
    expect(reviewerEvidenceReport.failed_gates).toEqual(['P4']);
    expect(reviewerEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'adversary_reviewer.real_llm',
        'adversary_reviewer.current_loop_decision_impact'
      ])
    });
    expect(releaseGateExitCode(reviewerEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: validAttackScenarios(),
        ...validAdversarySafetyLedger()
      }
    );
    await writeManifest(root, 'adversary-live-uat', 'adversary-run');

    const presentEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(presentEvidenceReport.status).toBe('pass');
    expect(presentEvidenceReport.failed_gates).toEqual([]);
    expect(presentEvidenceReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'present',
      expected_status: 'ADVERSARY_LIVE_PASS',
      manifest_summary: {
        ledger_ref: 'ledger.json',
        missing_count: 0
      },
      ledger_summary: {
        adversary_reviewer: {
          kind: 'controlled_command',
          real_llm: false,
          provider: 'controlled-command',
          proposal_source: 'deterministic_fixture',
          current_loop_decision_impact: 'none'
        },
        adversary_safety: {
          safety_check: { ok: true, failures: [] },
          host_execution_allowed: false,
          m2: {
            isolation: 'container',
            network: 'none',
            run_executed: true
          },
          m4: {
            isolation: 'container',
            network: 'none',
            run_executed: true
          }
        }
      }
    });
    expect(releaseGateExitCode(presentEvidenceReport)).toBe(0);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-real-reviewer',
      new Date('2026-06-15T01:05:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: validAttackScenarios(),
        ...validAdversarySafetyLedger(),
        adversary_reviewer: buildCommandAdversaryReviewerProvenance({
          realLlm: true,
          reviewReport: {
            reviewer_provider: 'openai',
            same_model_review: false,
            prompt_version: 'adversary-review-v1',
            prompt_hash: 'sha256:reviewer',
            accepted_proposal_count: 1
          }
        })
      }
    );
    await writeManifest(
      root,
      'adversary-live-uat',
      'adversary-run-real-reviewer'
    );

    const realReviewerEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(realReviewerEvidenceReport.status).toBe('pass');
    expect(realReviewerEvidenceReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'present',
      ledger_summary: {
        adversary_reviewer: {
          kind: 'adversary_review_command',
          real_llm: true,
          provider: 'openai',
          proposal_source: 'accepted_review_proposal',
          current_loop_decision_impact: 'none',
          accepted_proposal_count: 1
        }
      }
    });
  });

  it('fails the release gate report when required evidence is missing', async () => {
    const root = await tempRoot();
    const report = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P0', name: 'live environment', command: ['p0'] },
        { gate: 'P2', name: 'Postgres contract', command: ['p2'] },
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios: [
        {
          gate: 'P3',
          name: 'live Codex evidence bundle',
          scenario: 'skill-real-user-codex-live-uat'
        }
      ],
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(report.status).toBe('fail');
    expect(report.failed_gates).toEqual(['P3']);
    expect(releaseGateExitCode(report)).toBe(1);
  });

  it('fails P4 when nested adversary safety metadata is invalid', async () => {
    const root = await tempRoot();
    await writeLedger(root, 'skill-real-user-codex-live-uat', 'live-run');
    const report = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios: [
        {
          gate: 'P3',
          name: 'live Codex evidence bundle',
          scenario: 'skill-real-user-codex-live-uat'
        }
      ],
      runCommand: async () => ({
        status: 'blocked',
        exit_code: BLOCKED_EXIT,
        report: {
          status: 'blocked',
          reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
          required_failures: ['container_runtime'],
          safety_check: {
            ok: false,
            failures: ['host_execution_allowed_must_be_false']
          }
        }
      })
    });

    expect(report.status).toBe('fail');
    expect(report.blocked_gates).toEqual([]);
    expect(report.failed_gates).toEqual(['P4']);
    expect(report.preflights[0]).toMatchObject({
      status: 'fail',
      reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
      safety_check: {
        ok: false,
        failures: ['host_execution_allowed_must_be_false']
      }
    });
    expect(releaseGateExitCode(report)).toBe(1);
  });
});

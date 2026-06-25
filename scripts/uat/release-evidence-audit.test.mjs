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
  REQUIRED_ATTACK_SCENARIOS,
  buildAdversaryLiveAttackScenarios
} from './adversary-live-safety.mjs';
import {
  buildCommandAdversaryReviewerProvenance,
  buildControlledAdversaryReviewerProvenance
} from './adversary-live-contract.mjs';
import {
  ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS,
  SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS,
  buildReleaseEvidenceAuditReport,
  discoverEvidenceRoots,
  releaseEvidenceAuditExitCode,
  selectReleaseEvidenceAuditScenarios
} from './release-evidence-audit.mjs';
import {
  PRODUCT_100_PASS_STATUS,
  PRODUCT_100_REQUIRED_REQUIREMENTS
} from './product-100-contract.mjs';

const cleanup = [];

async function tempRoot() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-evidence-audit-')
  );
  cleanup.push(root);
  return root;
}

async function writeLedger(root, scenario, runId, patch, mtime = new Date()) {
  const runDir = path.join(root, scenario, runId);
  const ledger = path.join(runDir, 'ledger.json');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    ledger,
    `${JSON.stringify({ scenario, run_id: runId, ...patch }, null, 2)}\n`
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

function postgresLedger() {
  return {
    status: 'POSTGRES_CONTRACT_PASS',
    evidence_missing_count: 0,
    checks: {
      test_database_url: { ok: true, status: 'pass' },
      database_connection: { ok: true, status: 'pass' },
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
    test_result: { status: 'pass', exit_code: 0 }
  };
}

function attackScenarios() {
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
    'warranty_claim_hardcode'
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

function adversarySafetyLedger() {
  return {
    adversary_reviewer: buildControlledAdversaryReviewerProvenance(),
    safety_check: { ok: true, failures: [] },
    safety: {
      host_execution_allowed: false,
      current_loop_decision_impact: 'none',
      proposal_authority: 'advisory_only',
      required_preflights: ['container_runtime', 'container_smoke'],
      m2: { execute: true, isolation: 'container', network: 'none' },
      m4: { execute: true, isolation: 'container', network: 'none' },
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

function adversaryLedger(patch = {}) {
  return {
    status: 'ADVERSARY_LIVE_PASS',
    evidence_missing_count: 0,
    attack_scenarios: attackScenarios(),
    ...adversarySafetyLedger(),
    ...patch
  };
}

function matrixCells() {
  return [
    ['node-single', 'pass', 'skipped'],
    ['node-lockfile-provisioning', 'pass', 'cache_miss', 'npm'],
    ['node-pnpm-lockfile-provisioning', 'pass', 'cache_miss', 'pnpm'],
    ['node-yarn-lockfile-provisioning', 'pass', 'cache_miss', 'yarn'],
    ['python-stdlib', 'pass', 'skipped'],
    ['ruby-stdlib', 'pass', 'skipped'],
    ['java-stdlib', 'pass', 'skipped'],
    ['swift-stdlib', 'pass', 'skipped'],
    ['typescript-esm', 'pass', 'skipped'],
    ['js-monorepo-scope', 'pass', 'skipped'],
    ['react-next-like', 'pass', 'skipped'],
    ['django-like-service', 'pass', 'skipped'],
    ['rails-like-service', 'pass', 'skipped'],
    ['android-gradle-like', 'pass', 'skipped'],
    ['cli-tool', 'pass', 'skipped'],
    ['no-package-manager', 'pass', 'skipped'],
    ['large-file-count', 'pass', 'skipped'],
    ['dirty-worktree', 'blocked', 'not_run'],
    ['network-restricted-r1', 'unsupported', 'unsupported']
  ].map(([id, status, provisioningStatus, manager]) => ({
    id,
    status,
    dependency_provisioning:
      provisioningStatus === 'not_run' || provisioningStatus === 'unsupported'
        ? undefined
        : { status: provisioningStatus, ...(manager ? { manager } : {}) },
    provisioning:
      provisioningStatus === 'not_run' || provisioningStatus === 'unsupported'
        ? { status: provisioningStatus }
        : undefined
  }));
}

function matrixLedger() {
  return {
    status: 'REPO_MATRIX_PASS',
    cell_count: 19,
    pass_count: 17,
    blocked_count: 1,
    unsupported_count: 1,
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
    cells: matrixCells(),
    evidence_missing_count: 0
  };
}

function product100PassLedger(overrides = {}) {
  const requirements = Object.fromEntries(
    PRODUCT_100_REQUIRED_REQUIREMENTS.map((name) => [name, true])
  );
  const evaluation = {
    status: PRODUCT_100_PASS_STATUS,
    pass: true,
    satisfied: [...PRODUCT_100_REQUIRED_REQUIREMENTS],
    missing_requirements: [],
    blocked_requirements: [],
    requirements,
    ...(overrides.evaluation ?? {})
  };
  return {
    status: PRODUCT_100_PASS_STATUS,
    product_100_contract_version: 'product-100.codex-live.v1',
    evidence_missing_count: 0,
    summary: {
      live_loop_started: true,
      phase4: { every_issue_product_100_phase4_pass: true, issue_count: 10 },
      phase5: { phase5_pass: true },
      phase6: { phase6_pass: true },
      phase7: { phase7_pass: true },
      ...(overrides.summary ?? {})
    },
    evaluation,
    ...(overrides.ledger ?? {})
  };
}

function simplePassLedger(status) {
  return {
    status,
    evidence_missing_count: 0
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

function skillPromptLiveLedger(overrides = {}) {
  const githubDraftPr = overrides.githubDraftPr === true;
  const helperMode = overrides.helper?.mode ?? 'auto_discovery';
  return {
    status: 'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS',
    evidence_missing_count: 0,
    orchestrator: {
      real_llm: true,
      codex_cli: true,
      reported_skill_file_read: true,
      reported_skill_name: 'vibeloop-harness',
      ...(overrides.orchestrator ?? {})
    },
    builder: {
      real_llm: true,
      via: 'chatgpt-oauth-proxy',
      model: 'gpt-5.5',
      ...(overrides.builder ?? {})
    },
    helper: {
      invoked: true,
      mode: helperMode,
      command_kind: 'vibeloop_orchestrate',
      executed: true,
      execution_code: 0,
      ...(overrides.helper ?? {})
    },
    prompt_ux: {
      variant_id:
        helperMode === 'user_issue'
          ? 'ko-cart-natural-quantity-total'
          : 'ko-failing-tests-find-one',
      variant_source: 'built-in',
      language: 'ko',
      prompt_present: true,
      prompt_sha256:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      prompt_char_count: 42,
      classification: { mode: helperMode, confidence: 0.9 },
      expected_mode: helperMode,
      matched_expected_mode: true,
      ...(overrides.prompt_ux ?? {})
    },
    pr_candidate: true,
    final_verification: {
      provenance_ok: true,
      reverify_attempted: true,
      reverified: true,
      passed: true,
      ...(overrides.final_verification ?? {})
    },
    promotion: {
      branch_name: 'pr-candidate/skill-prompt-auto-uat',
      pushed: false,
      ...(overrides.promotion ?? {})
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
                branch_name: 'pr-candidate/skill-prompt-auto-remote',
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
    ...(overrides.ledger ?? {})
  };
}

async function writeValidCiEvidence(root) {
  await writeLedger(
    root,
    'postgres-contract-uat',
    'postgres-run',
    postgresLedger()
  );
  await writeManifest(root, 'postgres-contract-uat', 'postgres-run');

  await writeLedger(
    root,
    'adversary-live-uat',
    'adversary-run',
    adversaryLedger()
  );
  await writeManifest(root, 'adversary-live-uat', 'adversary-run');

  await writeLedger(root, 'repo-matrix-uat', 'matrix-run', matrixLedger());
  await writeManifest(root, 'repo-matrix-uat', 'matrix-run');
}

async function writeValidAllReleaseEvidence(root) {
  await writeValidCiEvidence(root);

  await writeLedger(
    root,
    'skill-real-user-codex-live-uat',
    'codex-live-run',
    simplePassLedger('REAL_USER_RUN_PASS')
  );
  await writeManifest(root, 'skill-real-user-codex-live-uat', 'codex-live-run');

  await writeLedger(
    root,
    'repo-matrix-python-codex-live-uat',
    'python-live-run',
    simplePassLedger('PYTHON_LIVE_REPRESENTATIVE_PASS')
  );
  await writeManifest(
    root,
    'repo-matrix-python-codex-live-uat',
    'python-live-run'
  );

  await writeLedger(
    root,
    'repo-matrix-monorepo-codex-live-uat',
    'monorepo-live-run',
    simplePassLedger('MONOREPO_LIVE_REPRESENTATIVE_PASS')
  );
  await writeManifest(
    root,
    'repo-matrix-monorepo-codex-live-uat',
    'monorepo-live-run'
  );

  await writeLedger(
    root,
    'repo-matrix-broad-codex-live-uat',
    'broad-live-run',
    {
      status: 'BROAD_LIVE_REPRESENTATIVE_PASS',
      evidence_missing_count: 0,
      cell_count: 4,
      pass_count: 4,
      fail_count: 0,
      cells: [
        { id: 'react-next-like', status: 'pass' },
        { id: 'django-like-service', status: 'pass' },
        { id: 'rails-like-service', status: 'pass' },
        { id: 'android-gradle-like', status: 'pass' }
      ]
    }
  );
  await writeManifest(
    root,
    'repo-matrix-broad-codex-live-uat',
    'broad-live-run'
  );
}

describe('release evidence audit', () => {
  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('validates merged evidence artifacts without running live preflights', async () => {
    const root = await tempRoot();
    await writeValidCiEvidence(root);

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root]
    });

    expect(report.status).toBe('pass');
    expect(report.mode).toBe('local-or-artifact-evidence-audit');
    expect(report.scope).toBe('default-release-gates');
    expect(report.audit_summary).toEqual(
      expect.objectContaining({
        required_count: 3,
        passed_count: 3,
        failed_count: 0,
        copied_integrity_checked_count: 3
      })
    );
    expect(report.failed_gates).toEqual([]);
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'P2',
          ok: true,
          scenario: 'postgres-contract-uat',
          ledger_summary: expect.objectContaining({
            status: 'POSTGRES_CONTRACT_PASS'
          })
        }),
        expect.objectContaining({
          gate: 'P4',
          ok: true,
          scenario: 'adversary-live-uat',
          ledger_summary: expect.objectContaining({
            status: 'ADVERSARY_LIVE_PASS'
          })
        }),
        expect.objectContaining({
          gate: 'P5',
          ok: true,
          scenario: 'repo-matrix-uat',
          ledger_summary: expect.objectContaining({
            status: 'REPO_MATRIX_PASS',
            cell_count: 19
          })
        })
      ])
    );
    expect(releaseEvidenceAuditExitCode(report)).toBe(0);
  });

  it('accepts release-grade real reviewer provenance in downloaded P4 evidence', async () => {
    const root = await tempRoot();
    await writeValidCiEvidence(root);
    await writeLedger(
      root,
      'adversary-live-uat',
      'real-reviewer-adversary-run',
      adversaryLedger({
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
      }),
      new Date('2030-01-01T00:00:00.000Z')
    );
    await writeManifest(
      root,
      'adversary-live-uat',
      'real-reviewer-adversary-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root]
    });

    expect(report.status).toBe('pass');
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'P4',
          ok: true,
          ledger_summary: expect.objectContaining({
            adversary_reviewer: expect.objectContaining({
              kind: 'adversary_review_command',
              real_llm: true,
              provider: 'openai',
              proposal_source: 'accepted_review_proposal',
              accepted_proposal_count: 1
            })
          })
        })
      ])
    );
  });

  it('can audit every release evidence scenario when requested', async () => {
    const root = await tempRoot();
    await writeValidAllReleaseEvidence(root);

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      allReleaseEvidence: true
    });

    expect(report.status).toBe('pass');
    expect(report.scope).toBe('all-release-evidence');
    expect(report.required_scenarios).toHaveLength(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.length
    );
    expect(report.audit_summary).toEqual(
      expect.objectContaining({
        required_count: ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.length,
        passed_count: ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.length,
        failed_count: 0,
        copied_integrity_checked_count:
          ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.length
      })
    );
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'P3',
          ok: true,
          scenario: 'skill-real-user-codex-live-uat',
          ledger_summary: expect.objectContaining({
            status: 'REAL_USER_RUN_PASS'
          })
        }),
        expect.objectContaining({
          gate: 'P5',
          ok: true,
          scenario: 'repo-matrix-python-codex-live-uat',
          ledger_summary: expect.objectContaining({
            status: 'PYTHON_LIVE_REPRESENTATIVE_PASS'
          })
        }),
        expect.objectContaining({
          gate: 'P5',
          ok: true,
          scenario: 'repo-matrix-monorepo-codex-live-uat',
          ledger_summary: expect.objectContaining({
            status: 'MONOREPO_LIVE_REPRESENTATIVE_PASS'
          })
        }),
        expect.objectContaining({
          gate: 'P5',
          ok: true,
          scenario: 'repo-matrix-broad-codex-live-uat',
          ledger_summary: expect.objectContaining({
            status: 'BROAD_LIVE_REPRESENTATIVE_PASS',
            cell_count: 4,
            pass_count: 4,
            fail_count: 0
          })
        })
      ])
    );
  });

  it('can audit a custom scenario subset without requiring default CI gates', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'codex-live-run',
      simplePassLedger('REAL_USER_RUN_PASS')
    );
    await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'codex-live-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['skill-real-user-codex-live-uat']
    });

    expect(report.status).toBe('pass');
    expect(report.scope).toBe('custom');
    expect(report.required_scenarios).toEqual([
      expect.objectContaining({
        gate: 'P3',
        scenario: 'skill-real-user-codex-live-uat',
        expected_status: 'REAL_USER_RUN_PASS'
      })
    ]);
    expect(report.audit_summary).toEqual(
      expect.objectContaining({
        required_count: 1,
        passed_count: 1,
        failed_count: 0,
        copied_integrity_checked_count: 1
      })
    );
  });

  it('can audit Skill full fixture UAT evidence as an explicit scenario', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-full-uat';
    await writeLedger(root, scenario, 'skill-full-run', skillFullUatLedger());
    await writeManifest(root, scenario, 'skill-full-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('pass');
    expect(report.required_scenarios).toEqual([
      expect.objectContaining({
        gate: 'P1',
        scenario,
        expected_status: 'FULL_UAT_PASS'
      })
    ]);
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: true,
        scenario,
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
      })
    );
  });

  it('can audit Skill prompt routing matrix evidence as an explicit scenario', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-prompt-matrix-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-matrix-run',
      skillPromptMatrixLedger()
    );
    await writeManifest(root, scenario, 'skill-prompt-matrix-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('pass');
    expect(report.required_scenarios).toEqual([
      expect.objectContaining({
        gate: 'P1',
        scenario,
        expected_status: 'SKILL_PROMPT_MATRIX_UAT_PASS'
      })
    ]);
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: true,
        scenario,
        ledger_summary: expect.objectContaining({
          status: 'SKILL_PROMPT_MATRIX_UAT_PASS',
          proof_scope: 'copied_skill_prompt_routing_matrix',
          total_cases: 28,
          passed_cases: 28,
          failed_cases: 0,
          unexpected_unknown: 0
        })
      })
    );
  });

  it('can audit Skill prompt journey evidence as an explicit scenario', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-prompt-journey-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-journey-run',
      skillPromptJourneyLedger()
    );
    await writeManifest(root, scenario, 'skill-prompt-journey-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('pass');
    expect(report.required_scenarios).toEqual([
      expect.objectContaining({
        gate: 'P1',
        scenario,
        expected_status: 'SKILL_PROMPT_JOURNEY_UAT_PASS'
      })
    ]);
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: true,
        scenario,
        ledger_summary: expect.objectContaining({
          status: 'SKILL_PROMPT_JOURNEY_UAT_PASS',
          proof_scope: 'copied_skill_prompt_runner_end_to_end_journey',
          prompt_journey: expect.objectContaining({
            step_count: 3,
            pr_candidate_steps: 2,
            report_summary_steps: 1
          })
        })
      })
    );
  });

  it('fails Skill full fixture UAT evidence when scope or invariants are weak', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-full-uat';
    await writeLedger(
      root,
      scenario,
      'skill-full-run',
      skillFullUatLedger({
        ledger: { not_live_codex_or_github_pass: false },
        actual_user_environment: {
          clean_codex_home: false,
          codex_home_skills_entries: ['unexpected-skill'],
          copied_skill_path: 'tmp/vibeloop-harness'
        },
        failure_rate: { unexpectedAccept: 1 }
      })
    );
    await writeManifest(root, scenario, 'skill-full-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('fail');
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'invalid_ledger',
        ledger_failures: expect.arrayContaining([
          'skill_full_uat.not_live_codex_or_github_pass',
          'skill_full_uat.clean_codex_home',
          'skill_full_uat.codex_home_skills_entries',
          'skill_full_uat.copied_skill_path',
          'skill_full_uat.unexpected_accept'
        ])
      })
    );
  });

  it('can audit Skill prompt real-builder evidence as an explicit scenario', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-codex-skill-prompt-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-user-live-run',
      skillPromptLiveLedger({
        ledger: { status: 'SKILL_PROMPT_LIVE_UAT_PASS' },
        helper: { mode: 'user_issue', command_kind: 'vibeloop_improve' },
        promotion: { branch_name: 'pr-candidate/skill-prompt-user-uat' }
      }),
      new Date('2026-06-21T01:00:00.000Z')
    );
    await writeManifest(root, scenario, 'skill-prompt-user-live-run');
    await writeLedger(
      root,
      scenario,
      'skill-prompt-auto-live-run',
      skillPromptLiveLedger(),
      new Date('2026-06-21T02:00:00.000Z')
    );
    await writeManifest(root, scenario, 'skill-prompt-auto-live-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('pass');
    expect(report.required_scenarios).toEqual([
      expect.objectContaining({
        gate: 'P1',
        scenario,
        expected_statuses: [
          'SKILL_PROMPT_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
        ],
        required_statuses: [
          'SKILL_PROMPT_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
        ]
      })
    ]);
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: true,
        scenario,
        ledger_summary: expect.objectContaining({
          status: 'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS',
          pr_candidate: true,
          builder: expect.objectContaining({
            real_llm: true,
            via: 'chatgpt-oauth-proxy'
          })
        }),
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
      })
    );
  });

  it('can audit Skill prompt GitHub draft PR evidence as an explicit scenario', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-codex-skill-prompt-github-draft-pr-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-user-github-run',
      skillPromptLiveLedger({
        githubDraftPr: true,
        ledger: { status: 'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS' },
        helper: { mode: 'user_issue', command_kind: 'vibeloop_improve' },
        promotion: { branch_name: 'pr-candidate/skill-prompt-user-uat' }
      }),
      new Date('2026-06-21T01:00:00.000Z')
    );
    await writeManifest(root, scenario, 'skill-prompt-user-github-run');
    await writeLedger(
      root,
      scenario,
      'skill-prompt-auto-github-run',
      skillPromptLiveLedger({
        githubDraftPr: true,
        ledger: {
          status: 'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
        }
      }),
      new Date('2026-06-21T02:00:00.000Z')
    );
    await writeManifest(root, scenario, 'skill-prompt-auto-github-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('pass');
    expect(report.required_scenarios).toEqual([
      expect.objectContaining({
        gate: 'P1',
        scenario,
        expected_statuses: [
          'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
        ],
        required_statuses: [
          'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
          'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
        ]
      })
    ]);
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: true,
        scenario,
        ledger_summary: expect.objectContaining({
          status: 'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
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
      })
    );
  });

  it('fails Skill prompt GitHub draft PR audit when PR evidence is not verified', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-codex-skill-prompt-github-draft-pr-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-user-github-run',
      skillPromptLiveLedger({
        githubDraftPr: true,
        ledger: { status: 'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS' },
        helper: { mode: 'user_issue', command_kind: 'vibeloop_improve' },
        promotion: { branch_name: 'pr-candidate/skill-prompt-user-uat' }
      }),
      new Date('2026-06-21T01:00:00.000Z')
    );
    await writeManifest(root, scenario, 'skill-prompt-user-github-run');
    await writeLedger(
      root,
      scenario,
      'skill-prompt-auto-github-run',
      skillPromptLiveLedger({
        ledger: {
          status: 'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
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
      }),
      new Date('2026-06-21T02:00:00.000Z')
    );
    await writeManifest(root, scenario, 'skill-prompt-auto-github-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('fail');
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: false,
        scenario,
        ledger_failures: expect.arrayContaining([
          'skill_prompt.github_draft_pr_verified',
          'skill_prompt.github.draft_prs.verified',
          'github_draft_pr'
        ])
      })
    );
  });

  it('fails Skill prompt evidence audit when a required prompt mode is missing', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-codex-skill-prompt-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-auto-live-run',
      skillPromptLiveLedger()
    );
    await writeManifest(root, scenario, 'skill-prompt-auto-live-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('fail');
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'invalid_required_status_evidence',
        scenario,
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
      })
    );
  });

  it('fails Skill prompt evidence audit when the builder was not real Codex', async () => {
    const root = await tempRoot();
    const scenario = 'skill-real-user-codex-skill-prompt-uat';
    await writeLedger(
      root,
      scenario,
      'skill-prompt-fixture-run',
      skillPromptLiveLedger({
        builder: { real_llm: false, via: 'command-fixture' }
      })
    );
    await writeManifest(root, scenario, 'skill-prompt-fixture-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('fail');
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: false,
        status: 'invalid_ledger',
        ledger_failures: expect.arrayContaining([
          'skill_prompt.builder.real_llm'
        ])
      })
    );
  });

  it('keeps Product-100 audit explicit/selectable but out of default all-release evidence', () => {
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: ['product-100-codex-live-uat']
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P6',
        scenario: 'product-100-codex-live-uat',
        expected_status: PRODUCT_100_PASS_STATUS,
        expected_ledger: { required_product_100: true }
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain('product-100-codex-live-uat');
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain('product-100-codex-live-uat');
  });

  it('keeps real reviewer P4 audit explicit and requires real LLM provenance', async () => {
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: ['adversary-live-real-reviewer-uat']
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P4',
        scenario: 'adversary-live-real-reviewer-uat',
        expected_status: 'ADVERSARY_LIVE_PASS',
        expected_ledger: expect.objectContaining({
          required_adversary_real_reviewer: true
        })
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain('adversary-live-real-reviewer-uat');
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain('adversary-live-real-reviewer-uat');

    const root = await tempRoot();
    await writeLedger(
      root,
      'adversary-live-real-reviewer-uat',
      'controlled-run',
      adversaryLedger()
    );
    await writeManifest(
      root,
      'adversary-live-real-reviewer-uat',
      'controlled-run'
    );

    const controlledReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['adversary-live-real-reviewer-uat']
    });

    expect(controlledReport.status).toBe('fail');
    expect(controlledReport.failed_gates).toEqual(['P4']);
    expect(controlledReport.evidence).toEqual([
      expect.objectContaining({
        ok: false,
        status: 'invalid_ledger',
        ledger_failures: expect.arrayContaining([
          'adversary_reviewer.kind',
          'adversary_reviewer.real_llm',
          'adversary_reviewer.provider',
          'adversary_reviewer.proposal_source'
        ])
      })
    ]);

    await writeLedger(
      root,
      'adversary-live-real-reviewer-uat',
      'real-reviewer-run',
      adversaryLedger({
        adversary_reviewer: buildCommandAdversaryReviewerProvenance({
          realLlm: true,
          reviewReport: {
            reviewer_provider: 'codex',
            same_model_review: false,
            prompt_version: 'adversary-review-v1',
            prompt_hash: 'sha256:reviewer',
            accepted_proposal_count: 1
          }
        })
      }),
      new Date('2030-01-01T00:00:00.000Z')
    );
    await writeManifest(
      root,
      'adversary-live-real-reviewer-uat',
      'real-reviewer-run'
    );

    const realReviewerReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['adversary-live-real-reviewer-uat']
    });

    expect(realReviewerReport.status).toBe('pass');
    expect(realReviewerReport.evidence).toEqual([
      expect.objectContaining({
        gate: 'P4',
        ok: true,
        scenario: 'adversary-live-real-reviewer-uat',
        ledger_summary: expect.objectContaining({
          adversary_reviewer: expect.objectContaining({
            kind: 'adversary_review_command',
            real_llm: true,
            provider: 'codex',
            accepted_proposal_count: 1
          })
        })
      })
    ]);
  });

  it('keeps broad real project corpus audit explicit and validates read-only cells', async () => {
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: ['repo-matrix-real-project-corpus-uat']
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P5',
        scenario: 'repo-matrix-real-project-corpus-uat',
        expected_status: 'REAL_PROJECT_CORPUS_PASS',
        expected_ledger: {
          min_cell_count: 2,
          min_pass_count: 2,
          max_fail_count: 0
        }
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain('repo-matrix-real-project-corpus-uat');
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain('repo-matrix-real-project-corpus-uat');

    const root = await tempRoot();
    await writeLedger(
      root,
      'repo-matrix-real-project-corpus-uat',
      'real-project-run',
      {
        status: 'REAL_PROJECT_CORPUS_PASS',
        evidence_missing_count: 0,
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          { id: 'node-real-project', status: 'pass' },
          { id: 'python-real-project', status: 'pass' }
        ]
      }
    );
    await writeManifest(
      root,
      'repo-matrix-real-project-corpus-uat',
      'real-project-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['repo-matrix-real-project-corpus-uat']
    });

    expect(report.status).toBe('pass');
    expect(report.scope).toBe('custom');
    expect(report.audit_summary).toEqual(
      expect.objectContaining({
        required_count: 1,
        passed_count: 1,
        failed_count: 0
      })
    );
    expect(report.evidence).toEqual([
      expect.objectContaining({
        gate: 'P5',
        ok: true,
        scenario: 'repo-matrix-real-project-corpus-uat',
        ledger_summary: expect.objectContaining({
          status: 'REAL_PROJECT_CORPUS_PASS',
          cell_count: 2,
          pass_count: 2,
          fail_count: 0
        })
      })
    ]);
  });

  it('keeps modifiable-copy real project corpus audit explicit and requires the write probe flag', async () => {
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: ['repo-matrix-real-project-modifiable-corpus-uat']
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P5',
        scenario: 'repo-matrix-real-project-modifiable-corpus-uat',
        expected_status: 'REAL_PROJECT_MODIFIABLE_CORPUS_PASS',
        expected_ledger: {
          min_cell_count: 2,
          min_pass_count: 2,
          max_fail_count: 0,
          required_modifiable_copy_smoke: true
        }
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain('repo-matrix-real-project-modifiable-corpus-uat');
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain('repo-matrix-real-project-modifiable-corpus-uat');

    const root = await tempRoot();
    await writeLedger(
      root,
      'repo-matrix-real-project-modifiable-corpus-uat',
      'real-project-modifiable-run',
      {
        status: 'REAL_PROJECT_MODIFIABLE_CORPUS_PASS',
        evidence_missing_count: 0,
        modifiable_copy_smoke: true,
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'node-real-project',
            status: 'pass',
            modifiable_copy: { status: 'pass' }
          },
          {
            id: 'python-real-project',
            status: 'pass',
            modifiable_copy: { status: 'pass' }
          }
        ]
      }
    );
    await writeManifest(
      root,
      'repo-matrix-real-project-modifiable-corpus-uat',
      'real-project-modifiable-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['repo-matrix-real-project-modifiable-corpus-uat']
    });

    expect(report.status).toBe('pass');
    expect(report.scope).toBe('custom');
    expect(report.evidence).toEqual([
      expect.objectContaining({
        gate: 'P5',
        ok: true,
        scenario: 'repo-matrix-real-project-modifiable-corpus-uat',
        ledger_summary: expect.objectContaining({
          status: 'REAL_PROJECT_MODIFIABLE_CORPUS_PASS',
          modifiable_copy_smoke: true,
          cell_count: 2,
          pass_count: 2,
          fail_count: 0
        })
      })
    ]);

    await writeLedger(
      root,
      'repo-matrix-real-project-modifiable-corpus-uat',
      'real-project-readonly-run',
      {
        status: 'REAL_PROJECT_MODIFIABLE_CORPUS_PASS',
        evidence_missing_count: 0,
        modifiable_copy_smoke: false,
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          { id: 'node-real-project', status: 'pass' },
          { id: 'python-real-project', status: 'pass' }
        ]
      }
    );
    await writeManifest(
      root,
      'repo-matrix-real-project-modifiable-corpus-uat',
      'real-project-readonly-run'
    );

    const weakenedReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['repo-matrix-real-project-modifiable-corpus-uat']
    });

    expect(weakenedReport.status).toBe('fail');
    expect(weakenedReport.evidence[0].ledger_failures).toContain(
      'modifiable_copy_smoke'
    );
  });

  it('keeps real Codex temp-clone project corpus audit explicit and requires hidden verifier evidence', async () => {
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: ['repo-matrix-real-project-codex-copy-uat']
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P5',
        scenario: 'repo-matrix-real-project-codex-copy-uat',
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
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain('repo-matrix-real-project-codex-copy-uat');
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain('repo-matrix-real-project-codex-copy-uat');

    const root = await tempRoot();
    await writeLedger(
      root,
      'repo-matrix-real-project-codex-copy-uat',
      'real-project-codex-copy-run',
      {
        status: 'REAL_PROJECT_CODEX_COPY_PASS',
        evidence_missing_count: 0,
        codex_copy_smoke: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: {
          real_llm: true,
          provider: 'codex',
          model: 'gpt-5.5'
        },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'node-real-project',
            status: 'pass',
            codex_copy: {
              status: 'pass',
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' }
            }
          },
          {
            id: 'python-real-project',
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
      'real-project-codex-copy-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['repo-matrix-real-project-codex-copy-uat']
    });

    expect(report.status).toBe('pass');
    expect(report.evidence).toEqual([
      expect.objectContaining({
        gate: 'P5',
        ok: true,
        scenario: 'repo-matrix-real-project-codex-copy-uat',
        ledger_summary: expect.objectContaining({
          status: 'REAL_PROJECT_CODEX_COPY_PASS',
          codex_copy_smoke: true,
          llm_modification: true,
          hidden_acceptance: true,
          source_repos_read_only: true,
          draft_pr: false,
          builder: expect.objectContaining({
            real_llm: true,
            provider: 'codex'
          })
        })
      })
    ]);

    await writeLedger(
      root,
      'repo-matrix-real-project-codex-copy-uat',
      'real-project-codex-copy-weakened-run',
      {
        status: 'REAL_PROJECT_CODEX_COPY_PASS',
        evidence_missing_count: 0,
        codex_copy_smoke: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: {
          real_llm: true,
          provider: 'codex',
          model: 'gpt-5.5'
        },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'node-real-project',
            status: 'pass',
            codex_copy: {
              status: 'pass',
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' }
            }
          },
          {
            id: 'python-real-project',
            status: 'pass',
            codex_copy: {
              status: 'pass',
              hidden_acceptance: { status: 'fail' },
              diff_scope: { status: 'pass' }
            }
          }
        ]
      },
      new Date(Date.now() + 1000)
    );
    await writeManifest(
      root,
      'repo-matrix-real-project-codex-copy-uat',
      'real-project-codex-copy-weakened-run'
    );

    const weakenedReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['repo-matrix-real-project-codex-copy-uat']
    });

    expect(weakenedReport.status).toBe('fail');
    expect(weakenedReport.evidence[0].ledger_failures).toContain(
      'cells.python-real-project.codex_copy.hidden_acceptance'
    );
  });

  it('keeps real Codex temp-clone source repair corpus audit explicit and requires repair evidence', async () => {
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: ['repo-matrix-real-project-codex-repair-uat']
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P5',
        scenario: 'repo-matrix-real-project-codex-repair-uat',
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
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain('repo-matrix-real-project-codex-repair-uat');
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain('repo-matrix-real-project-codex-repair-uat');

    const root = await tempRoot();
    await writeLedger(
      root,
      'repo-matrix-real-project-codex-repair-uat',
      'real-project-codex-repair-run',
      {
        status: 'REAL_PROJECT_CODEX_REPAIR_PASS',
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        source_code_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: {
          real_llm: true,
          provider: 'codex',
          model: 'gpt-5.5'
        },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'node-real-project',
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
            id: 'python-real-project',
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
    await writeManifest(
      root,
      'repo-matrix-real-project-codex-repair-uat',
      'real-project-codex-repair-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['repo-matrix-real-project-codex-repair-uat']
    });

    expect(report.status).toBe('pass');
    expect(report.evidence).toEqual([
      expect.objectContaining({
        gate: 'P5',
        ok: true,
        scenario: 'repo-matrix-real-project-codex-repair-uat',
        ledger_summary: expect.objectContaining({
          status: 'REAL_PROJECT_CODEX_REPAIR_PASS',
          codex_repair_smoke: true,
          source_code_repair: true,
          llm_modification: true,
          hidden_acceptance: true,
          source_repos_read_only: true,
          draft_pr: false,
          builder: expect.objectContaining({
            real_llm: true,
            provider: 'codex'
          })
        })
      })
    ]);

    await writeLedger(
      root,
      'repo-matrix-real-project-codex-repair-uat',
      'real-project-codex-repair-weakened-run',
      {
        status: 'REAL_PROJECT_CODEX_REPAIR_PASS',
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        source_code_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: {
          real_llm: true,
          provider: 'codex',
          model: 'gpt-5.5'
        },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'node-real-project',
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
            id: 'python-real-project',
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
      },
      new Date(Date.now() + 1000)
    );
    await writeManifest(
      root,
      'repo-matrix-real-project-codex-repair-uat',
      'real-project-codex-repair-weakened-run'
    );

    const weakenedReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['repo-matrix-real-project-codex-repair-uat']
    });

    expect(weakenedReport.status).toBe('fail');
    expect(weakenedReport.evidence[0].ledger_failures).toEqual(
      expect.arrayContaining([
        'cells.python-real-project.codex_repair.hidden_acceptance',
        'cells.python-real-project.codex_repair.source_changed'
      ])
    );
  });

  it('keeps real Codex business repair corpus audit explicit and requires business bug evidence', async () => {
    const scenario = 'repo-matrix-real-project-business-repair-uat';
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: [scenario]
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P5',
        scenario,
        expected_status: 'REAL_PROJECT_BUSINESS_REPAIR_PASS',
        expected_ledger: {
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
        }
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain(scenario);
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain(scenario);

    const root = await tempRoot();
    await writeLedger(root, scenario, 'real-project-business-repair-run', {
      status: 'REAL_PROJECT_BUSINESS_REPAIR_PASS',
      evidence_missing_count: 0,
      codex_repair_smoke: true,
      business_repair_smoke: true,
      source_code_repair: true,
      business_bug_repair: true,
      llm_modification: true,
      hidden_acceptance: true,
      source_repos_read_only: true,
      draft_pr: false,
      builder: {
        real_llm: true,
        provider: 'codex',
        model: 'gpt-5.5'
      },
      cell_count: 2,
      pass_count: 2,
      fail_count: 0,
      cells: [
        {
          id: 'node-real-project',
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
          id: 'python-real-project',
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
    });
    await writeManifest(root, scenario, 'real-project-business-repair-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('pass');
    expect(report.evidence).toEqual([
      expect.objectContaining({
        gate: 'P5',
        ok: true,
        scenario,
        ledger_summary: expect.objectContaining({
          status: 'REAL_PROJECT_BUSINESS_REPAIR_PASS',
          codex_repair_smoke: true,
          business_repair_smoke: true,
          source_code_repair: true,
          business_bug_repair: true,
          llm_modification: true,
          hidden_acceptance: true,
          source_repos_read_only: true,
          draft_pr: false
        })
      })
    ]);

    await writeLedger(
      root,
      scenario,
      'real-project-business-repair-weakened-run',
      {
        status: 'REAL_PROJECT_BUSINESS_REPAIR_PASS',
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        business_repair_smoke: false,
        source_code_repair: true,
        business_bug_repair: false,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: {
          real_llm: true,
          provider: 'codex',
          model: 'gpt-5.5'
        },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'node-real-project',
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
            id: 'python-real-project',
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
      },
      new Date(Date.now() + 1000)
    );
    await writeManifest(
      root,
      scenario,
      'real-project-business-repair-weakened-run'
    );

    const weakenedReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(weakenedReport.status).toBe('fail');
    expect(weakenedReport.evidence[0].ledger_failures).toEqual(
      expect.arrayContaining([
        'business_bug_repair',
        'cells.node-real-project.codex_repair.business_bug_repair',
        'cells.python-real-project.codex_repair.business_bug_repair'
      ])
    );
  });

  it('keeps targeted existing business-source repair audit explicit', async () => {
    const scenario = 'repo-matrix-real-project-business-source-repair-uat';
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: [scenario]
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P5',
        scenario,
        expected_status: 'REAL_PROJECT_BUSINESS_SOURCE_REPAIR_PASS',
        expected_ledger: {
          min_cell_count: 3,
          min_pass_count: 3,
          min_distinct_semantic_target_count: 3,
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
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain(scenario);
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain(scenario);

    const root = await tempRoot();
    await writeLedger(root, scenario, 'business-source-repair-run', {
      status: 'REAL_PROJECT_BUSINESS_SOURCE_REPAIR_PASS',
      evidence_missing_count: 0,
      codex_repair_smoke: true,
      business_repair_smoke: false,
      business_source_repair_smoke: true,
      business_source_repair: true,
      business_bug_repair: true,
      existing_source_repair_smoke: true,
      existing_source_repair: true,
      semantic_source_repair_smoke: true,
      semantic_source_repair: true,
      semantic_bug_repair: true,
      source_code_repair: true,
      llm_modification: true,
      hidden_acceptance: true,
      source_repos_read_only: true,
      draft_pr: false,
      builder: {
        real_llm: true,
        provider: 'codex',
        model: 'gpt-5.5'
      },
      cell_count: 3,
      pass_count: 3,
      fail_count: 0,
      cells: [
        {
          id: 'checkout-pricing-project',
          status: 'pass',
          codex_repair: {
            status: 'pass',
            business_source_repair: true,
            business_bug_repair: true,
            business_domain: 'checkout_pricing',
            semantic_source_repair: true,
            semantic_bug_repair: true,
            semantic_domain: 'checkout_coupon_segment_eligibility',
            semantic_target_id: 'checkout-pricing-coupon-segment',
            existing_source: true,
            repair_source: 'examples/business-source/checkout-pricing.cjs',
            visible_acceptance: { status: 'pass' },
            hidden_acceptance: { status: 'pass' },
            diff_scope: { status: 'pass' },
            source_changed: true,
            visible_test_unchanged: true,
            source_repo_integrity: { status: 'pass' }
          }
        },
        {
          id: 'subscription-billing-project',
          status: 'pass',
          codex_repair: {
            status: 'pass',
            business_source_repair: true,
            business_bug_repair: true,
            business_domain: 'subscription_billing',
            semantic_source_repair: true,
            semantic_bug_repair: true,
            semantic_domain: 'subscription_invoice_status_eligibility',
            semantic_target_id: 'subscription-seat-billing-active-status',
            existing_source: true,
            repair_source:
              'examples/business-source/subscription-seat-billing.cjs',
            visible_acceptance: { status: 'pass' },
            hidden_acceptance: { status: 'pass' },
            diff_scope: { status: 'pass' },
            source_changed: true,
            visible_test_unchanged: true,
            source_repo_integrity: { status: 'pass' }
          }
        },
        {
          id: 'order-fulfillment-project',
          status: 'pass',
          codex_repair: {
            status: 'pass',
            business_source_repair: true,
            business_bug_repair: true,
            business_domain: 'order_fulfillment',
            semantic_source_repair: true,
            semantic_bug_repair: true,
            semantic_domain: 'order_fulfillment_hazmat_express_eligibility',
            semantic_target_id: 'order-fulfillment-hazmat-express',
            existing_source: true,
            repair_source: 'examples/business-source/order-fulfillment.cjs',
            visible_acceptance: { status: 'pass' },
            hidden_acceptance: { status: 'pass' },
            diff_scope: { status: 'pass' },
            source_changed: true,
            visible_test_unchanged: true,
            source_repo_integrity: { status: 'pass' }
          }
        }
      ]
    });
    await writeManifest(root, scenario, 'business-source-repair-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('pass');
    expect(report.evidence[0]).toEqual(
      expect.objectContaining({
        ok: true,
        scenario,
        ledger_summary: expect.objectContaining({
          status: 'REAL_PROJECT_BUSINESS_SOURCE_REPAIR_PASS',
          business_source_repair_smoke: true,
          business_source_repair: true,
          business_bug_repair: true,
          existing_source_repair: true,
          semantic_source_repair: true,
          hidden_acceptance: true
        })
      })
    );

    await writeLedger(
      root,
      scenario,
      'business-source-repair-weakened-run',
      {
        status: 'REAL_PROJECT_BUSINESS_SOURCE_REPAIR_PASS',
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        business_source_repair_smoke: false,
        business_source_repair: false,
        business_bug_repair: true,
        existing_source_repair_smoke: true,
        existing_source_repair: true,
        semantic_source_repair_smoke: true,
        semantic_source_repair: true,
        semantic_bug_repair: true,
        source_code_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: {
          real_llm: true,
          provider: 'codex',
          model: 'gpt-5.5'
        },
        cell_count: 2,
        pass_count: 2,
        fail_count: 0,
        cells: [
          {
            id: 'checkout-pricing-project',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              business_source_repair: false,
              business_bug_repair: true,
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'checkout_coupon_segment_eligibility',
              semantic_target_id: 'checkout-pricing-coupon-segment',
              existing_source: true,
              repair_source: 'examples/business-source/checkout-pricing.cjs',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          },
          {
            id: 'subscription-billing-project',
            status: 'pass',
            codex_repair: {
              status: 'pass',
              business_source_repair: true,
              business_bug_repair: true,
              business_domain: 'subscription_billing',
              semantic_source_repair: true,
              semantic_bug_repair: true,
              semantic_domain: 'subscription_invoice_status_eligibility',
              semantic_target_id: 'subscription-seat-billing-active-status',
              existing_source: true,
              repair_source:
                'examples/business-source/subscription-seat-billing.cjs',
              visible_acceptance: { status: 'pass' },
              hidden_acceptance: { status: 'pass' },
              diff_scope: { status: 'pass' },
              source_changed: true,
              visible_test_unchanged: true,
              source_repo_integrity: { status: 'pass' }
            }
          }
        ]
      },
      new Date(Date.now() + 1000)
    );
    await writeManifest(root, scenario, 'business-source-repair-weakened-run');

    const weakenedReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(weakenedReport.status).toBe('fail');
    expect(weakenedReport.evidence[0].ledger_failures).toEqual(
      expect.arrayContaining([
        'business_source_repair',
        'cells.checkout-pricing-project.codex_repair.business_source_repair',
        'cells.checkout-pricing-project.codex_repair.business_domain'
      ])
    );
  });

  it('keeps real Codex existing-source repair corpus audit explicit and requires existing source evidence', async () => {
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: ['repo-matrix-real-project-existing-source-repair-uat']
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P5',
        scenario: 'repo-matrix-real-project-existing-source-repair-uat',
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
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain('repo-matrix-real-project-existing-source-repair-uat');
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain('repo-matrix-real-project-existing-source-repair-uat');

    const root = await tempRoot();
    const existingSourceRepairCells = [
      ['sampleproject', 'noxfile.py'],
      ['click', 'docs/conf.py'],
      ['express', 'examples/auth/index.js'],
      ['js-yaml', 'benchmark/benchmark.mjs'],
      ['requests', 'docs/conf.py'],
      ['urllib3', 'src/urllib3/contrib/emscripten/emscripten_fetch_worker.js'],
      ['itsdangerous', 'docs/conf.py'],
      ['packaging', 'benchmarks/__init__.py']
    ].map(([id, repairSource]) => ({
      id,
      status: 'pass',
      codex_repair: {
        status: 'pass',
        repair_source: repairSource,
        existing_source: true,
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
      'repo-matrix-real-project-existing-source-repair-uat',
      'real-project-existing-source-repair-run',
      {
        status: 'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS',
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        existing_source_repair_smoke: true,
        source_code_repair: true,
        existing_source_repair: true,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: {
          real_llm: true,
          provider: 'codex',
          model: 'gpt-5.5'
        },
        cell_count: existingSourceRepairCells.length,
        pass_count: existingSourceRepairCells.length,
        fail_count: 0,
        cells: existingSourceRepairCells
      }
    );
    await writeManifest(
      root,
      'repo-matrix-real-project-existing-source-repair-uat',
      'real-project-existing-source-repair-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['repo-matrix-real-project-existing-source-repair-uat']
    });

    expect(report.status).toBe('pass');
    expect(report.evidence).toEqual([
      expect.objectContaining({
        gate: 'P5',
        ok: true,
        scenario: 'repo-matrix-real-project-existing-source-repair-uat',
        ledger_summary: expect.objectContaining({
          status: 'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS',
          codex_repair_smoke: true,
          existing_source_repair: true,
          source_code_repair: true,
          llm_modification: true,
          hidden_acceptance: true,
          source_repos_read_only: true,
          draft_pr: false
        })
      })
    ]);

    await writeLedger(
      root,
      'repo-matrix-real-project-existing-source-repair-uat',
      'real-project-existing-source-repair-weakened-run',
      {
        status: 'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS',
        evidence_missing_count: 0,
        codex_repair_smoke: true,
        existing_source_repair_smoke: false,
        source_code_repair: true,
        existing_source_repair: false,
        llm_modification: true,
        hidden_acceptance: true,
        source_repos_read_only: true,
        draft_pr: false,
        builder: {
          real_llm: true,
          provider: 'codex',
          model: 'gpt-5.5'
        },
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
      },
      new Date(Date.now() + 1000)
    );
    await writeManifest(
      root,
      'repo-matrix-real-project-existing-source-repair-uat',
      'real-project-existing-source-repair-weakened-run'
    );

    const weakenedReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['repo-matrix-real-project-existing-source-repair-uat']
    });

    expect(weakenedReport.status).toBe('fail');
    expect(weakenedReport.evidence[0].ledger_failures).toEqual(
      expect.arrayContaining([
        'existing_source_repair',
        'cells.sampleproject.codex_repair.existing_source',
        'cells.sampleproject.codex_repair.repair_source'
      ])
    );
  });

  it('keeps real Codex semantic source repair corpus audit explicit and requires semantic evidence', async () => {
    const scenario = 'repo-matrix-real-project-semantic-source-repair-uat';
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: [scenario]
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P5',
        scenario,
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
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain(scenario);
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain(scenario);

    const root = await tempRoot();
    await writeLedger(root, scenario, 'semantic-source-repair-run', {
      status: 'REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_PASS',
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
      builder: {
        real_llm: true,
        provider: 'codex',
        model: 'gpt-5.5'
      },
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
    });
    await writeManifest(root, scenario, 'semantic-source-repair-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('pass');
    expect(report.evidence).toEqual([
      expect.objectContaining({
        gate: 'P5',
        ok: true,
        scenario,
        ledger_summary: expect.objectContaining({
          status: 'REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_PASS',
          codex_repair_smoke: true,
          existing_source_repair: true,
          semantic_source_repair: true,
          semantic_bug_repair: true,
          source_code_repair: true,
          llm_modification: true,
          hidden_acceptance: true,
          source_repos_read_only: true,
          draft_pr: false
        })
      })
    ]);

    await writeLedger(
      root,
      scenario,
      'semantic-source-repair-weakened-run',
      {
        status: 'REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_PASS',
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
        builder: {
          real_llm: true,
          provider: 'codex',
          model: 'gpt-5.5'
        },
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
      },
      new Date(Date.now() + 1000)
    );
    await writeManifest(root, scenario, 'semantic-source-repair-weakened-run');

    const weakenedReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(weakenedReport.status).toBe('fail');
    expect(weakenedReport.evidence[0].ledger_failures).toEqual(
      expect.arrayContaining([
        'semantic_source_repair',
        'semantic_bug_repair',
        'cells.sampleproject.codex_repair.semantic_source_repair',
        'cells.sampleproject.codex_repair.semantic_bug_repair',
        'cells.sampleproject.codex_repair.semantic_domain'
      ])
    );
  });

  it('keeps real Codex existing-source repair draft PR corpus audit explicit and requires PR evidence', async () => {
    const scenario = 'repo-matrix-real-project-existing-source-repair-pr-uat';
    const selected = selectReleaseEvidenceAuditScenarios({
      scenarioNames: [scenario]
    });
    expect(selected).toEqual([
      expect.objectContaining({
        gate: 'P5',
        scenario,
        expected_status: 'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_PASS',
        expected_ledger: expect.objectContaining({
          required_existing_source_repair: true,
          required_draft_pr: true,
          required_github_draft_pr: true
        })
      })
    ]);
    expect(
      SELECTABLE_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).toContain(scenario);
    expect(
      ALL_RELEASE_EVIDENCE_AUDIT_SCENARIOS.map((item) => item.scenario)
    ).not.toContain(scenario);

    const root = await tempRoot();
    await writeLedger(root, scenario, 'existing-source-repair-pr-run', {
      status: 'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_PASS',
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
          id: 'node-real-project',
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
              draft_pr_verified: true,
              main_unchanged: true,
              pr_url:
                'https://github.com/coreline-ai/vibeloop-real-project-repair-a/pull/1'
            }
          }
        },
        {
          id: 'python-real-project',
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
    });
    await writeManifest(root, scenario, 'existing-source-repair-pr-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(report.status).toBe('pass');
    expect(report.evidence).toEqual([
      expect.objectContaining({
        gate: 'P5',
        ok: true,
        scenario,
        ledger_summary: expect.objectContaining({
          status: 'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_PASS',
          existing_source_repair: true,
          draft_pr: true,
          github_draft_pr: true,
          github_draft_pr_verified: true
        })
      })
    ]);

    await writeLedger(
      root,
      scenario,
      'existing-source-repair-pr-weakened-run',
      {
        status: 'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_PASS',
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
            id: 'node-real-project',
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
            id: 'python-real-project',
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
      },
      new Date(Date.now() + 1000)
    );
    await writeManifest(
      root,
      scenario,
      'existing-source-repair-pr-weakened-run'
    );

    const weakenedReport = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: [scenario]
    });

    expect(weakenedReport.status).toBe('fail');
    expect(weakenedReport.evidence[0].ledger_failures).toEqual(
      expect.arrayContaining([
        'draft_pr',
        'github_draft_pr',
        'cells.node-real-project.codex_repair.github.draft_pr_verified',
        'cells.node-real-project.codex_repair.github.main_unchanged',
        'cells.node-real-project.codex_repair.github.pr_url'
      ])
    );
  });

  it('audits explicit Product-100 evidence with every fixed requirement and Phase7 proof', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'product-100-codex-live-uat',
      'product-100-pass-run',
      product100PassLedger()
    );
    await writeManifest(
      root,
      'product-100-codex-live-uat',
      'product-100-pass-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['product-100-codex-live-uat']
    });

    expect(report.status).toBe('pass');
    expect(report.scope).toBe('custom');
    expect(report.audit_summary).toEqual(
      expect.objectContaining({
        required_count: 1,
        passed_count: 1,
        failed_count: 0,
        copied_integrity_checked_count: 1
      })
    );
    expect(report.evidence).toEqual([
      expect.objectContaining({
        gate: 'P6',
        ok: true,
        scenario: 'product-100-codex-live-uat',
        ledger_summary: expect.objectContaining({
          status: PRODUCT_100_PASS_STATUS,
          product_100: expect.objectContaining({
            evaluation_pass: true,
            phase4_pass: true,
            phase5_pass: true,
            phase6_pass: true,
            phase7_pass: true,
            live_loop_started: true
          })
        })
      })
    ]);
  });

  it('rejects explicit Product-100 evidence when a fixed requirement is missing', async () => {
    const root = await tempRoot();
    const requirements = Object.fromEntries(
      PRODUCT_100_REQUIRED_REQUIREMENTS.map((name) => [name, true])
    );
    requirements.strict_score_improvement_every_issue = false;
    await writeLedger(
      root,
      'product-100-codex-live-uat',
      'product-100-fail-run',
      product100PassLedger({
        evaluation: {
          status: 'PRODUCT_100_CODEX_LIVE_FAIL',
          pass: false,
          satisfied: PRODUCT_100_REQUIRED_REQUIREMENTS.filter(
            (name) => requirements[name]
          ),
          missing_requirements: ['strict_score_improvement_every_issue'],
          requirements
        },
        ledger: { status: 'PRODUCT_100_CODEX_LIVE_FAIL' }
      })
    );
    await writeManifest(
      root,
      'product-100-codex-live-uat',
      'product-100-fail-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root],
      scenarioNames: ['product-100-codex-live-uat']
    });

    expect(report.status).toBe('fail');
    expect(report.failed_gates).toEqual(['P6']);
    expect(report.evidence).toEqual([
      expect.objectContaining({
        ok: false,
        status: 'invalid_ledger',
        ledger_failures: expect.arrayContaining([
          'status',
          'product_100.evaluation.status',
          'product_100.evaluation.pass',
          'product_100.missing_requirements',
          'product_100.requirements.strict_score_improvement_every_issue'
        ])
      })
    ]);
  });

  it('rejects unknown or conflicting audit scenario selection', () => {
    expect(() =>
      selectReleaseEvidenceAuditScenarios({
        scenarioNames: ['missing-scenario']
      })
    ).toThrow('unknown scenario: missing-scenario');
    expect(() =>
      selectReleaseEvidenceAuditScenarios({
        allReleaseEvidence: true,
        scenarioNames: ['repo-matrix-uat']
      })
    ).toThrow('--all-release-evidence cannot be combined with --scenario');
  });

  it('discovers unmerged GitHub artifact directories under a download root', async () => {
    const parent = await tempRoot();
    const postgresRoot = path.join(parent, 'postgres-contract-evidence-1');
    const adversaryRoot = path.join(parent, 'adversary-live-evidence-1');
    const matrixRoot = path.join(parent, 'uat-evidence-1');

    await writeLedger(
      postgresRoot,
      'postgres-contract-uat',
      'postgres-run',
      postgresLedger()
    );
    await writeManifest(postgresRoot, 'postgres-contract-uat', 'postgres-run');
    await writeLedger(
      adversaryRoot,
      'adversary-live-uat',
      'adversary-run',
      adversaryLedger()
    );
    await writeManifest(adversaryRoot, 'adversary-live-uat', 'adversary-run');
    await writeLedger(
      matrixRoot,
      'repo-matrix-uat',
      'matrix-run',
      matrixLedger()
    );
    await writeManifest(matrixRoot, 'repo-matrix-uat', 'matrix-run');

    await expect(discoverEvidenceRoots([parent])).resolves.toEqual(
      [adversaryRoot, postgresRoot, matrixRoot].sort()
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [parent]
    });

    expect(report.status).toBe('pass');
    expect(report.evidence_roots).toEqual(
      [adversaryRoot, postgresRoot, matrixRoot].sort()
    );
  });

  it('fails P4 when a downloaded adversary artifact weakens safety evidence', async () => {
    const root = await tempRoot();
    await writeValidCiEvidence(root);
    await writeLedger(
      root,
      'adversary-live-uat',
      'unsafe-adversary-run',
      adversaryLedger({
        safety: {
          ...adversarySafetyLedger().safety,
          host_execution_allowed: true
        }
      }),
      new Date('2030-01-01T00:00:00.000Z')
    );
    await writeManifest(root, 'adversary-live-uat', 'unsafe-adversary-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root]
    });

    expect(report.status).toBe('fail');
    expect(report.failed_gates).toEqual(['P4']);
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'P4',
          ok: false,
          status: 'invalid_ledger',
          ledger_failures: expect.arrayContaining([
            'adversary_safety.host_execution_allowed'
          ])
        })
      ])
    );
    expect(releaseEvidenceAuditExitCode(report)).toBe(1);
  });

  it('fails P4 when a downloaded attack scenario allows current-loop impact', async () => {
    const root = await tempRoot();
    await writeValidCiEvidence(root);
    const weakenedAttackScenarios = attackScenarios();
    weakenedAttackScenarios.results[0] = {
      ...weakenedAttackScenarios.results[0],
      live_required: false,
      current_loop_impact: 'current_loop_accept',
      pr_created: true,
      promotion_allowed: true,
      blocked: false
    };
    await writeLedger(
      root,
      'adversary-live-uat',
      'impact-adversary-run',
      adversaryLedger({
        attack_scenarios: weakenedAttackScenarios
      }),
      new Date('2030-01-01T00:00:00.000Z')
    );
    await writeManifest(root, 'adversary-live-uat', 'impact-adversary-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root]
    });

    expect(report.status).toBe('fail');
    expect(report.failed_gates).toEqual(['P4']);
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'P4',
          ok: false,
          status: 'invalid_ledger',
          ledger_failures: expect.arrayContaining([
            'attack_scenarios.test_weakening.live_required',
            'attack_scenarios.test_weakening.current_loop_impact',
            'attack_scenarios.test_weakening.pr_created',
            'attack_scenarios.test_weakening.promotion_allowed',
            'attack_scenarios.test_weakening.blocked'
          ])
        })
      ])
    );
    expect(releaseEvidenceAuditExitCode(report)).toBe(1);
  });

  it('fails P4 when a downloaded semantic attack scenario was not executed', async () => {
    const root = await tempRoot();
    await writeValidCiEvidence(root);
    const notExecutedAttackScenarios = attackScenarios();
    notExecutedAttackScenarios.results = notExecutedAttackScenarios.results.map(
      (scenario) =>
        scenario.id === 'gift_card_redemption_hardcode'
          ? { ...scenario, executed: false }
          : scenario
    );
    await writeLedger(
      root,
      'adversary-live-uat',
      'not-executed-adversary-run',
      adversaryLedger({
        attack_scenarios: notExecutedAttackScenarios
      }),
      new Date('2030-01-01T00:00:00.000Z')
    );
    await writeManifest(
      root,
      'adversary-live-uat',
      'not-executed-adversary-run'
    );

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root]
    });

    expect(report.status).toBe('fail');
    expect(report.failed_gates).toEqual(['P4']);
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'P4',
          ok: false,
          status: 'invalid_ledger',
          ledger_failures: expect.arrayContaining([
            'attack_scenarios.gift_card_redemption_hardcode.executed'
          ])
        })
      ])
    );
    expect(releaseEvidenceAuditExitCode(report)).toBe(1);
  });

  it('fails P4 when downloaded reviewer provenance overclaims real LLM review', async () => {
    const root = await tempRoot();
    await writeValidCiEvidence(root);
    await writeLedger(
      root,
      'adversary-live-uat',
      'reviewer-overclaim-run',
      adversaryLedger({
        adversary_reviewer: {
          ...buildControlledAdversaryReviewerProvenance(),
          real_llm: true,
          current_loop_decision_impact: 'accept'
        }
      }),
      new Date('2030-01-01T00:00:00.000Z')
    );
    await writeManifest(root, 'adversary-live-uat', 'reviewer-overclaim-run');

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root]
    });

    expect(report.status).toBe('fail');
    expect(report.failed_gates).toEqual(['P4']);
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'P4',
          ok: false,
          status: 'invalid_ledger',
          ledger_failures: expect.arrayContaining([
            'adversary_reviewer.real_llm',
            'adversary_reviewer.current_loop_decision_impact'
          ])
        })
      ])
    );
    expect(releaseEvidenceAuditExitCode(report)).toBe(1);
  });

  it('fails when a downloaded artifact manifest hash does not match the copied file', async () => {
    const root = await tempRoot();
    await writeValidCiEvidence(root);
    await writeLedger(
      root,
      'repo-matrix-uat',
      'tampered-matrix-run',
      matrixLedger(),
      new Date('2030-01-01T00:00:00.000Z')
    );
    await writeManifest(root, 'repo-matrix-uat', 'tampered-matrix-run', {
      copied: [
        {
          kind: 'ledger',
          bundle_path: 'ledger.json',
          sha256: 'f'.repeat(64),
          size_bytes: 1
        }
      ]
    });

    const report = await buildReleaseEvidenceAuditReport({
      evidenceRoots: [root]
    });

    expect(report.status).toBe('fail');
    expect(report.failed_gates).toEqual(['P5']);
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: 'P5',
          ok: false,
          status: 'invalid_manifest',
          manifest_failures: expect.arrayContaining([
            'copied[0].size_bytes',
            'copied[0].sha256'
          ])
        })
      ])
    );
  });
});

import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildProduct100CodexLiveUatReport,
  product100AgentTimeoutSeconds,
  product100CandidatesPerIssue,
  product100CodexLiveReportPath,
  product100IssueFilter,
  product100StrictBestRetries,
  product100GithubOwner,
  product100GithubRepoName,
  shouldProvisionProduct100GithubRepos,
  product100TmpParent,
  product100CodexLiveUatExitCode,
  shouldRetryProduct100StrictBest,
  writeProduct100CodexLiveReport
} from './product-100-codex-live-uat.mjs';

const passPreflight = {
  status: 'pass',
  blocked_requirements: [],
  required_failures: [],
  checks: {
    live: { status: 'pass' },
    r1_adversary_container: { status: 'pass' },
    real_adversary_reviewer: { ok: true }
  }
};

const blockedPreflight = {
  status: 'blocked',
  blocked_requirements: ['r1_container_preflight_pass'],
  required_failures: ['r1_container_preflight'],
  checks: {
    live: { status: 'pass' },
    r1_adversary_container: { status: 'blocked' },
    real_adversary_reviewer: { ok: false }
  },
  next_step: 'start docker'
};

const phase4Pass = {
  issue_count: 10,
  expected_issue_count: 10,
  all_issues_covered: true,
  real_codex_builder_used_every_issue: true,
  real_codex_challenger_used_every_issue: true,
  hidden_eval_generated_and_passed_every_issue: true,
  strict_score_improvement_every_issue: true,
  every_issue_pr_candidate: true,
  rediscovery_after_each_fix: true,
  every_issue_product_100_phase4_pass: true,
  false_pass_zero: true,
  leak_zero: true,
  evidence_missing_count_zero: true,
  issues: []
};

const baseValidationPass = {
  visible_base_fail_every_issue: true,
  hidden_base_fail_every_issue: true,
  issue_count: 10,
  results: []
};

describe('Product-100 Codex live UAT driver contract', () => {
  it('writes a durable live report under the phase4 evidence root', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'p100-report-'));
    const report = {
      status: 'PRODUCT_100_CODEX_LIVE_FAIL',
      summary: {
        phase4: {
          tmp_root: tmpRoot
        }
      },
      evidence: {}
    };

    const reportPath = await writeProduct100CodexLiveReport(report, {});
    const written = JSON.parse(await readFile(reportPath, 'utf8'));

    expect(product100CodexLiveReportPath(report, {})).toBe(
      path.join(tmpRoot, 'product-100-live-report.json')
    );
    expect(reportPath).toBe(path.join(tmpRoot, 'product-100-live-report.json'));
    expect(report.report_file).toBe(reportPath);
    expect(report.evidence.product_100_live_report).toBe(reportPath);
    expect(written.report_file).toBe(reportPath);
    expect(written.evidence.product_100_live_report).toBe(reportPath);
  });

  it('allows an explicit Product-100 report file override', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'p100-report-env-'));
    const explicitPath = path.join(tmpRoot, 'custom', 'ledger.json');
    const report = { status: 'PRODUCT_100_CODEX_LIVE_FAIL', evidence: {} };

    const reportPath = await writeProduct100CodexLiveReport(report, {
      VIBELOOP_PRODUCT_100_REPORT_FILE: explicitPath
    });

    expect(reportPath).toBe(explicitPath);
    expect(JSON.parse(await readFile(explicitPath, 'utf8')).report_file).toBe(
      explicitPath
    );
  });

  it('defaults live R1 worktree roots to a container-mountable home data directory', () => {
    const parent = product100TmpParent({});

    expect(parent).toBe(path.join(os.homedir(), '.vibeloop'));
    expect(parent.startsWith(os.tmpdir())).toBe(false);
  });

  it('allows explicit Product-100 tmp parent override for controlled runners', () => {
    expect(
      product100TmpParent({
        VIBELOOP_PRODUCT_100_TMP_PARENT: '/tmp/product-100-controlled'
      })
    ).toBe('/tmp/product-100-controlled');
  });

  it('defaults to enough candidates to prove strict-best instead of one-shot pass', () => {
    expect(product100CandidatesPerIssue({})).toBe(4);
    expect(
      product100CandidatesPerIssue({
        VIBELOOP_PRODUCT_100_CANDIDATES_PER_ISSUE: '6'
      })
    ).toBe(6);
    expect(
      product100CandidatesPerIssue({
        VIBELOOP_PRODUCT_100_CANDIDATES_PER_ISSUE: '1'
      })
    ).toBe(4);
  });



  it('defines explicit Phase6 GitHub repo provisioning controls without enabling side effects by default', () => {
    expect(shouldProvisionProduct100GithubRepos({})).toBe(false);
    expect(
      shouldProvisionProduct100GithubRepos({
        VIBELOOP_PRODUCT_100_ENABLE_GITHUB_REPOS: '1'
      })
    ).toBe(true);
    expect(
      product100GithubOwner({ VIBELOOP_PRODUCT_100_GITHUB_OWNER: 'coreline-ai' })
    ).toBe('coreline-ai');
    expect(product100GithubRepoName('product-100-1234567890', 'node-monorepo-scope')).toMatch(
      /^vibeloop-p100-product-100-1234567890-node-monorepo-scope$/
    );
  });

  it('bounds Product-100 live agent timeouts and strict-best retries by explicit env', () => {
    expect(product100AgentTimeoutSeconds({})).toBe(240);
    expect(
      product100AgentTimeoutSeconds({
        VIBELOOP_PRODUCT_100_AGENT_TIMEOUT_SECONDS: '120'
      })
    ).toBe(120);
    expect(
      product100AgentTimeoutSeconds({
        VIBELOOP_PRODUCT_100_AGENT_TIMEOUT_SECONDS: '10'
      })
    ).toBe(240);
    expect(product100StrictBestRetries({})).toBe(2);
    expect(
      product100StrictBestRetries({
        VIBELOOP_PRODUCT_100_STRICT_BEST_RETRIES: '0'
      })
    ).toBe(0);
  });

  it('retries Product-100 strict-best only for accepted single-comparator shortages', () => {
    expect(
      shouldRetryProduct100StrictBest({
        pr_candidate: true,
        accepted_count: 1,
        selection_quality: {
          status: 'single_accepted_no_comparator',
          strict_score_improvement: false,
          reasons: ['only_one_accepted_candidate']
        }
      })
    ).toBe(true);
    expect(
      shouldRetryProduct100StrictBest({
        pr_candidate: true,
        accepted_count: 2,
        selection_quality: { strict_score_improvement: true }
      })
    ).toBe(false);
    expect(shouldRetryProduct100StrictBest({ pr_candidate: false })).toBe(false);
  });

  it('supports explicit issue filters for targeted live reruns without redefining full coverage', () => {
    const filter = product100IssueFilter({
      VIBELOOP_PRODUCT_100_ISSUE_IDS: 'PY-001,node-monorepo-scope/NM-002'
    });
    expect(filter.active).toBe(true);
    expect(filter.values).toEqual(['PY-001', 'NODE-MONOREPO-SCOPE/NM-002']);
    expect(filter.matches({ repo_id: 'python-service-quantity', issue_id: 'PY-001' })).toBe(true);
    expect(filter.matches({ repo_id: 'node-monorepo-scope', issue_id: 'NM-002' })).toBe(true);
    expect(filter.matches({ repo_id: 'node-monorepo-scope', issue_id: 'NM-001' })).toBe(false);
  });

  it('returns BLOCKED, not PASS, when Product-100 preflight is blocked', async () => {
    const report = await buildProduct100CodexLiveUatReport({
      preflightReport: blockedPreflight,
      baseValidationReport: baseValidationPass,
      runId: 'test-run'
    });
    expect(report.status).toBe('PRODUCT_100_CODEX_LIVE_BLOCKED');
    expect(report.evaluation.pass).toBe(false);
    expect(report.evaluation.requirements.live_preflight_pass).toBe(true);
    expect(report.evaluation.requirements.r1_container_preflight_pass).toBe(false);
    expect(report.summary.base_validation.visible_base_fail_every_issue).toBe(true);
    expect(product100CodexLiveUatExitCode(report)).toBe(20);
  });

  it('maps Phase 4 real-loop evidence into fixed requirements but still refuses Product-100 PASS before Phase5/6/7', async () => {
    const report = await buildProduct100CodexLiveUatReport({
      preflightReport: passPreflight,
      phase4Report: phase4Pass,
      baseValidationReport: baseValidationPass,
      runId: 'test-run'
    });
    expect(report.status).toBe('PRODUCT_100_CODEX_LIVE_FAIL');
    expect(report.fail_reason).toBe('PRODUCT_100_PHASE5_NOT_IMPLEMENTED');
    expect(report.evaluation.pass).toBe(false);
    expect(report.evaluation.requirements.real_codex_builder_used_every_issue).toBe(true);
    expect(report.evaluation.requirements.real_codex_challenger_used_every_issue).toBe(true);
    expect(report.evaluation.requirements.hidden_eval_generated_and_passed_every_issue).toBe(true);
    expect(report.evaluation.requirements.strict_score_improvement_every_issue).toBe(true);
    expect(report.evaluation.missing_requirements).toContain('m2_confirmed_under_r1');
    expect(product100CodexLiveUatExitCode(report)).toBe(1);
  });


  it('maps Phase5 evidence but still refuses Product-100 PASS before Phase6/7', async () => {
    const phase5Pass = {
      phase5_pass: true,
      real_codex_adversary_reviewer_used: true,
      accepted_review_proposal_count_at_least_one: true,
      same_model_review_false: true,
      m2_confirmed_under_r1: true,
      m4_replay_safe_under_r1: true,
      frozen_rulepack_semantic_gate_passed_next_loop: true
    };
    const report = await buildProduct100CodexLiveUatReport({
      preflightReport: passPreflight,
      phase4Report: phase4Pass,
      phase5Report: phase5Pass,
      baseValidationReport: baseValidationPass,
      runId: 'test-run'
    });
    expect(report.status).toBe('PRODUCT_100_CODEX_LIVE_FAIL');
    expect(report.fail_reason).toBe('PRODUCT_100_PHASE6_NOT_IMPLEMENTED');
    expect(report.evaluation.requirements.real_codex_adversary_reviewer_used).toBe(true);
    expect(report.evaluation.requirements.accepted_review_proposal_count_at_least_one).toBe(true);
    expect(report.evaluation.requirements.m2_confirmed_under_r1).toBe(true);
    expect(report.evaluation.requirements.frozen_rulepack_semantic_gate_passed_next_loop).toBe(true);
    expect(report.evaluation.missing_requirements).toContain('github_draft_prs_open');
  });

  it('runs the aggregate Phase5 runner after Phase4 pass and maps its requirements', async () => {
    let runnerCalled = false;
    const report = await buildProduct100CodexLiveUatReport({
      preflightReport: passPreflight,
      phase4Report: phase4Pass,
      phase5Runner: async ({ phase4 }) => {
        runnerCalled = true;
        expect(phase4.every_issue_product_100_phase4_pass).toBe(true);
        return {
          kind: 'product_100_phase5_issue_aggregate',
          phase5_pass: true,
          issue_count: 10,
          expected_issue_count: 10,
          all_issues_covered: true,
          real_codex_adversary_reviewer_used: true,
          accepted_review_proposal_count_at_least_one: true,
          same_model_review_false: true,
          m2_confirmed_under_r1: true,
          m4_replay_safe_under_r1: true,
          frozen_rulepack_ready_next_loop: true,
          frozen_rulepack_semantic_gate_passed_next_loop: true,
          issues: []
        };
      },
      baseValidationReport: baseValidationPass,
      runId: 'test-run'
    });

    expect(runnerCalled).toBe(true);
    expect(report.status).toBe('PRODUCT_100_CODEX_LIVE_FAIL');
    expect(report.fail_reason).toBe('PRODUCT_100_PHASE6_NOT_IMPLEMENTED');
    expect(report.summary.phase5.kind).toBe(
      'product_100_phase5_issue_aggregate'
    );
    expect(report.evaluation.requirements.m2_confirmed_under_r1).toBe(true);
    expect(
      report.evaluation.requirements
        .frozen_rulepack_semantic_gate_passed_next_loop
    ).toBe(true);
  });

  it('runs Phase6 runner after aggregate Phase5 pass and still requires Phase7', async () => {
    let phase6RunnerCalled = false;
    const phase5Pass = {
      kind: 'product_100_phase5_issue_aggregate',
      phase5_pass: true,
      real_codex_adversary_reviewer_used: true,
      accepted_review_proposal_count_at_least_one: true,
      same_model_review_false: true,
      m2_confirmed_under_r1: true,
      m4_replay_safe_under_r1: true,
      frozen_rulepack_semantic_gate_passed_next_loop: true
    };
    const report = await buildProduct100CodexLiveUatReport({
      preflightReport: passPreflight,
      phase4Report: phase4Pass,
      phase5Report: phase5Pass,
      phase6Runner: async ({ phase4, phase5 }) => {
        phase6RunnerCalled = true;
        expect(phase4.every_issue_product_100_phase4_pass).toBe(true);
        expect(phase5.phase5_pass).toBe(true);
        return {
          kind: 'product_100_phase6_release',
          phase6_pass: true,
          github_draft_prs_open: true,
          evidence_missing_count_zero: true,
          evidence_copied_count_positive: true,
          release_evidence_audit_pass: true
        };
      },
      baseValidationReport: baseValidationPass,
      runId: 'test-run'
    });

    expect(phase6RunnerCalled).toBe(true);
    expect(report.fail_reason).toBe('PRODUCT_100_PHASE7_NOT_IMPLEMENTED');
    expect(report.summary.phase6.kind).toBe('product_100_phase6_release');
    expect(report.evaluation.requirements.github_draft_prs_open).toBe(true);
    expect(report.evaluation.requirements.release_evidence_audit_pass).toBe(true);
    expect(report.evaluation.requirements.docs_run_ledger_readme_truthful).toBe(false);
  });

  it('runs Phase7 docs checker with a desired PASS ledger after Phase6 pass', async () => {
    let phase7RunnerCalled = false;
    const phase5Pass = {
      phase5_pass: true,
      real_codex_adversary_reviewer_used: true,
      accepted_review_proposal_count_at_least_one: true,
      same_model_review_false: true,
      m2_confirmed_under_r1: true,
      m4_replay_safe_under_r1: true,
      frozen_rulepack_semantic_gate_passed_next_loop: true
    };
    const phase6Pass = {
      phase6_pass: true,
      github_draft_prs_open: true,
      evidence_missing_count_zero: true,
      evidence_copied_count_positive: true,
      release_evidence_audit_pass: true
    };
    const report = await buildProduct100CodexLiveUatReport({
      preflightReport: passPreflight,
      phase4Report: phase4Pass,
      phase5Report: phase5Pass,
      phase6Report: phase6Pass,
      phase7Runner: async ({ ledger, runId }) => {
        phase7RunnerCalled = true;
        expect(runId).toBe('test-run');
        expect(ledger.status).toBe('PRODUCT_100_CODEX_LIVE_PASS');
        expect(ledger.evaluation.missing_requirements).toEqual([]);
        return {
          phase7_pass: true,
          docs_run_ledger_readme_truthful: true
        };
      },
      baseValidationReport: baseValidationPass,
      runId: 'test-run'
    });

    expect(phase7RunnerCalled).toBe(true);
    expect(report.status).toBe('PRODUCT_100_CODEX_LIVE_PASS');
    expect(report.evaluation.pass).toBe(true);
    expect(report.evaluation.requirements.docs_run_ledger_readme_truthful).toBe(true);
  });


  it('maps Phase6 evidence but still refuses Product-100 PASS before Phase7 documentation/run-ledger closure', async () => {
    const phase5Pass = {
      phase5_pass: true,
      real_codex_adversary_reviewer_used: true,
      accepted_review_proposal_count_at_least_one: true,
      same_model_review_false: true,
      m2_confirmed_under_r1: true,
      m4_replay_safe_under_r1: true,
      frozen_rulepack_semantic_gate_passed_next_loop: true
    };
    const phase6Pass = {
      phase6_pass: true,
      github_draft_prs_open: true,
      evidence_missing_count_zero: true,
      evidence_copied_count_positive: true,
      release_evidence_audit_pass: true
    };
    const report = await buildProduct100CodexLiveUatReport({
      preflightReport: passPreflight,
      phase4Report: phase4Pass,
      phase5Report: phase5Pass,
      phase6Report: phase6Pass,
      baseValidationReport: baseValidationPass,
      runId: 'test-run'
    });
    expect(report.status).toBe('PRODUCT_100_CODEX_LIVE_FAIL');
    expect(report.fail_reason).toBe('PRODUCT_100_PHASE7_NOT_IMPLEMENTED');
    expect(report.evaluation.pass).toBe(false);
    expect(report.evaluation.requirements.github_draft_prs_open).toBe(true);
    expect(report.evaluation.requirements.release_evidence_audit_pass).toBe(true);
    expect(report.evaluation.requirements.docs_run_ledger_readme_truthful).toBe(false);
    expect(report.evaluation.missing_requirements).toEqual(['docs_run_ledger_readme_truthful']);
  });

  it('keeps Phase 4 failures as Product-100 FAIL even after preflight passes', async () => {
    const report = await buildProduct100CodexLiveUatReport({
      preflightReport: passPreflight,
      phase4Report: { ...phase4Pass, strict_score_improvement_every_issue: false, every_issue_product_100_phase4_pass: false },
      baseValidationReport: baseValidationPass,
      runId: 'test-run'
    });
    expect(report.status).toBe('PRODUCT_100_CODEX_LIVE_FAIL');
    expect(report.fail_reason).toBe('PRODUCT_100_PHASE4_FAIL');
    expect(report.evaluation.requirements.strict_score_improvement_every_issue).toBe(false);
  });
});

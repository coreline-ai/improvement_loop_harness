import { describe, expect, it } from 'vitest';
import {
  evaluateProduct100IssueLoop,
  isRealCodexCandidate,
  scoreProduct100Candidate,
  selectProduct100StrictBest
} from './product-100-strict-best.mjs';

function candidate(id, role, overrides = {}) {
  return {
    id,
    role,
    accepted: true,
    provenance: { real_llm: true, provider: 'codex', fixture: false },
    gates: {
      visible: true,
      hidden: true,
      scope: true,
      artifact_leak: true,
      test_on_base: true,
      final_reverify: true
    },
    metrics: {
      changed_files: 2,
      changed_lines: 20,
      evidence_count: 2,
      regression_tests_added: 1,
      target_touched: true,
      protected_files_touched: 0,
      leak_count: 0
    },
    ...overrides
  };
}

describe('Product-100 strict-best selector', () => {
  it('only treats real Codex non-fixture candidates as eligible', () => {
    expect(isRealCodexCandidate(candidate('real', 'builder'))).toBe(true);
    expect(
      isRealCodexCandidate(
        candidate('fixture', 'builder', {
          provenance: { real_llm: false, provider: 'command', fixture: true }
        })
      )
    ).toBe(false);
  });

  it('scores only candidates that pass visible, hidden, scope, leak, base, and final reverify gates', () => {
    const rejected = scoreProduct100Candidate(
      candidate('bad', 'builder', { gates: { visible: true, hidden: false } })
    );
    expect(rejected.accepted_for_selection).toBe(false);
    expect(rejected.reasons).toContain('gate_hidden_not_pass');
  });

  it('selects the fixed-score best candidate and requires a real builder and challenger comparator', () => {
    const verboseBuilder = candidate('builder-verbose', 'builder', {
      metrics: { changed_files: 4, changed_lines: 120, evidence_count: 1, regression_tests_added: 1, target_touched: true }
    });
    const compactChallenger = candidate('challenger-compact', 'challenger', {
      metrics: { changed_files: 2, changed_lines: 18, evidence_count: 2, regression_tests_added: 1, target_touched: true }
    });
    const selection = selectProduct100StrictBest([verboseBuilder, compactChallenger]);
    expect(selection.selected_candidate_id).toBe('challenger-compact');
    expect(selection.runner_up_candidate_id).toBe('builder-verbose');
    expect(selection.strict_score_improvement).toBe(true);
    expect(selection.accepted_for_product_100).toBe(true);
  });

  it('rejects single accepted candidate because there is no strict comparator', () => {
    const selection = selectProduct100StrictBest([candidate('only', 'builder')]);
    expect(selection.strict_score_improvement).toBe(false);
    expect(selection.accepted_for_product_100).toBe(false);
  });

  it('accepts independent candidates that converge on the exact same patch hash', () => {
    const selection = selectProduct100StrictBest([
      candidate('builder-converged', 'builder', { patch_hash: 'sha256:same' }),
      candidate('challenger-converged', 'challenger', { patch_hash: 'sha256:same' })
    ]);
    expect(selection.strict_score_improvement).toBe(true);
    expect(selection.equivalent_patch_convergence).toBe(true);
    expect(selection.accepted_for_product_100).toBe(true);
  });

  it('summarizes issue-loop requirements for Product-100 contract consumption', () => {
    const issueResults = [
      {
        repo_id: 'repo',
        issue_id: 'ISSUE-1',
        rediscovery_after_fix: true,
        pr_candidate: true,
        candidates: [
          candidate('builder-verbose', 'builder', {
            metrics: { changed_files: 4, changed_lines: 120, evidence_count: 1, regression_tests_added: 1, target_touched: true }
          }),
          candidate('challenger-compact', 'challenger', {
            metrics: { changed_files: 2, changed_lines: 18, evidence_count: 2, regression_tests_added: 1, target_touched: true }
          })
        ]
      }
    ];
    const result = evaluateProduct100IssueLoop(issueResults);
    expect(result.real_codex_builder_used_every_issue).toBe(true);
    expect(result.real_codex_challenger_used_every_issue).toBe(true);
    expect(result.strict_score_improvement_every_issue).toBe(true);
    expect(result.every_issue_pr_candidate).toBe(true);
    expect(result.rediscovery_after_each_fix).toBe(true);
    expect(result.every_issue_product_100_pass).toBe(true);
  });
});

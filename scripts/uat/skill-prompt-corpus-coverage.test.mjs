import { describe, expect, it } from 'vitest';
import { buildPromptCorpusCoverageReport } from './skill-prompt-corpus-coverage.mjs';

describe('P1 prompt corpus coverage audit', () => {
  it('keeps the live corpus size and mode split explicit', () => {
    const report = buildPromptCorpusCoverageReport();

    expect(report.corpus_count).toBe(56);
    expect(report.corpus_mode_counts).toEqual({
      user_issue: 28,
      auto_discovery: 28
    });
    expect(report.matrix_case_count).toBe(71);
  });

  it('reports the current prompt-matrix as representative, not exact corpus coverage', () => {
    const report = buildPromptCorpusCoverageReport();

    expect(report.exact_id_covered_count).toBe(32);
    expect(report.exact_id_gap_count).toBe(24);
    expect(report.exact_pre_codex_coverage).toBe(false);
    expect(report.phase3_required).toBe(true);
    expect(report.not_live_codex_or_github_pass).toBe(true);
    expect(report.builder_executed).toBe(false);
    expect(report.github_draft_pr_verified).toBe(false);
    expect(report.local_pr_like).toBe(false);
    expect(report.gap_mode_counts).toEqual({
      user_issue: 7,
      auto_discovery: 17
    });
  });
});

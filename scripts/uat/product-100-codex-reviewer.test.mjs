import { describe, expect, it } from 'vitest';
import {
  buildProduct100CodexReviewerArgs,
  buildProduct100ReviewerPrompt,
  runProduct100CodexReviewer
} from './product-100-codex-reviewer.mjs';

const reviewerInput = {
  reviewer_context: { authority: 'advisory_only' },
  task: { id: 'ISSUE-1', objective: 'public task' },
  selected: { candidate_id: 'c1', patch: 'diff --git public' },
  hidden_source_included: false,
  builder_transcript_included: false
};

describe('Product-100 Codex reviewer wrapper', () => {
  it('builds a prompt that excludes hidden markers and demands JSON-only advisory output', () => {
    const prompt = buildProduct100ReviewerPrompt(reviewerInput);
    expect(prompt).toContain('Return exactly one JSON object');
    expect(prompt).toContain('advisory-only');
    expect(prompt).toContain('tests/adversary/');
    expect(prompt).not.toContain('HIDDEN_PRODUCT_100');
  });

  it('uses Codex CLI 0.129 compatible approval config for live exec', () => {
    const args = buildProduct100CodexReviewerArgs({
      model: 'gpt-test',
      outputFile: '/tmp/last-message.txt'
    });
    expect(args).toContain('service_tier=fast');
    expect(args).toContain('approval_policy=never');
    expect(args).toContain('--ignore-user-config');
    expect(args).not.toContain('--ask-for-approval');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
  });

  it('supports a deterministic dry-run reviewer output that is explicitly not real LLM evidence', async () => {
    const report = await runProduct100CodexReviewer({
      dryRun: true,
      stdinText: JSON.stringify(reviewerInput)
    });
    expect(report.status).toBe('PRODUCT_100_CODEX_REVIEWER_DRY_RUN');
    expect(report.real_llm).toBe(false);
    expect(report.review.proposals[0]).toEqual(
      expect.objectContaining({
        targetPath: 'tests/adversary/dry-run-visible-edge.test.cjs',
        authority: 'advisory_only',
        decision_impact: 'none'
      })
    );
  });

  it('blocks live reviewer execution unless --live is explicit', async () => {
    const report = await runProduct100CodexReviewer({
      stdinText: JSON.stringify(reviewerInput)
    });
    expect(report.status).toBe('PRODUCT_100_CODEX_REVIEWER_BLOCKED');
    expect(report.reason).toBe('LIVE_FLAG_REQUIRED');
    expect(report.real_llm).toBe(false);
  });
});

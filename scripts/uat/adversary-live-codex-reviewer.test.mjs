import { describe, expect, it } from 'vitest';
import { filterAdversaryProposal } from '../../packages/eval-engine/src/adversary-filter.ts';
import {
  buildAdversaryLiveFilterConfig,
  buildAdversaryLiveReviewInput
} from './adversary-live-contract.mjs';
import {
  buildAdversaryLiveCodexReviewerArgs,
  buildAdversaryLiveReviewerPrompt,
  runAdversaryLiveCodexReviewer
} from './adversary-live-codex-reviewer.mjs';

const reviewerInput = buildAdversaryLiveReviewInput();

describe('adversary live Codex reviewer wrapper', () => {
  it('builds a prompt for advisory JSON-only cart semantic proposals', () => {
    const prompt = buildAdversaryLiveReviewerPrompt(reviewerInput);

    expect(prompt).toContain('Return exactly one JSON object');
    expect(prompt).toContain('advisory-only');
    expect(prompt).toContain('tests/adversary/');
    expect(prompt).toContain('quantity: 0');
    expect(prompt).toContain('candidate formula');
    expect(prompt).toContain('Math.round');
    expect(prompt).toContain('canViewProfile');
    expect(prompt).toContain('adminOnly');
    expect(prompt).toContain('simple values');
    expect(prompt).toContain('node <targetPath>');
    expect(prompt).not.toContain('SECRET_HIDDEN_EXPECTATION');
  });

  it('uses Codex CLI compatible approval and read-only sandbox config', () => {
    const args = buildAdversaryLiveCodexReviewerArgs({
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

  it('supports a deterministic dry-run output that remains non-real-LLM evidence', async () => {
    const report = await runAdversaryLiveCodexReviewer({
      dryRun: true,
      stdinText: JSON.stringify(reviewerInput)
    });
    const proposal = report.review.proposals[0];

    expect(report.status).toBe('ADVERSARY_LIVE_CODEX_REVIEWER_DRY_RUN');
    expect(report.real_llm).toBe(false);
    expect(proposal).toMatchObject({
      targetPath: 'tests/adversary/cart-quantity-semantic.test.cjs',
      expectation: 'fail_to_pass',
      authority: 'advisory_only',
      decision_impact: 'none'
    });
    expect(
      filterAdversaryProposal(proposal, buildAdversaryLiveFilterConfig())
        .accepted
    ).toBe(true);
  });

  it('blocks live reviewer execution unless --live is explicit', async () => {
    const report = await runAdversaryLiveCodexReviewer({
      stdinText: JSON.stringify(reviewerInput)
    });

    expect(report.status).toBe('ADVERSARY_LIVE_CODEX_REVIEWER_BLOCKED');
    expect(report.reason).toBe('LIVE_FLAG_REQUIRED');
    expect(report.real_llm).toBe(false);
  });
});

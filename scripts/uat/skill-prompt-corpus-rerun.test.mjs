import { describe, expect, it } from 'vitest';
import {
  buildFailedVariantRerunPlan,
  failedVariantKeys
} from './skill-prompt-corpus-rerun.mjs';

describe('skill prompt corpus failed variant rerun commands', () => {
  it('builds a targeted local rerun command for only failed variants', () => {
    const plan = buildFailedVariantRerunPlan([
      { mode: 'user_issue', variant_id: 'ko-pass', pass: true },
      { mode: 'user_issue', variant_id: 'ko-fail', pass: false },
      { mode: 'auto_discovery', variant_id: 'ko-auto-fail', pass: false },
      { mode: 'auto_discovery', variant_id: 'ko-auto-fail', pass: false }
    ]);

    expect(plan).toEqual({
      lane: 'p1-targeted',
      variant_count: 2,
      variants: [
        'user_issue:ko-fail',
        'auto_discovery:ko-auto-fail'
      ],
      command:
        "VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS='user_issue:ko-fail,auto_discovery:ko-auto-fail' corepack pnpm uat:skill-loop:p1-targeted"
    });
  });

  it('keeps Gitea reruns in the local PR-like lane', () => {
    const plan = buildFailedVariantRerunPlan(
      [{ mode: 'user_issue', variant_id: 'ko-fail', pass: false }],
      {
        gitProvider: 'gitea',
        giteaBaseUrl: 'http://127.0.0.1:13000'
      }
    );

    expect(plan?.lane).toBe('p1-gitea-pr');
    expect(plan?.command).toContain('uat:skill-loop:p1-gitea-pr');
    expect(plan?.command).toContain(
      "VIBELOOP_GITEA_BASE_URL='http://127.0.0.1:13000'"
    );
    expect(plan?.command).not.toContain('GITHUB');
  });

  it('targets GitHub draft PR failures without using the smoke wrapper', () => {
    const plan = buildFailedVariantRerunPlan(
      [{ mode: 'auto_discovery', variant_id: 'ko-auto-fail', pass: false }],
      {
        githubDraftPrRequested: true,
        keepRemote: true
      }
    );

    expect(plan).toMatchObject({
      lane: 'prompt-corpus-live:github-pr-targeted',
      variants: ['auto_discovery:ko-auto-fail']
    });
    expect(plan?.command).toContain(
      'VIBELOOP_SKILL_PROMPT_CORPUS_GITHUB_DRAFT_PR=1'
    );
    expect(plan?.command).toContain('VIBELOOP_UAT_KEEP_REMOTE=1');
    expect(plan?.command).toContain('uat:skill-loop:prompt-corpus-live');
    expect(plan?.command).not.toContain('uat:skill-loop:p1-github-final-smoke');
  });

  it('returns null when every variant passed', () => {
    expect(
      buildFailedVariantRerunPlan([
        { mode: 'user_issue', variant_id: 'ko-pass', pass: true }
      ])
    ).toBeNull();
    expect(failedVariantKeys([])).toEqual([]);
  });
});

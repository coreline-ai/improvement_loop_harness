import { describe, expect, it } from 'vitest';
import {
  buildSkillPromptCorpusChunkAggregateAudit,
  chunkAggregateAuditFailStatus,
  chunkAggregateAuditPassStatus
} from './skill-prompt-corpus-chunk-audit.mjs';

function variant({ mode, id, github = true }) {
  return {
    id: `${mode}-${id}`,
    mode,
    variant_id: id,
    status:
      mode === 'auto_discovery'
        ? 'SKILL_PROMPT_AUTO_DISCOVERY_GITHUB_DRAFT_PR_LIVE_UAT_PASS'
        : 'SKILL_PROMPT_GITHUB_DRAFT_PR_LIVE_UAT_PASS',
    pass: true,
    timed_out: false,
    failures: [],
    prompt_ux: {
      prompt_present: true,
      matched_expected_mode: true,
      expected_mode: mode,
      variant_id: id
    },
    final_verification: {
      passed: true,
      reverified: true,
      reverify_qualified: true
    },
    github_draft_pr: github,
    github_draft_pr_verified: github,
    evidence_ledger: github ? `/tmp/${mode}-${id}/ledger.json` : null,
    builder: {
      real_llm: true,
      proxy_auth_header_seen: true
    },
    orchestrator: {
      reported_skill_file_read: true
    }
  };
}

function ledger(variants, patch = {}) {
  return {
    scenario: 'skill-real-user-prompt-corpus-live-uat',
    status: 'SKILL_PROMPT_CORPUS_LIVE_UAT_PASS',
    prompt_corpus: {
      github_draft_pr_requested: true,
      variants
    },
    github_draft_pr: true,
    github_draft_pr_verified: true,
    false_pass: 0,
    leak: 0,
    failed_cases: 0,
    builder: {
      real_llm: true
    },
    orchestrator: {
      real_llm: true,
      required_child_skill_file_read: true
    },
    ...patch
  };
}

describe('skill prompt corpus chunk aggregate audit', () => {
  it('passes strict aggregate expectations for multiple chunks', async () => {
    const report = await buildSkillPromptCorpusChunkAggregateAudit({
      ledgers: [
        ledger([
          variant({ mode: 'user_issue', id: 'ko-cart' }),
          variant({ mode: 'auto_discovery', id: 'ko-auto' })
        ]),
        ledger([
          variant({ mode: 'user_issue', id: 'en-cart' }),
          variant({ mode: 'auto_discovery', id: 'en-auto' })
        ])
      ],
      expected: {
        total: 4,
        modes: {
          user_issue: 2,
          auto_discovery: 2
        }
      },
      requireGithubPr: true,
      requireRealBuilder: true,
      requireSkillRead: true
    });

    expect(report.status).toBe(chunkAggregateAuditPassStatus);
    expect(report.aggregate).toMatchObject({
      ledger_count: 2,
      variant_count: 4,
      passed_variant_count: 4,
      mode_counts: {
        user_issue: 2,
        auto_discovery: 2
      }
    });
    expect(report.failures).toEqual([]);
  });

  it('fails duplicate prompt variants across chunks', async () => {
    const report = await buildSkillPromptCorpusChunkAggregateAudit({
      ledgers: [
        ledger([variant({ mode: 'user_issue', id: 'ko-cart' })]),
        ledger([variant({ mode: 'user_issue', id: 'ko-cart' })])
      ],
      expected: {
        total: 2,
        modes: {
          user_issue: 2
        }
      },
      requireGithubPr: true
    });

    expect(report.status).toBe(chunkAggregateAuditFailStatus);
    expect(report.failures).toContain(
      'ledger:2:user_issue:ko-cart:duplicate_variant'
    );
  });

  it('fails when aggregate expectations are not met', async () => {
    const report = await buildSkillPromptCorpusChunkAggregateAudit({
      ledgers: [ledger([variant({ mode: 'user_issue', id: 'ko-cart' })])],
      expected: {
        total: 2,
        modes: {
          user_issue: 1,
          auto_discovery: 1
        }
      }
    });

    expect(report.status).toBe(chunkAggregateAuditFailStatus);
    expect(report.failures).toContain('aggregate:expected_total:2:actual:1');
    expect(report.failures).toContain(
      'aggregate:expected_auto_discovery:1:actual:0'
    );
  });

  it('fails when GitHub PR verification is required but missing', async () => {
    const report = await buildSkillPromptCorpusChunkAggregateAudit({
      ledgers: [
        ledger([
          variant({ mode: 'auto_discovery', id: 'ko-auto', github: false })
        ])
      ],
      expected: {
        total: 1,
        modes: {
          auto_discovery: 1
        }
      },
      requireGithubPr: true
    });

    expect(report.status).toBe(chunkAggregateAuditFailStatus);
    expect(report.failures).toContain(
      'ledger:1:auto_discovery:ko-auto:github_draft_pr'
    );
    expect(report.failures).toContain(
      'ledger:1:auto_discovery:ko-auto:github_draft_pr_verified'
    );
  });
});

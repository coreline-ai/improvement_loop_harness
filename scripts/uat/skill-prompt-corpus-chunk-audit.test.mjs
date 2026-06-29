import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSkillPromptCorpusChunkAggregateAudit,
  chunkAggregateAuditFailStatus,
  chunkAggregateAuditPassStatus,
  writeSkillPromptCorpusChunkAggregateAuditEvidence
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

function localPrLikeVariant({ mode, id }) {
  const base = variant({ mode, id, github: false });
  return {
    ...base,
    status:
      mode === 'auto_discovery'
        ? 'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS'
        : 'SKILL_PROMPT_LIVE_UAT_PASS',
    git_provider: 'gitea',
    local_pr_like: true,
    draft_supported: false,
    github_draft_pr: false,
    github_draft_pr_verified: false
  };
}

function ledger(variants, patch = {}) {
  const { prompt_corpus: promptCorpusPatch, ...ledgerPatch } = patch;
  return {
    scenario: 'skill-real-user-prompt-corpus-live-uat',
    status: 'SKILL_PROMPT_CORPUS_LIVE_UAT_PASS',
    prompt_corpus: {
      github_draft_pr_requested: true,
      variants,
      ...(promptCorpusPatch ?? {})
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
    ...ledgerPatch
  };
}

function localPrLikeLedger(variants, patch = {}) {
  return ledger(variants, {
    git_provider: 'gitea',
    local_pr_like: true,
    draft_supported: false,
    draft_pr: false,
    github_draft_pr: false,
    github_draft_pr_verified: false,
    prompt_corpus: {
      git_provider: 'gitea',
      local_pr_like: true,
      draft_supported: false,
      github_draft_pr_requested: false
    },
    ...patch
  });
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

  it('passes local PR-like aggregate expectations without GitHub draft PR claims', async () => {
    const report = await buildSkillPromptCorpusChunkAggregateAudit({
      ledgers: [
        localPrLikeLedger([
          localPrLikeVariant({ mode: 'user_issue', id: 'ko-cart' }),
          localPrLikeVariant({ mode: 'auto_discovery', id: 'ko-auto' })
        ])
      ],
      expected: {
        total: 2,
        modes: {
          user_issue: 1,
          auto_discovery: 1
        }
      },
      requireLocalPrLike: true,
      requireRealBuilder: true,
      requireSkillRead: true
    });

    expect(report.status).toBe(chunkAggregateAuditPassStatus);
    expect(report.requirements).toMatchObject({
      require_github_pr: false,
      require_local_pr_like: true
    });
    expect(report.failures).toEqual([]);
  });

  it('fails local PR-like aggregate when a Gitea ledger claims GitHub draft PR verification', async () => {
    const report = await buildSkillPromptCorpusChunkAggregateAudit({
      ledgers: [
        localPrLikeLedger(
          [localPrLikeVariant({ mode: 'user_issue', id: 'ko-cart' })],
          {
            github_draft_pr: true,
            github_draft_pr_verified: true,
            draft_pr: true,
            prompt_corpus: {
              git_provider: 'gitea',
              local_pr_like: true,
              draft_supported: false,
              github_draft_pr_requested: true
            }
          }
        )
      ],
      expected: {
        total: 1,
        modes: {
          user_issue: 1
        }
      },
      requireLocalPrLike: true
    });

    expect(report.status).toBe(chunkAggregateAuditFailStatus);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        'ledger:1:github_draft_pr_provider',
        'ledger:1:local_pr_like_github_claim'
      ])
    );
  });

  it('fails GitHub PR aggregate requirement on local PR-like evidence', async () => {
    const report = await buildSkillPromptCorpusChunkAggregateAudit({
      ledgers: [
        localPrLikeLedger([
          localPrLikeVariant({ mode: 'auto_discovery', id: 'ko-auto' })
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
    expect(report.failures).toEqual(
      expect.arrayContaining([
        'ledger:1:github_draft_pr_provider',
        'ledger:1:github_draft_pr',
        'ledger:1:auto_discovery:ko-auto:github_draft_pr_provider',
        'ledger:1:auto_discovery:ko-auto:github_draft_pr'
      ])
    );
  });

  it('rejects mutually exclusive GitHub PR and local PR-like aggregate requirements', async () => {
    await expect(
      buildSkillPromptCorpusChunkAggregateAudit({
        ledgers: [
          ledger([variant({ mode: 'user_issue', id: 'ko-cart' })])
        ],
        requireGithubPr: true,
        requireLocalPrLike: true
      })
    ).rejects.toThrow(
      'requireGithubPr cannot be combined with requireLocalPrLike'
    );
  });

  it('writes durable evidence with source ledger copies', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-chunk-audit-test-')
    );
    try {
      const sourceDir = path.join(root, 'source');
      await mkdir(sourceDir, { recursive: true });
      const sourceLedger = path.join(sourceDir, 'ledger.json');
      await writeFile(
        sourceLedger,
        `${JSON.stringify(
          ledger([
            variant({ mode: 'user_issue', id: 'ko-cart' }),
            variant({ mode: 'auto_discovery', id: 'ko-auto' })
          ]),
          null,
          2
        )}\n`
      );
      const report = await buildSkillPromptCorpusChunkAggregateAudit({
        ledgerPaths: [sourceLedger],
        expected: {
          total: 2,
          modes: {
            user_issue: 1,
            auto_discovery: 1
          }
        },
        requireGithubPr: true,
        requireRealBuilder: true,
        requireSkillRead: true,
        runId: 'chunk-audit-run'
      });

      const evidence = await writeSkillPromptCorpusChunkAggregateAuditEvidence(
        report,
        {
          runId: 'chunk-audit-run',
          ledgerPaths: [sourceLedger],
          evidenceDir: path.join(root, 'evidence')
        }
      );

      expect(evidence.ledger.status).toBe(chunkAggregateAuditPassStatus);
      expect(evidence.ledger.evidence_missing_count).toBe(0);
      const manifest = JSON.parse(
        await readFile(evidence.bundle.manifest_path, 'utf8')
      );
      expect(manifest.scenario).toBe(
        'skill-prompt-corpus-chunk-aggregate-audit'
      );
      expect(manifest.ledger_ref).toBe('ledger.json');
      expect(
        manifest.copied.some((entry) => entry.kind === 'source_ledger')
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildProduct100DraftPrBody,
  buildProduct100Phase6IssueResults,
  containsProduct100Leak,
  createProduct100DraftPrs,
  parseGhPrCreateUrl,
  evaluateProduct100Phase6,
  runProduct100Phase6Release,
  validateProduct100DraftPrs,
  writeProduct100EvidenceBundle
} from './product-100-release.mjs';

describe('Product-100 Phase6 release/evidence contract', () => {
  it('builds a draft PR body without hidden literals or raw proposal bodies', () => {
    const body = buildProduct100DraftPrBody({
      issue: { repo_id: 'repo', issue_id: 'ISSUE-1' },
      phase4Issue: {
        selected_candidate_id: 'candidate-1',
        hidden_eval_passed: true,
        strict_score_improvement: true,
        rediscovery_after_fix: true
      },
      phase5: { review_report: { accepted_proposals: [{ id: 'edge', body: 'HIDDEN_PRODUCT_100_BAD' }] } },
      evidenceRef: 'bundle/ledger.json'
    });
    expect(body).toContain('Proposal IDs: edge');
    expect(body).not.toContain('HIDDEN_PRODUCT_100_BAD');
    expect(containsProduct100Leak(body)).toBe(false);
  });

  it('parses gh pr create output URLs and ignores non-PR text', () => {
    expect(parseGhPrCreateUrl('Created https://github.com/coreline-ai/example/pull/7')).toBe(
      'https://github.com/coreline-ai/example/pull/7'
    );
    expect(parseGhPrCreateUrl('no url')).toBeNull();
  });

  it('creates Product-100 draft PRs through injectable gh runner without exposing hidden data', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'product-100-pr-test-'));
    const calls = [];
    try {
      const result = await createProduct100DraftPrs({
        issueResults: [
          {
            issue_id: 'ISSUE-1',
            repo_id: 'repo',
            github_repo: 'coreline-ai/example',
            head_branch: 'product-100/issue-1',
            selected_candidate_id: 'c1',
            hidden_eval_passed: true,
            strict_score_improvement: true,
            rediscovery_after_fix: true
          }
        ],
        phase5: { review_report: { accepted_proposals: [{ id: 'edge' }] } },
        evidenceRef: 'bundle/ledger.json',
        tmpRoot: tmp,
        run: async (command, args) => {
          calls.push({ command, args });
          const bodyFile = args[args.indexOf('--body-file') + 1];
          const body = await readFile(bodyFile, 'utf8');
          expect(body).toContain('Draft only: true');
          expect(body).toContain('Proposal IDs: edge');
          expect(body).not.toContain('HIDDEN_PRODUCT_100');
          return {
            ok: true,
            exit_code: 0,
            stdout: 'https://github.com/coreline-ai/example/pull/7\n',
            stderr: ''
          };
        }
      });
      expect(result.ok).toBe(true);
      expect(result.validation.ok).toBe(true);
      expect(result.draft_prs).toEqual([
        expect.objectContaining({
          issue_id: 'ISSUE-1',
          state: 'open',
          draft: true,
          url: 'https://github.com/coreline-ai/example/pull/7'
        })
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(
        expect.arrayContaining([
          'pr',
          'create',
          '--draft',
          '--repo',
          'coreline-ai/example',
          '--base',
          'main',
          '--head',
          'product-100/issue-1'
        ])
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });


  it('pushes a local issue branch before opening a live draft PR', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'product-100-pr-push-test-'));
    const calls = [];
    try {
      const result = await createProduct100DraftPrs({
        issueResults: [
          {
            issue_id: 'ISSUE-1',
            repo_id: 'repo',
            repo_path: tmp,
            github_repo: 'coreline-ai/example',
            head_branch: 'product-100/run/repo/issue-1',
            selected_candidate_id: 'c1',
            hidden_eval_passed: true,
            strict_score_improvement: true,
            rediscovery_after_fix: true
          }
        ],
        tmpRoot: tmp,
        run: async (command, args) => {
          calls.push({ command, args });
          if (command === 'git') {
            return { ok: true, exit_code: 0, stdout: '', stderr: '' };
          }
          return {
            ok: true,
            exit_code: 0,
            stdout: 'https://github.com/coreline-ai/example/pull/8\n',
            stderr: ''
          };
        }
      });

      expect(result.ok).toBe(true);
      expect(calls.map((call) => [call.command, call.args[0], call.args[1]])).toEqual([
        ['git', 'remote', 'remove'],
        ['git', 'remote', 'add'],
        ['git', 'push', 'product100-origin'],
        ['gh', 'pr', 'create']
      ]);
      expect(calls[2].args).toContain(
        'refs/heads/product-100/run/repo/issue-1:refs/heads/product-100/run/repo/issue-1'
      );
      expect(calls[2].args).not.toContain(
        'HEAD:refs/heads/product-100/run/repo/issue-1'
      );
      expect(result.draft_prs[0]).toEqual(
        expect.objectContaining({ branch_pushed: true, url: 'https://github.com/coreline-ai/example/pull/8' })
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('fails closed when Product-100 draft PR creation lacks repository or head branch', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'product-100-pr-test-'));
    try {
      const result = await createProduct100DraftPrs({
        issueResults: [{ issue_id: 'ISSUE-1' }],
        tmpRoot: tmp,
        run: async () => {
          throw new Error('gh must not be called without repo/head');
        }
      });
      expect(result.ok).toBe(false);
      expect(result.draft_prs[0]).toEqual(
        expect.objectContaining({
          state: 'not_created',
          draft: false,
          url: null,
          error: 'missing_repository'
        })
      );
      expect(result.validation.failures).toEqual(
        expect.arrayContaining([
          'draft_pr.ISSUE-1.draft',
          'draft_pr.ISSUE-1.state',
          'draft_pr.ISSUE-1.url'
        ])
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects missing, non-draft, closed, duplicate, or leaking draft PR entries', () => {
    const issueResults = [{ issue_id: 'ISSUE-1' }];
    expect(validateProduct100DraftPrs({ issueResults, draftPrs: [] }).ok).toBe(false);
    const bad = validateProduct100DraftPrs({
      issueResults,
      draftPrs: [
        { issue_id: 'ISSUE-1', state: 'closed', draft: false, url: 'not-url', body: 'HIDDEN_PRODUCT_100' }
      ]
    });
    expect(bad.ok).toBe(false);
    expect(bad.failures).toEqual(expect.arrayContaining([
      'draft_pr.ISSUE-1.draft',
      'draft_pr.ISSUE-1.state',
      'draft_pr.ISSUE-1.url',
      'draft_pr.ISSUE-1.body_leak'
    ]));
  });

  it('maps open draft PRs, evidence bundle, and release audit to Phase6 requirements', () => {
    const issueResults = [{ issue_id: 'ISSUE-1' }];
    const body = buildProduct100DraftPrBody({ phase4Issue: { issue_id: 'ISSUE-1' } });
    const evaluation = evaluateProduct100Phase6({
      issueResults,
      draftPrs: [{ issue_id: 'ISSUE-1', state: 'open', draft: true, url: 'https://github.com/coreline-ai/example/pull/1', body }],
      evidenceBundle: { missing_count: 0, copied_count: 3 },
      releaseAudit: { status: 'pass' }
    });
    expect(evaluation.phase6_pass).toBe(true);
    expect(evaluation.github_draft_prs_open).toBe(true);
    expect(evaluation.evidence_missing_count_zero).toBe(true);
    expect(evaluation.release_evidence_audit_pass).toBe(true);
  });

  it('fails Phase6 when draft PR evidence covers only a subset of expected Product-100 issues', () => {
    const issueResults = [{ issue_id: 'ISSUE-1' }];
    const body = buildProduct100DraftPrBody({
      phase4Issue: { issue_id: 'ISSUE-1' }
    });
    const evaluation = evaluateProduct100Phase6({
      expectedIssueCount: 2,
      issueResults,
      draftPrs: [
        {
          issue_id: 'ISSUE-1',
          state: 'open',
          draft: true,
          url: 'https://github.com/coreline-ai/example/pull/1',
          body
        }
      ],
      evidenceBundle: { missing_count: 0, copied_count: 3 },
      releaseAudit: { status: 'pass' }
    });

    expect(evaluation.phase6_pass).toBe(false);
    expect(evaluation.github_draft_prs_open).toBe(false);
    expect(evaluation.draft_pr_validation.failures).toContain(
      'draft_pr.issue_result_count'
    );
  });

  it('builds aggregate Phase6 issue results from every Phase4 PR candidate', () => {
    const issueResults = buildProduct100Phase6IssueResults({
      repository: 'coreline-ai/example',
      phase4: {
        issues: [
          {
            issue_id: 'ISSUE-1',
            repo_id: 'repo',
            pr_candidate: true,
            head_branch: 'product-100/issue-1'
          },
          {
            issue_id: 'ISSUE-2',
            repo_id: 'repo',
            pr_candidate: false,
            head_branch: 'product-100/issue-2'
          }
        ]
      }
    });

    expect(issueResults).toEqual([
      expect.objectContaining({
        issue_id: 'ISSUE-1',
        github_repo: 'coreline-ai/example',
        head_branch: 'product-100/issue-1'
      })
    ]);
  });

  it('runs Phase6 release aggregation and refuses PASS when issue branches are missing', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'product-100-phase6-'));
    try {
      const report = await runProduct100Phase6Release({
        phase4: {
          expected_issue_count: 1,
          issue_count: 1,
          issues: [
            {
              issue_id: 'ISSUE-1',
              repo_id: 'repo',
              pr_candidate: true
            }
          ]
        },
        phase5: {
          phase5_pass: true,
          issues: [
            {
              issue_id: 'ISSUE-1',
              report: {
                review_report: { accepted_proposals: [{ id: 'edge' }] }
              }
            }
          ]
        },
        evidenceBundle: { missing_count: 0, copied_count: 3 },
        releaseAudit: { status: 'pass' },
        repository: 'coreline-ai/example',
        tmpRoot: tmp,
        run: async () => {
          throw new Error('gh should not run without a head branch');
        }
      });

      expect(report.phase6_pass).toBe(false);
      expect(report.github_draft_prs_open).toBe(false);
      expect(report.draft_pr_validation.failures).toEqual(
        expect.arrayContaining([
          'draft_pr.ISSUE-1.draft',
          'draft_pr.ISSUE-1.state',
          'draft_pr.ISSUE-1.url'
        ])
      );
      expect(report.next_step).toBe(
        'complete_product_100_phase6_github_draft_pr_evidence_audit'
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('writes a Product-100 evidence bundle with ledger and zero missing files', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'product-100-release-test-'));
    const evidenceDir = await mkdtemp(path.join(os.tmpdir(), 'product-100-evidence-test-'));
    try {
      const report = path.join(tmp, 'report.json');
      await writeFile(report, '{"ok":true}\n');
      const bundle = await writeProduct100EvidenceBundle({
        ledger: { status: 'PRODUCT_100_CODEX_LIVE_FAIL', scenario: 'product-100-codex-live-uat', run_id: 'test-run' },
        runId: 'test-run',
        tmpRoot: tmp,
        evidenceDir,
        extraFiles: [{ label: 'report', path: report, kind: 'report' }]
      });
      expect(bundle.evidence_missing_count).toBe(0);
      expect(bundle.evidence_copied_count).toBeGreaterThan(0);
      expect(bundle.ledger_file).toContain('ledger.json');
    } finally {
      await rm(tmp, { recursive: true, force: true });
      await rm(evidenceDir, { recursive: true, force: true });
    }
  });
});

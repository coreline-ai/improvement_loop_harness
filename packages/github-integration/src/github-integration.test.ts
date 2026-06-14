import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import {
  buildPullRequestBody,
  createDraftPullRequest,
  GitHubApiError,
  parseGitHubRepo
} from './pull-request.js';
import { defaultBranchName, prepareBranchAndPush } from './branch.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('GitHub draft PR integration', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('parses GitHub repository URLs without accepting non-GitHub remotes', () => {
    expect(
      parseGitHubRepo(
        'https://github.com/coreline-ai/improvement_loop_harness.git'
      )
    ).toEqual({
      owner: 'coreline-ai',
      repo: 'improvement_loop_harness'
    });
    expect(
      parseGitHubRepo('git@github.com:coreline-ai/improvement_loop_harness.git')
    ).toEqual({
      owner: 'coreline-ai',
      repo: 'improvement_loop_harness'
    });
    expect(parseGitHubRepo('coreline-ai/improvement_loop_harness')).toEqual({
      owner: 'coreline-ai',
      repo: 'improvement_loop_harness'
    });
    expect(parseGitHubRepo('https://example.com/coreline-ai/repo')).toBeNull();
  });

  it('creates and pushes a branch from candidate.patch with safe git', async () => {
    const repo = await createTempGitRepo();
    const bareRemote = await tempDir('vibeloop-github-remote-');
    await repo.git(['init', '--bare', bareRemote]);
    await repo.git(['remote', 'add', 'origin', bareRemote]);
    await repo.git(['push', 'origin', 'main']);
    const patchPath = path.join(
      await tempDir('vibeloop-github-patch-'),
      'candidate.patch'
    );
    await writeFile(
      patchPath,
      [
        'diff --git a/README.md b/README.md',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1,2 @@',
        ' # fixture repo',
        '+patched',
        ''
      ].join('\n')
    );

    const options = {
      repoPath: repo.repoPath,
      baseRef: 'main',
      branchName: defaultBranchName('loop-safe-git'),
      candidatePatchPath: patchPath,
      commitMessage: 'apply candidate patch',
      pushUrl: bareRemote
    };
    const branch = await prepareBranchAndPush(options);
    const retry = await prepareBranchAndPush(options);

    const remoteHead = (
      await repo.git(['ls-remote', bareRemote, branch.branchName])
    ).trim();
    expect(branch.headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(retry.headSha).toMatch(/^[a-f0-9]{40}$/);
    expect(remoteHead).toContain(retry.headSha);
  });

  it('creates a draft PR with eval-report reason codes in the body', async () => {
    const body = buildPullRequestBody(
      {
        decision: 'accept',
        summary: 'All gates passed.',
        decision_reasons: [
          { code: 'ALL_PASS', message: 'All required gates passed.' }
        ],
        gate_runs: [
          { name: 'unit_tests', status: 'pass', required: true },
          { name: 'diff_scope', status: 'pass', required: true }
        ],
        trust_summary: {
          deterministic_authority: 'decision_engine',
          advisory_findings_count: 0,
          provenance_verified: true,
          hidden_acceptance_status: 'passed',
          verifier_status: 'passed'
        }
      },
      {
        adversaryReview: {
          authority: 'advisory_only',
          decision_impact: 'none',
          accepted_proposal_count: 1,
          requires_human_review_signal: true,
          next_step:
            'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
          findings: [{ severity: 'medium', message: 'Add an edge-case test.' }]
        }
      }
    );
    expect(body).toContain('`ALL_PASS`');
    expect(body).toContain('Deterministic authority: decision_engine');
    expect(body).toContain('Advisory adversary review');
    expect(body).toContain('Decision impact: none');
    expect(body).toContain('Human review signal: yes');
    expect(body).toContain('medium: Add an edge-case test.');

    nock('https://api.github.com')
      .get('/repos/coreline-ai/improvement_loop_harness/pulls')
      .query({ head: 'coreline-ai:vibeloop/loop-1', state: 'open' })
      .reply(200, [])
      .post('/repos/coreline-ai/improvement_loop_harness/pulls', (payload) => {
        expect(payload).toMatchObject({
          title: 'VibeLoop: fix issue',
          head: 'vibeloop/loop-1',
          base: 'main',
          draft: true
        });
        expect(String(payload.body)).toContain('`ALL_PASS`');
        expect(String(payload.body)).toContain('Trust boundary');
        expect(String(payload.body)).toContain('Advisory adversary review');
        return true;
      })
      .reply(201, {
        html_url:
          'https://github.com/coreline-ai/improvement_loop_harness/pull/7',
        number: 7
      });

    const result = await createDraftPullRequest({
      owner: 'coreline-ai',
      repo: 'improvement_loop_harness',
      token: 'server-token',
      headBranch: 'vibeloop/loop-1',
      baseBranch: 'main',
      title: 'VibeLoop: fix issue',
      body
    });

    expect(result).toEqual({
      url: 'https://github.com/coreline-ai/improvement_loop_harness/pull/7',
      number: 7,
      reused: false
    });
    expect(nock.isDone()).toBe(true);
  });

  it('reuses an existing open PR and does not create duplicates on retry', async () => {
    nock('https://api.github.com')
      .get('/repos/coreline-ai/improvement_loop_harness/pulls')
      .query({ head: 'coreline-ai:vibeloop/loop-1', state: 'open' })
      .reply(200, [
        {
          html_url:
            'https://github.com/coreline-ai/improvement_loop_harness/pull/8',
          number: 8
        }
      ]);

    const result = await createDraftPullRequest({
      owner: 'coreline-ai',
      repo: 'improvement_loop_harness',
      token: 'server-token',
      headBranch: 'vibeloop/loop-1',
      baseBranch: 'main',
      title: 'VibeLoop: fix issue',
      body: 'body'
    });

    expect(result).toEqual({
      url: 'https://github.com/coreline-ai/improvement_loop_harness/pull/8',
      number: 8,
      reused: true
    });
    expect(nock.isDone()).toBe(true);
  });

  it('surfaces GitHub API failures for create_failed lifecycle handling', async () => {
    nock('https://api.github.com')
      .get('/repos/coreline-ai/improvement_loop_harness/pulls')
      .query(true)
      .reply(200, [])
      .post('/repos/coreline-ai/improvement_loop_harness/pulls')
      .reply(500, { message: 'boom' });

    await expect(
      createDraftPullRequest({
        owner: 'coreline-ai',
        repo: 'improvement_loop_harness',
        token: 'server-token',
        headBranch: 'vibeloop/loop-1',
        baseBranch: 'main',
        title: 'VibeLoop: fix issue',
        body: 'body'
      })
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});

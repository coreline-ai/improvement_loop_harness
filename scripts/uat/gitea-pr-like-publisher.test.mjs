import { describe, expect, it } from 'vitest';
import { publishGiteaPrLike } from './gitea-pr-like-publisher.mjs';

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

describe('Gitea PR-like publisher', () => {
  it('publishes a local branch as PR-like evidence without GitHub draft claims', async () => {
    const calls = [];
    const gitCalls = [];
    const token = 'gitea-secret-token-1234567890';
    const report = await publishGiteaPrLike(
      {
        repoPath: '/tmp/repo',
        headBranch: 'pr-candidate/skill-prompt-uat',
        baseBranch: 'main',
        variantId: 'user_issue-ko-default-cart-path',
        title: 'VibeLoop local PR-like'
      },
      {
        env: {
          VIBELOOP_GITEA_BASE_URL: 'http://127.0.0.1:13000',
          VIBELOOP_GITEA_TOKEN: token
        },
        runCommand: async (command, args) => {
          gitCalls.push({ command, args });
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: args.join(' '),
            stderr: ''
          };
        },
        fetchImpl: async (url, options = {}) => {
          calls.push({ url, method: options.method ?? 'GET', body: options.body });
          if (url.endsWith('/api/v1/user')) {
            return response(200, { login: 'vibeloop' });
          }
          if (url.endsWith('/api/v1/user/repos')) {
            return response(201, { name: 'repo' });
          }
          if (url.endsWith('/pulls')) {
            return response(201, {
              number: 1,
              state: 'open',
              html_url: 'http://127.0.0.1:13000/vibeloop/repo/pulls/1',
              base: { ref: 'main' },
              head: { ref: 'pr-candidate/skill-prompt-uat' },
              body: JSON.parse(options.body).body
            });
          }
          if (url.endsWith('/pulls/1')) {
            return response(200, {
              number: 1,
              state: 'open',
              html_url: 'http://127.0.0.1:13000/vibeloop/repo/pulls/1',
              base: { ref: 'main' },
              head: { ref: 'pr-candidate/skill-prompt-uat' },
              body: calls.find((call) => call.url.endsWith('/pulls'))?.body
                ? JSON.parse(calls.find((call) => call.url.endsWith('/pulls')).body)
                    .body
                : ''
            });
          }
          return response(404);
        }
      }
    );

    expect(report).toMatchObject({
      ok: true,
      git_provider: 'gitea',
      local_pr_like: true,
      draft_supported: false,
      github_draft_pr: false,
      github_draft_pr_verified: false,
      draft_pr: false,
      pushed: true,
      pr_number: 1
    });
    expect(report.live_pr_view.checks).toMatchObject({
      state_open: true,
      base_ref_matches: true,
      head_ref_matches: true,
      body_sha_matches: true
    });
    expect(report.timing).toMatchObject({
      git_push_ms: expect.any(Number),
      pr_create_ms: expect.any(Number),
      total_ms: expect.any(Number)
    });
    expect(gitCalls.map((call) => call.args[0])).toEqual([
      'rev-parse',
      'rev-parse',
      'remote',
      'push',
      'push',
      'remote'
    ]);
    expect(JSON.stringify(report)).not.toContain(token);
    expect(calls.map((call) => call.method)).toContain('POST');
  });

  it('does not accept non-local Gitea URLs for local fast-lane evidence', async () => {
    const report = await publishGiteaPrLike(
      {
        repoPath: '/tmp/repo',
        headBranch: 'pr-candidate/skill-prompt-uat',
        variantId: 'user_issue-ko-default-cart-path'
      },
      {
        env: {
          VIBELOOP_GITEA_BASE_URL: 'https://gitea.example.com',
          VIBELOOP_GITEA_TOKEN: 'gitea-secret-token-1234567890'
        }
      }
    );

    expect(report).toMatchObject({
      ok: false,
      status: 'blocked',
      reason: 'GITEA_BASE_URL_NOT_LOCAL'
    });
  });

  it('retries pull request creation after a transient branch visibility 404', async () => {
    let createAttempts = 0;
    const report = await publishGiteaPrLike(
      {
        repoPath: '/tmp/repo',
        headBranch: 'pr-candidate/skill-prompt-uat',
        baseBranch: 'main',
        variantId: 'user_issue-ko-default-cart-path'
      },
      {
        env: {
          VIBELOOP_GITEA_BASE_URL: 'http://127.0.0.1:13000',
          VIBELOOP_GITEA_TOKEN: 'gitea-secret-token-1234567890'
        },
        runCommand: async () => ({
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: '',
          stderr: ''
        }),
        fetchImpl: async (url, options = {}) => {
          if (url.endsWith('/api/v1/user')) {
            return response(200, { login: 'vibeloop' });
          }
          if (url.endsWith('/api/v1/user/repos')) {
            return response(201, { name: 'repo' });
          }
          if (url.endsWith('/pulls') && (options.method ?? 'GET') === 'POST') {
            createAttempts += 1;
            if (createAttempts === 1) {
              return response(404, { message: "The target couldn't be found." });
            }
            return response(201, {
              number: 1,
              state: 'open',
              html_url: 'http://127.0.0.1:13000/vibeloop/repo/pulls/1',
              base: { ref: 'main' },
              head: { ref: 'pr-candidate/skill-prompt-uat' },
              body: JSON.parse(options.body).body
            });
          }
          if (url.endsWith('/pulls/1')) {
            return response(200, {
              number: 1,
              state: 'open',
              html_url: 'http://127.0.0.1:13000/vibeloop/repo/pulls/1',
              base: { ref: 'main' },
              head: { ref: 'pr-candidate/skill-prompt-uat' },
              body: [
                'VibeLoop local Gitea PR-like evidence.',
                '',
                'variant=user_issue-ko-default-cart-path',
                'claim=local_pr_like_only',
                'github_draft_pr_verified=false'
              ].join('\n')
            });
          }
          return response(404);
        }
      }
    );

    expect(report.ok).toBe(true);
    expect(report.local_pr_like).toBe(true);
    expect(report.timing.pr_create_attempts).toBe(2);
  });
});

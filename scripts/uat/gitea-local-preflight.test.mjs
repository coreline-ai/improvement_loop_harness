import { describe, expect, it } from 'vitest';
import {
  buildGiteaLocalPreflightReport,
  redact
} from './gitea-local-preflight.mjs';

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

describe('gitea local preflight', () => {
  it('redacts Gitea token values from runtime text', () => {
    const token = 'gitea-secret-token-1234567890';
    const output = redact(
      `Authorization: token ${token}\nVIBELOOP_GITEA_TOKEN=${token}`,
      [token]
    );

    expect(output).not.toContain(token);
    expect(output).toContain('[REDACTED');
  });

  it('blocks without leaking the token when Docker or Colima is unavailable', async () => {
    const token = 'gitea-secret-token-abcdefghij';
    const report = await buildGiteaLocalPreflightReport({
      env: {
        VIBELOOP_GITEA_BASE_URL: 'http://127.0.0.1:3000',
        VIBELOOP_GITEA_TOKEN: token
      },
      runCommand: async () => ({
        ok: false,
        status: 'fail',
        exit_code: 1,
        stdout: '',
        stderr: `Cannot connect with token ${token}`
      })
    });

    expect(report.status).toBe('blocked');
    expect(report.exit_code).toBe(20);
    expect(report.reason).toBe('DOCKER_OR_COLIMA_UNAVAILABLE');
    expect(JSON.stringify(report)).not.toContain(token);
    expect(report.checks.docker.stderr).toContain('[REDACTED');
  });

  it('passes service and token repo probe on local Gitea', async () => {
    const calls = [];
    const report = await buildGiteaLocalPreflightReport({
      env: {
        VIBELOOP_GITEA_BASE_URL: 'http://127.0.0.1:3000',
        VIBELOOP_GITEA_TOKEN: 'gitea-secret-token-abcdefghij'
      },
      healthTimeoutMs: 50,
      pollMs: 1,
      runCommand: async (_command, args) => ({
        ok: true,
        status: 'pass',
        exit_code: 0,
        stdout: args.includes('version') ? '24.0.0' : 'started',
        stderr: ''
      }),
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? 'GET' });
        if (url.endsWith('/api/healthz')) return response(200);
        if (url.endsWith('/api/v1/user')) return response(200, { login: 'vl' });
        if (url.endsWith('/api/v1/user/repos')) return response(201, {});
        if (url.endsWith('/pulls')) {
          return response(201, {
            number: 1,
            html_url: 'http://127.0.0.1:3000/vl/repo/pulls/1',
            state: 'open'
          });
        }
        if (url.includes('/api/v1/repos/vl/')) return response(204, {});
        return response(404);
      }
    });

    expect(report.status).toBe('pass');
    expect(report.checks.api_token).toMatchObject({
      ok: true,
      owner: 'vl',
      git_push: { ok: true },
      pull_request: { ok: true, local_pr_like: true },
      cleanup: { attempted: true, ok: true, http_status: 204 }
    });
    expect(calls.map((call) => call.method)).toContain('POST');
    expect(calls.map((call) => call.method)).toContain('DELETE');
  });

  it('bootstraps a local Gitea token when no token env is provided', async () => {
    const bootToken = 'bootstrapped-gitea-token-abcdefghij';
    const report = await buildGiteaLocalPreflightReport({
      env: {
        VIBELOOP_GITEA_BASE_URL: 'http://127.0.0.1:3000'
      },
      healthTimeoutMs: 50,
      pollMs: 1,
      runCommand: async (_command, args) => {
        if (_command === 'git') {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: 'git ok',
            stderr: ''
          };
        }
        if (args.includes('version')) {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: '24.0.0',
            stderr: ''
          };
        }
        if (args.includes('compose')) {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: 'started',
            stderr: ''
          };
        }
        if (args.includes('create')) {
          return {
            ok: false,
            status: 'fail',
            exit_code: 1,
            stdout: '',
            stderr: 'user already exists'
          };
        }
        if (args.includes('generate-access-token')) {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: `${bootToken}\n`,
            stderr: ''
          };
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
      fetchImpl: async (url, options = {}) => {
        if (url.endsWith('/api/healthz')) return response(200);
        expect(options.headers?.Authorization).toBe(`token ${bootToken}`);
        if (url.endsWith('/api/v1/user')) return response(200, { login: 'vl' });
        if (url.endsWith('/api/v1/user/repos')) return response(201, {});
        if (url.endsWith('/pulls')) {
          return response(201, {
            number: 1,
            html_url: 'http://127.0.0.1:3000/vl/repo/pulls/1',
            state: 'open'
          });
        }
        if (url.includes('/api/v1/repos/vl/')) return response(204, {});
        return response(404);
      }
    });

    expect(report.status).toBe('pass');
    expect(report.checks.bootstrap).toMatchObject({
      user: 'vibeloop',
      token_source: 'bootstrap',
      generate_token: { ok: true }
    });
    expect(JSON.stringify(report)).not.toContain(bootToken);
  });

  it('blocks non-local Gitea base URLs before any repo cleanup attempt', async () => {
    const report = await buildGiteaLocalPreflightReport({
      env: {
        VIBELOOP_GITEA_BASE_URL: 'https://gitea.example.com',
        VIBELOOP_GITEA_TOKEN: 'gitea-secret-token-abcdefghij'
      },
      runCommand: async () => {
        throw new Error('must not be called');
      }
    });

    expect(report.status).toBe('blocked');
    expect(report.reason).toBe('GITEA_BASE_URL_NOT_LOCAL');
  });
});

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:13000';
const COMPOSE_FILE = path.resolve('infra/gitea/docker-compose.yml');
const GITEA_CONTAINER_NAME = 'vibeloop-local-gitea';
const GITEA_CONFIG_PATH = '/data/gitea/conf/app.ini';
const GITEA_WORK_PATH = '/data/gitea';

function trimOutput(value) {
  return String(value ?? '').trim().slice(0, 4_000);
}

export function redact(text, secrets = []) {
  let redacted = String(text ?? '');
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED:secret]');
  }
  return redacted
    .replace(
      /\b(VIBELOOP_GITEA_TOKEN|GITEA_TOKEN|access_token|refresh_token|api_key|OPENAI_API_KEY|GITHUB_TOKEN|password|authorization)\s*[:=]\s*['"]?[^'"\s]+['"]?/gi,
      '$1=[REDACTED]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\btoken\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'token [REDACTED]');
}

function sanitizeResult(result, secrets) {
  return {
    ...result,
    stdout: redact(trimOutput(result.stdout), secrets),
    stderr: redact(trimOutput(result.stderr), secrets)
  };
}

export function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        status: 'timeout',
        exit_code: null,
        stdout,
        stderr
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        status: 'spawn_error',
        exit_code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        status: code === 0 ? 'pass' : 'fail',
        exit_code: code,
        stdout,
        stderr
      });
    });
  });
}

function isLocalBaseUrl(value) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function waitForGiteaHealth({
  baseUrl,
  fetchImpl,
  timeoutMs,
  pollMs
}) {
  const started = Date.now();
  let last_error = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetchImpl(`${baseUrl}/api/healthz`);
      if (response.ok) {
        return {
          ok: true,
          status: 'pass',
          http_status: response.status,
          elapsed_ms: Date.now() - started
        };
      }
      last_error = `HTTP ${response.status}`;
    } catch (error) {
      last_error = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    ok: false,
    status: 'timeout',
    elapsed_ms: Date.now() - started,
    last_error
  };
}

async function giteaApi(fetchImpl, baseUrl, token, route, options = {}) {
  return fetchImpl(`${baseUrl}${route}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `token ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {})
    }
  });
}

function authenticatedGitUrl(baseUrl, owner, repo, token) {
  const url = new URL(
    `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`,
    baseUrl
  );
  url.username = owner;
  url.password = token;
  return url.toString();
}

async function probeGitPush({ run, baseUrl, owner, repo, token }) {
  const branch = `vibeloop-preflight-${process.pid}-${Date.now()}`;
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-gitea-git-'));
  const workDir = path.join(tmpRoot, 'repo');
  const gitUrl = authenticatedGitUrl(baseUrl, owner, repo, token);
  const secrets = [token, gitUrl];
  const steps = {};
  try {
    steps.clone = sanitizeResult(
      await run('git', ['clone', gitUrl, workDir], { timeoutMs: 30_000 }),
      secrets
    );
    if (!steps.clone.ok) return { ok: false, status: 'fail', step: 'clone', branch, steps };
    await mkdir(workDir, { recursive: true });
    await writeFile(
      path.join(workDir, 'VIBELOOP_GITEA_PREFLIGHT.md'),
      `# VibeLoop Gitea preflight\n\nbranch=${branch}\n`
    );
    steps.checkout = sanitizeResult(
      await run('git', ['checkout', '-b', branch], {
        cwd: workDir,
        timeoutMs: 30_000
      }),
      secrets
    );
    if (!steps.checkout.ok) {
      return { ok: false, status: 'fail', step: 'checkout', branch, steps };
    }
    steps.add = sanitizeResult(
      await run('git', ['add', 'VIBELOOP_GITEA_PREFLIGHT.md'], {
        cwd: workDir,
        timeoutMs: 30_000
      }),
      secrets
    );
    if (!steps.add.ok) return { ok: false, status: 'fail', step: 'add', branch, steps };
    steps.commit = sanitizeResult(
      await run(
        'git',
        [
          '-c',
          'user.name=coreline-ai',
          '-c',
          'user.email=coreline-ai@users.noreply.github.com',
          'commit',
          '-m',
          'vibeloop: local gitea preflight'
        ],
        { cwd: workDir, timeoutMs: 30_000 }
      ),
      secrets
    );
    if (!steps.commit.ok) {
      return { ok: false, status: 'fail', step: 'commit', branch, steps };
    }
    steps.push = sanitizeResult(
      await run('git', ['push', 'origin', `HEAD:${branch}`], {
        cwd: workDir,
        timeoutMs: 30_000
      }),
      secrets
    );
    if (!steps.push.ok) return { ok: false, status: 'fail', step: 'push', branch, steps };
    return { ok: true, status: 'pass', branch, steps };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function probeGiteaToken({ fetchImpl, run, baseUrl, token, keepRepo }) {
  const userResponse = await giteaApi(fetchImpl, baseUrl, token, '/api/v1/user');
  if (!userResponse.ok) {
    return {
      ok: false,
      status: 'fail',
      step: 'user',
      http_status: userResponse.status
    };
  }
  const user = await userResponse.json();
  const owner = user.login ?? user.username ?? null;
  if (!owner) {
    return {
      ok: false,
      status: 'fail',
      step: 'user_login',
      http_status: userResponse.status
    };
  }
  const repoName = `vibeloop-gitea-preflight-${process.pid}-${Date.now()}`;
  const createResponse = await giteaApi(
    fetchImpl,
    baseUrl,
    token,
    '/api/v1/user/repos',
    {
      method: 'POST',
      body: JSON.stringify({
        name: repoName,
        private: false,
        auto_init: true,
        description: 'VibeLoop local Gitea preflight probe'
      })
    }
  );
  if (!createResponse.ok) {
    return {
      ok: false,
      status: 'fail',
      step: 'repo_create',
      http_status: createResponse.status,
      owner,
      repo: repoName
    };
  }

  const gitPush = await probeGitPush({ run, baseUrl, owner, repo: repoName, token });
  if (!gitPush.ok) {
    return {
      ok: false,
      status: 'fail',
      step: `git_${gitPush.step}`,
      owner,
      repo: repoName,
      git_push: gitPush
    };
  }

  const prResponse = await giteaApi(
    fetchImpl,
    baseUrl,
    token,
    `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        base: 'main',
        head: gitPush.branch,
        title: 'VibeLoop local Gitea preflight PR',
        body: 'Local PR-like preflight for VibeLoop fast lane.'
      })
    }
  );
  if (!prResponse.ok) {
    return {
      ok: false,
      status: 'fail',
      step: 'pull_request_create',
      http_status: prResponse.status,
      owner,
      repo: repoName,
      git_push: gitPush
    };
  }
  const pr = await prResponse.json();

  let cleanup = { attempted: false, ok: null, http_status: null };
  if (!keepRepo && owner && isLocalBaseUrl(baseUrl)) {
    const deleteResponse = await giteaApi(
      fetchImpl,
      baseUrl,
      token,
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
      { method: 'DELETE' }
    );
    cleanup = {
      attempted: true,
      ok: deleteResponse.ok,
      http_status: deleteResponse.status
    };
  }

  return {
    ok: true,
    status: 'pass',
    owner,
    repo: repoName,
    git_push: gitPush,
    pull_request: {
      ok: true,
      number: pr.number ?? null,
      url: pr.html_url ?? pr.url ?? null,
      state: pr.state ?? null,
      local_pr_like: true,
      draft_supported: false
    },
    cleanup
  };
}

export async function bootstrapGiteaToken({ run, env, secrets }) {
  const username = env.VIBELOOP_GITEA_BOOTSTRAP_USER ?? 'vibeloop';
  const password =
    env.VIBELOOP_GITEA_BOOTSTRAP_PASSWORD ??
    `vibeloop-local-${process.pid}-${Date.now()}`;
  const email =
    env.VIBELOOP_GITEA_BOOTSTRAP_EMAIL ?? 'vibeloop@example.invalid';
  const tokenName = `vibeloop-preflight-${process.pid}-${Date.now()}`;
  const localSecrets = [...secrets, password];
  const commonArgs = [
    'exec',
    '--user',
    'git',
    GITEA_CONTAINER_NAME,
    'gitea',
    '--config',
    GITEA_CONFIG_PATH,
    '--work-path',
    GITEA_WORK_PATH,
    'admin',
    'user'
  ];
  const createRaw = sanitizeResult(
    await run('docker', [
      ...commonArgs,
      'create',
      '--username',
      username,
      '--password',
      password,
      '--email',
      email,
      '--admin',
      '--must-change-password=false'
    ]),
    localSecrets
  );
  const create =
    !createRaw.ok &&
    /user already exists/i.test(`${createRaw.stdout}\n${createRaw.stderr}`)
      ? { ...createRaw, ok: true, status: 'already_exists' }
      : createRaw;

  const tokenResult = await run('docker', [
    ...commonArgs,
    'generate-access-token',
    '--username',
    username,
    '--token-name',
    tokenName,
    '--scopes',
    'all',
    '--raw'
  ]);
  const rawToken = trimOutput(tokenResult.stdout);
  const token = tokenResult.ok && rawToken ? rawToken : '';
  const sanitizedToken = sanitizeResult(tokenResult, [...localSecrets, token]);
  return {
    ok: Boolean(token),
    token,
    report: {
      user: username,
      create_user: create,
      generate_token: sanitizedToken,
      token_source: 'bootstrap'
    }
  };
}

export async function buildGiteaLocalPreflightReport(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const run = options.runCommand ?? runCommand;
  const baseUrl = (env.VIBELOOP_GITEA_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    ''
  );
  let token = env.VIBELOOP_GITEA_TOKEN?.trim() ?? '';
  const secrets = [token].filter(Boolean);
  const composeFile = options.composeFile ?? COMPOSE_FILE;
  const checks = {};

  if (!isLocalBaseUrl(baseUrl)) {
    return {
      status: 'blocked',
      exit_code: 20,
      reason: 'GITEA_BASE_URL_NOT_LOCAL',
      base_url: baseUrl,
      checks
    };
  }

  checks.docker = sanitizeResult(
    await run('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 10_000
    }),
    secrets
  );
  if (!checks.docker.ok) {
    return {
      status: 'blocked',
      exit_code: 20,
      reason: 'DOCKER_OR_COLIMA_UNAVAILABLE',
      base_url: baseUrl,
      checks
    };
  }

  checks.compose_up = sanitizeResult(
    await run('docker', ['compose', '-f', composeFile, 'up', '-d'], {
      timeoutMs: 60_000
    }),
    secrets
  );
  if (!checks.compose_up.ok) {
    return {
      status: 'blocked',
      exit_code: 20,
      reason: 'GITEA_COMPOSE_UP_FAILED',
      base_url: baseUrl,
      checks
    };
  }

  checks.health = await waitForGiteaHealth({
    baseUrl,
    fetchImpl,
    timeoutMs: options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS
  });
  if (!checks.health.ok) {
    return {
      status: 'blocked',
      exit_code: 20,
      reason: 'GITEA_HEALTH_UNAVAILABLE',
      base_url: baseUrl,
      checks
    };
  }

  if (!token && env.VIBELOOP_GITEA_BOOTSTRAP !== '0') {
    const bootstrap = await bootstrapGiteaToken({ run, env, secrets });
    checks.bootstrap = bootstrap.report;
    token = bootstrap.token;
    if (!bootstrap.ok) {
      return {
        status: 'blocked',
        exit_code: 20,
        reason: 'GITEA_BOOTSTRAP_TOKEN_FAILED',
        base_url: baseUrl,
        checks
      };
    }
  }

  if (!token) {
    return {
      status: 'blocked',
      exit_code: 20,
      reason: 'GITEA_TOKEN_NOT_AVAILABLE',
      base_url: baseUrl,
      required_env: ['VIBELOOP_GITEA_TOKEN'],
      checks
    };
  }

  checks.api_token = await probeGiteaToken({
    fetchImpl,
    run,
    baseUrl,
    token,
    keepRepo: env.VIBELOOP_GITEA_KEEP_REPO === '1'
  });
  if (!checks.api_token.ok) {
    return {
      status: 'blocked',
      exit_code: 20,
      reason: 'GITEA_TOKEN_OR_REPO_PROBE_FAILED',
      base_url: baseUrl,
      checks
    };
  }

  return {
    status: 'pass',
    exit_code: 0,
    base_url: baseUrl,
    checks
  };
}

async function main() {
  const report = await buildGiteaLocalPreflightReport();
  const redacted = JSON.parse(
    redact(JSON.stringify(report), [process.env.VIBELOOP_GITEA_TOKEN])
  );
  console.log(JSON.stringify(redacted, null, 2));
  process.exitCode = report.exit_code ?? (report.status === 'pass' ? 0 : 20);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

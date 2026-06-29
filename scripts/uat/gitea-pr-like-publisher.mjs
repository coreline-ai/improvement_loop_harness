import { createHash } from 'node:crypto';
import {
  bootstrapGiteaToken,
  runCommand
} from './gitea-local-preflight.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:13000';

function sha256Text(value) {
  return createHash('sha256')
    .update(value ?? '', 'utf8')
    .digest('hex');
}

function safeName(value, fallback = 'vibeloop-p1') {
  const sanitized = String(value ?? fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || fallback;
}

function redactSecrets(text, secrets = []) {
  let redacted = String(text ?? '');
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED:secret]');
  }
  return redacted.replace(
    /(access_token|refresh_token|api_key|OPENAI_API_KEY|GITHUB_TOKEN|VIBELOOP_GITEA_TOKEN|password|authorization)\s*[:=]\s*[^\s"']+/gi,
    '$1=[REDACTED]'
  );
}

function sanitizeCommandResult(result, secrets) {
  return {
    ...result,
    stdout: redactSecrets(result.stdout, secrets),
    stderr: redactSecrets(result.stderr, secrets)
  };
}

function isLocalBaseUrl(value) {
  try {
    const url = new URL(value);
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
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

async function jsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function giteaToken(env = process.env, options = {}) {
  const existing = env.VIBELOOP_GITEA_TOKEN?.trim();
  if (existing) return { token: existing, source: 'env', bootstrap: null };
  if (env.VIBELOOP_GITEA_BOOTSTRAP === '0') {
    return { token: '', source: 'missing', bootstrap: null };
  }
  const bootstrap = await bootstrapGiteaToken({
    run: options.runCommand ?? runCommand,
    env,
    secrets: []
  });
  return {
    token: bootstrap.token,
    source: 'bootstrap',
    bootstrap: bootstrap.report
  };
}

export async function publishGiteaPrLike(input, options = {}) {
  const startedAt = Date.now();
  const timing = {
    user_lookup_ms: null,
    repo_create_ms: null,
    git_push_ms: 0,
    pr_create_ms: null,
    pr_create_attempts: 0,
    pr_fetch_ms: null,
    total_ms: null
  };
  const finish = (report) => ({
    ...report,
    timing: {
      ...timing,
      total_ms: Date.now() - startedAt
    }
  });
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const run = options.runCommand ?? runCommand;
  const baseUrl = (env.VIBELOOP_GITEA_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    ''
  );
  if (!isLocalBaseUrl(baseUrl)) {
    return finish({
      ok: false,
      status: 'blocked',
      reason: 'GITEA_BASE_URL_NOT_LOCAL',
      base_url: baseUrl
    });
  }

  const tokenInfo = await giteaToken(env, { runCommand: run });
  const token = tokenInfo.token;
  const secrets = [token].filter(Boolean);
  if (!token) {
    return finish({
      ok: false,
      status: 'blocked',
      reason: 'GITEA_TOKEN_NOT_AVAILABLE',
      base_url: baseUrl
    });
  }

  const userLookupStartedAt = Date.now();
  const userResponse = await giteaApi(fetchImpl, baseUrl, token, '/api/v1/user');
  timing.user_lookup_ms = Date.now() - userLookupStartedAt;
  if (!userResponse.ok) {
    return finish({
      ok: false,
      status: 'blocked',
      reason: 'GITEA_USER_LOOKUP_FAILED',
      http_status: userResponse.status,
      base_url: baseUrl
    });
  }
  const user = await jsonResponse(userResponse);
  const owner = user.login ?? user.username;
  if (!owner) {
    return finish({
      ok: false,
      status: 'blocked',
      reason: 'GITEA_USER_LOGIN_MISSING',
      base_url: baseUrl
    });
  }

  const repoName = safeName(
    `${input.repoPrefix ?? 'vibeloop-p1'}-${input.variantId}-${process.pid}-${Date.now()}`
  );
  const repoCreateStartedAt = Date.now();
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
        auto_init: false,
        description: 'VibeLoop local Gitea PR-like evidence'
      })
    }
  );
  timing.repo_create_ms = Date.now() - repoCreateStartedAt;
  if (!createResponse.ok) {
    return finish({
      ok: false,
      status: 'fail',
      reason: 'GITEA_REPO_CREATE_FAILED',
      http_status: createResponse.status,
      owner,
      repo: repoName,
      base_url: baseUrl
    });
  }

  const repoPath = input.repoPath;
  const headBranch = input.headBranch;
  const baseBranch = input.baseBranch ?? 'main';
  const remoteName = `vibeloop-gitea-${process.pid}-${Date.now()}`;
  const gitUrl = authenticatedGitUrl(baseUrl, owner, repoName, token);
  const gitSecrets = [...secrets, gitUrl];
  const steps = {};
  const git = async (name, args) => {
    const stepStartedAt = Date.now();
    const result = sanitizeCommandResult(
      await run('git', args, { cwd: repoPath, timeoutMs: 60_000 }),
      gitSecrets
    );
    const elapsedMs = Date.now() - stepStartedAt;
    steps[name] = { ...result, elapsed_ms: elapsedMs };
    if (name === 'push_base' || name === 'push_head') {
      timing.git_push_ms += elapsedMs;
    }
    return result;
  };

  try {
    const verifyBase = await git('verify_base', [
      'rev-parse',
      '--verify',
      `refs/heads/${baseBranch}`
    ]);
    if (!verifyBase.ok) throw new Error('base branch missing');
    const verifyHead = await git('verify_head', [
      'rev-parse',
      '--verify',
      `refs/heads/${headBranch}`
    ]);
    if (!verifyHead.ok) throw new Error('head branch missing');
    const remoteAdd = await git('remote_add', ['remote', 'add', remoteName, gitUrl]);
    if (!remoteAdd.ok) throw new Error('remote add failed');
    const pushBase = await git('push_base', [
      'push',
      remoteName,
      `refs/heads/${baseBranch}:refs/heads/${baseBranch}`
    ]);
    if (!pushBase.ok) throw new Error('base push failed');
    const pushHead = await git('push_head', [
      'push',
      remoteName,
      `refs/heads/${headBranch}:refs/heads/${headBranch}`
    ]);
    if (!pushHead.ok) throw new Error('head push failed');
  } catch (error) {
    await git('remote_remove_after_failure', [
      'remote',
      'remove',
      remoteName
    ]).catch(() => undefined);
    return finish({
      ok: false,
      status: 'fail',
      reason: 'GITEA_GIT_PUSH_FAILED',
      error: error instanceof Error ? error.message : String(error),
      owner,
      repo: repoName,
      base_url: baseUrl,
      steps
    });
  }

  await git('remote_remove', ['remote', 'remove', remoteName]).catch(
    () => undefined
  );

  const body = [
    'VibeLoop local Gitea PR-like evidence.',
    '',
    `variant=${input.variantId ?? 'unknown'}`,
    'claim=local_pr_like_only',
    'github_draft_pr_verified=false'
  ].join('\n');
  const prCreateBody = JSON.stringify({
    base: baseBranch,
    head: headBranch,
    title: input.title ?? `VibeLoop local PR-like: ${input.variantId}`,
    body
  });
  let createPrResponse = null;
  let createPrText = '';
  const maxPrCreateAttempts = 5;
  for (let attempt = 1; attempt <= maxPrCreateAttempts; attempt += 1) {
    timing.pr_create_attempts = attempt;
    const prCreateStartedAt = Date.now();
    createPrResponse = await giteaApi(
      fetchImpl,
      baseUrl,
      token,
      `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls`,
      {
        method: 'POST',
        body: prCreateBody
      }
    );
    timing.pr_create_ms =
      (timing.pr_create_ms ?? 0) + (Date.now() - prCreateStartedAt);
    createPrText = await createPrResponse.text();
    if (createPrResponse.ok) break;
    if (createPrResponse.status !== 404 || attempt === maxPrCreateAttempts) {
      break;
    }
    await sleep(250 * attempt);
  }
  if (!createPrResponse.ok) {
    return finish({
      ok: false,
      status: 'fail',
      reason: 'GITEA_PULL_REQUEST_CREATE_FAILED',
      http_status: createPrResponse.status,
      response_body: redactSecrets(createPrText, secrets).slice(0, 1_000),
      owner,
      repo: repoName,
      base_url: baseUrl,
      steps
    });
  }
  const createdPr = createPrText ? JSON.parse(createPrText) : {};
  const prNumber = createdPr.number;
  const prFetchStartedAt = Date.now();
  const viewResponse =
    Number.isInteger(prNumber) || typeof prNumber === 'number'
      ? await giteaApi(
          fetchImpl,
          baseUrl,
          token,
          `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${prNumber}`
        )
      : null;
  timing.pr_fetch_ms = Date.now() - prFetchStartedAt;
  const live = viewResponse?.ok ? await jsonResponse(viewResponse) : createdPr;
  const liveBody = typeof live.body === 'string' ? live.body : body;
  const checks = {
    state_open: ['open', 'OPEN'].includes(String(live.state ?? '')),
    base_ref_matches: (live.base?.ref ?? live.base_branch ?? baseBranch) === baseBranch,
    head_ref_matches: (live.head?.ref ?? live.head_branch ?? headBranch) === headBranch,
    body_sha_matches: sha256Text(liveBody) === sha256Text(body),
    draft_not_supported: true
  };
  const failures = Object.entries(checks)
    .filter(([, ok]) => ok !== true)
    .map(([key]) => key);

  return finish({
    ok: failures.length === 0,
    status: failures.length === 0 ? 'pass' : 'fail',
    git_provider: 'gitea',
    local_pr_like: failures.length === 0,
    draft_supported: false,
    github_draft_pr: false,
    github_draft_pr_verified: false,
    draft_pr: false,
    owner,
    repo: `${owner}/${repoName}`,
    repo_url: `${baseUrl}/${owner}/${repoName}`,
    branch_name: headBranch,
    base_ref: baseBranch,
    pr_number: prNumber ?? null,
    pr_url:
      live.html_url ??
      createdPr.html_url ??
      `${baseUrl}/${owner}/${repoName}/pulls/${prNumber}`,
    pushed: true,
    token_source: tokenInfo.source,
    bootstrap: tokenInfo.bootstrap,
    live_pr_view: {
      confirmed: failures.length === 0,
      state: live.state ?? null,
      is_draft: null,
      draft_supported: false,
      base_ref: live.base?.ref ?? null,
      head_ref: live.head?.ref ?? null,
      body_sha256: sha256Text(liveBody),
      body_char_count: liveBody.length,
      checks,
      failures
    },
    steps
  });
}

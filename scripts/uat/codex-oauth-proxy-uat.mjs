#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const scenarioRoot = path.join(
  repoRoot,
  'tests/e2e/user-scenarios/cart-quantity'
);
const targetTemplate = path.join(scenarioRoot, 'target-template');
const defaultModel = 'gpt-5.5';
const defaultReasoningEffort = 'xhigh';
const defaultUpstreamBaseUrl = 'https://chatgpt.com/backend-api/codex';

const hopByHopHeaders = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function git(cwd, args) {
  const result = await run('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function parseCliJson(stdout) {
  const lines = stdout.trim().split(/\n/).filter(Boolean);
  const start = lines.findIndex((line) => line.trim().startsWith('{'));
  if (start < 0) throw new Error(`CLI JSON output not found: ${stdout}`);
  return JSON.parse(lines.slice(start).join('\n'));
}

async function createTargetRepo(tmpRoot) {
  const repoPath = path.join(tmpRoot, 'target');
  await mkdir(repoPath, { recursive: true });
  await cp(targetTemplate, repoPath, { recursive: true });
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'codex-oauth-uat@example.test']);
  await git(repoPath, ['config', 'user.name', 'Codex OAuth UAT']);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'initial cart fixture']);
  const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  return { repoPath, baseCommit };
}

function blocked(reason, details = {}) {
  console.log(
    JSON.stringify(
      {
        status: 'blocked',
        reason,
        ...details
      },
      null,
      2
    )
  );
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

function safePathName(urlPath) {
  return urlPath.replace(/\/+$/, '') || '/';
}

function responseEndpointFor(upstreamBaseUrl) {
  return `${upstreamBaseUrl.replace(/\/+$/, '')}/responses`;
}

function copyForwardHeaders(sourceHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(sourceHeaders)) {
    const lower = key.toLowerCase();
    if (!value || hopByHopHeaders.has(lower)) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function copyResponseHeaders(upstreamHeaders) {
  const headers = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower)) continue;
    headers[key] = value;
  }
  return headers;
}

function parseJsonBody(body) {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

function collectUsage(contentType, body) {
  const text = body.toString('utf8');
  const usage = [];
  if (contentType?.includes('application/json')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.usage) usage.push(parsed.usage);
      if (parsed?.response?.usage) usage.push(parsed.response.usage);
    } catch {
      return usage;
    }
  }
  if (contentType?.includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const payload = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        if (parsed?.usage) usage.push(parsed.usage);
        if (parsed?.response?.usage) usage.push(parsed.response.usage);
      } catch {
        // Ignore non-JSON SSE chunks.
      }
    }
  }
  return usage;
}

function addUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return;
  target.prompt_tokens +=
    typeof usage.prompt_tokens === 'number'
      ? usage.prompt_tokens
      : typeof usage.input_tokens === 'number'
        ? usage.input_tokens
        : 0;
  target.completion_tokens +=
    typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : typeof usage.output_tokens === 'number'
        ? usage.output_tokens
        : 0;
  target.total_tokens +=
    typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : typeof usage.input_tokens === 'number' ||
          typeof usage.output_tokens === 'number'
        ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        : 0;
}

async function startInternalOAuthProxy(options) {
  const host = options.host ?? '127.0.0.1';
  const model = options.model;
  const upstreamBaseUrl = options.upstreamBaseUrl ?? defaultUpstreamBaseUrl;
  const logs = [];
  const stats = {
    mode: 'internal-oauth-forwarder',
    requests: 0,
    response_requests: 0,
    model_requests: 0,
    auth_header_seen: false,
    auth_header_missing: false,
    upstream_statuses: [],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      requests: 0
    }
  };

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://${host}`);
      const pathname = safePathName(requestUrl.pathname);

      if (
        request.method === 'GET' &&
        ['/v1/models', '/models'].includes(pathname)
      ) {
        stats.requests += 1;
        stats.model_requests += 1;
        logs.push({ direction: 'request', method: 'GET', path: pathname });
        jsonResponse(response, 200, {
          object: 'list',
          data: [
            {
              id: model,
              object: 'model',
              created: 0,
              owned_by: 'openai'
            }
          ]
        });
        return;
      }

      if (!['/v1/responses', '/responses'].includes(pathname)) {
        stats.requests += 1;
        logs.push({
          direction: 'request',
          method: request.method,
          path: pathname,
          status: 404
        });
        jsonResponse(response, 404, { error: `unsupported path: ${pathname}` });
        return;
      }

      const body = await readRequestBody(request);
      const bodyJson = parseJsonBody(body);
      const authorization = request.headers.authorization;
      stats.requests += 1;
      stats.response_requests += 1;
      stats.auth_header_seen = stats.auth_header_seen || Boolean(authorization);
      stats.auth_header_missing = stats.auth_header_missing || !authorization;

      logs.push({
        direction: 'request',
        method: request.method,
        path: pathname,
        auth_header_present: Boolean(authorization),
        body_bytes: body.length,
        model: bodyJson?.model ?? null,
        stream: bodyJson?.stream ?? null
      });

      if (!authorization) {
        jsonResponse(response, 401, {
          error: 'Codex did not attach OpenAI OAuth authorization header'
        });
        return;
      }

      const headers = copyForwardHeaders(request.headers);
      headers.set('authorization', authorization);
      if (body.length > 0 && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }

      const upstream = await fetch(responseEndpointFor(upstreamBaseUrl), {
        method: request.method ?? 'POST',
        headers,
        body
      });
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type');
      for (const usage of collectUsage(contentType, upstreamBody)) {
        addUsage(stats.usage, usage);
      }
      stats.usage.requests += 1;
      stats.upstream_statuses.push(upstream.status);

      logs.push({
        direction: 'response',
        path: pathname,
        upstream_status: upstream.status,
        content_type: contentType,
        body_bytes: upstreamBody.length
      });

      response.writeHead(
        upstream.status,
        copyResponseHeaders(upstream.headers)
      );
      response.end(upstreamBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.push({ direction: 'error', message });
      jsonResponse(response, 502, { error: message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('OAuth proxy failed to bind to a TCP port');
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    stats,
    logs,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

function normalizeProxyBaseUrl(proxyBaseUrl) {
  const trimmed = proxyBaseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function buildCodexCommand({
  codeHome,
  proxyBaseUrl,
  provider,
  model,
  reasoningEffort,
  requiresOpenaiAuth
}) {
  const codexParts = [
    'CODEX_HOME=' + shellQuote(codeHome),
    'codex',
    'exec',
    '-c',
    shellQuote('service_tier=fast'),
    '-c',
    shellQuote('approval_policy=never'),
    '-c',
    shellQuote(`model_provider=${JSON.stringify(provider)}`),
    '-c',
    shellQuote(
      `model_providers.${provider}.name=${JSON.stringify('VibeLoop OAuth Proxy')}`
    ),
    '-c',
    shellQuote(
      `model_providers.${provider}.base_url=${JSON.stringify(
        normalizeProxyBaseUrl(proxyBaseUrl)
      )}`
    ),
    '-c',
    shellQuote(
      `model_providers.${provider}.wire_api=${JSON.stringify('responses')}`
    ),
    ...(requiresOpenaiAuth
      ? [
          '-c',
          shellQuote(`model_providers.${provider}.requires_openai_auth=true`)
        ]
      : []),
    '-c',
    shellQuote(`model_reasoning_effort=${JSON.stringify(reasoningEffort)}`),
    '-m',
    shellQuote(model),
    '-s',
    'workspace-write',
    '--skip-git-repo-check',
    '-C',
    '"$VIBELOOP_WORKTREE"',
    '-',
    '<',
    '"$VIBELOOP_TASK_FILE"'
  ];
  return `command:${codexParts.join(' ')}`;
}

async function preflightExternalProxy(proxyUrl) {
  const modelsUrl = new URL('models', normalizeProxyBaseUrl(proxyUrl) + '/');
  try {
    const response = await fetch(modelsUrl);
    return {
      ok: response.ok,
      status: response.status,
      body: (await response.text()).slice(0, 500)
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main() {
  const model = process.env.VIBELOOP_UAT_MODEL || defaultModel;
  const reasoningEffort =
    process.env.VIBELOOP_UAT_REASONING_EFFORT || defaultReasoningEffort;
  const codeHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const externalProxyUrl = process.env.VIBELOOP_UAT_OAUTH_PROXY_URL;
  const upstreamBaseUrl =
    process.env.VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL || defaultUpstreamBaseUrl;
  const provider = 'vibeloop-oauth-proxy';

  const codexVersion = await run('codex', ['--version']);
  if (codexVersion.code !== 0) {
    blocked('CODEX_CLI_NOT_AVAILABLE', { stderr: codexVersion.stderr.trim() });
    process.exitCode = 20;
    return;
  }

  const loginStatus = await run('codex', [
    '-c',
    'service_tier=fast',
    'login',
    'status'
  ]);
  if (loginStatus.code !== 0) {
    blocked('CODEX_CHATGPT_LOGIN_NOT_AVAILABLE', {
      codex_version: codexVersion.stdout.trim() || codexVersion.stderr.trim(),
      stderr: loginStatus.stderr.trim()
    });
    process.exitCode = 20;
    return;
  }

  let proxy;
  let proxyBaseUrl = externalProxyUrl;
  let proxyMode = 'external-openai-oauth-compatible';
  let requiresOpenaiAuth = false;
  let externalPreflight = null;

  if (proxyBaseUrl) {
    externalPreflight = await preflightExternalProxy(proxyBaseUrl);
    if (!externalPreflight.ok) {
      blocked('EXTERNAL_OAUTH_PROXY_NOT_REACHABLE', {
        proxy_url: proxyBaseUrl,
        preflight: externalPreflight,
        expected:
          'OpenAI-compatible OAuth proxy with /v1/models and /v1/responses'
      });
      process.exitCode = 20;
      return;
    }
  } else {
    proxy = await startInternalOAuthProxy({ model, upstreamBaseUrl });
    proxyBaseUrl = proxy.baseUrl;
    proxyMode = 'internal-codex-oauth-forwarder';
    requiresOpenaiAuth = true;
  }

  const tmpRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-codex-oauth-uat-')
  );
  const dataDir = path.join(tmpRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  const loopId = 'real-codex-oauth-proxy-uat-loop';
  const projectId = 'real-codex-oauth-proxy-uat';

  try {
    const { repoPath, baseCommit } = await createTargetRepo(tmpRoot);
    const agentSpec = buildCodexCommand({
      codeHome,
      proxyBaseUrl,
      provider,
      model,
      reasoningEffort,
      requiresOpenaiAuth
    });

    const cli = await run(
      process.execPath,
      [
        path.join(repoRoot, 'packages/cli/bin/vibeloop'),
        '--data-dir',
        dataDir,
        'run',
        '--repo',
        repoPath,
        '--task',
        path.join(scenarioRoot, 'task.yaml'),
        '--eval',
        path.join(scenarioRoot, 'eval.yaml'),
        '--agent',
        agentSpec,
        '--project-id',
        projectId,
        '--loop-id',
        loopId,
        '--base-commit',
        baseCommit,
        '--skip-dependency-install'
      ],
      { cwd: repoRoot }
    );

    await writeFile(path.join(tmpRoot, 'cli.stdout.log'), cli.stdout);
    await writeFile(path.join(tmpRoot, 'cli.stderr.log'), cli.stderr);
    if (proxy) {
      await writeFile(
        path.join(tmpRoot, 'oauth-proxy.log.json'),
        `${JSON.stringify(proxy.logs, null, 2)}\n`
      );
    }

    const output = parseCliJson(cli.stdout);
    const report = JSON.parse(await readFile(output.report, 'utf8'));
    const proxyStats = proxy
      ? proxy.stats
      : {
          mode: proxyMode,
          external_preflight: externalPreflight,
          auth_header_seen: null,
          usage: null
        };

    const hiddenTextLeaked = JSON.stringify(report).includes(
      'SECRET_HIDDEN_EXPECTATION'
    );
    const allPass =
      output.status === 'accepted' &&
      output.decision === 'accept' &&
      report.decision_reasons?.[0]?.code === 'ALL_PASS' &&
      !hiddenTextLeaked;

    console.log(
      JSON.stringify(
        {
          status: output.status,
          decision: output.decision,
          reason: report.decision_reasons?.[0]?.code ?? null,
          report: output.report,
          artifact_root: output.artifact_root,
          tmp_root: tmpRoot,
          changed_files: report.changed_files?.map((file) => file.path) ?? [],
          gates:
            report.gate_runs?.map((gate) => [
              gate.name,
              gate.status,
              gate.type,
              gate.group ?? null
            ]) ?? [],
          evidence: report.improvement_evidence ?? [],
          oauth_proxy: {
            mode: proxyMode,
            base_url: proxyBaseUrl,
            requires_openai_auth: requiresOpenaiAuth,
            stats: proxyStats
          },
          model,
          reasoning_effort: reasoningEffort,
          codex_version:
            codexVersion.stdout.trim() || codexVersion.stderr.trim(),
          login_status: loginStatus.stdout.trim() || loginStatus.stderr.trim(),
          cli_exit_code: cli.code,
          hidden_text_leaked: hiddenTextLeaked
        },
        null,
        2
      )
    );

    if (!allPass) {
      process.exitCode = 1;
    }
  } finally {
    if (proxy) {
      await proxy.close().catch(() => undefined);
    }
    if (process.env.VIBELOOP_UAT_KEEP_TMP === '0') {
      await rm(tmpRoot, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse
} from 'node:http';

export const DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL =
  'https://chatgpt.com/backend-api/codex';

export interface CodexOAuthUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
}

export interface CodexOAuthProxyStats {
  mode: 'internal-oauth-forwarder';
  requests: number;
  response_requests: number;
  model_requests: number;
  auth_header_seen: boolean;
  auth_header_missing: boolean;
  upstream_statuses: number[];
  usage: CodexOAuthUsage;
}

export interface CodexOAuthProxyLogEntry {
  direction: 'request' | 'response' | 'error';
  method?: string | undefined;
  path?: string | undefined;
  status?: number | undefined;
  auth_header_present?: boolean | undefined;
  body_bytes?: number | undefined;
  model?: unknown;
  stream?: unknown;
  upstream_status?: number | undefined;
  content_type?: string | null | undefined;
  message?: string | undefined;
}

export interface CodexOAuthProxyOptions {
  model: string;
  host?: string | undefined;
  port?: number | undefined;
  upstreamBaseUrl?: string | undefined;
}

export interface CodexOAuthProxyServer {
  baseUrl: string;
  stats: CodexOAuthProxyStats;
  logs: CodexOAuthProxyLogEntry[];
  close(): Promise<void>;
}

export interface BuildCodexOAuthCommandOptions {
  codeHome: string;
  proxyBaseUrl: string;
  provider: string;
  model: string;
  reasoningEffort: string;
  requiresOpenaiAuth: boolean;
}

export interface OAuthProxyPreflightResult {
  ok: boolean;
  status: number | null;
  body: string;
}

export const CODEX_OAUTH_PROXY_STATS_PATH = '/__vibeloop_proxy_stats';

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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readRequestBody(
  request: NodeJS.ReadableStream
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(body)}\n`);
}

function modelsResponse(model: string): unknown {
  const modelEntry = {
    id: model,
    slug: model,
    name: model,
    object: 'model',
    created: 0,
    owned_by: 'openai'
  };
  return {
    object: 'list',
    data: [modelEntry],
    models: [modelEntry]
  };
}

function safePathName(urlPath: string): string {
  return urlPath.replace(/\/+$/, '') || '/';
}

function responseEndpointFor(upstreamBaseUrl: string): string {
  return `${upstreamBaseUrl.replace(/\/+$/, '')}/responses`;
}

function copyForwardHeaders(sourceHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(sourceHeaders)) {
    const lower = key.toLowerCase();
    if (!value || hopByHopHeaders.has(lower)) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function copyResponseHeaders(upstreamHeaders: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower)) continue;
    headers[key] = value;
  }
  return headers;
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function valueOf(record: unknown, key: string): unknown {
  return record && typeof record === 'object'
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function collectUsage(contentType: string | null, body: Buffer): unknown[] {
  const text = body.toString('utf8');
  const usage: unknown[] = [];
  if (contentType?.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const direct = valueOf(parsed, 'usage');
      const nested = valueOf(valueOf(parsed, 'response'), 'usage');
      if (direct) usage.push(direct);
      if (nested) usage.push(nested);
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
        const parsed = JSON.parse(payload) as unknown;
        const direct = valueOf(parsed, 'usage');
        const nested = valueOf(valueOf(parsed, 'response'), 'usage');
        if (direct) usage.push(direct);
        if (nested) usage.push(nested);
      } catch {
        // Ignore non-JSON SSE chunks.
      }
    }
  }
  return usage;
}

function addUsage(target: CodexOAuthUsage, usage: unknown): void {
  if (!usage || typeof usage !== 'object') return;
  const record = usage as Record<string, unknown>;
  target.prompt_tokens +=
    typeof record.prompt_tokens === 'number'
      ? record.prompt_tokens
      : typeof record.input_tokens === 'number'
        ? record.input_tokens
        : 0;
  target.completion_tokens +=
    typeof record.completion_tokens === 'number'
      ? record.completion_tokens
      : typeof record.output_tokens === 'number'
        ? record.output_tokens
        : 0;
  target.total_tokens +=
    typeof record.total_tokens === 'number'
      ? record.total_tokens
      : typeof record.input_tokens === 'number' ||
          typeof record.output_tokens === 'number'
        ? (typeof record.input_tokens === 'number' ? record.input_tokens : 0) +
          (typeof record.output_tokens === 'number' ? record.output_tokens : 0)
        : 0;
}

export function normalizeOAuthProxyBaseUrl(proxyBaseUrl: string): string {
  const trimmed = proxyBaseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function buildCodexOAuthCommand(
  options: BuildCodexOAuthCommandOptions
): string {
  const codexParts = [
    'CODEX_HOME=' + shellQuote(options.codeHome),
    'codex',
    'exec',
    '-c',
    shellQuote('service_tier=fast'),
    '-c',
    shellQuote('approval_policy=never'),
    '-c',
    shellQuote(`model_provider=${JSON.stringify(options.provider)}`),
    '-c',
    shellQuote(
      `model_providers.${options.provider}.name=${JSON.stringify('VibeLoop OAuth Proxy')}`
    ),
    '-c',
    shellQuote(
      `model_providers.${options.provider}.base_url=${JSON.stringify(normalizeOAuthProxyBaseUrl(options.proxyBaseUrl))}`
    ),
    '-c',
    shellQuote(
      `model_providers.${options.provider}.wire_api=${JSON.stringify('responses')}`
    ),
    ...(options.requiresOpenaiAuth
      ? [
          '-c',
          shellQuote(
            `model_providers.${options.provider}.requires_openai_auth=true`
          )
        ]
      : []),
    '-c',
    shellQuote(
      `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`
    ),
    '-m',
    shellQuote(options.model),
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

export function codexOAuthProxyStatsUrl(proxyBaseUrl: string): string {
  return `${proxyBaseUrl.replace(/\/+$/, '')}${CODEX_OAUTH_PROXY_STATS_PATH}`;
}

function snapshotStats(stats: CodexOAuthProxyStats): CodexOAuthProxyStats {
  return {
    ...stats,
    upstream_statuses: [...stats.upstream_statuses],
    usage: { ...stats.usage }
  };
}

export async function preflightExternalOAuthProxy(
  proxyUrl: string
): Promise<OAuthProxyPreflightResult> {
  const modelsUrl = new URL(
    'models',
    normalizeOAuthProxyBaseUrl(proxyUrl) + '/'
  );
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

export async function startCodexOAuthProxy(
  options: CodexOAuthProxyOptions
): Promise<CodexOAuthProxyServer> {
  const host = options.host ?? '127.0.0.1';
  const upstreamBaseUrl =
    options.upstreamBaseUrl ?? DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL;
  const logs: CodexOAuthProxyLogEntry[] = [];
  const stats: CodexOAuthProxyStats = {
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
        [CODEX_OAUTH_PROXY_STATS_PATH, `/v1${CODEX_OAUTH_PROXY_STATS_PATH}`]
          .includes(pathname)
      ) {
        jsonResponse(response, 200, snapshotStats(stats));
        return;
      }

      if (
        request.method === 'GET' &&
        ['/v1/models', '/models'].includes(pathname)
      ) {
        stats.requests += 1;
        stats.model_requests += 1;
        logs.push({ direction: 'request', method: 'GET', path: pathname });
        jsonResponse(response, 200, modelsResponse(options.model));
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
        model: valueOf(bodyJson, 'model') ?? null,
        stream: valueOf(bodyJson, 'stream') ?? null
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

  await new Promise<void>((resolve, reject) => {
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
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 2000);
        server.close((error) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    }
  };
}

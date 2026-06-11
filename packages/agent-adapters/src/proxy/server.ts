import http from 'node:http';
import { redactProxyLog } from './redact.js';

export interface ProxyUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
}

export interface LlmProxyOptions {
  upstreamBaseUrl: string;
  apiKey: string;
  loopId: string;
  host?: string | undefined;
  port?: number | undefined;
}

export interface LlmProxyServer {
  baseUrl: string;
  close(): Promise<void>;
  getUsage(loopId?: string): ProxyUsage;
  logs: string[];
}

function emptyUsage(): ProxyUsage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    requests: 0
  };
}

function addUsage(target: ProxyUsage, usage: unknown): boolean {
  if (!usage || typeof usage !== 'object') {
    return false;
  }
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
    typeof record.total_tokens === 'number' ? record.total_tokens : 0;
  return true;
}

function sseDataPayloads(body: string): string[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n')
    )
    .filter((payload) => payload.length > 0 && payload !== '[DONE]');
}

function collectUsageFromResponse(
  contentType: string | null,
  body: Buffer
): unknown[] {
  const text = body.toString('utf8');
  if (contentType?.includes('application/json')) {
    const parsed = JSON.parse(text) as { usage?: unknown };
    return parsed.usage ? [parsed.usage] : [];
  }
  if (contentType?.includes('text/event-stream')) {
    return sseDataPayloads(text).flatMap((payload) => {
      try {
        const parsed = JSON.parse(payload) as {
          usage?: unknown;
          response?: { usage?: unknown };
        };
        return parsed.response?.usage
          ? [parsed.response.usage]
          : parsed.usage
            ? [parsed.usage]
            : [];
      } catch {
        return [];
      }
    });
  }
  return [];
}

function recordResponseUsage(
  target: ProxyUsage,
  contentType: string | null,
  body: Buffer
): void {
  for (const usage of collectUsageFromResponse(contentType, body)) {
    addUsage(target, usage);
  }
  target.requests += 1;
}

function redact(value: unknown, apiKey: string): string {
  return redactProxyLog(JSON.stringify(value), { secrets: [apiKey] });
}

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function startLlmProxy(
  options: LlmProxyOptions
): Promise<LlmProxyServer> {
  const host = options.host ?? '127.0.0.1';
  const logs: string[] = [];
  const usageByLoop = new Map<string, ProxyUsage>();
  usageByLoop.set(options.loopId, emptyUsage());

  const server = http.createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      const upstreamUrl = new URL(request.url ?? '/', options.upstreamBaseUrl);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (
          !value ||
          key.toLowerCase() === 'host' ||
          key.toLowerCase() === 'content-length'
        ) {
          continue;
        }
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      headers.set('authorization', `Bearer ${options.apiKey}`);
      if (body.length > 0 && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }

      logs.push(
        redact(
          {
            direction: 'request',
            method: request.method,
            url: upstreamUrl.toString(),
            headers: Object.fromEntries(headers),
            body: body.toString('utf8')
          },
          options.apiKey
        )
      );

      const requestInit: RequestInit = {
        ...(request.method ? { method: request.method } : {}),
        headers,
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body })
      };
      const upstream = await fetch(upstreamUrl, requestInit);
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get('content-type');
      if (contentType) {
        response.setHeader('content-type', contentType);
      }

      const usage = usageByLoop.get(options.loopId) ?? emptyUsage();
      recordResponseUsage(usage, contentType, upstreamBody);
      usageByLoop.set(options.loopId, usage);

      logs.push(
        redact(
          {
            direction: 'response',
            status: upstream.status,
            body: upstreamBody.toString('utf8')
          },
          options.apiKey
        )
      );
      response.writeHead(upstream.status);
      response.end(upstreamBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.push(redact({ direction: 'error', message }, options.apiKey));
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
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
    throw new Error('proxy failed to bind to a TCP port');
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    logs,
    getUsage(loopId = options.loopId): ProxyUsage {
      return usageByLoop.get(loopId) ?? emptyUsage();
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

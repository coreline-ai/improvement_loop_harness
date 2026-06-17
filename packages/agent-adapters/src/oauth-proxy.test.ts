import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  buildCodexOAuthCommand,
  codexOAuthProxyStatsUrl,
  preflightExternalOAuthProxy,
  startCodexOAuthProxy
} from './oauth-proxy.js';

async function withJsonServer(
  handler: (request: {
    method?: string;
    url?: string;
    authorization?: string;
  }) => unknown
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const body = handler({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify(body)}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('failed to bind server');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

describe('codex oauth proxy helpers', () => {
  it('serves /v1/models without upstream access', async () => {
    const proxy = await startCodexOAuthProxy({ model: 'gpt-test' });
    try {
      const response = await fetch(`${proxy.baseUrl}/v1/models`);
      const body = (await response.json()) as {
        data: Array<{ id: string; slug: string }>;
        models: Array<{ id: string; slug: string }>;
      };
      expect(response.status).toBe(200);
      expect(body.data[0]?.id).toBe('gpt-test');
      expect(body.data[0]?.slug).toBe('gpt-test');
      expect(body.models[0]?.id).toBe('gpt-test');
      expect(body.models[0]?.slug).toBe('gpt-test');
      expect(proxy.stats.model_requests).toBe(1);
    } finally {
      await proxy.close();
    }
  });

  it('records OAuth authorization presence without logging token text', async () => {
    const token = 'Bearer sk-secret-token-value';
    const upstream = await withJsonServer((request) => ({
      ok: true,
      upstream_path: request.url,
      saw_auth: request.authorization === token,
      usage: { input_tokens: 2, output_tokens: 3 }
    }));
    const proxy = await startCodexOAuthProxy({
      model: 'gpt-test',
      upstreamBaseUrl: upstream.baseUrl
    });
    try {
      const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { authorization: token, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
      });
      const body = (await response.json()) as { saw_auth: boolean };
      expect(response.status).toBe(200);
      expect(body.saw_auth).toBe(true);
      expect(proxy.stats.auth_header_seen).toBe(true);
      expect(proxy.stats.auth_header_missing).toBe(false);
      expect(proxy.stats.usage.total_tokens).toBe(5);
      expect(JSON.stringify(proxy.logs)).not.toContain('sk-secret-token-value');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('serves sanitized proxy usage stats without counting the stats read', async () => {
    const token = 'Bearer sk-secret-token-value';
    const upstream = await withJsonServer(() => ({
      ok: true,
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    }));
    const proxy = await startCodexOAuthProxy({
      model: 'gpt-test',
      upstreamBaseUrl: upstream.baseUrl
    });
    try {
      const modelResponse = await fetch(`${proxy.baseUrl}/v1/models`);
      expect(modelResponse.status).toBe(200);

      const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { authorization: token, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
      });
      expect(response.status).toBe(200);

      const beforeStatsRead = proxy.stats.requests;
      const statsResponse = await fetch(codexOAuthProxyStatsUrl(proxy.baseUrl));
      const stats = (await statsResponse.json()) as {
        mode: string;
        requests: number;
        model_requests: number;
        response_requests: number;
        auth_header_seen: boolean;
        usage: { total_tokens: number };
      };

      expect(statsResponse.status).toBe(200);
      expect(stats.mode).toBe('internal-oauth-forwarder');
      expect(stats.requests).toBe(beforeStatsRead);
      expect(stats.model_requests).toBe(1);
      expect(stats.response_requests).toBe(1);
      expect(stats.auth_header_seen).toBe(true);
      expect(stats.usage.total_tokens).toBe(18);
      expect(proxy.stats.requests).toBe(beforeStatsRead);
      expect(JSON.stringify(stats)).not.toContain('sk-secret-token-value');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  it('requires an authorization header before forwarding responses', async () => {
    const proxy = await startCodexOAuthProxy({ model: 'gpt-test' });
    try {
      const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
        method: 'POST',
        body: '{}'
      });
      expect(response.status).toBe(401);
      expect(proxy.stats.auth_header_missing).toBe(true);
      expect(proxy.stats.upstream_statuses).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it('builds a Codex command that requests OpenAI auth without embedding tokens', () => {
    const command = buildCodexOAuthCommand({
      codeHome: '/tmp/codex home',
      proxyBaseUrl: 'http://127.0.0.1:1234',
      provider: 'vibeloop-oauth-proxy',
      model: 'gpt-test',
      reasoningEffort: 'xhigh',
      requiresOpenaiAuth: true
    });
    expect(command).toContain('requires_openai_auth=true');
    expect(command).toContain('base_url');
    expect(command).not.toMatch(/Bearer\s+/i);
    expect(command).not.toMatch(/access_token|refresh_token/i);
  });

  it('preflights an external OAuth-compatible proxy', async () => {
    const upstream = await withJsonServer(() => ({ object: 'list', data: [] }));
    try {
      const result = await preflightExternalOAuthProxy(upstream.baseUrl);
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    } finally {
      await upstream.close();
    }
  });
});

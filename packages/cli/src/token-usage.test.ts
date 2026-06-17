import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOKEN_BUDGET_TOTAL,
  buildTokenBudgetLoopOptions,
  readTokenUsageFromUrl
} from './token-usage.js';

async function withUsageServer(
  body: unknown
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
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
  if (!address || typeof address === 'string') {
    throw new Error('usage server failed to bind');
  }
  return {
    url: `http://127.0.0.1:${address.port}/stats`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

describe('token budget CLI helpers', () => {
  it('requires a usage URL when a token budget is requested', () => {
    expect(() =>
      buildTokenBudgetLoopOptions({ tokenBudgetTotal: '1000' })
    ).toThrow('--token-budget-total requires --token-usage-url or --llm-proxy-url');
  });

  it('normalizes proxy stats usage into an SDK token snapshot', async () => {
    const server = await withUsageServer({
      usage: { total_tokens: 42 }
    });
    try {
      await expect(readTokenUsageFromUrl(server.url)).resolves.toEqual({
        total_tokens: 42
      });
    } finally {
      await server.close();
    }
  });

  it('builds an SDK token hook from CLI options', async () => {
    const server = await withUsageServer({ total_tokens: 7 });
    try {
      const options = buildTokenBudgetLoopOptions({
        tokenBudgetTotal: '10',
        tokenUsageUrl: server.url
      });
      await expect(options.getTokenUsage?.()).resolves.toEqual({
        total_tokens: 7
      });
      expect(options.tokenBudgetTotal).toBe(10);
    } finally {
      await server.close();
    }
  });

  it('infers the OAuth proxy stats endpoint from --llm-proxy-url', async () => {
    const server = await withUsageServer({
      usage: { total_tokens: 13 }
    });
    try {
      const options = buildTokenBudgetLoopOptions({
        tokenBudgetTotal: '20',
        llmProxyUrl: server.url.replace(/\/stats$/, '')
      });
      await expect(options.getTokenUsage?.()).resolves.toEqual({
        total_tokens: 13
      });
      expect(options.tokenBudgetTotal).toBe(20);
    } finally {
      await server.close();
    }
  });

  it('applies the default token budget when a proxy usage source is available', async () => {
    const server = await withUsageServer({
      usage: { total_tokens: 21 }
    });
    try {
      const options = buildTokenBudgetLoopOptions({
        llmProxyUrl: server.url.replace(/\/stats$/, '')
      });
      await expect(options.getTokenUsage?.()).resolves.toEqual({
        total_tokens: 21
      });
      expect(options.tokenBudgetTotal).toBe(DEFAULT_TOKEN_BUDGET_TOTAL);
    } finally {
      await server.close();
    }
  });

  it('allows the default token budget to be overridden or disabled by env', async () => {
    const server = await withUsageServer({ total_tokens: 3 });
    try {
      const baseOptions = {
        llmProxyUrl: server.url.replace(/\/stats$/, '')
      };
      expect(
        buildTokenBudgetLoopOptions(baseOptions, {
          VIBELOOP_TOKEN_BUDGET_TOTAL: '1234'
        }).tokenBudgetTotal
      ).toBe(1234);
      expect(
        buildTokenBudgetLoopOptions(baseOptions, {
          VIBELOOP_TOKEN_BUDGET_TOTAL: 'off'
        })
      ).toEqual({});
      expect(
        buildTokenBudgetLoopOptions(
          { ...baseOptions, tokenBudgetTotal: '44' },
          { VIBELOOP_TOKEN_BUDGET_TOTAL: 'off' }
        ).tokenBudgetTotal
      ).toBe(44);
    } finally {
      await server.close();
    }
  });
});

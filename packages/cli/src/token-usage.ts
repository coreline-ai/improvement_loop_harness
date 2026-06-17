import type { TokenUsageSnapshot } from '@vibeloop/sdk';

export interface TokenBudgetCommandOptions {
  tokenBudgetTotal?: string | undefined;
  tokenUsageUrl?: string | undefined;
  llmProxyUrl?: string | undefined;
}

export interface TokenBudgetLoopOptions {
  tokenBudgetTotal?: number | undefined;
  getTokenUsage?: (() => Promise<TokenUsageSnapshot>) | undefined;
}

const CODEX_OAUTH_PROXY_STATS_PATH = '/__vibeloop_proxy_stats';
export const DEFAULT_TOKEN_BUDGET_TOTAL = 500_000;
export const TOKEN_BUDGET_TOTAL_ENV = 'VIBELOOP_TOKEN_BUDGET_TOTAL';

const DISABLE_TOKEN_BUDGET_VALUES = new Set([
  '0',
  'false',
  'off',
  'none',
  'disabled'
]);

function parsePositiveInt(
  value: string | undefined,
  name: string
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseEnvTokenBudget(
  value: string | undefined
): number | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (DISABLE_TOKEN_BUDGET_VALUES.has(normalized)) return null;
  return parsePositiveInt(value, TOKEN_BUDGET_TOTAL_ENV);
}

function usageTotalFromBody(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const usage = record.usage;
  const directTotal = record.total_tokens;
  if (typeof directTotal === 'number') return directTotal;
  if (usage && typeof usage === 'object') {
    const nestedTotal = (usage as Record<string, unknown>).total_tokens;
    if (typeof nestedTotal === 'number') return nestedTotal;
  }
  return null;
}

export async function readTokenUsageFromUrl(
  url: string
): Promise<TokenUsageSnapshot> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`--token-usage-url returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  const totalTokens = usageTotalFromBody(body);
  if (totalTokens === null || !Number.isFinite(totalTokens)) {
    throw new Error('--token-usage-url response must include total_tokens');
  }
  return { total_tokens: Math.max(0, totalTokens) };
}

function inferredProxyStatsUrl(proxyBaseUrl: string): string {
  return `${proxyBaseUrl.replace(/\/+$/, '')}${CODEX_OAUTH_PROXY_STATS_PATH}`;
}

export function buildTokenBudgetLoopOptions(
  options: TokenBudgetCommandOptions,
  env: NodeJS.ProcessEnv = process.env
): TokenBudgetLoopOptions {
  const explicitTokenBudgetTotal = parsePositiveInt(
    options.tokenBudgetTotal,
    '--token-budget-total'
  );
  const envTokenBudgetTotal =
    explicitTokenBudgetTotal === undefined
      ? parseEnvTokenBudget(env[TOKEN_BUDGET_TOTAL_ENV])
      : undefined;
  const defaultBudgetApplies =
    explicitTokenBudgetTotal === undefined &&
    envTokenBudgetTotal === undefined &&
    (Boolean(options.tokenUsageUrl) || Boolean(options.llmProxyUrl));
  const tokenBudgetTotal =
    explicitTokenBudgetTotal ??
    (envTokenBudgetTotal === null ? undefined : envTokenBudgetTotal) ??
    (defaultBudgetApplies ? DEFAULT_TOKEN_BUDGET_TOTAL : undefined);
  const tokenUsageUrl =
    options.tokenUsageUrl ??
    (tokenBudgetTotal !== undefined && options.llmProxyUrl
      ? inferredProxyStatsUrl(options.llmProxyUrl)
      : undefined);
  if (tokenBudgetTotal !== undefined && !tokenUsageUrl) {
    throw new Error(
      '--token-budget-total requires --token-usage-url or --llm-proxy-url'
    );
  }
  if (!tokenUsageUrl) {
    return tokenBudgetTotal === undefined ? {} : { tokenBudgetTotal };
  }
  try {
    const parsed = new URL(tokenUsageUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error('--token-usage-url must be an absolute HTTP(S) URL');
  }
  return {
    ...(tokenBudgetTotal !== undefined ? { tokenBudgetTotal } : {}),
    getTokenUsage: () => readTokenUsageFromUrl(tokenUsageUrl)
  };
}

export const DEFAULT_TOKEN_BUDGET_TOTAL = 500000;
export const TOKEN_BUDGET_TOTAL_ENV = 'VIBELOOP_TOKEN_BUDGET_TOTAL';
export const UAT_TOKEN_BUDGET_TOTAL_ENV = 'VIBELOOP_UAT_TOKEN_BUDGET_TOTAL';
export const CODEX_OAUTH_PROXY_STATS_PATH = '/__vibeloop_proxy_stats';

const DISABLE_TOKEN_BUDGET_VALUES = new Set([
  '0',
  'false',
  'off',
  'none',
  'disabled'
]);

function codexOAuthProxyStatsUrl(proxyBaseUrl) {
  return `${proxyBaseUrl.replace(/\/+$/, '')}${CODEX_OAUTH_PROXY_STATS_PATH}`;
}

export function resolveTokenBudgetSetting(env = process.env) {
  const explicit =
    env[UAT_TOKEN_BUDGET_TOTAL_ENV] ?? env[TOKEN_BUDGET_TOTAL_ENV];
  if (explicit !== undefined) {
    const normalized = explicit.trim().toLowerCase();
    if (DISABLE_TOKEN_BUDGET_VALUES.has(normalized)) {
      return {
        enforced: false,
        total: null,
        source:
          env[UAT_TOKEN_BUDGET_TOTAL_ENV] !== undefined
            ? UAT_TOKEN_BUDGET_TOTAL_ENV
            : TOKEN_BUDGET_TOTAL_ENV
      };
    }
    return {
      enforced: true,
      total: explicit,
      source:
        env[UAT_TOKEN_BUDGET_TOTAL_ENV] !== undefined
          ? UAT_TOKEN_BUDGET_TOTAL_ENV
          : TOKEN_BUDGET_TOTAL_ENV
    };
  }
  return {
    enforced: true,
    total: String(DEFAULT_TOKEN_BUDGET_TOTAL),
    source: 'default'
  };
}

export function tokenBudgetCliArgs(proxyBaseUrl, env = process.env) {
  const setting = resolveTokenBudgetSetting(env);
  if (!setting.enforced) return [];
  return [
    '--token-budget-total',
    setting.total,
    '--token-usage-url',
    codexOAuthProxyStatsUrl(proxyBaseUrl)
  ];
}

export function tokenBudgetLedger(env = process.env) {
  const setting = resolveTokenBudgetSetting(env);
  return {
    token_budget_total: setting.total,
    token_budget_enforced: setting.enforced,
    token_budget_source: setting.source
  };
}

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOKEN_BUDGET_TOTAL,
  tokenBudgetCliArgs,
  tokenBudgetLedger
} from './token-budget.mjs';

describe('UAT token budget helper', () => {
  it('applies the release default token budget with proxy stats', () => {
    expect(tokenBudgetCliArgs('http://127.0.0.1:1234/', {})).toEqual([
      '--token-budget-total',
      String(DEFAULT_TOKEN_BUDGET_TOTAL),
      '--token-usage-url',
      'http://127.0.0.1:1234/__vibeloop_proxy_stats'
    ]);
    expect(tokenBudgetLedger({})).toEqual({
      token_budget_total: String(DEFAULT_TOKEN_BUDGET_TOTAL),
      token_budget_enforced: true,
      token_budget_source: 'default'
    });
  });

  it('allows operational override, UAT override, and explicit disable', () => {
    expect(
      tokenBudgetLedger({ VIBELOOP_TOKEN_BUDGET_TOTAL: '1234' })
    ).toMatchObject({
      token_budget_total: '1234',
      token_budget_enforced: true,
      token_budget_source: 'VIBELOOP_TOKEN_BUDGET_TOTAL'
    });
    expect(
      tokenBudgetLedger({
        VIBELOOP_TOKEN_BUDGET_TOTAL: '1234',
        VIBELOOP_UAT_TOKEN_BUDGET_TOTAL: '44'
      })
    ).toMatchObject({
      token_budget_total: '44',
      token_budget_source: 'VIBELOOP_UAT_TOKEN_BUDGET_TOTAL'
    });
    expect(
      tokenBudgetCliArgs('http://127.0.0.1:1234', {
        VIBELOOP_UAT_TOKEN_BUDGET_TOTAL: 'off'
      })
    ).toEqual([]);
    expect(
      tokenBudgetLedger({ VIBELOOP_UAT_TOKEN_BUDGET_TOTAL: 'off' })
    ).toMatchObject({
      token_budget_total: null,
      token_budget_enforced: false,
      token_budget_source: 'VIBELOOP_UAT_TOKEN_BUDGET_TOTAL'
    });
  });
});

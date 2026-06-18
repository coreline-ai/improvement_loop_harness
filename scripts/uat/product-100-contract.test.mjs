import { describe, expect, it } from 'vitest';
import {
  PRODUCT_100_BLOCKED_STATUS,
  PRODUCT_100_FAIL_STATUS,
  PRODUCT_100_PASS_STATUS,
  PRODUCT_100_REQUIRED_REQUIREMENTS,
  PRODUCT_100_EVIDENCE_SCENARIO,
  buildProduct100Ledger,
  evaluateProduct100Pass
} from './product-100-contract.mjs';

function allRequirements(value = true) {
  return Object.fromEntries(
    PRODUCT_100_REQUIRED_REQUIREMENTS.map((name) => [name, value])
  );
}

describe('Product-100 PASS contract', () => {
  it('passes only when every fixed requirement is true', () => {
    const result = evaluateProduct100Pass({ requirements: allRequirements(true) });
    expect(result.status).toBe(PRODUCT_100_PASS_STATUS);
    expect(result.pass).toBe(true);
    expect(result.missing_requirements).toEqual([]);
  });

  it('fails instead of passing when a non-blocking quality requirement is missing', () => {
    const requirements = allRequirements(true);
    requirements.strict_score_improvement_every_issue = false;
    const result = evaluateProduct100Pass({ requirements });
    expect(result.status).toBe(PRODUCT_100_FAIL_STATUS);
    expect(result.pass).toBe(false);
    expect(result.missing_requirements).toContain('strict_score_improvement_every_issue');
  });

  it('blocks when a live prerequisite such as R1 isolation is missing', () => {
    const requirements = allRequirements(true);
    requirements.r1_container_preflight_pass = false;
    const result = evaluateProduct100Pass({ requirements });
    expect(result.status).toBe(PRODUCT_100_BLOCKED_STATUS);
    expect(result.blocked_requirements).toContain('r1_container_preflight_pass');
  });

  it('rejects controlled fixture usage because real Codex builder/challenger evidence is required', () => {
    const requirements = allRequirements(true);
    requirements.real_codex_builder_used_every_issue = false;
    requirements.real_codex_challenger_used_every_issue = false;
    const result = evaluateProduct100Pass({ requirements });
    expect(result.status).toBe(PRODUCT_100_BLOCKED_STATUS);
    expect(result.missing_requirements).toEqual(
      expect.arrayContaining([
        'real_codex_builder_used_every_issue',
        'real_codex_challenger_used_every_issue'
      ])
    );
  });



  it('uses the durable Product-100 evidence scenario name in ledgers', () => {
    const ledger = buildProduct100Ledger({ requirements: allRequirements(false) });
    expect(ledger.scenario).toBe(PRODUCT_100_EVIDENCE_SCENARIO);
  });

  it('builds a ledger that cannot advertise Product-100 PASS with missing requirements', () => {
    const ledger = buildProduct100Ledger({ requirements: allRequirements(false) });
    expect(ledger.status).not.toBe(PRODUCT_100_PASS_STATUS);
    expect(ledger.scope).toBe('product_100_candidate');
    expect(ledger.evaluation.missing_requirements.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  REQUIRED_ATTACK_SCENARIOS,
  buildAdversaryLiveSafetyPlan,
  validateAdversaryLiveSafetyPlan
} from './adversary-live-safety.mjs';

describe('adversary live safety plan', () => {
  it('requires M2/M4 isolated execution and next-loop-only semantic impact', () => {
    const plan = buildAdversaryLiveSafetyPlan({
      image: 'node:fixture',
      timeoutMs: 1234
    });

    expect(validateAdversaryLiveSafetyPlan(plan)).toEqual({
      ok: true,
      failures: []
    });
    expect(plan).toMatchObject({
      host_execution_allowed: false,
      current_loop_decision_impact: 'none',
      proposal_authority: 'advisory_only',
      required_preflights: ['container_runtime', 'container_smoke'],
      attack_scenarios: expect.arrayContaining(
        REQUIRED_ATTACK_SCENARIOS.map((id) =>
          expect.objectContaining({
            id,
            live_required: true
          })
        )
      ),
      m2: {
        execute: true,
        isolation: 'container',
        image: 'node:fixture',
        network: 'none',
        timeout_ms: 1234
      },
      m4: {
        execute: true,
        isolation: 'container',
        image: 'node:fixture',
        network: 'none',
        timeout_ms: 1234
      },
      frozen_rulepack: {
        authority: 'fixed_next_loop_gate',
        decision_impact: 'next_loop_only',
        same_loop_application_allowed: false
      },
      n_plus_one: {
        gate: 'builtin:rulepack-semantic',
        required: true,
        expected_good_status: 'pass',
        expected_bad_status: 'fail'
      }
    });
  });

  it('fails closed when a live adversary invariant is weakened', () => {
    const plan = buildAdversaryLiveSafetyPlan();
    const report = validateAdversaryLiveSafetyPlan({
      ...plan,
      host_execution_allowed: true,
      attack_scenarios: plan.attack_scenarios.filter(
        (scenario) => scenario.id !== 'prompt_injection'
      ),
      m2: { ...plan.m2, network: 'default' },
      m4: { ...plan.m4, execute: false },
      frozen_rulepack: {
        ...plan.frozen_rulepack,
        same_loop_application_allowed: true
      },
      n_plus_one: {
        ...plan.n_plus_one,
        expected_bad_status: 'pass'
      }
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        'host_execution_allowed_must_be_false',
        'attack_scenario_count_too_low',
        'attack_scenario_prompt_injection_missing',
        'm2_network_must_be_none',
        'm4_must_execute',
        'same_loop_application_must_be_forbidden',
        'n_plus_one_bad_candidate_must_fail'
      ])
    );
  });
});

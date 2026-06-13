import { describe, expect, it } from 'vitest';
import { decideShadowPromotion, diffRulepack } from './rulepack-shadow.js';

const base = [
  { id: 'Q1', hash: 'h1' },
  { id: 'Q2', hash: 'h2' }
];

describe('diffRulepack', () => {
  it('detects an append-only (strengthening) proposal', () => {
    const diff = diffRulepack(base, [...base, { id: 'Q3', hash: 'h3' }]);
    expect(diff.added).toEqual(['Q3']);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.appendOnly).toBe(true);
  });

  it('flags removal as not append-only', () => {
    const diff = diffRulepack(base, [{ id: 'Q1', hash: 'h1' }]);
    expect(diff.removed).toEqual(['Q2']);
    expect(diff.appendOnly).toBe(false);
  });

  it('flags relaxation (same id, different hash) as not append-only', () => {
    const diff = diffRulepack(base, [
      { id: 'Q1', hash: 'h1' },
      { id: 'Q2', hash: 'h2-relaxed' }
    ]);
    expect(diff.changed).toEqual(['Q2']);
    expect(diff.appendOnly).toBe(false);
  });
});

describe('decideShadowPromotion', () => {
  it('promotes an append-only, replay-safe, next-loop-only proposal', () => {
    const diff = diffRulepack(base, [...base, { id: 'Q3', hash: 'h3' }]);
    const decision = decideShadowPromotion({
      diff,
      replaySafe: true,
      appliedToCurrentLoop: false
    });
    expect(decision.promote).toBe(true);
    expect(decision.status).toBe('shadow_promoted');
    expect(decision.reasons).toEqual([]);
  });

  it('rejects relaxation, replay-unsafe, or current-loop application', () => {
    const relaxed = diffRulepack(base, [
      { id: 'Q1', hash: 'h1' },
      { id: 'Q2', hash: 'h2-relaxed' }
    ]);
    const decision = decideShadowPromotion({
      diff: relaxed,
      replaySafe: false,
      appliedToCurrentLoop: true
    });
    expect(decision.promote).toBe(false);
    expect(decision.status).toBe('shadow_rejected');
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'not_append_only',
        'replay_unsafe',
        'applied_to_current_loop'
      ])
    );
  });

  it('rejects a no-op proposal that adds nothing', () => {
    const diff = diffRulepack(base, base);
    const decision = decideShadowPromotion({
      diff,
      replaySafe: true,
      appliedToCurrentLoop: false
    });
    expect(decision.promote).toBe(false);
    expect(decision.reasons).toContain('no_new_rules');
  });
});

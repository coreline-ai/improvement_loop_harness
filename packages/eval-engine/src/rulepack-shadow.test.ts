import { describe, expect, it } from 'vitest';
import {
  decideShadowPromotion,
  diffRulepack,
  hashRuleSpec,
  normalizeRuleTargetPath,
  ruleSpecHashMatches
} from './rulepack-shadow.js';

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

describe('content-addressed RuleSpec', () => {
  const spec = {
    kind: 'command_test' as const,
    target_path: 'tests/adversary/fixed-edge.test.cjs',
    body: 'process.exit(0);\n',
    command: 'node tests/adversary/fixed-edge.test.cjs',
    expect: 'pass_to_pass' as const,
    network: 'none' as const
  };

  it('hashes the canonical executable spec and verifies rule hash binding', () => {
    const hash = hashRuleSpec(spec);
    expect(hash).toMatch(/^sha256:/);
    expect(
      ruleSpecHashMatches({
        id: 'adversary:p-fixed-edge',
        hash,
        spec
      })
    ).toBe(true);
    expect(
      ruleSpecHashMatches({
        id: 'adversary:p-fixed-edge',
        hash,
        spec: { ...spec, body: 'process.exit(1);\n' }
      })
    ).toBe(false);
  });

  it('rejects absolute or escaping rule target paths', () => {
    expect(normalizeRuleTargetPath('tests/adversary/test.cjs')).toBe(
      'tests/adversary/test.cjs'
    );
    expect(() => normalizeRuleTargetPath('../hidden/test.cjs')).toThrow(
      /invalid rule target path/
    );
    expect(() => normalizeRuleTargetPath('/tmp/test.cjs')).toThrow(
      /invalid rule target path/
    );
  });
});

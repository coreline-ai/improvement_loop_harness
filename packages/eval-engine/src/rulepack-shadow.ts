/**
 * M4 (partial) — shadow rule learning: deterministic safety core.
 *
 * Shadow learning lets the rulepack evolve WITHOUT a human in the hot loop, but
 * only in a strengthening direction. This module provides the two deterministic
 * guarantees that make that safe:
 *   1. append-only / monotonic — a proposal may only ADD rules, never remove or
 *      change existing ones (no relaxation).
 *   2. promotion gate — a proposal is promotable only if it is append-only, was
 *      NOT applied to the current loop, and the replay corpus confirmed it is safe.
 *
 * DEFERRED: the replay-corpus EXECUTION (running candidate rules against
 * known-good/known-bad fixtures to compute `replaySafe`) requires rule-execution
 * infrastructure (policy.lock / rulepack runner) that is not built yet, and may
 * require R1 isolation. Here `replaySafe` is an INPUT; this module is the fixed
 * decision gate over it. See docs/SELF_IMPROVEMENT_LOOP_DESIGN.md §14.
 */

export interface RulepackRule {
  /** Stable rule identifier. */
  id: string;
  /** Content hash of the rule's deterministic implementation/spec. */
  hash: string;
}

export interface RulepackDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** True iff nothing was removed or changed — i.e. a pure strengthening. */
  appendOnly: boolean;
}

export function diffRulepack(
  current: readonly RulepackRule[],
  proposed: readonly RulepackRule[]
): RulepackDiff {
  const currentById = new Map(current.map((rule) => [rule.id, rule.hash]));
  const proposedById = new Map(proposed.map((rule) => [rule.id, rule.hash]));

  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, hash] of proposedById) {
    const existing = currentById.get(id);
    if (existing === undefined) {
      added.push(id);
    } else if (existing !== hash) {
      changed.push(id);
    }
  }
  const removed: string[] = [];
  for (const id of currentById.keys()) {
    if (!proposedById.has(id)) {
      removed.push(id);
    }
  }

  added.sort();
  changed.sort();
  removed.sort();
  return {
    added,
    changed,
    removed,
    appendOnly: removed.length === 0 && changed.length === 0
  };
}

export interface ShadowPromotionInput {
  diff: RulepackDiff;
  /** Result of replay-corpus validation (computed by the deferred replay runner). */
  replaySafe: boolean;
  /** Must be false — promoted rules apply only to the NEXT loop, never the current one. */
  appliedToCurrentLoop: boolean;
}

export type ShadowPromotionStatus = 'shadow_promoted' | 'shadow_rejected';

export interface ShadowPromotionDecision {
  promote: boolean;
  status: ShadowPromotionStatus;
  reasons: string[];
}

export function decideShadowPromotion(
  input: ShadowPromotionInput
): ShadowPromotionDecision {
  const reasons: string[] = [];
  if (!input.diff.appendOnly) {
    reasons.push('not_append_only');
  }
  if (!input.replaySafe) {
    reasons.push('replay_unsafe');
  }
  if (input.appliedToCurrentLoop) {
    reasons.push('applied_to_current_loop');
  }
  if (input.diff.added.length === 0) {
    reasons.push('no_new_rules');
  }
  const promote = reasons.length === 0;
  return {
    promote,
    status: promote ? 'shadow_promoted' : 'shadow_rejected',
    reasons
  };
}

/**
 * M2 (partial) — deterministic Adversary proposal filter.
 *
 * An Adversary LLM proposes counterexamples / tests. They are NEVER trusted as-is:
 * this fixed-rule filter statically validates a proposal before it could become an
 * ephemeral gate. The filter performs NO execution — it only inspects the proposal.
 *
 * IMPORTANT — execution is gated on R1 isolation. Actually RUNNING an
 * adversary-proposed test (to confirm fail-to-pass / determinism) and wiring it as
 * an ephemeral gate executes untrusted LLM-generated code on the host, which
 * requires container/network isolation (R1). Those execution-confirmed checks are
 * deliberately NOT implemented here. See docs/SELF_IMPROVEMENT_LOOP_DESIGN.md §10.
 */

import { pathMatchesAny } from '@vibeloop/guards';

export type AdversaryProposalKind =
  | 'objective_edge'
  | 'regression_guard'
  | 'invalid'
  | 'out_of_scope';

export type ProposalFilterId =
  | 'scope'
  | 'objective_link'
  | 'no_weakening'
  | 'no_hidden_leak'
  | 'bounded_cost';

export interface AdversaryProposal {
  id: string;
  /** Path where the proposed test would be staged. */
  targetPath: string;
  /** Proposed test content. The filter inspects it but never executes it. */
  body: string;
  /** Outcome the proposer claims (execution-confirmed only after R1). */
  expectation?: 'fail_to_pass' | 'pass_to_pass' | undefined;
}

export interface ProposalFilterConfig {
  /** Allowed test / ephemeral-staging directory prefixes. */
  testDirs: string[];
  /** Structural-link terms (objective/target/fingerprint). At least one must appear. */
  objectiveTerms?: string[] | undefined;
  /** Markers that indicate a hidden-acceptance/secret leak. */
  hiddenMarkers?: string[] | undefined;
  /** Maximum proposal body size in bytes. */
  maxBodyBytes?: number | undefined;
}

export interface ProposalFilterResult {
  proposalId: string;
  accepted: boolean;
  classification: AdversaryProposalKind;
  failedFilters: ProposalFilterId[];
  /**
   * Static filters passed, but the proposal must still be confirmed by execution
   * (fail-to-pass + determinism) under R1 isolation before becoming a real gate.
   */
  requiresExecutionConfirmation: boolean;
}

const WEAKENING_PATTERNS: readonly RegExp[] = [
  /\btest\.skip\b/,
  /\bit\.only\b/,
  /\bdescribe\.skip\b/,
  /\bxit\b/,
  /\bxdescribe\b/,
  /expect\(\s*true\s*\)\.toBe\(\s*true\s*\)/,
  /\.timeout\(\s*0\s*\)/
];

function normalize(value: string): string {
  return value.replace(/\\/g, '/');
}

export function filterAdversaryProposal(
  proposal: AdversaryProposal,
  config: ProposalFilterConfig
): ProposalFilterResult {
  const failedFilters: ProposalFilterId[] = [];
  const targetPath = normalize(proposal.targetPath);
  const body = proposal.body;

  // scope — staged inside an allowed test/staging directory (proper containment,
  // not bare startsWith, so `tests/` cannot be spoofed by `tests-evil/...`).
  if (!pathMatchesAny(targetPath, config.testDirs)) {
    failedFilters.push('scope');
  }

  // objective_link — structurally tied to the task objective/target
  if (config.objectiveTerms && config.objectiveTerms.length > 0) {
    const haystack = `${targetPath}\n${body}`.toLowerCase();
    const linked = config.objectiveTerms.some((term) =>
      haystack.includes(term.toLowerCase())
    );
    if (!linked) {
      failedFilters.push('objective_link');
    }
  }

  // no_weakening — must not disable/loosen existing checks
  if (WEAKENING_PATTERNS.some((pattern) => pattern.test(body))) {
    failedFilters.push('no_weakening');
  }

  // no_hidden_leak — must not embed hidden-acceptance/secret markers
  if (
    config.hiddenMarkers &&
    config.hiddenMarkers.some(
      (marker) => marker.length > 0 && body.includes(marker)
    )
  ) {
    failedFilters.push('no_hidden_leak');
  }

  // bounded_cost — proposal body within size limit
  if (
    config.maxBodyBytes !== undefined &&
    Buffer.byteLength(body, 'utf8') > config.maxBodyBytes
  ) {
    failedFilters.push('bounded_cost');
  }

  const hasIntegrityFailure =
    failedFilters.includes('no_weakening') ||
    failedFilters.includes('no_hidden_leak');
  const hasScopeFailure =
    failedFilters.includes('scope') || failedFilters.includes('objective_link');

  let classification: AdversaryProposalKind;
  if (hasIntegrityFailure || failedFilters.includes('bounded_cost')) {
    classification = 'invalid';
  } else if (hasScopeFailure) {
    classification = 'out_of_scope';
  } else {
    classification =
      proposal.expectation === 'pass_to_pass'
        ? 'regression_guard'
        : 'objective_edge';
  }

  const accepted = failedFilters.length === 0;
  return {
    proposalId: proposal.id,
    accepted,
    classification,
    failedFilters,
    requiresExecutionConfirmation: accepted
  };
}

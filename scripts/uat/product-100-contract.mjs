#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PRODUCT_100_PASS_STATUS = 'PRODUCT_100_CODEX_LIVE_PASS';
export const PRODUCT_100_BLOCKED_STATUS = 'PRODUCT_100_CODEX_LIVE_BLOCKED';
export const PRODUCT_100_FAIL_STATUS = 'PRODUCT_100_CODEX_LIVE_FAIL';
export const PRODUCT_100_CONTRACT_VERSION = 'product-100.codex-live.v1';
export const PRODUCT_100_EVIDENCE_SCENARIO = 'product-100-codex-live-uat';

export const PRODUCT_100_REQUIRED_REQUIREMENTS = Object.freeze([
  'live_preflight_pass',
  'r1_container_preflight_pass',
  'real_codex_builder_used_every_issue',
  'real_codex_challenger_used_every_issue',
  'hidden_eval_generated_and_passed_every_issue',
  'real_codex_adversary_reviewer_used',
  'accepted_review_proposal_count_at_least_one',
  'same_model_review_false',
  'm2_confirmed_under_r1',
  'm4_replay_safe_under_r1',
  'frozen_rulepack_semantic_gate_passed_next_loop',
  'strict_score_improvement_every_issue',
  'every_issue_pr_candidate',
  'rediscovery_after_each_fix',
  'github_draft_prs_open',
  'false_pass_zero',
  'leak_zero',
  'evidence_missing_count_zero',
  'release_evidence_audit_pass',
  'docs_run_ledger_readme_truthful'
]);

export const PRODUCT_100_BLOCKING_REQUIREMENTS = Object.freeze([
  'live_preflight_pass',
  'r1_container_preflight_pass',
  'real_codex_builder_used_every_issue',
  'real_codex_challenger_used_every_issue',
  'real_codex_adversary_reviewer_used'
]);

const REQUIREMENT_LABELS = Object.freeze({
  live_preflight_pass: 'Codex/GitHub live preflight must pass',
  r1_container_preflight_pass: 'R1 isolated container preflight must pass',
  real_codex_builder_used_every_issue:
    'Every issue must be modified by a real Codex Builder, not a command fixture',
  real_codex_challenger_used_every_issue:
    'Every issue must have a real Codex Challenger candidate',
  hidden_eval_generated_and_passed_every_issue:
    'Generated hidden/adversary evals must pass for every accepted issue',
  real_codex_adversary_reviewer_used:
    'A separate real Codex adversary reviewer must run',
  accepted_review_proposal_count_at_least_one:
    'At least one reviewer proposal must be accepted into a frozen rulepack path',
  same_model_review_false:
    'Reviewer context/provider must not be the same mutable Builder session',
  m2_confirmed_under_r1: 'M2 confirmation must run inside R1 isolation',
  m4_replay_safe_under_r1: 'M4 replay must run inside R1 isolation',
  frozen_rulepack_semantic_gate_passed_next_loop:
    'Frozen rulepack semantic gate must pass in the next loop',
  strict_score_improvement_every_issue:
    'Strict score improvement must be true for every issue',
  every_issue_pr_candidate: 'Every accepted issue must produce a PR candidate',
  rediscovery_after_each_fix:
    'After each accepted fix, the next issue must be rediscovered from current state',
  github_draft_prs_open: 'GitHub draft PRs must be opened for accepted fixes',
  false_pass_zero: 'False pass count must be zero',
  leak_zero: 'Artifact/context leak count must be zero',
  evidence_missing_count_zero: 'Evidence missing count must be zero',
  release_evidence_audit_pass: 'Release evidence audit must pass',
  docs_run_ledger_readme_truthful:
    'Docs, Run Ledger, and README must truthfully reflect Product-100 status and remaining blockers'
});

function requirementsFromInput(input = {}) {
  const explicit = input.requirements ?? {};
  const merged = {};
  for (const name of PRODUCT_100_REQUIRED_REQUIREMENTS) {
    merged[name] = explicit[name] ?? input[name] ?? false;
  }
  return merged;
}

export function evaluateProduct100Pass(input = {}) {
  const requirements = requirementsFromInput(input);
  const declaredBlocked = new Set(input.blocked_requirements ?? []);
  const missingRequirements = PRODUCT_100_REQUIRED_REQUIREMENTS.filter(
    (name) => requirements[name] !== true
  );
  const blockedRequirements = missingRequirements.filter(
    (name) =>
      PRODUCT_100_BLOCKING_REQUIREMENTS.includes(name) || declaredBlocked.has(name)
  );
  for (const name of declaredBlocked) {
    if (!blockedRequirements.includes(name)) {
      blockedRequirements.push(name);
    }
  }

  const satisfied = PRODUCT_100_REQUIRED_REQUIREMENTS.filter(
    (name) => requirements[name] === true
  );
  const status =
    missingRequirements.length === 0
      ? PRODUCT_100_PASS_STATUS
      : blockedRequirements.length > 0
        ? PRODUCT_100_BLOCKED_STATUS
        : PRODUCT_100_FAIL_STATUS;
  const failReasons = missingRequirements.map((name) => ({
    requirement: name,
    label: REQUIREMENT_LABELS[name] ?? name,
    blocked: blockedRequirements.includes(name)
  }));

  return {
    status,
    contract_version: PRODUCT_100_CONTRACT_VERSION,
    pass: status === PRODUCT_100_PASS_STATUS,
    satisfied,
    missing_requirements: missingRequirements,
    blocked_requirements: blockedRequirements,
    fail_reasons: failReasons,
    requirements
  };
}

export function assertNoProduct100FalsePass(result) {
  if (result.status === PRODUCT_100_PASS_STATUS && result.missing_requirements.length > 0) {
    throw new Error(
      `Product-100 false PASS: missing ${result.missing_requirements.join(', ')}`
    );
  }
  return result;
}

export function buildProduct100Ledger(input = {}) {
  const evaluation = assertNoProduct100FalsePass(evaluateProduct100Pass(input));
  return {
    status: evaluation.status,
    scenario: input.scenario ?? PRODUCT_100_EVIDENCE_SCENARIO,
    product_100_contract_version: PRODUCT_100_CONTRACT_VERSION,
    generated_at: input.generated_at ?? new Date().toISOString(),
    run_id: input.run_id ?? null,
    scope: input.scope ?? 'product_100_candidate',
    summary: input.summary ?? {},
    evaluation,
    evidence: input.evidence ?? {},
    issue_results: input.issue_results ?? [],
    review_results: input.review_results ?? [],
    next_step: input.next_step ?? defaultNextStep(evaluation)
  };
}

function defaultNextStep(evaluation) {
  if (evaluation.status === PRODUCT_100_PASS_STATUS) {
    return 'Product-100 live UAT passed. Preserve ledger and draft PR evidence.';
  }
  if (evaluation.status === PRODUCT_100_BLOCKED_STATUS) {
    return `Unblock required prerequisites: ${evaluation.blocked_requirements.join(', ')}`;
  }
  return `Fix failed Product-100 requirements: ${evaluation.missing_requirements.join(', ')}`;
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input.trim() ? JSON.parse(input) : {};
}

async function main() {
  const input = await readStdinJson();
  const ledger = buildProduct100Ledger(input);
  console.log(JSON.stringify(ledger, null, 2));
  process.exit(ledger.status === PRODUCT_100_PASS_STATUS ? 0 : 20);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

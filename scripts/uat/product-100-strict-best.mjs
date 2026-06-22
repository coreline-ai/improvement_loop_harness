#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PRODUCT_100_STRICT_BEST_VERSION = 'product-100.strict-best.v1';
const REAL_CODEX_ROLES = new Set(['builder', 'challenger']);

export function isRealCodexCandidate(candidate = {}) {
  return (
    candidate.provenance?.real_llm === true &&
    candidate.provenance?.provider === 'codex' &&
    candidate.provenance?.fixture !== true &&
    REAL_CODEX_ROLES.has(candidate.role)
  );
}

export function candidateGatePass(candidate = {}) {
  const gates = candidate.gates ?? {};
  return (
    candidate.accepted === true &&
    gates.visible === true &&
    gates.hidden === true &&
    gates.scope === true &&
    gates.artifact_leak === true &&
    gates.test_on_base === true &&
    gates.final_reverify === true &&
    isRealCodexCandidate(candidate)
  );
}

export function scoreProduct100Candidate(candidate = {}) {
  if (!candidateGatePass(candidate)) {
    return {
      candidate_id: candidate.id ?? null,
      accepted_for_selection: false,
      score: Number.NEGATIVE_INFINITY,
      reasons: rejectionReasons(candidate)
    };
  }
  const metrics = candidate.metrics ?? {};
  const changedFiles = Number(metrics.changed_files ?? 99);
  const changedLines = Number(metrics.changed_lines ?? 9999);
  const evidenceCount = Number(metrics.evidence_count ?? 0);
  const regressionTestsAdded = Number(metrics.regression_tests_added ?? 0);
  const targetTouch = metrics.target_touched === true ? 1 : 0;
  const protectedPenalty = Number(metrics.protected_files_touched ?? 0) * 1000;
  const leakPenalty = Number(metrics.leak_count ?? 0) * 1000;
  const score =
    1000 +
    evidenceCount * 20 +
    regressionTestsAdded * 30 +
    targetTouch * 25 -
    changedFiles * 10 -
    changedLines * 0.25 -
    protectedPenalty -
    leakPenalty;
  return {
    candidate_id: candidate.id ?? null,
    accepted_for_selection: true,
    score,
    metrics: {
      changed_files: changedFiles,
      changed_lines: changedLines,
      evidence_count: evidenceCount,
      regression_tests_added: regressionTestsAdded,
      target_touched: Boolean(targetTouch),
      protected_files_touched: Number(metrics.protected_files_touched ?? 0),
      leak_count: Number(metrics.leak_count ?? 0)
    },
    reasons: []
  };
}

function rejectionReasons(candidate = {}) {
  const gates = candidate.gates ?? {};
  const reasons = [];
  if (candidate.accepted !== true) reasons.push('candidate_not_accepted');
  for (const name of [
    'visible',
    'hidden',
    'scope',
    'artifact_leak',
    'test_on_base',
    'final_reverify'
  ]) {
    if (gates[name] !== true) reasons.push(`gate_${name}_not_pass`);
  }
  if (!isRealCodexCandidate(candidate)) reasons.push('not_real_codex_candidate');
  return reasons;
}

export function selectProduct100StrictBest(candidates = []) {
  const scored = candidates.map((candidate) => ({
    candidate,
    score: scoreProduct100Candidate(candidate)
  }));
  const selectable = scored.filter((item) => item.score.accepted_for_selection);
  selectable.sort((a, b) => b.score.score - a.score.score);
  const topScore = selectable[0]?.score.score ?? null;
  const topSelectable = topScore === null
    ? []
    : selectable.filter((item) => item.score.score === topScore);
  const convergedTopPatchGroup = topSelectable
    .filter((item) => item.candidate.patch_hash ?? item.candidate.patchHash)
    .reduce((groups, item) => {
      const hash = item.candidate.patch_hash ?? item.candidate.patchHash;
      groups.set(hash, [...(groups.get(hash) ?? []), item]);
      return groups;
    }, new Map())
    .values();
  const selected =
    [...convergedTopPatchGroup]
      .filter((group) => group.length >= 2)
      .sort(
        (a, b) =>
          b.length - a.length ||
          String(a[0]?.candidate.id ?? '').localeCompare(String(b[0]?.candidate.id ?? ''))
      )[0]?.[0] ??
    selectable[0] ??
    null;
  const runnerUp = selectable[1] ?? null;
  const hasRealBuilder = selectable.some((item) => item.candidate.role === 'builder');
  const hasRealChallenger = selectable.some((item) => item.candidate.role === 'challenger');
  const selectedPatchHash = selected?.candidate.patch_hash ?? selected?.candidate.patchHash;
  const equivalentPatchConvergence = Boolean(
    selectedPatchHash &&
      topSelectable.length >= 2 &&
      topSelectable.filter(
        (item) =>
          (item.candidate.patch_hash ?? item.candidate.patchHash) ===
          selectedPatchHash
      ).length >= 2
  );
  const strictScoreImprovement = Boolean(
    (selected && runnerUp && selected.score.score > runnerUp.score.score) ||
      equivalentPatchConvergence
  );
  return {
    version: PRODUCT_100_STRICT_BEST_VERSION,
    candidate_count: candidates.length,
    selectable_count: selectable.length,
    has_real_codex_builder: hasRealBuilder,
    has_real_codex_challenger: hasRealChallenger,
    selected_candidate_id: selected?.candidate.id ?? null,
    runner_up_candidate_id: runnerUp?.candidate.id ?? null,
    selected_score: selected?.score.score ?? null,
    runner_up_score: runnerUp?.score.score ?? null,
    strict_score_improvement: strictScoreImprovement,
    equivalent_patch_convergence: equivalentPatchConvergence,
    accepted_for_product_100:
      strictScoreImprovement && hasRealBuilder && hasRealChallenger,
    scored: scored.map((item) => ({
      candidate_id: item.candidate.id ?? null,
      role: item.candidate.role ?? null,
      ...item.score
    }))
  };
}

export function evaluateProduct100IssueLoop(issueResults = []) {
  const evaluated = issueResults.map((issue) => {
    const selection = issue.selection ?? selectProduct100StrictBest(issue.candidates ?? []);
    return {
      issue_id: issue.issue_id,
      repo_id: issue.repo_id,
      rediscovery_after_fix: issue.rediscovery_after_fix === true,
      pr_candidate: issue.pr_candidate === true,
      selection,
      product_100_issue_pass:
        selection.accepted_for_product_100 === true &&
        issue.rediscovery_after_fix === true &&
        issue.pr_candidate === true
    };
  });
  return {
    version: PRODUCT_100_STRICT_BEST_VERSION,
    issue_count: evaluated.length,
    real_codex_builder_used_every_issue: evaluated.every(
      (item) => item.selection.has_real_codex_builder === true
    ),
    real_codex_challenger_used_every_issue: evaluated.every(
      (item) => item.selection.has_real_codex_challenger === true
    ),
    strict_score_improvement_every_issue: evaluated.every(
      (item) => item.selection.strict_score_improvement === true
    ),
    every_issue_pr_candidate: evaluated.every((item) => item.pr_candidate === true),
    rediscovery_after_each_fix: evaluated.every(
      (item) => item.rediscovery_after_fix === true
    ),
    every_issue_product_100_pass: evaluated.every(
      (item) => item.product_100_issue_pass === true
    ),
    issues: evaluated
  };
}

async function readStdinJson() {
  if (process.stdin.isTTY) return [];
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input.trim() ? JSON.parse(input) : [];
}

async function main() {
  const input = await readStdinJson();
  const results = Array.isArray(input) ? input : input.issue_results ?? [];
  console.log(JSON.stringify(evaluateProduct100IssueLoop(results), null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

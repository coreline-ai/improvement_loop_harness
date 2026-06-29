#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { defaultCorpus } from './skill-real-user-prompt-corpus-live-uat.mjs';
import { promptMatrixCases } from './skill-real-user-prompt-matrix-uat.mjs';

const scenario = 'skill-prompt-corpus-coverage-audit';

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function matrixIdSet(matrixCases) {
  return new Set(matrixCases.map((item) => item.id));
}

function corpusIdCandidates(item) {
  return [item.id, item.variant].filter(Boolean);
}

export function buildPromptCorpusCoverageReport({
  corpus = defaultCorpus,
  matrixCases = promptMatrixCases
} = {}) {
  const matrixIds = matrixIdSet(matrixCases);
  const rows = corpus.map((item) => {
    const candidates = corpusIdCandidates(item);
    const matchedMatrixIds = candidates.filter((candidate) =>
      matrixIds.has(candidate)
    );
    return {
      id: item.id,
      variant: item.variant,
      mode: item.mode,
      language: item.language,
      exact_matrix_id_match: matchedMatrixIds.length > 0,
      matched_matrix_ids: matchedMatrixIds
    };
  });
  const coveredRows = rows.filter((item) => item.exact_matrix_id_match);
  const gapRows = rows.filter((item) => !item.exact_matrix_id_match);
  const corpusModeCounts = countBy(corpus, (item) => item.mode);
  const matrixModeCounts = countBy(
    matrixCases,
    (item) => item.expectedMode ?? 'unknown'
  );
  const gapModeCounts = countBy(gapRows, (item) => item.mode);

  return {
    status: 'SKILL_PROMPT_CORPUS_COVERAGE_AUDIT_REVIEWED',
    scenario,
    proof_scope: 'static_exact_id_coverage_only',
    matching_policy: 'matrix id must equal corpus id or corpus variant',
    not_live_codex_or_github_pass: true,
    builder_executed: false,
    github_draft_pr_verified: false,
    local_pr_like: false,
    corpus_count: corpus.length,
    corpus_mode_counts: corpusModeCounts,
    matrix_case_count: matrixCases.length,
    matrix_expected_mode_counts: matrixModeCounts,
    exact_id_covered_count: coveredRows.length,
    exact_id_gap_count: gapRows.length,
    exact_pre_codex_coverage: gapRows.length === 0,
    phase3_required: gapRows.length > 0,
    gap_mode_counts: gapModeCounts,
    covered: coveredRows,
    gaps: gapRows,
    limitations: [
      'audits exact corpus-to-matrix ID coverage without running Codex',
      'does not classify prompts, execute a builder, or publish PR evidence',
      'a gap means prompt-matrix is representative coverage, not exact 56-variant pre-Codex coverage'
    ]
  };
}

function main() {
  console.log(JSON.stringify(buildPromptCorpusCoverageReport(), null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

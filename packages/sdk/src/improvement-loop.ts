import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Decision } from '@vibeloop/shared';
import type { TerminalRunStatus } from '@vibeloop/artifacts';
import { loadTask } from '@vibeloop/task-protocol';
import { resolveBaseCommit, worktreeStatus } from '@vibeloop/workspace-runner';
import {
  verifyCandidatePatchHash,
  verifyEvalReportProvenance,
  type EvalReport,
  type QualityReport
} from '@vibeloop/eval-engine';
import { runKernel } from './run.js';
import { isPrCandidate } from './pr-candidate.js';
import {
  filterAdversaryReviewOutput,
  fixedAdversaryReviewContext,
  fixedAdversaryReviewPromptHash,
  FIXED_ADVERSARY_REVIEW_PROMPT_VERSION,
  resolveAdversaryReviewIndependence,
  type AdversaryReviewReport,
  type AdversaryReviewer
} from './adversary-review.js';
import type { QualityJudge } from './quality-judge.js';

/**
 * M1 — best-known candidate loop.
 *
 * Runs one builder per candidate, each through the full deterministic Verifier +
 * Evaluator kernel (separate worktree/exec — isolation preserved). Among
 * candidates that are `accepted` (decision === 'accept' AND qualified), a
 * deterministic Arbiter selects the best-known candidate by a fixed score and
 * fixed tie-break. No LLM votes, no LLM scoring. Candidates that do not verify
 * are never compared; a failed candidate never displaces a passing one.
 *
 * Cost is bounded by the candidate count: total kernel runs ≤
 * `builders.length + sum(refinementRounds[*].length) + sum(challengerRounds[*].length)`
 * (refinement rounds run only until the first accepted candidate; challenger rounds
 * always run). Callers MUST cap all three — there is no implicit ceiling.
 *
 * See docs/SELF_IMPROVEMENT_LOOP_DESIGN.md §5/§8/§12.
 */

export interface ImprovementLoopOptions {
  repoPath: string;
  taskFile: string;
  evalFile: string;
  dataDir: string;
  /** One agent spec per candidate (>= 1). Each runs in its own worktree/exec. */
  builders: string[];
  /**
   * M3 — bounded same-issue refinement (recover from failure). Each entry is an
   * additional round of builder specs, run ONLY if no `accepted` candidate has
   * appeared yet. The list length is the round cap. The Arbiter still selects the
   * best-known accepted candidate across all rounds; a failed refinement never
   * displaces an earlier passing candidate.
   */
  refinementRounds?: string[][] | undefined;
  /**
   * Challenger rounds run ALWAYS (even after an accepted candidate exists) to
   * search for a measurably better one — this is the "passed, but can it be
   * improved?" exploration. The Arbiter selects the best-known across all rounds;
   * a failed/worse challenger never displaces an earlier passing candidate.
   */
  challengerRounds?: string[][] | undefined;
  projectId?: string | undefined;
  loopId?: string | undefined;
  baseCommit?: string | undefined;
  proxyBaseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  logToStdout?: boolean | undefined;
  skipDependencyInstall?: boolean | undefined;
  /**
   * Trust-floor cap (B4): hard ceiling on total kernel runs across all rounds.
   * When reached, no further candidates are launched (`cap_hit` is recorded).
   * Undefined = no ceiling (caller-bounded, legacy behavior).
   */
  maxCandidates?: number | undefined;
  /**
   * Trust-floor wall-clock budget (B4): once this many ms have elapsed since the
   * loop started, no further candidates are launched (`deadline_hit` recorded).
   * In-flight candidates are NOT interrupted. Undefined = no time budget.
   */
  deadlineMs?: number | undefined;
  /**
   * Trust-floor token budget (B4): when paired with `getTokenUsage`, no further
   * candidates are launched once observed provider usage reaches this total.
   * In-flight candidates are NOT interrupted. Undefined = no token ceiling.
   */
  tokenBudgetTotal?: number | undefined;
  /**
   * Optional provider usage source, typically backed by an OAuth/API proxy. The
   * loop samples it before launching each candidate and after kernels complete.
   * If omitted, token usage remains `null` and token budget is not enforced.
   */
  getTokenUsage?:
    | (() => TokenUsageSnapshot | Promise<TokenUsageSnapshot>)
    | undefined;
  /**
   * Skip the B2 re-execution of the selected patch (keep only the B3 provenance
   * hash binding). Default false — the selected candidate is re-applied on a
   * fresh worktree and must reproduce accept ∧ qualified before it is a PR
   * candidate. Intended only for environments that cannot run an extra kernel.
   */
  skipFinalReverify?: boolean | undefined;
  /**
   * Trust-floor dirty-source guard (#1): when the base commit is auto-resolved
   * (no explicit `baseCommit`) and the source repo has uncommitted changes, the
   * loop refuses by default — the harness only fixes the committed state, so a
   * dirty tree silently diverges from what the user sees. Set true to proceed
   * anyway. Ignored when `baseCommit` is pinned (the caller chose the state).
   */
  allowDirty?: boolean | undefined;
  /**
   * B1 — OPTIONAL advisory tie-break. When 2+ accepted candidates are
   * score-indistinguishable, this judge (run in a separate context) may express
   * a quality preference among them. Strictly advisory: it only picks among
   * already-accepted, score-equal candidates and never changes correctness; the
   * pick is still gated by final verification. Omit to keep the deterministic
   * lexicographic tie-break.
   */
  qualityJudge?: QualityJudge | undefined;
  /**
   * Optional separate-context adversary reviewer. Advisory only: it receives the
   * selected/final-verified patch and may propose findings/tests, but it cannot
   * change decision/qualified/selection. Proposed tests are statically filtered
   * and must go through M2 isolation + M4 replay/freeze before any future gate.
   */
  adversaryReviewer?: AdversaryReviewer | undefined;
  /**
   * Declared provider for the separate-context adversary reviewer. Used only for
   * observability (`same_model_review` independence warning), never for accept.
   */
  adversaryReviewerProvider?: string | undefined;
  /**
   * Contract flag saying the caller intended a different provider. If the
   * reported provider identity does not prove independence, the advisory report
   * keeps `same_model_review=true` and raises a review signal.
   */
  adversaryRequireDifferentProvider?: boolean | undefined;
}

export interface TokenUsageSnapshot {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens: number;
  requests?: number | undefined;
}

export interface CandidateScore {
  evidence_present: number;
  changed_files: number;
  changed_lines: number;
  /**
   * Existing verifier/adversary tests are evidence, not the fix surface.
   * Modifying them is not an automatic rejection because some legacy tasks
   * still allow tests in scope, but it must lose to an implementation-only
   * equivalent fix under the fixed Evaluator score.
   */
  test_file_modifications: number;
  /** Deterministic Q5 metric-delta contribution from reports/quality-report.json. */
  quality_metric_score: number;
  total: number;
}

/**
 * Result of the final verification applied to the Arbiter-selected candidate
 * before it becomes a PR candidate. Combines B3 (provenance hash binding) and
 * B2 (re-execution of the selected patch on a fresh worktree). `passed` gates
 * PR candidacy: a selected candidate that fails this is NOT promoted.
 */
export interface FinalVerification {
  candidate_id: string;
  /** B3: expected sha256 for the selected candidate.patch at promotion time. */
  candidate_patch_hash?: string | undefined;
  /** B3: on-disk patch + gate-artifact hashes match what the report recorded. */
  provenance_ok: boolean;
  /** B2: true once the final reverify kernel was launched. */
  reverify_attempted: boolean;
  /** B2: the selected patch was re-applied + gates re-run on a fresh worktree. */
  reverified: boolean;
  reverify_decision?: string | undefined;
  reverify_qualified?: boolean | undefined;
  reverify_report?: string | undefined;
  passed: boolean;
  /**
   * Failure code when not passed: REPORT_MISSING | PROVENANCE_MISMATCH |
   * PATCH_MISSING | REVERIFY_APPLY_FAILED | REVERIFY_REJECTED |
   * REVERIFY_NOT_QUALIFIED.
   */
  reason?: string | undefined;
}

/** Trust-floor cost bounds applied to the loop (B4) and what actually happened. */
export interface LoopLimits {
  max_candidates: number | null;
  candidates_run: number;
  /** Candidate kernels plus final reverify kernels. */
  kernel_runs: number;
  /** Final reverify kernel attempts. */
  reverify_runs: number;
  /** Base-worktree test-on-base checks launched inside kernels. */
  test_on_base_runs: number;
  cap_hit: boolean;
  deadline_ms: number | null;
  deadline_hit: boolean;
  token_budget_total: number | null;
  token_usage_total: number | null;
  token_budget_hit: boolean;
}

/**
 * B1 — record of the advisory tie-break. ADVISORY ONLY: it can only reorder among
 * `tied_candidate_ids` (all already accepted + score-equal) and never changes
 * correctness. `changed_pick` is true when the judge moved the pick off the
 * deterministic (lexicographic) choice.
 */
export interface AdvisoryTieBreak {
  ran: boolean;
  tied_candidate_ids: string[];
  /** The deterministic pick (accepted[0]) before any advisory. */
  deterministic_pick: string;
  winner_candidate_id?: string | undefined;
  rationale?: string | undefined;
  changed_pick: boolean;
  /** Judge picked outside the tied set → ignored, deterministic pick kept. */
  invalid?: boolean | undefined;
  /** Judge threw → ignored, deterministic pick kept. */
  error?: string | undefined;
}

export type SelectionQualityStatus =
  | 'no_verified_selection'
  | 'single_accepted_no_comparator'
  | 'strict_fixed_score_win'
  | 'fixed_equivalent_patch_convergence'
  | 'fixed_tie_advisory_supported'
  | 'fixed_tie_no_distinction';

/**
 * Fixed evidence for "is this the best-known fix?" separate from correctness.
 *
 * Full autonomous improvement may only rely on `strict_score_improvement=true`.
 * That flag is derived from fixed Evaluator evidence only: either a strict fixed
 * score spread or independent accepted candidates converging on the exact same
 * patch hash. Advisory tie-breaks can support a choice among score-equal
 * candidates, but never make a full-improvement PASS.
 */
export interface SelectionQuality {
  authority: 'fixed_score_required_for_full_improvement';
  status: SelectionQualityStatus;
  selected_candidate_id: string | null;
  selected_score: CandidateScore | null;
  accepted_candidate_ids: string[];
  comparator_candidate_ids: string[];
  score_spread: number;
  strict_score_improvement: boolean;
  equivalent_patch_convergence: boolean;
  advisory_supported: boolean;
  best_choice_supported: boolean;
  full_autonomous_improvement_eligible: boolean;
  evidence:
    | 'strict_fixed_score_spread'
    | 'equivalent_patch_hash_convergence'
    | 'advisory_tie_break_changed_pick'
    | 'single_accepted_no_comparator'
    | 'fixed_tie_no_distinction'
    | 'none';
  reasons: string[];
}

export interface CandidateOutcome {
  candidateId: string;
  agentSpec: string;
  round: number;
  status: TerminalRunStatus;
  decision?: Decision | undefined;
  qualified: boolean;
  accepted: boolean;
  artifactRoot: string;
  reportPath?: string | undefined;
  score?: CandidateScore | undefined;
  patchHash?: string | undefined;
}

export interface SelectionReport {
  schema_version: '1.1';
  loop_id: string;
  base_commit: string;
  candidate_count: number;
  accepted_count: number;
  selected_candidate_id: string | null;
  selected_artifact_root: string | null;
  selected_report: string | null;
  selected_patch: string | null;
  /** True only when a candidate was selected AND survived final verification. */
  pr_candidate: boolean;
  final_verification: FinalVerification | null;
  advisory_tie_break: AdvisoryTieBreak | null;
  selection_quality: SelectionQuality;
  adversary_review: AdversaryReviewReport | null;
  limits: LoopLimits;
  candidates: Array<{
    candidate_id: string;
    accepted: boolean;
    decision?: string | undefined;
    qualified: boolean;
    score?: CandidateScore | undefined;
    patch_hash?: string | undefined;
    artifact_root: string;
    report_path?: string | undefined;
    quality_report_ref: string;
  }>;
}

const CANDIDATE_PATCH_REF = 'patches/candidate.patch';
const QUALITY_REPORT_REF = 'reports/quality-report.json';
// Placeholder spec for the re-verification kernel run: evalOnlyPatch skips the
// agent entirely, so this is never resolved to an adapter (mirrors retry.ts).
const REVERIFY_AGENT_SPEC = 'mock:__final_reverify_no_agent__.json';

export interface ReverifyContext {
  repoPath: string;
  taskFile: string;
  evalFile: string;
  dataDir: string;
  projectId?: string | undefined;
  baseCommit: string;
  baseLoopId: string;
  proxyBaseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  logToStdout?: boolean | undefined;
  skipDependencyInstall?: boolean | undefined;
  skipFinalReverify: boolean;
}

/**
 * Final verification of the Arbiter-selected candidate before PR candidacy.
 *
 * B3 (provenance): re-hash the on-disk patch + gate artifacts and confirm they
 * still match what the selected candidate's eval-report recorded — catches a
 * patch/report that was altered or swapped between verification and promotion.
 *
 * B2 (re-execution): re-apply the selected patch on a FRESH worktree at the same
 * base and re-run the full gate set; the PR candidate must independently
 * reproduce accept ∧ qualified. A patch that no longer applies or no longer
 * passes is not promoted (no PR).
 */
export async function verifySelectedCandidate(
  selected: CandidateOutcome,
  ctx: ReverifyContext
): Promise<FinalVerification> {
  const fv: FinalVerification = {
    candidate_id: selected.candidateId,
    provenance_ok: false,
    reverify_attempted: false,
    reverified: false,
    passed: false
  };
  const report = selected.reportPath
    ? await readJson<EvalReport>(selected.reportPath)
    : undefined;
  if (!report) {
    fv.reason = 'REPORT_MISSING';
    return fv;
  }
  fv.candidate_patch_hash = report.provenance?.candidate_patch_hash;
  const provenanceOk =
    (await verifyEvalReportProvenance(selected.artifactRoot, report)) &&
    (await verifyCandidatePatchHash(selected.artifactRoot, report));
  fv.provenance_ok = provenanceOk;
  if (!provenanceOk) {
    fv.reason = 'PROVENANCE_MISMATCH';
    return fv;
  }
  if (ctx.skipFinalReverify) {
    // Provenance-only mode: the hash binding held; skip the extra kernel run.
    fv.passed = true;
    return fv;
  }
  let patch: string;
  try {
    patch = await readFile(
      path.join(selected.artifactRoot, CANDIDATE_PATCH_REF),
      'utf8'
    );
  } catch {
    fv.reason = 'PATCH_MISSING';
    return fv;
  }
  let reverify: Awaited<ReturnType<typeof runKernel>>;
  try {
    fv.reverify_attempted = true;
    reverify = await runKernel({
      repoPath: ctx.repoPath,
      taskFile: ctx.taskFile,
      evalFile: ctx.evalFile,
      dataDir: ctx.dataDir,
      agentSpec: REVERIFY_AGENT_SPEC,
      projectId: ctx.projectId,
      loopId: `${ctx.baseLoopId}-reverify`,
      baseCommit: ctx.baseCommit,
      proxyBaseUrl: ctx.proxyBaseUrl,
      signal: ctx.signal,
      logToStdout: ctx.logToStdout,
      skipDependencyInstall: ctx.skipDependencyInstall,
      evalOnlyPatch: patch
    });
  } catch {
    // git apply failed / kernel threw → the patch does not cleanly reproduce.
    fv.reason = 'REVERIFY_APPLY_FAILED';
    return fv;
  }
  fv.reverified = true;
  fv.reverify_decision = reverify.decision;
  fv.reverify_qualified = reverify.qualified;
  fv.reverify_report = reverify.reportPath;
  if (reverify.decision !== 'accept') {
    fv.reason = 'REVERIFY_REJECTED';
    return fv;
  }
  if (!reverify.qualified) {
    fv.reason = 'REVERIFY_NOT_QUALIFIED';
    return fv;
  }
  fv.passed = true;
  return fv;
}

export interface ImprovementLoopResult {
  loopId: string;
  projectId: string;
  baseCommit: string;
  candidates: CandidateOutcome[];
  /**
   * The PR candidate: the best-known accepted candidate THAT ALSO survived final
   * verification (B2/B3). Undefined when nothing cleared the bar — including the
   * case where the Arbiter's pick failed re-verification (see `finalVerification`).
   */
  selected?: CandidateOutcome | undefined;
  selectionReportPath?: string | undefined;
  finalVerification?: FinalVerification | undefined;
  advisoryTieBreak?: AdvisoryTieBreak | undefined;
  selectionQuality?: SelectionQuality | undefined;
  adversaryReview?: AdversaryReviewReport | undefined;
  limits?: LoopLimits | undefined;
}

export interface ArtifactSignals {
  evidencePresent: number;
  changedFiles: number;
  changedLines: number;
  testFileModifications: number;
  /**
   * Fixed quality metric score from Q5 rules. Positive means objectively better
   * than baseline according to configured metrics. This is deterministic and
   * comes from the Evaluator artifact, not an LLM opinion.
   */
  qualityMetricScore: number;
}

function isTestLikePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/test/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/__tests__/') ||
    normalized.includes('/spec/') ||
    normalized.includes('/adversary/') ||
    /\.test\.[cm]?[jt]sx?$/.test(normalized) ||
    /\.spec\.[cm]?[jt]sx?$/.test(normalized) ||
    normalized.endsWith('_test.py') ||
    normalized.startsWith('test_') ||
    normalized.includes('/test_')
  );
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function q5MetricScore(quality: QualityReport | undefined): number {
  if (!quality?.rules) return 0;
  return quality.rules.reduce((score, rule) => {
    if (!rule.id.startsWith('Q5_') || typeof rule.value !== 'number') {
      return score;
    }
    // Coverage is higher-is-better. The remaining Q5 deltas are lower-is-better
    // (latency/security/critical-security/duplication), so negate their delta.
    if (rule.id === 'Q5_coverage') return score + rule.value;
    return score - rule.value;
  }, 0);
}

async function readCandidateSignals(
  artifactRoot: string
): Promise<ArtifactSignals> {
  const changed = await readJson<{
    files?: Array<{
      path?: string;
      status?: string;
      added_lines?: number;
      deleted_lines?: number;
    }>;
  }>(path.join(artifactRoot, 'patches', 'changed-files.json'));
  const evidence = await readJson<{
    evidence?: Array<{ status?: string }>;
  }>(path.join(artifactRoot, 'reports', 'evidence-summary.json'));
  const quality = await readJson<QualityReport>(
    path.join(artifactRoot, 'reports', 'quality-report.json')
  );

  const files = changed?.files ?? [];
  const testFileModifications = files.filter((file) => {
    const filePath = file.path ?? '';
    // New regression tests can be legitimate evidence. Mutating existing test
    // files is the risky case because it can make a weak candidate appear to
    // pass by moving the verifier surface. Keep it deterministic and penalized.
    return file.status !== 'added' && isTestLikePath(filePath);
  }).length;
  return {
    evidencePresent: (evidence?.evidence ?? []).filter(
      (item) => item.status === 'present'
    ).length,
    changedFiles: files.length,
    changedLines: files.reduce(
      (sum, file) => sum + (file.added_lines ?? 0) + (file.deleted_lines ?? 0),
      0
    ),
    testFileModifications,
    qualityMetricScore: q5MetricScore(quality)
  };
}

export function scoreArtifactSignalsForSelection(
  signals: ArtifactSignals
): CandidateScore {
  // Fixed weights: more evidence and better Q5 metric deltas are better; smaller
  // diffs are better. Existing test mutations are penalized so an
  // implementation-only candidate beats a candidate that improves its score by
  // editing verifier evidence. If no Q5 rules exist, qualityMetricScore=0.
  const total =
    signals.evidencePresent * 100 +
    signals.qualityMetricScore -
    signals.changedFiles * 5 -
    signals.changedLines -
    signals.testFileModifications * 25;
  return {
    evidence_present: signals.evidencePresent,
    changed_files: signals.changedFiles,
    changed_lines: signals.changedLines,
    test_file_modifications: signals.testFileModifications,
    quality_metric_score: signals.qualityMetricScore,
    total
  };
}

async function readCandidatePatchHash(
  artifactRoot: string
): Promise<string | undefined> {
  try {
    const patch = await readFile(
      path.join(artifactRoot, CANDIDATE_PATCH_REF),
      'utf8'
    );
    return createHash('sha256').update(patch).digest('hex');
  } catch {
    return undefined;
  }
}

/** Deterministic best-known ranking among accepted candidates (highest first). */
function compareAccepted(a: CandidateOutcome, b: CandidateOutcome): number {
  const sa = a.score;
  const sb = b.score;
  if (!sa || !sb) return a.candidateId.localeCompare(b.candidateId);
  if (sb.total !== sa.total) return sb.total - sa.total;
  if (sa.test_file_modifications !== sb.test_file_modifications) {
    return sa.test_file_modifications - sb.test_file_modifications;
  }
  if (sa.changed_files !== sb.changed_files)
    return sa.changed_files - sb.changed_files;
  if (sa.changed_lines !== sb.changed_lines)
    return sa.changed_lines - sb.changed_lines;
  return a.candidateId.localeCompare(b.candidateId);
}

function topEquivalentPatchGroup(
  accepted: CandidateOutcome[],
  preferred: CandidateOutcome | undefined
): CandidateOutcome[] {
  const top = preferred?.score;
  if (!top) return [];
  const tied = accepted.filter(
    (candidate) =>
      !!candidate.score &&
      candidate.score.total === top.total &&
      candidate.score.changed_files === top.changed_files &&
      candidate.score.changed_lines === top.changed_lines &&
      !!candidate.patchHash
  );
  const groups = new Map<string, CandidateOutcome[]>();
  for (const candidate of tied) {
    groups.set(candidate.patchHash!, [
      ...(groups.get(candidate.patchHash!) ?? []),
      candidate
    ]);
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort(
      (a, b) => b.length - a.length || a[0]!.candidateId.localeCompare(b[0]!.candidateId)
    )[0] ?? [];
}

async function writeAdversaryM2Handoff(options: {
  report: AdversaryReviewReport;
  selected: CandidateOutcome;
  baseCommit: string;
  loopId: string;
}): Promise<string | undefined> {
  const accepted = options.report.proposals.filter(
    (proposal) => proposal.next_step === 'm2_execution_required'
  );
  if (accepted.length === 0) return undefined;

  const handoffRef = path.join(
    options.selected.artifactRoot,
    'reports',
    'adversary-m2-handoff.json'
  );
  await mkdir(path.dirname(handoffRef), { recursive: true });
  await writeFile(
    handoffRef,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_m2_handoff',
        authority: 'advisory_only',
        decision_impact: 'none',
        note: 'Static filters passed only. Execute under R1 isolation and M4 replay/freeze before any next-loop fixed gate.',
        loop_id: options.loopId,
        base_commit: options.baseCommit,
        selected_candidate_id: options.selected.candidateId,
        selected_patch: path.join(
          options.selected.artifactRoot,
          CANDIDATE_PATCH_REF
        ),
        selected_report: options.selected.reportPath ?? null,
        next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
        proposals: accepted.map((entry) => ({
          proposal: entry.proposal,
          filter: entry.filter,
          next_step: entry.next_step
        }))
      },
      null,
      2
    )}\n`
  );
  return handoffRef;
}

function buildSelectionQuality(options: {
  selected: CandidateOutcome | undefined;
  accepted: CandidateOutcome[];
  advisoryTieBreak: AdvisoryTieBreak | undefined;
}): SelectionQuality {
  const { selected, accepted, advisoryTieBreak } = options;
  const acceptedIds = accepted.map((candidate) => candidate.candidateId);
  const comparatorIds = selected
    ? acceptedIds.filter((id) => id !== selected.candidateId)
    : acceptedIds;
  const scores = accepted
    .map((candidate) => candidate.score?.total)
    .filter((score): score is number => typeof score === 'number');
  const scoreSpread =
    scores.length > 0 ? Math.max(...scores) - Math.min(...scores) : 0;
  const selectedScore = selected?.score ?? null;
  const selectedIsTopFixedScore =
    !!selectedScore &&
    scores.length > 0 &&
    selectedScore.total === Math.max(...scores);
  const strictScoreImprovement =
    !!selected &&
    accepted.length >= 2 &&
    selectedIsTopFixedScore &&
    scoreSpread > 0;
  const topScore = scores.length > 0 ? Math.max(...scores) : null;
  const topAccepted = topScore === null
    ? []
    : accepted.filter((candidate) => candidate.score?.total === topScore);
  const selectedPatchHash = selected?.patchHash;
  const equivalentPatchConvergence = Boolean(
    selected &&
      topAccepted.length >= 2 &&
      selectedPatchHash &&
      topAccepted.filter(
        (candidate) => candidate.patchHash === selectedPatchHash
      ).length >= 2
  );
  const strictImprovementEvidence =
    strictScoreImprovement || equivalentPatchConvergence;
  const advisorySupported = advisoryTieBreak?.changed_pick === true;
  let status: SelectionQualityStatus;
  let evidence: SelectionQuality['evidence'];
  const reasons: string[] = [];

  if (!selected) {
    status = 'no_verified_selection';
    evidence = 'none';
    reasons.push('no_selected_candidate_survived_final_verification');
  } else if (accepted.length <= 1) {
    status = 'single_accepted_no_comparator';
    evidence = 'single_accepted_no_comparator';
    reasons.push('only_one_accepted_candidate');
  } else if (strictScoreImprovement) {
    status = 'strict_fixed_score_win';
    evidence = 'strict_fixed_score_spread';
    reasons.push('selected_candidate_has_strictly_better_fixed_score');
  } else if (equivalentPatchConvergence) {
    status = 'fixed_equivalent_patch_convergence';
    evidence = 'equivalent_patch_hash_convergence';
    reasons.push('accepted_top_candidates_converged_on_identical_patch_hash');
  } else if (advisorySupported) {
    status = 'fixed_tie_advisory_supported';
    evidence = 'advisory_tie_break_changed_pick';
    reasons.push('fixed_scores_tied_and_advisory_tie_break_changed_pick');
  } else {
    status = 'fixed_tie_no_distinction';
    evidence = 'fixed_tie_no_distinction';
    reasons.push('fixed_scores_do_not_prove_better_choice');
  }

  return {
    authority: 'fixed_score_required_for_full_improvement',
    status,
    selected_candidate_id: selected?.candidateId ?? null,
    selected_score: selectedScore,
    accepted_candidate_ids: acceptedIds,
    comparator_candidate_ids: comparatorIds,
    score_spread: scoreSpread,
    strict_score_improvement: strictImprovementEvidence,
    equivalent_patch_convergence: equivalentPatchConvergence,
    advisory_supported: advisorySupported,
    best_choice_supported: strictImprovementEvidence || advisorySupported,
    full_autonomous_improvement_eligible: strictImprovementEvidence,
    evidence,
    reasons
  };
}

export async function runImprovementLoop(
  options: ImprovementLoopOptions
): Promise<ImprovementLoopResult> {
  if (options.builders.length === 0) {
    throw new Error('runImprovementLoop requires at least one builder spec');
  }

  const baseLoopId = options.loopId ?? `iloop-${Date.now()}`;
  const task = await loadTask(options.taskFile);

  // Trust-floor dirty-source guard (#1): only when the base is auto-resolved
  // (an explicit --base-commit means the caller pinned the exact state). The
  // worktree is isolated at baseCommit, so dirt does not corrupt the run — but
  // it silently excludes the user's uncommitted work, so refuse by default.
  if (options.baseCommit === undefined && options.allowDirty !== true) {
    const status = await worktreeStatus(options.repoPath);
    if (status.dirty) {
      throw new Error(
        `Source repo has ${status.entries.length} uncommitted change(s); the ` +
          `improvement loop only fixes the committed state, so a dirty tree ` +
          `would silently diverge from what you see. Commit/stash, pass an ` +
          `explicit --base-commit, or --allow-dirty to proceed anyway.`
      );
    }
  }

  // Resolve the base commit ONCE so every candidate fixes the same problem state.
  const baseCommit =
    options.baseCommit ??
    (await resolveBaseCommit(options.repoPath, task.base_branch ?? 'HEAD'));

  const outcomes: CandidateOutcome[] = [];
  let resolvedProjectId = options.projectId ?? 'default';
  let candidateCounter = 0;
  let candidateKernelRuns = 0;
  let candidateTestOnBaseRuns = 0;
  const testOnBaseEnabled = (task.acceptance?.required_tests?.length ?? 0) > 0;

  // B4 — trust-floor cost bounds. Enforced BEFORE each kernel run so neither the
  // candidate count nor the wall-clock budget can be exceeded by the harness.
  const startedAt = Date.now();
  const { maxCandidates, deadlineMs, tokenBudgetTotal } = options;
  let capHit = false;
  let deadlineHit = false;
  let tokenBudgetHit = false;
  let tokenUsageTotal: number | null = null;
  const refreshTokenUsage = async (): Promise<void> => {
    if (!options.getTokenUsage) return;
    const usage = await options.getTokenUsage();
    tokenUsageTotal = Math.max(0, usage.total_tokens);
  };
  const budgetExhausted = async (): Promise<boolean> => {
    await refreshTokenUsage();
    if (
      tokenBudgetTotal !== undefined &&
      tokenUsageTotal !== null &&
      tokenUsageTotal >= tokenBudgetTotal
    ) {
      tokenBudgetHit = true;
      return true;
    }
    if (maxCandidates !== undefined && candidateCounter >= maxCandidates) {
      capHit = true;
      return true;
    }
    if (deadlineMs !== undefined && Date.now() - startedAt >= deadlineMs) {
      deadlineHit = true;
      return true;
    }
    return false;
  };

  // Run one round's builder specs as isolated candidates. (Sequential for v1;
  // parallelism is a later optimization — independence is satisfied by a separate
  // worktree/exec per candidate.)
  const runRoundSpecs = async (
    specs: string[],
    round: number
  ): Promise<void> => {
    for (const agentSpec of specs) {
      if (await budgetExhausted()) return;
      const candidateId = `${baseLoopId}-c${candidateCounter}`;
      candidateCounter += 1;
      candidateKernelRuns += 1;
      if (testOnBaseEnabled) candidateTestOnBaseRuns += 1;
      const result = await runKernel({
        repoPath: options.repoPath,
        taskFile: options.taskFile,
        evalFile: options.evalFile,
        dataDir: options.dataDir,
        agentSpec,
        projectId: options.projectId,
        loopId: candidateId,
        baseCommit,
        proxyBaseUrl: options.proxyBaseUrl,
        signal: options.signal,
        logToStdout: options.logToStdout,
        skipDependencyInstall: options.skipDependencyInstall
      });
      resolvedProjectId = result.projectId;
      const accepted = result.decision === 'accept' && result.qualified;
      const outcome: CandidateOutcome = {
        candidateId,
        agentSpec,
        round,
        status: result.status,
        decision: result.decision,
        qualified: result.qualified,
        accepted,
        artifactRoot: result.layout.root,
        reportPath: result.reportPath
      };
      if (accepted) {
        outcome.score = scoreArtifactSignalsForSelection(
          await readCandidateSignals(result.layout.root)
        );
        outcome.patchHash = await readCandidatePatchHash(result.layout.root);
      }
      outcomes.push(outcome);
      await refreshTokenUsage();
    }
  };

  let round = 0;
  // Recovery rounds: round 0 is the initial builder pool; later refinement rounds
  // run ONLY while no accepted candidate has appeared yet (recover from failure).
  const recoveryRounds = [
    options.builders,
    ...(options.refinementRounds ?? [])
  ];
  for (let r = 0; r < recoveryRounds.length; r += 1) {
    if (capHit || deadlineHit) break; // cost ceiling reached
    if (r > 0 && outcomes.some((outcome) => outcome.accepted)) {
      break; // already have a passing candidate; stop failure-recovery refinement
    }
    await runRoundSpecs(recoveryRounds[r]!, round);
    round += 1;
  }

  // Challenger rounds: run ALWAYS (even after an accepted candidate exists) to
  // search for a measurably BETTER one. The Arbiter still selects the best-known
  // across everything, and a failed challenger never displaces a passing candidate.
  for (const challenger of options.challengerRounds ?? []) {
    if (capHit || deadlineHit) break; // cost ceiling reached
    await runRoundSpecs(challenger, round);
    round += 1;
  }

  const accepted = outcomes
    .filter((outcome) => outcome.accepted)
    .sort(compareAccepted);

  // B1 — advisory tie-break. Among score-indistinguishable accepted candidates,
  // an OPTIONAL separate-context judge may reorder the top group. It can ONLY pick
  // among already-accepted, score-equal candidates — never changes correctness —
  // and its pick is still gated by the final verification below.
  let preferred = accepted[0];
  const equivalentPatchGroup = topEquivalentPatchGroup(accepted, preferred);
  if (equivalentPatchGroup.length > 0) {
    preferred = equivalentPatchGroup[0];
  }
  let advisoryTieBreak: AdvisoryTieBreak | undefined;
  if (preferred && options.qualityJudge) {
    const top = preferred.score;
    const tied = accepted.filter(
      (c) =>
        !!c.score &&
        !!top &&
        c.score.total === top.total &&
        c.score.changed_files === top.changed_files &&
        c.score.changed_lines === top.changed_lines
    );
    if (tied.length >= 2) {
      advisoryTieBreak = {
        ran: true,
        tied_candidate_ids: tied.map((c) => c.candidateId),
        deterministic_pick: preferred.candidateId,
        changed_pick: false
      };
      try {
        const verdict = await options.qualityJudge({
          tied: tied.map((c) => ({
            candidate_id: c.candidateId,
            artifact_root: c.artifactRoot,
            patch_ref: path.join(c.artifactRoot, CANDIDATE_PATCH_REF),
            report_path: c.reportPath,
            score: c.score
              ? {
                  total: c.score.total,
                  changed_files: c.score.changed_files,
                  changed_lines: c.score.changed_lines,
                  quality_metric_score: c.score.quality_metric_score
                }
              : undefined
          }))
        });
        const winner = tied.find(
          (c) => c.candidateId === verdict.winner_candidate_id
        );
        if (winner) {
          preferred = winner;
          advisoryTieBreak.winner_candidate_id = winner.candidateId;
          advisoryTieBreak.rationale = verdict.rationale;
          advisoryTieBreak.changed_pick =
            winner.candidateId !== advisoryTieBreak.deterministic_pick;
        } else {
          // Judge named a candidate outside the tied set → ignore (cannot let an
          // advisory promote anything the deterministic Arbiter did not tie).
          advisoryTieBreak.invalid = true;
        }
      } catch (error) {
        // A failing advisory never blocks the run; keep the deterministic pick.
        advisoryTieBreak.error =
          error instanceof Error ? error.message : String(error);
      }
    }
  }

  // The pick is only a PR candidate if it ALSO survives final verification (B2
  // re-execution + B3 provenance binding). A pick that fails is recorded but NOT
  // promoted — no PR comes out of an unverifiable patch.
  const best = preferred;
  let finalVerification: FinalVerification | undefined;
  let selected = best;
  if (best) {
    finalVerification = await verifySelectedCandidate(best, {
      repoPath: options.repoPath,
      taskFile: options.taskFile,
      evalFile: options.evalFile,
      dataDir: options.dataDir,
      projectId: options.projectId,
      baseCommit,
      baseLoopId,
      proxyBaseUrl: options.proxyBaseUrl,
      signal: options.signal,
      logToStdout: options.logToStdout,
      skipDependencyInstall: options.skipDependencyInstall,
      skipFinalReverify: options.skipFinalReverify ?? false
    });
    if (!finalVerification.passed) {
      selected = undefined;
    }
    await refreshTokenUsage();
  }

  let adversaryReview: AdversaryReviewReport | undefined;
  if (selected && options.adversaryReviewer) {
    const adversaryIndependence = resolveAdversaryReviewIndependence({
      builderAgentSpec: selected.agentSpec,
      reviewerProvider: options.adversaryReviewerProvider,
      requireDifferentProvider: options.adversaryRequireDifferentProvider
    });
    const patchRef = path.join(selected.artifactRoot, CANDIDATE_PATCH_REF);
    const adversaryInput = {
      reviewer_context: fixedAdversaryReviewContext(),
      task: {
        id: task.id,
        title: task.title,
        objective: task.objective,
        required_evidence: task.required_evidence,
        acceptance_required_tests: task.acceptance?.required_tests ?? [],
        write_scope_allowed: task.write_scope.allowed
      },
      selected: {
        candidate_id: selected.candidateId,
        patch_ref: patchRef,
        patch: await readFile(patchRef, 'utf8')
      }
    };
    try {
      const output = await options.adversaryReviewer(adversaryInput);
      adversaryReview = filterAdversaryReviewOutput({
        input: adversaryInput,
        output,
        independence: adversaryIndependence
      });
      const m2HandoffRef = await writeAdversaryM2Handoff({
        report: adversaryReview,
        selected,
        baseCommit,
        loopId: baseLoopId
      });
      if (m2HandoffRef) adversaryReview.m2_handoff_ref = m2HandoffRef;
    } catch (error) {
      adversaryReview = {
        ran: true,
        authority: 'advisory_only',
        decision_impact: 'none',
        selected_candidate_id: selected.candidateId,
        builder_provider: adversaryIndependence.builder_provider,
        reviewer_provider: adversaryIndependence.reviewer_provider,
        same_model_review: adversaryIndependence.same_model_review,
        require_different_provider:
          adversaryIndependence.require_different_provider,
        prompt_version: FIXED_ADVERSARY_REVIEW_PROMPT_VERSION,
        prompt_hash: fixedAdversaryReviewPromptHash(),
        findings: [],
        proposals: [],
        accepted_proposal_count: 0,
        requires_human_review_signal: true,
        next_step: 'none',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  const selectionQuality = buildSelectionQuality({
    selected,
    accepted,
    advisoryTieBreak
  });

  const limits: LoopLimits = {
    reverify_runs: finalVerification?.reverify_attempted ? 1 : 0,
    max_candidates: maxCandidates ?? null,
    candidates_run: outcomes.length,
    kernel_runs:
      candidateKernelRuns + (finalVerification?.reverify_attempted ? 1 : 0),
    test_on_base_runs:
      candidateTestOnBaseRuns +
      (finalVerification?.reverify_attempted && testOnBaseEnabled ? 1 : 0),
    cap_hit: capHit,
    deadline_ms: deadlineMs ?? null,
    deadline_hit: deadlineHit,
    token_budget_total: tokenBudgetTotal ?? null,
    token_usage_total: tokenUsageTotal,
    token_budget_hit: tokenBudgetHit
  };

  const selectionReport: SelectionReport = {
    schema_version: '1.1',
    loop_id: baseLoopId,
    base_commit: baseCommit,
    candidate_count: outcomes.length,
    accepted_count: accepted.length,
    selected_candidate_id: selected?.candidateId ?? null,
    selected_artifact_root: selected?.artifactRoot ?? null,
    selected_report: selected?.reportPath ?? null,
    selected_patch: selected
      ? path.join(selected.artifactRoot, CANDIDATE_PATCH_REF)
      : null,
    pr_candidate: isPrCandidate({
      decision: selected?.decision ?? null,
      allPass: selected?.decision === 'accept',
      qualified: selected?.qualified ?? null,
      selected,
      finalVerification: finalVerification ?? null
    }),
    final_verification: finalVerification ?? null,
    advisory_tie_break: advisoryTieBreak ?? null,
    selection_quality: selectionQuality,
    adversary_review: adversaryReview ?? null,
    limits,
    candidates: outcomes.map((outcome) => ({
      candidate_id: outcome.candidateId,
      accepted: outcome.accepted,
      decision: outcome.decision,
      qualified: outcome.qualified,
      score: outcome.score,
      patch_hash: outcome.patchHash,
      artifact_root: outcome.artifactRoot,
      report_path: outcome.reportPath,
      quality_report_ref: path.join(outcome.artifactRoot, QUALITY_REPORT_REF)
    }))
  };

  const selectionDir = path.join(
    options.dataDir,
    'projects',
    resolvedProjectId,
    'selections'
  );
  await mkdir(selectionDir, { recursive: true });
  const selectionReportPath = path.join(selectionDir, `${baseLoopId}.json`);
  await writeFile(
    selectionReportPath,
    `${JSON.stringify(selectionReport, null, 2)}\n`
  );

  return {
    loopId: baseLoopId,
    projectId: resolvedProjectId,
    baseCommit,
    candidates: outcomes,
    selected,
    selectionReportPath,
    finalVerification,
    advisoryTieBreak,
    selectionQuality,
    adversaryReview,
    limits
  };
}

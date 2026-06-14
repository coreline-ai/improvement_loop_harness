import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Decision } from '@vibeloop/shared';
import type { TerminalRunStatus } from '@vibeloop/artifacts';
import { loadTask } from '@vibeloop/task-protocol';
import { resolveBaseCommit, worktreeStatus } from '@vibeloop/workspace-runner';
import {
  verifyCandidatePatchHash,
  verifyEvalReportProvenance,
  type EvalReport
} from '@vibeloop/eval-engine';
import { runKernel } from './run.js';
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
}

export interface CandidateScore {
  evidence_present: number;
  changed_files: number;
  changed_lines: number;
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
  /** B3: on-disk patch + gate-artifact hashes match what the report recorded. */
  provenance_ok: boolean;
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
  cap_hit: boolean;
  deadline_ms: number | null;
  deadline_hit: boolean;
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
  limits: LoopLimits;
  candidates: Array<{
    candidate_id: string;
    accepted: boolean;
    decision?: string | undefined;
    qualified: boolean;
    score?: CandidateScore | undefined;
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
  limits?: LoopLimits | undefined;
}

interface ArtifactSignals {
  evidencePresent: number;
  changedFiles: number;
  changedLines: number;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function readCandidateSignals(
  artifactRoot: string
): Promise<ArtifactSignals> {
  const changed = await readJson<{
    files?: Array<{ added_lines?: number; deleted_lines?: number }>;
  }>(path.join(artifactRoot, 'patches', 'changed-files.json'));
  const evidence = await readJson<{
    evidence?: Array<{ status?: string }>;
  }>(path.join(artifactRoot, 'reports', 'evidence-summary.json'));

  const files = changed?.files ?? [];
  return {
    evidencePresent: (evidence?.evidence ?? []).filter(
      (item) => item.status === 'present'
    ).length,
    changedFiles: files.length,
    changedLines: files.reduce(
      (sum, file) => sum + (file.added_lines ?? 0) + (file.deleted_lines ?? 0),
      0
    )
  };
}

function scoreFor(signals: ArtifactSignals): CandidateScore {
  // Fixed weights: more evidence is better; smaller diffs are better.
  const total =
    signals.evidencePresent * 100 -
    signals.changedFiles * 5 -
    signals.changedLines;
  return {
    evidence_present: signals.evidencePresent,
    changed_files: signals.changedFiles,
    changed_lines: signals.changedLines,
    total
  };
}

/** Deterministic best-known ranking among accepted candidates (highest first). */
function compareAccepted(a: CandidateOutcome, b: CandidateOutcome): number {
  const sa = a.score;
  const sb = b.score;
  if (!sa || !sb) return a.candidateId.localeCompare(b.candidateId);
  if (sb.total !== sa.total) return sb.total - sa.total;
  if (sa.changed_files !== sb.changed_files)
    return sa.changed_files - sb.changed_files;
  if (sa.changed_lines !== sb.changed_lines)
    return sa.changed_lines - sb.changed_lines;
  return a.candidateId.localeCompare(b.candidateId);
}

export async function runImprovementLoop(
  options: ImprovementLoopOptions
): Promise<ImprovementLoopResult> {
  if (options.builders.length === 0) {
    throw new Error('runImprovementLoop requires at least one builder spec');
  }

  const baseLoopId = options.loopId ?? `iloop-${Date.now()}`;

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
    (await resolveBaseCommit(
      options.repoPath,
      (await loadTask(options.taskFile)).base_branch ?? 'HEAD'
    ));

  const outcomes: CandidateOutcome[] = [];
  let resolvedProjectId = options.projectId ?? 'default';
  let candidateCounter = 0;

  // B4 — trust-floor cost bounds. Enforced BEFORE each kernel run so neither the
  // candidate count nor the wall-clock budget can be exceeded by the harness.
  const startedAt = Date.now();
  const { maxCandidates, deadlineMs } = options;
  let capHit = false;
  let deadlineHit = false;
  const budgetExhausted = (): boolean => {
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
      if (budgetExhausted()) return;
      const candidateId = `${baseLoopId}-c${candidateCounter}`;
      candidateCounter += 1;
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
        outcome.score = scoreFor(
          await readCandidateSignals(result.layout.root)
        );
      }
      outcomes.push(outcome);
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
                  changed_lines: c.score.changed_lines
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
  }

  const limits: LoopLimits = {
    max_candidates: maxCandidates ?? null,
    candidates_run: outcomes.length,
    cap_hit: capHit,
    deadline_ms: deadlineMs ?? null,
    deadline_hit: deadlineHit
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
    pr_candidate: !!selected,
    final_verification: finalVerification ?? null,
    advisory_tie_break: advisoryTieBreak ?? null,
    limits,
    candidates: outcomes.map((outcome) => ({
      candidate_id: outcome.candidateId,
      accepted: outcome.accepted,
      decision: outcome.decision,
      qualified: outcome.qualified,
      score: outcome.score,
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
    limits
  };
}

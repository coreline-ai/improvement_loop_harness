import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Decision } from '@vibeloop/shared';
import type { TerminalRunStatus } from '@vibeloop/artifacts';
import { loadTask } from '@vibeloop/task-protocol';
import { resolveBaseCommit } from '@vibeloop/workspace-runner';
import { runKernel } from './run.js';

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
}

export interface CandidateScore {
  evidence_present: number;
  changed_files: number;
  changed_lines: number;
  total: number;
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
  schema_version: '1.0';
  loop_id: string;
  base_commit: string;
  candidate_count: number;
  accepted_count: number;
  selected_candidate_id: string | null;
  selected_artifact_root: string | null;
  selected_report: string | null;
  selected_patch: string | null;
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

export interface ImprovementLoopResult {
  loopId: string;
  projectId: string;
  baseCommit: string;
  candidates: CandidateOutcome[];
  selected?: CandidateOutcome | undefined;
  selectionReportPath?: string | undefined;
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

  // Run one round's builder specs as isolated candidates. (Sequential for v1;
  // parallelism is a later optimization — independence is satisfied by a separate
  // worktree/exec per candidate.)
  const runRoundSpecs = async (
    specs: string[],
    round: number
  ): Promise<void> => {
    for (const agentSpec of specs) {
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
    await runRoundSpecs(challenger, round);
    round += 1;
  }

  const accepted = outcomes
    .filter((outcome) => outcome.accepted)
    .sort(compareAccepted);
  const selected = accepted[0];

  const selectionReport: SelectionReport = {
    schema_version: '1.0',
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
    selectionReportPath
  };
}

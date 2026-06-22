/**
 * M4 (execution substrate) — replay a corpus under R1 isolation to compute
 * `replaySafe` for shadow rule promotion.
 *
 * `decideShadowPromotion` (rulepack-shadow.ts) consumes `replaySafe` as an INPUT.
 * This module computes it deterministically by running each replay case in a
 * throwaway, network-isolated container (R1) and checking it matches the expected
 * verdict. Cases exercise candidate rules against known-good / known-bad
 * fixtures; a rule set is replay-safe only if EVERY case matches.
 *
 * Scope: this is the isolated EXECUTION substrate. Turning a RulepackRule
 * ({id, hash}) into concrete replay cases is the remaining policy.lock/rulepack
 * contract work (design-first, separate). See docs/SELF_IMPROVEMENT_LOOP_DESIGN.md
 * §13/§14.
 */
import { runCommandInContainer } from '@vibeloop/shared';

export interface ReplayCase {
  id: string;
  /** Command run in isolation with cwd = the corpus worktree. */
  command: string;
  /** Expected outcome for a replay-safe rule set. */
  expect: 'pass' | 'fail';
}

export interface ReplayCorpusOptions {
  /** Corpus worktree mounted into the container (must be a runtime-exposed path). */
  worktreePath: string;
  /** Container image with the toolchain to run cases. */
  image: string;
  network?: 'none' | 'default';
  timeoutMs?: number;
}

export interface ReplayMismatch {
  id: string;
  expected: 'pass' | 'fail';
  actual: 'pass' | 'fail' | 'error';
  exit_code?: number | null | undefined;
  timed_out?: boolean | undefined;
  duration_ms?: number | undefined;
  worktree_path?: string | undefined;
  stdout_excerpt?: string | undefined;
  stderr_excerpt?: string | undefined;
}

export interface ReplayCorpusResult {
  replaySafe: boolean;
  total: number;
  matched: number;
  mismatches: ReplayMismatch[];
}

function excerpt(value: string, maxChars = 2000): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

/**
 * Run every replay case in isolation; `replaySafe` iff all match expectations.
 * Deterministic (exit-code based), no LLM, untrusted cases never touch the host.
 */
export async function replayCorpusUnderIsolation(
  cases: readonly ReplayCase[],
  options: ReplayCorpusOptions
): Promise<ReplayCorpusResult> {
  const mismatches: ReplayMismatch[] = [];
  for (const replayCase of cases) {
    const result = await runCommandInContainer(replayCase.command, {
      image: options.image,
      mounts: [
        { hostPath: options.worktreePath, containerPath: options.worktreePath }
      ],
      workdir: options.worktreePath,
      network: options.network ?? 'none',
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    });
    // 'error' (timeout/exec failure) is never a match — fail closed.
    const actual = result.status;
    if (actual !== replayCase.expect) {
      mismatches.push({
        id: replayCase.id,
        expected: replayCase.expect,
        actual,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        duration_ms: result.durationMs,
        worktree_path: options.worktreePath,
        stdout_excerpt: excerpt(result.stdout),
        stderr_excerpt: excerpt(result.stderr)
      });
    }
  }
  return {
    replaySafe: mismatches.length === 0,
    total: cases.length,
    matched: cases.length - mismatches.length,
    mismatches
  };
}

/**
 * M2 (execution) — confirm an adversary proposal under R1 isolation.
 *
 * The deterministic filter (adversary-filter.ts) statically validates a proposal.
 * This module runs an ACCEPTED proposal's test — untrusted, LLM-generated code —
 * to deterministically confirm its claim (fail-to-pass / pass-to-pass). The test
 * runs ONLY inside a throwaway, network-isolated container (R1), never on the
 * host. The verdict is exit-code based, never an LLM judgment. Defense in depth:
 * a proposal that fails the static filter is NEVER executed.
 *
 * See docs/SELF_IMPROVEMENT_LOOP_DESIGN.md §10.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommandInContainer } from '@vibeloop/shared';
import {
  filterAdversaryProposal,
  type AdversaryProposal,
  type ProposalFilterConfig
} from './adversary-filter.js';

export interface ProposalExecutionOptions {
  /** Container image with the toolchain to run the staged test. */
  image: string;
  /** Command (run with cwd=worktree, inside the container) that runs the test. */
  testCommand: string;
  /** Network policy for the untrusted test. Default 'none'. */
  network?: 'none' | 'default';
  timeoutMs?: number;
}

export interface ProposalConfirmation {
  proposalId: string;
  /** False ⇒ the static filter rejected it; it was never executed. */
  executed: boolean;
  /** The claimed expectation held under isolation. */
  confirmed: boolean;
  reason: string;
  base?: 'pass' | 'fail' | 'error';
  candidate?: 'pass' | 'fail' | 'error';
}

async function stageAndRun(
  proposal: AdversaryProposal,
  worktreePath: string,
  options: ProposalExecutionOptions
): Promise<'pass' | 'fail' | 'error'> {
  const runRoot = await mkdtemp(
    path.join(os.homedir(), '.vibeloop-adversary-m2-')
  );
  const stagedWorktree = path.join(runRoot, 'worktree');
  try {
    await cp(worktreePath, stagedWorktree, { recursive: true });
    const staged = path.join(stagedWorktree, proposal.targetPath);
    await mkdir(path.dirname(staged), { recursive: true });
    await writeFile(staged, proposal.body);
    const result = await runCommandInContainer(options.testCommand, {
      image: options.image,
      mounts: [
        { hostPath: stagedWorktree, containerPath: stagedWorktree }
      ],
      workdir: stagedWorktree,
      network: options.network ?? 'none',
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    });
    return result.status;
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

/**
 * Confirm a proposal by executing its staged test under isolation.
 * - `fail_to_pass`: requires a base target; confirmed iff base fails AND candidate passes.
 * - `pass_to_pass`: confirmed iff candidate passes.
 */
export async function confirmProposalUnderIsolation(
  proposal: AdversaryProposal,
  filterConfig: ProposalFilterConfig,
  targets: {
    candidate: { worktreePath: string };
    base?: { worktreePath: string };
  },
  options: ProposalExecutionOptions
): Promise<ProposalConfirmation> {
  const filtered = filterAdversaryProposal(proposal, filterConfig);
  if (!filtered.accepted) {
    return {
      proposalId: proposal.id,
      executed: false,
      confirmed: false,
      reason: `static filter rejected: ${filtered.failedFilters.join(', ')}`
    };
  }

  const expectation = proposal.expectation ?? 'fail_to_pass';
  const candidate = await stageAndRun(
    proposal,
    targets.candidate.worktreePath,
    options
  );

  if (expectation === 'pass_to_pass') {
    return {
      proposalId: proposal.id,
      executed: true,
      confirmed: candidate === 'pass',
      reason:
        candidate === 'pass'
          ? 'pass-on-candidate confirmed under isolation'
          : `expected pass-on-candidate, got ${candidate}`,
      candidate
    };
  }

  // fail_to_pass needs a base checkout to prove the test actually catches the bug.
  if (!targets.base) {
    return {
      proposalId: proposal.id,
      executed: true,
      confirmed: false,
      reason: 'fail_to_pass requires a base target',
      candidate
    };
  }
  const base = await stageAndRun(proposal, targets.base.worktreePath, options);
  const confirmed = base === 'fail' && candidate === 'pass';
  return {
    proposalId: proposal.id,
    executed: true,
    confirmed,
    reason: confirmed
      ? 'fail-on-base, pass-on-candidate confirmed under isolation'
      : `expected fail-on-base/pass-on-candidate, got base=${base} candidate=${candidate}`,
    base,
    candidate
  };
}

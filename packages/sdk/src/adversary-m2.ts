import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  confirmProposalUnderIsolation,
  type AdversaryProposal,
  type ProposalConfirmation,
  type ProposalExecutionOptions,
  type ProposalFilterConfig
} from '@vibeloop/eval-engine';
import { isContainerRuntimeAvailable } from '@vibeloop/shared';

export interface AdversaryM2HandoffEntry {
  proposal: AdversaryProposal;
  next_step?: string | undefined;
}

export interface AdversaryM2Handoff {
  schema_version: string;
  kind: 'adversary_m2_handoff';
  authority: 'advisory_only';
  decision_impact: 'none';
  loop_id: string;
  base_commit: string;
  selected_candidate_id: string;
  selected_patch: string;
  selected_report?: string | null | undefined;
  next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop';
  proposals: AdversaryM2HandoffEntry[];
}

export interface ConfirmAdversaryM2HandoffOptions {
  handoffFile: string;
  candidateWorktree?: string | undefined;
  baseWorktree?: string | undefined;
  execute: boolean;
  filterConfig: ProposalFilterConfig;
  execution?: ProposalExecutionOptions | undefined;
  outputFile?: string | undefined;
}

export interface AdversaryM2ConfirmationReport {
  schema_version: '1.0';
  kind: 'adversary_m2_confirmation';
  handoff_ref: string;
  authority: 'deterministic_isolated_execution';
  decision_impact: 'none';
  execute_requested: boolean;
  executed: boolean;
  runtime_available: boolean | null;
  selected_candidate_id: string;
  proposal_count: number;
  confirmed_count: number;
  all_confirmed: boolean;
  execution?: {
    image: string;
    test_command: string;
    network: 'none' | 'default';
    timeout_ms?: number | undefined;
  } | null;
  next_step:
    | 'execute_required'
    | 'm4_replay_freeze_required'
    | 'discard_or_revise_proposals';
  confirmations: ProposalConfirmation[];
}

export async function loadAdversaryM2Handoff(
  handoffFile: string
): Promise<AdversaryM2Handoff> {
  const handoff = JSON.parse(
    await readFile(handoffFile, 'utf8')
  ) as AdversaryM2Handoff;
  if (handoff.kind !== 'adversary_m2_handoff') {
    throw new Error(`not an adversary_m2_handoff artifact: ${handoffFile}`);
  }
  if (handoff.authority !== 'advisory_only') {
    throw new Error(`invalid handoff authority: ${handoff.authority}`);
  }
  if (handoff.decision_impact !== 'none') {
    throw new Error(
      `invalid handoff decision impact: ${handoff.decision_impact}`
    );
  }
  if (!Array.isArray(handoff.proposals)) {
    throw new Error('handoff proposals must be an array');
  }
  return handoff;
}

function dryRunConfirmation(proposal: AdversaryProposal): ProposalConfirmation {
  return {
    proposalId: proposal.id,
    executed: false,
    confirmed: false,
    reason: 'dry-run: pass --execute with R1 isolation options to confirm'
  };
}

export async function confirmAdversaryM2Handoff(
  options: ConfirmAdversaryM2HandoffOptions
): Promise<AdversaryM2ConfirmationReport> {
  const handoff = await loadAdversaryM2Handoff(options.handoffFile);
  const confirmations: ProposalConfirmation[] = [];
  let runtimeAvailable: boolean | null = null;

  if (options.execute) {
    runtimeAvailable = await isContainerRuntimeAvailable();
    if (!runtimeAvailable) {
      confirmations.push(
        ...handoff.proposals.map((entry) => ({
          proposalId: entry.proposal.id,
          executed: false,
          confirmed: false,
          reason: 'container runtime unavailable; M2 execution not performed'
        }))
      );
    } else {
      if (!options.candidateWorktree) {
        throw new Error('--execute requires a candidate worktree');
      }
      if (!options.execution?.image || !options.execution.testCommand) {
        throw new Error('--execute requires image and testCommand');
      }
      for (const entry of handoff.proposals) {
        confirmations.push(
          await confirmProposalUnderIsolation(
            entry.proposal,
            options.filterConfig,
            {
              candidate: { worktreePath: options.candidateWorktree },
              ...(options.baseWorktree
                ? { base: { worktreePath: options.baseWorktree } }
                : {})
            },
            options.execution
          )
        );
      }
    }
  } else {
    confirmations.push(
      ...handoff.proposals.map((entry) => dryRunConfirmation(entry.proposal))
    );
  }

  const executed =
    options.execute &&
    runtimeAvailable === true &&
    confirmations.some((confirmation) => confirmation.executed);
  const confirmedCount = confirmations.filter(
    (confirmation) => confirmation.confirmed
  ).length;
  const allConfirmed =
    executed &&
    confirmations.length > 0 &&
    confirmedCount === confirmations.length;
  const report: AdversaryM2ConfirmationReport = {
    schema_version: '1.0',
    kind: 'adversary_m2_confirmation',
    handoff_ref: options.handoffFile,
    authority: 'deterministic_isolated_execution',
    decision_impact: 'none',
    execute_requested: options.execute,
    executed,
    runtime_available: runtimeAvailable,
    selected_candidate_id: handoff.selected_candidate_id,
    proposal_count: handoff.proposals.length,
    confirmed_count: confirmedCount,
    all_confirmed: allConfirmed,
    execution:
      options.execute && options.execution
        ? {
            image: options.execution.image,
            test_command: options.execution.testCommand,
            network: options.execution.network ?? 'none',
            ...(options.execution.timeoutMs
              ? { timeout_ms: options.execution.timeoutMs }
              : {})
          }
        : null,
    next_step: !executed
      ? 'execute_required'
      : allConfirmed
        ? 'm4_replay_freeze_required'
        : 'discard_or_revise_proposals',
    confirmations
  };

  if (options.outputFile) {
    await mkdir(path.dirname(options.outputFile), { recursive: true });
    await writeFile(options.outputFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

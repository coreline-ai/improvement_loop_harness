import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  diffRulepack,
  hashRuleSpec,
  normalizeRuleTargetPath,
  type RulepackDiff,
  type RulepackRule,
  type RulepackRuleSpec
} from '@vibeloop/eval-engine';
import {
  loadAdversaryM2Handoff,
  type AdversaryM2ConfirmationReport
} from './adversary-m2.js';

export type { RulepackDiff, RulepackRule } from '@vibeloop/eval-engine';

export interface BuildAdversaryRulepackCandidateOptions {
  handoffFile: string;
  confirmationFile: string;
  currentRules?: RulepackRule[] | undefined;
  outputFile?: string | undefined;
}

export interface AdversaryRulepackCandidateReport {
  schema_version: '1.0';
  kind: 'adversary_rulepack_candidate';
  authority: 'candidate_only';
  decision_impact: 'none';
  candidate_created: boolean;
  status: 'candidate_created_m4_required' | 'rejected';
  reasons: string[];
  selected_candidate_id: string;
  source_loop_id: string;
  source_base_commit: string;
  source_handoff_ref: string;
  source_confirmation_ref: string;
  current_rules: RulepackRule[];
  proposed_rules: RulepackRule[];
  added_rules: RulepackRule[];
  diff: RulepackDiff;
  next_step: 'm4_replay_freeze_required' | 'discard_or_revise_proposals';
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function loadConfirmation(
  confirmationFile: string
): Promise<AdversaryM2ConfirmationReport> {
  const confirmation = JSON.parse(
    await readFile(confirmationFile, 'utf8')
  ) as AdversaryM2ConfirmationReport;
  if (confirmation.kind !== 'adversary_m2_confirmation') {
    throw new Error(
      `not an adversary_m2_confirmation artifact: ${confirmationFile}`
    );
  }
  if (confirmation.decision_impact !== 'none') {
    throw new Error(
      `invalid confirmation decision impact: ${confirmation.decision_impact}`
    );
  }
  return confirmation;
}

function defaultCommandForTarget(targetPath: string): string {
  return `node ${shSingleQuote(targetPath)}`;
}

function ruleSpecForProposal(
  proposal: {
    targetPath: string;
    body: string;
    expectation?: 'fail_to_pass' | 'pass_to_pass' | undefined;
  },
  testCommand?: string | undefined
): RulepackRuleSpec {
  const targetPath = normalizeRuleTargetPath(proposal.targetPath);
  return {
    kind: 'command_test',
    target_path: targetPath,
    body: proposal.body,
    command: testCommand?.trim() || defaultCommandForTarget(targetPath),
    expect: proposal.expectation ?? 'fail_to_pass',
    network: 'none'
  };
}

function ruleForProposal(
  proposal: {
    id: string;
    targetPath: string;
    body: string;
    expectation?: 'fail_to_pass' | 'pass_to_pass' | undefined;
  },
  testCommand?: string | undefined
): RulepackRule {
  const spec = ruleSpecForProposal(proposal, testCommand);
  return {
    id: `adversary:${proposal.id}`,
    hash: hashRuleSpec(spec),
    spec
  };
}

export async function buildAdversaryRulepackCandidate(
  options: BuildAdversaryRulepackCandidateOptions
): Promise<AdversaryRulepackCandidateReport> {
  const handoff = await loadAdversaryM2Handoff(options.handoffFile);
  const confirmation = await loadConfirmation(options.confirmationFile);
  const reasons: string[] = [];

  if (confirmation.handoff_ref !== options.handoffFile) {
    reasons.push('handoff_ref_mismatch');
  }
  if (!confirmation.execute_requested || !confirmation.executed) {
    reasons.push('m2_not_executed');
  }
  if (!confirmation.all_confirmed) {
    reasons.push('m2_not_confirmed');
  }
  if (
    confirmation.execution?.network &&
    confirmation.execution.network !== 'none'
  ) {
    reasons.push('m2_network_not_none');
  }

  const confirmedIds = new Set(
    confirmation.confirmations
      .filter((item) => item.executed && item.confirmed)
      .map((item) => item.proposalId)
  );
  const addedRules = handoff.proposals
    .filter((entry) => confirmedIds.has(entry.proposal.id))
    .map((entry) =>
      ruleForProposal(entry.proposal, confirmation.execution?.test_command)
    );
  if (addedRules.length === 0) reasons.push('no_confirmed_proposals');

  const currentRules = [...(options.currentRules ?? [])];
  const proposedRules = [...currentRules, ...addedRules];
  const diff = diffRulepack(currentRules, proposedRules);
  if (!diff.appendOnly) reasons.push('not_append_only');
  if (diff.added.length === 0) reasons.push('no_new_rules');

  const candidateCreated = reasons.length === 0;
  const report: AdversaryRulepackCandidateReport = {
    schema_version: '1.0',
    kind: 'adversary_rulepack_candidate',
    authority: 'candidate_only',
    decision_impact: 'none',
    candidate_created: candidateCreated,
    status: candidateCreated ? 'candidate_created_m4_required' : 'rejected',
    reasons,
    selected_candidate_id: handoff.selected_candidate_id,
    source_loop_id: handoff.loop_id,
    source_base_commit: handoff.base_commit,
    source_handoff_ref: options.handoffFile,
    source_confirmation_ref: options.confirmationFile,
    current_rules: currentRules,
    proposed_rules: proposedRules,
    added_rules: addedRules,
    diff,
    next_step: candidateCreated
      ? 'm4_replay_freeze_required'
      : 'discard_or_revise_proposals'
  };

  if (options.outputFile) {
    await mkdir(path.dirname(options.outputFile), { recursive: true });
    await writeFile(options.outputFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decideShadowPromotion, diffRulepack } from '@vibeloop/eval-engine';
import type {
  ReplayCorpusResult,
  RulepackDiff,
  RulepackRule
} from '@vibeloop/eval-engine';
import type { AdversaryRulepackCandidateReport } from './rulepack-candidate.js';

export interface FreezeAdversaryRulepackOptions {
  candidateFile: string;
  replayFile: string;
  appliedToCurrentLoop?: boolean | undefined;
  outputFile?: string | undefined;
  rulepackOutFile?: string | undefined;
}

export interface FrozenRulepack {
  schema_version: '1.0';
  kind: 'frozen_rulepack';
  authority: 'fixed_next_loop_gate';
  decision_impact: 'next_loop_only';
  source_candidate_ref: string;
  source_replay_ref: string;
  frozen_at: string;
  rules: RulepackRule[];
  added_rules: RulepackRule[];
  diff: RulepackDiff;
  replay: Pick<
    ReplayCorpusResult,
    'replaySafe' | 'total' | 'matched' | 'mismatches'
  >;
  lock_hash: string;
}

export interface AdversaryRulepackFreezeReport {
  schema_version: '1.0';
  kind: 'adversary_rulepack_freeze';
  authority: 'deterministic_m4_freeze';
  decision_impact: 'next_loop_only';
  frozen: boolean;
  status: 'frozen_next_loop' | 'rejected';
  reasons: string[];
  source_candidate_ref: string;
  source_replay_ref: string;
  candidate_status: string;
  replay_safe: boolean;
  applied_to_current_loop: boolean;
  diff: RulepackDiff;
  frozen_rulepack: FrozenRulepack | null;
  rulepack_ref: string | null;
  next_step: 'use_as_next_loop_fixed_gate' | 'discard_or_replay';
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameDiff(left: RulepackDiff, right: RulepackDiff): boolean {
  return (
    left.appendOnly === right.appendOnly &&
    sameStringArray(left.added, right.added) &&
    sameStringArray(left.removed, right.removed) &&
    sameStringArray(left.changed, right.changed)
  );
}

async function loadCandidate(
  filePath: string
): Promise<AdversaryRulepackCandidateReport> {
  const parsed = JSON.parse(
    await readFile(filePath, 'utf8')
  ) as AdversaryRulepackCandidateReport;
  if (parsed.kind !== 'adversary_rulepack_candidate') {
    throw new Error(
      `not an adversary_rulepack_candidate artifact: ${filePath}`
    );
  }
  if (parsed.authority !== 'candidate_only') {
    throw new Error(`invalid candidate authority: ${parsed.authority}`);
  }
  if (parsed.decision_impact !== 'none') {
    throw new Error(
      `invalid candidate decision impact: ${parsed.decision_impact}`
    );
  }
  return parsed;
}

async function loadReplay(filePath: string): Promise<ReplayCorpusResult> {
  const replay = JSON.parse(
    await readFile(filePath, 'utf8')
  ) as ReplayCorpusResult;
  if (typeof replay.replaySafe !== 'boolean') {
    throw new Error(`invalid replay report: ${filePath}`);
  }
  if (!Array.isArray(replay.mismatches)) {
    throw new Error(`invalid replay mismatches: ${filePath}`);
  }
  return replay;
}

function buildFrozenRulepack(options: {
  candidateFile: string;
  replayFile: string;
  candidate: AdversaryRulepackCandidateReport;
  replay: ReplayCorpusResult;
  diff: RulepackDiff;
}): FrozenRulepack {
  const lockInput = {
    source_candidate_ref: options.candidateFile,
    source_replay_ref: options.replayFile,
    rules: options.candidate.proposed_rules,
    added_rules: options.candidate.added_rules,
    diff: options.diff,
    replay: {
      replaySafe: options.replay.replaySafe,
      total: options.replay.total,
      matched: options.replay.matched,
      mismatches: options.replay.mismatches
    }
  };
  return {
    schema_version: '1.0',
    kind: 'frozen_rulepack',
    authority: 'fixed_next_loop_gate',
    decision_impact: 'next_loop_only',
    source_candidate_ref: options.candidateFile,
    source_replay_ref: options.replayFile,
    frozen_at: new Date().toISOString(),
    rules: options.candidate.proposed_rules,
    added_rules: options.candidate.added_rules,
    diff: options.diff,
    replay: lockInput.replay,
    lock_hash: sha256(lockInput)
  };
}

export async function freezeAdversaryRulepack(
  options: FreezeAdversaryRulepackOptions
): Promise<AdversaryRulepackFreezeReport> {
  const candidate = await loadCandidate(options.candidateFile);
  const replay = await loadReplay(options.replayFile);
  const diff = diffRulepack(candidate.current_rules, candidate.proposed_rules);
  const reasons: string[] = [];

  if (!candidate.candidate_created) reasons.push('candidate_not_created');
  if (candidate.status !== 'candidate_created_m4_required') {
    reasons.push('candidate_not_m4_ready');
  }
  if (candidate.next_step !== 'm4_replay_freeze_required') {
    reasons.push('candidate_next_step_not_m4');
  }
  if (!candidate.diff.appendOnly || !diff.appendOnly) {
    reasons.push('not_append_only');
  }
  if (diff.added.length === 0) reasons.push('no_new_rules');
  if (!sameDiff(candidate.diff, diff)) reasons.push('candidate_diff_mismatch');

  const promotion = decideShadowPromotion({
    diff,
    replaySafe: replay.replaySafe,
    appliedToCurrentLoop: options.appliedToCurrentLoop === true
  });
  reasons.push(
    ...promotion.reasons.filter((reason) => !reasons.includes(reason))
  );

  const frozen = reasons.length === 0;
  const frozenRulepack = frozen
    ? buildFrozenRulepack({
        candidateFile: options.candidateFile,
        replayFile: options.replayFile,
        candidate,
        replay,
        diff
      })
    : null;

  if (frozenRulepack && options.rulepackOutFile) {
    await mkdir(path.dirname(options.rulepackOutFile), { recursive: true });
    await writeFile(
      options.rulepackOutFile,
      `${JSON.stringify(frozenRulepack, null, 2)}\n`
    );
  }

  const report: AdversaryRulepackFreezeReport = {
    schema_version: '1.0',
    kind: 'adversary_rulepack_freeze',
    authority: 'deterministic_m4_freeze',
    decision_impact: 'next_loop_only',
    frozen,
    status: frozen ? 'frozen_next_loop' : 'rejected',
    reasons,
    source_candidate_ref: options.candidateFile,
    source_replay_ref: options.replayFile,
    candidate_status: candidate.status,
    replay_safe: replay.replaySafe,
    applied_to_current_loop: options.appliedToCurrentLoop === true,
    diff,
    frozen_rulepack: frozenRulepack,
    rulepack_ref:
      frozen && options.rulepackOutFile ? options.rulepackOutFile : null,
    next_step: frozen ? 'use_as_next_loop_fixed_gate' : 'discard_or_replay'
  };

  if (options.outputFile) {
    await mkdir(path.dirname(options.outputFile), { recursive: true });
    await writeFile(options.outputFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

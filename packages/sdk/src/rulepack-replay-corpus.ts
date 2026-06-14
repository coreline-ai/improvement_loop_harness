import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdversaryProposal } from '@vibeloop/eval-engine';
import type { ReplayCase } from './rulepack-replay.js';
import { loadAdversaryM2Handoff } from './adversary-m2.js';
import type { AdversaryRulepackCandidateReport } from './rulepack-candidate.js';

export interface BuildAdversaryReplayCorpusOptions {
  handoffFile: string;
  candidateFile: string;
  testCommand: string;
  outputFile?: string | undefined;
}

export interface AdversaryReplayCorpusReport {
  schema_version: '1.0';
  kind: 'adversary_replay_corpus';
  authority: 'm2_confirmed_proposal_replay_corpus';
  decision_impact: 'none';
  source_handoff_ref: string;
  source_candidate_ref: string;
  test_command: string;
  case_count: number;
  cases: ReplayCase[];
  next_step: 'run_adversary_rulepack_replay';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeRelativeTarget(targetPath: string): string {
  const normalized = path.posix.normalize(targetPath.replace(/\\/g, '/'));
  if (
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.length === 0
  ) {
    throw new Error(`invalid adversary proposal target path: ${targetPath}`);
  }
  return normalized;
}

function heredocDelimiter(body: string, proposalId: string): string {
  const base = `VIBELOOP_ADVERSARY_${sha256(`${proposalId}\n${body}`).slice(0, 16)}`;
  if (!body.includes(base)) return base;
  return `${base}_${sha256(body).slice(16, 32)}`;
}

function commandForProposal(
  proposal: AdversaryProposal,
  testCommand: string
): string {
  const targetPath = normalizeRelativeTarget(proposal.targetPath);
  const targetDir = path.posix.dirname(targetPath);
  const delimiter = heredocDelimiter(proposal.body, proposal.id);
  const mkdirCommand =
    targetDir === '.' ? ':' : `mkdir -p ${shSingleQuote(targetDir)}`;
  return [
    mkdirCommand,
    `cat > ${shSingleQuote(targetPath)} <<'${delimiter}'`,
    proposal.body,
    delimiter,
    testCommand
  ].join('\n');
}

async function loadCandidate(
  candidateFile: string
): Promise<AdversaryRulepackCandidateReport> {
  const parsed = JSON.parse(
    await readFile(candidateFile, 'utf8')
  ) as AdversaryRulepackCandidateReport;
  if (parsed.kind !== 'adversary_rulepack_candidate') {
    throw new Error(
      `not an adversary_rulepack_candidate artifact: ${candidateFile}`
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
  if (!parsed.candidate_created) {
    throw new Error('rulepack candidate was not created');
  }
  return parsed;
}

function proposalIdsFromCandidate(
  candidate: AdversaryRulepackCandidateReport
): Set<string> {
  return new Set(
    candidate.added_rules
      .map((rule) =>
        rule.id.startsWith('adversary:')
          ? rule.id.slice('adversary:'.length)
          : ''
      )
      .filter((id) => id.length > 0)
  );
}

export async function buildAdversaryReplayCorpus(
  options: BuildAdversaryReplayCorpusOptions
): Promise<AdversaryReplayCorpusReport> {
  if (options.testCommand.trim().length === 0) {
    throw new Error('--test-command must be non-empty');
  }
  const handoff = await loadAdversaryM2Handoff(options.handoffFile);
  const candidate = await loadCandidate(options.candidateFile);
  if (candidate.source_handoff_ref !== options.handoffFile) {
    throw new Error('candidate source_handoff_ref does not match --handoff');
  }

  const proposalIds = proposalIdsFromCandidate(candidate);
  const cases = handoff.proposals
    .filter((entry) => proposalIds.has(entry.proposal.id))
    .map(
      (entry): ReplayCase => ({
        id: `adversary:${entry.proposal.id}`,
        command: commandForProposal(entry.proposal, options.testCommand),
        expect: 'pass'
      })
    );
  if (cases.length === 0) {
    throw new Error('no M2-confirmed adversary proposals found for replay');
  }

  const report: AdversaryReplayCorpusReport = {
    schema_version: '1.0',
    kind: 'adversary_replay_corpus',
    authority: 'm2_confirmed_proposal_replay_corpus',
    decision_impact: 'none',
    source_handoff_ref: options.handoffFile,
    source_candidate_ref: options.candidateFile,
    test_command: options.testCommand,
    case_count: cases.length,
    cases,
    next_step: 'run_adversary_rulepack_replay'
  };

  if (options.outputFile) {
    await mkdir(path.dirname(options.outputFile), { recursive: true });
    await writeFile(options.outputFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

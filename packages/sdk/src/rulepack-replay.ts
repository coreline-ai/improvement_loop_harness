import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  replayCorpusUnderIsolation,
  type ReplayCase,
  type ReplayCorpusOptions,
  type ReplayCorpusResult
} from '@vibeloop/eval-engine';
import { isContainerRuntimeAvailable } from '@vibeloop/shared';

export type { ReplayCase, ReplayCorpusResult } from '@vibeloop/eval-engine';

export interface AdversaryReplayCorpus {
  schema_version?: string | undefined;
  kind?: 'adversary_replay_corpus' | undefined;
  cases: ReplayCase[];
}

export interface ReplayAdversaryRulepackOptions {
  corpusFile: string;
  execute: boolean;
  worktreePath?: string | undefined;
  image?: string | undefined;
  network?: 'none' | 'default' | undefined;
  timeoutMs?: number | undefined;
  outputFile?: string | undefined;
  /**
   * Test hook. Production uses the real container runtime probe.
   */
  runtimeAvailable?: (() => Promise<boolean>) | undefined;
  /**
   * Test hook. Production executes the corpus through R1 isolation.
   */
  replayRunner?:
    | ((
        cases: readonly ReplayCase[],
        options: ReplayCorpusOptions
      ) => Promise<ReplayCorpusResult>)
    | undefined;
}

export interface AdversaryRulepackReplayReport extends ReplayCorpusResult {
  schema_version: '1.0';
  kind: 'adversary_rulepack_replay';
  authority: 'deterministic_m4_replay';
  decision_impact: 'none';
  execute_requested: boolean;
  executed: boolean;
  runtime_available: boolean | null;
  source_corpus_ref: string;
  worktree_ref: string | null;
  image: string | null;
  network: 'none' | 'default';
  timeout_ms: number | null;
  next_step:
    | 'execute_required'
    | 'freeze_rulepack_next_loop'
    | 'discard_or_replay';
}

function isReplayCase(value: unknown): value is ReplayCase {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0 &&
    typeof candidate.command === 'string' &&
    candidate.command.trim().length > 0 &&
    (candidate.expect === 'pass' || candidate.expect === 'fail')
  );
}

async function loadReplayCorpus(corpusFile: string): Promise<ReplayCase[]> {
  const parsed = JSON.parse(await readFile(corpusFile, 'utf8')) as unknown;
  const cases = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as AdversaryReplayCorpus).cases)
      ? (parsed as AdversaryReplayCorpus).cases
      : null;
  if (!cases) {
    throw new Error(
      'replay corpus must be an array of cases or an adversary_replay_corpus object'
    );
  }
  if (cases.length === 0) {
    throw new Error('replay corpus must contain at least one case');
  }
  for (const replayCase of cases) {
    if (!isReplayCase(replayCase)) {
      throw new Error(
        'each replay case must include non-empty id, command, and expect=pass|fail'
      );
    }
  }
  return cases;
}

function notExecutedResult(cases: readonly ReplayCase[]): ReplayCorpusResult {
  return {
    replaySafe: false,
    total: cases.length,
    matched: 0,
    mismatches: []
  };
}

export async function replayAdversaryRulepack(
  options: ReplayAdversaryRulepackOptions
): Promise<AdversaryRulepackReplayReport> {
  const cases = await loadReplayCorpus(options.corpusFile);
  const network = options.network ?? 'none';
  let runtimeAvailable: boolean | null = null;
  let executed = false;
  let result = notExecutedResult(cases);

  if (options.execute) {
    if (!options.worktreePath) {
      throw new Error('--execute requires --worktree');
    }
    if (!options.image) {
      throw new Error('--execute requires --image');
    }
    runtimeAvailable = await (
      options.runtimeAvailable ?? isContainerRuntimeAvailable
    )();
    if (runtimeAvailable) {
      result = await (options.replayRunner ?? replayCorpusUnderIsolation)(
        cases,
        {
          worktreePath: options.worktreePath,
          image: options.image,
          network,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
        }
      );
      executed = true;
    }
  }

  const report: AdversaryRulepackReplayReport = {
    schema_version: '1.0',
    kind: 'adversary_rulepack_replay',
    authority: 'deterministic_m4_replay',
    decision_impact: 'none',
    execute_requested: options.execute,
    executed,
    runtime_available: runtimeAvailable,
    source_corpus_ref: options.corpusFile,
    worktree_ref: options.worktreePath ?? null,
    image: options.image ?? null,
    network,
    timeout_ms: options.timeoutMs ?? null,
    replaySafe: executed ? result.replaySafe : false,
    total: result.total,
    matched: executed ? result.matched : 0,
    mismatches: executed ? result.mismatches : [],
    next_step: !executed
      ? 'execute_required'
      : result.replaySafe
        ? 'freeze_rulepack_next_loop'
        : 'discard_or_replay'
  };

  if (options.outputFile) {
    await mkdir(path.dirname(options.outputFile), { recursive: true });
    await writeFile(options.outputFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

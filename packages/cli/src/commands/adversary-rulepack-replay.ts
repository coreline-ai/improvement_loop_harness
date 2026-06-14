import type { Command } from 'commander';
import { EXIT_CODES, replayAdversaryRulepack } from '@vibeloop/sdk';

interface Options {
  corpus: string;
  execute?: boolean | undefined;
  worktree?: string | undefined;
  image?: string | undefined;
  network?: 'none' | 'default' | undefined;
  timeoutMs?: string | undefined;
  out?: string | undefined;
}

function parsePositiveInt(
  value: string | undefined,
  name: string
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function registerAdversaryRulepackReplayCommand(program: Command): void {
  program
    .command('adversary-rulepack-replay')
    .description(
      'M4 helper: run a replay corpus under R1 isolation and emit a freeze-compatible replay result (never current-loop accept)'
    )
    .requiredOption(
      '--corpus <path>',
      'adversary_replay_corpus JSON or raw ReplayCase[]'
    )
    .option('--execute', 'actually run the replay corpus in isolation', false)
    .option('--worktree <path>', 'corpus worktree for --execute')
    .option('--image <image>', 'container image for --execute')
    .option('--network <none|default>', 'container network policy', 'none')
    .option('--timeout-ms <n>', 'per replay-case timeout in milliseconds')
    .option('--out <path>', 'write replay report JSON')
    .action(async (options: Options) => {
      if (options.network && !['none', 'default'].includes(options.network)) {
        throw new Error('--network must be none or default');
      }
      const execute = options.execute === true;
      if (execute && (!options.worktree || !options.image)) {
        throw new Error('--execute requires --worktree and --image');
      }
      const timeoutMs = parsePositiveInt(options.timeoutMs, '--timeout-ms');
      const report = await replayAdversaryRulepack({
        corpusFile: options.corpus,
        execute,
        ...(options.worktree ? { worktreePath: options.worktree } : {}),
        ...(options.image ? { image: options.image } : {}),
        network: options.network ?? 'none',
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(options.out ? { outputFile: options.out } : {})
      });
      process.exitCode = !execute
        ? EXIT_CODES.accept
        : report.executed && report.replaySafe
          ? EXIT_CODES.accept
          : EXIT_CODES.reject;
      console.log(JSON.stringify(report, null, 2));
    });
}

import type { Command } from 'commander';
import { EXIT_CODES, freezeAdversaryRulepack } from '@vibeloop/sdk';

interface Options {
  candidate: string;
  replay: string;
  appliedToCurrentLoop?: boolean | undefined;
  rulepackOut?: string | undefined;
  out?: string | undefined;
}

export function registerAdversaryRulepackFreezeCommand(program: Command): void {
  program
    .command('adversary-rulepack-freeze')
    .description(
      'M4 helper: freeze an M2-confirmed/replay-safe rulepack candidate as a next-loop fixed gate artifact (never current-loop accept)'
    )
    .requiredOption('--candidate <path>', 'adversary_rulepack_candidate JSON')
    .requiredOption('--replay <path>', 'M4 replay corpus result JSON')
    .option(
      '--applied-to-current-loop',
      'mark the rulepack as having affected the current loop; this must reject',
      false
    )
    .option('--rulepack-out <path>', 'write frozen_rulepack JSON for next loop')
    .option('--out <path>', 'write freeze report JSON')
    .action(async (options: Options) => {
      const report = await freezeAdversaryRulepack({
        candidateFile: options.candidate,
        replayFile: options.replay,
        appliedToCurrentLoop: options.appliedToCurrentLoop === true,
        ...(options.rulepackOut
          ? { rulepackOutFile: options.rulepackOut }
          : {}),
        ...(options.out ? { outputFile: options.out } : {})
      });
      process.exitCode = report.frozen ? EXIT_CODES.accept : EXIT_CODES.reject;
      console.log(JSON.stringify(report, null, 2));
    });
}

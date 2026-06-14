import type { Command } from 'commander';
import { buildAdversaryReplayCorpus, EXIT_CODES } from '@vibeloop/sdk';

interface Options {
  handoff: string;
  candidate: string;
  testCommand: string;
  out?: string | undefined;
}

export function registerAdversaryRulepackReplayCorpusCommand(
  program: Command
): void {
  program
    .command('adversary-rulepack-replay-corpus')
    .description(
      'M4 helper: build an operator-reviewable replay corpus from M2-confirmed adversary proposals (no execution, no accept impact)'
    )
    .requiredOption('--handoff <path>', 'adversary-m2-handoff JSON')
    .requiredOption('--candidate <path>', 'adversary_rulepack_candidate JSON')
    .requiredOption(
      '--test-command <command>',
      'command to run after staging each adversary proposal body'
    )
    .option('--out <path>', 'write replay corpus JSON')
    .action(async (options: Options) => {
      const report = await buildAdversaryReplayCorpus({
        handoffFile: options.handoff,
        candidateFile: options.candidate,
        testCommand: options.testCommand,
        ...(options.out ? { outputFile: options.out } : {})
      });
      process.exitCode = EXIT_CODES.accept;
      console.log(JSON.stringify(report, null, 2));
    });
}

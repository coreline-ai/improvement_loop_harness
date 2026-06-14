import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  EXIT_CODES,
  buildAdversaryRulepackCandidate,
  type RulepackRule
} from '@vibeloop/sdk';

interface Options {
  handoff: string;
  confirmation: string;
  currentRulepack?: string | undefined;
  out?: string | undefined;
}

async function readCurrentRules(
  file: string | undefined
): Promise<RulepackRule[]> {
  if (!file) return [];
  const parsed = JSON.parse(await readFile(file, 'utf8')) as
    | RulepackRule[]
    | { rules?: RulepackRule[] };
  if (Array.isArray(parsed)) return parsed;
  return parsed.rules ?? [];
}

export function registerAdversaryRulepackCandidateCommand(
  program: Command
): void {
  program
    .command('adversary-rulepack-candidate')
    .description(
      'Build a next-loop rulepack candidate from an M2-confirmed adversary handoff (candidate only; requires M4 replay/freeze before use)'
    )
    .requiredOption('--handoff <path>', 'adversary-m2-handoff.json')
    .requiredOption('--confirmation <path>', 'adversary_m2_confirmation JSON')
    .option(
      '--current-rulepack <path>',
      'current rulepack JSON array or {rules}'
    )
    .option('--out <path>', 'write rulepack candidate report JSON')
    .action(async (options: Options) => {
      const report = await buildAdversaryRulepackCandidate({
        handoffFile: options.handoff,
        confirmationFile: options.confirmation,
        currentRules: await readCurrentRules(options.currentRulepack),
        ...(options.out ? { outputFile: options.out } : {})
      });
      process.exitCode = report.candidate_created
        ? EXIT_CODES.accept
        : EXIT_CODES.reject;
      console.log(JSON.stringify(report, null, 2));
    });
}

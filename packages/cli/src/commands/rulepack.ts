import type { Command } from 'commander';
import { EXIT_CODES, inspectFrozenRulepack } from '@vibeloop/sdk';

export function registerRulepackCommand(program: Command): void {
  const rulepack = program
    .command('rulepack')
    .description('Inspect and validate frozen rulepack artifacts');

  rulepack
    .command('inspect <path>')
    .description(
      'Inspect a frozen rulepack lock and report semantic gate readiness'
    )
    .action(async (file: string) => {
      const report = await inspectFrozenRulepack(file);
      process.exitCode = report.valid ? EXIT_CODES.accept : EXIT_CODES.reject;
      console.log(JSON.stringify(report, null, 2));
    });
}

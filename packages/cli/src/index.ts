import { Command } from 'commander';
import { getDataDir } from '@vibeloop/shared';
import { registerDiscoverCommand } from './commands/discover.js';
import { registerGcCommand } from './commands/gc.js';
import { registerImproveCommand } from './commands/improve.js';
import { registerReportCommand } from './commands/report.js';
import { registerRetryCommand } from './commands/retry.js';
import { registerRunCommand } from './commands/run.js';
import { EXIT_CODES } from '@vibeloop/sdk';

export const VERSION = '0.1.0';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('vibeloop')
    .description('VibeLoop Harness CLI verification kernel')
    .version(VERSION)
    .option('--data-dir <path>', 'VibeLoop data directory', getDataDir());

  registerDiscoverCommand(program);
  registerRunCommand(program);
  registerImproveCommand(program);
  registerRetryCommand(program);
  registerReportCommand(program);
  registerGcCommand(program);

  return program;
}

export function runCli(argv: string[] = process.argv): void {
  createProgram()
    .parseAsync(argv)
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = EXIT_CODES.failed;
    });
}

export * from '@vibeloop/sdk';
export * from './commands/retry.js';
export * from './commands/discover.js';

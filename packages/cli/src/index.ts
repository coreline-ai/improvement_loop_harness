import { Command } from 'commander';
import { getDataDir } from '@vibeloop/shared';

export const VERSION = '0.1.0';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('vibeloop')
    .description('VibeLoop Harness CLI verification kernel')
    .version(VERSION)
    .option('--data-dir <path>', 'VibeLoop data directory', getDataDir());

  return program;
}

export function runCli(argv: string[] = process.argv): void {
  createProgram().parse(argv);
}

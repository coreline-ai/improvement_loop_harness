import { rm } from 'node:fs/promises';
import type { Command } from 'commander';
import { collectExpired } from '@vibeloop/artifacts';

interface GcCommandOptions {
  out?: string | undefined;
  apply?: boolean | undefined;
}

function globalDataDir(command: Command): string {
  return (command.parent?.opts<{ dataDir: string }>().dataDir ?? command.opts<{ dataDir: string }>().dataDir) as string;
}

export function registerGcCommand(program: Command): void {
  program
    .command('gc')
    .description('List expired run artifacts; dry-run by default')
    .option('--out <path>', 'artifact data directory override')
    .option('--apply', 'delete expired runs instead of dry-run', false)
    .action(async (options: GcCommandOptions, command: Command) => {
      const dataDir = options.out ?? globalDataDir(command);
      const expired = await collectExpired(dataDir);
      for (const run of expired) {
        console.log(`${options.apply ? 'delete' : 'dry-run'}\t${run.runRoot}\t${run.manifest.status}`);
        if (options.apply) {
          await rm(run.runRoot, { recursive: true, force: true });
        }
      }
      if (expired.length === 0) {
        console.log('no expired runs');
      }
    });
}

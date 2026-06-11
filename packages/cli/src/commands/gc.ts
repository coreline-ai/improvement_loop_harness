import type { Command } from 'commander';
import { collectExpired, deleteExpiredRuns } from '@vibeloop/artifacts';

interface GcCommandOptions {
  out?: string | undefined;
  apply?: boolean | undefined;
}

function globalDataDir(command: Command): string {
  return (command.parent?.opts<{ dataDir: string }>().dataDir ??
    command.opts<{ dataDir: string }>().dataDir) as string;
}

export async function runGc(options: {
  dataDir: string;
  apply?: boolean | undefined;
}): Promise<number> {
  if (options.apply) {
    const records = await deleteExpiredRuns(options.dataDir);
    for (const record of records) {
      console.log(
        `delete\t${record.run_root}\t${record.status}\t${record.preserved_manifest_path}`
      );
    }
    if (records.length === 0) {
      console.log('no expired runs');
    }
    return records.length;
  }

  const expired = await collectExpired(options.dataDir);
  for (const run of expired) {
    console.log(`dry-run\t${run.runRoot}\t${run.manifest.status}`);
  }
  if (expired.length === 0) {
    console.log('no expired runs');
  }
  return expired.length;
}

export function registerGcCommand(program: Command): void {
  program
    .command('gc')
    .description('List expired run artifacts; dry-run by default')
    .option('--out <path>', 'artifact data directory override')
    .option(
      '--apply',
      'delete expired runs and preserve manifest/deletion record',
      false
    )
    .action(async (options: GcCommandOptions, command: Command) => {
      await runGc({
        dataDir: options.out ?? globalDataDir(command),
        apply: options.apply
      });
    });
}

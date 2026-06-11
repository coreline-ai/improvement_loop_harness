import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { createRunLayout, readManifest } from '@vibeloop/artifacts';

interface ReportCommandOptions {
  out?: string | undefined;
  projectId?: string | undefined;
}

function globalDataDir(command: Command): string {
  return (command.parent?.opts<{ dataDir: string }>().dataDir ?? command.opts<{ dataDir: string }>().dataDir) as string;
}

async function findProjectIds(dataDir: string, projectId: string | undefined): Promise<string[]> {
  if (projectId) {
    return [projectId];
  }
  return readdir(path.join(dataDir, 'projects')).catch(() => []);
}

export function registerReportCommand(program: Command): void {
  program
    .command('report <loop-id>')
    .description('Print a concise console summary for a loop eval-report')
    .option('--out <path>', 'artifact data directory override')
    .option('--project-id <id>', 'project id')
    .action(async (loopId: string, options: ReportCommandOptions, command: Command) => {
      const dataDir = options.out ?? globalDataDir(command);
      for (const projectId of await findProjectIds(dataDir, options.projectId)) {
        const layout = createRunLayout(dataDir, projectId, loopId);
        const manifest = await readManifest(layout).catch(() => undefined);
        if (!manifest) {
          continue;
        }
        const report = JSON.parse(await readFile(path.join(layout.reports, 'eval-report.json'), 'utf8')) as {
          decision: string;
          decision_reasons: Array<{ code: string; message: string }>;
          changed_files: unknown[];
          gate_runs: Array<{ status: string }>;
        };
        const statusCounts = report.gate_runs.reduce<Record<string, number>>((acc, gate) => {
          acc[gate.status] = (acc[gate.status] ?? 0) + 1;
          return acc;
        }, {});
        console.table([
          {
            loop_id: loopId,
            project_id: projectId,
            status: manifest.status,
            decision: report.decision,
            reason: report.decision_reasons[0]?.code ?? '',
            changed_files: report.changed_files.length,
            gates: JSON.stringify(statusCounts)
          }
        ]);
        return;
      }
      throw new Error(`loop report not found: ${loopId}`);
    });
}

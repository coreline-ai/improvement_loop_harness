import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  createRunLayout,
  readManifest,
  type RunLayout
} from '@vibeloop/artifacts';
import {
  writeReportHtmlFromRunRoot,
  type WrittenReportHtml
} from '@vibeloop/report-html';

interface ReportCommandOptions {
  out?: string | undefined;
  projectId?: string | undefined;
  html?: boolean | undefined;
  open?: boolean | undefined;
}

interface ReportLocation {
  projectId: string;
  layout: RunLayout;
}

function globalDataDir(command: Command): string {
  return (command.parent?.opts<{ dataDir: string }>().dataDir ??
    command.opts<{ dataDir: string }>().dataDir) as string;
}

async function findProjectIds(
  dataDir: string,
  projectId: string | undefined
): Promise<string[]> {
  if (projectId) {
    return [projectId];
  }
  return readdir(path.join(dataDir, 'projects')).catch(() => []);
}

async function findReportLocation(
  dataDir: string,
  loopId: string,
  projectId: string | undefined
): Promise<ReportLocation> {
  for (const candidateProjectId of await findProjectIds(dataDir, projectId)) {
    const layout = createRunLayout(dataDir, candidateProjectId, loopId);
    const manifest = await readManifest(layout).catch(() => undefined);
    if (manifest) {
      return { projectId: candidateProjectId, layout };
    }
  }
  throw new Error(`loop report not found: ${loopId}`);
}

async function openFile(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const subprocess = spawn('open', [filePath], { stdio: 'ignore' });
    subprocess.on('error', reject);
    subprocess.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(new Error(`open failed with exit code ${exitCode ?? 'unknown'}`));
    });
  });
}

export async function renderLoopHtmlReport(options: {
  dataDir: string;
  loopId: string;
  projectId?: string | undefined;
  open?: boolean | undefined;
}): Promise<WrittenReportHtml> {
  const location = await findReportLocation(
    options.dataDir,
    options.loopId,
    options.projectId
  );
  const written = await writeReportHtmlFromRunRoot(location.layout.root);
  if (options.open) {
    await openFile(written.path);
  }
  return written;
}

export function registerReportCommand(program: Command): void {
  program
    .command('report <loop-id>')
    .description('Print or render a concise report for a loop eval-report')
    .option('--out <path>', 'artifact data directory override')
    .option('--project-id <id>', 'project id')
    .option('--html', 'write a self-contained static HTML report', false)
    .option(
      '--open',
      'open the generated HTML report with the OS file handler',
      false
    )
    .action(
      async (
        loopId: string,
        options: ReportCommandOptions,
        command: Command
      ) => {
        const dataDir = options.out ?? globalDataDir(command);
        const shouldRenderHtml = Boolean(options.html || options.open);
        if (shouldRenderHtml) {
          const written = await renderLoopHtmlReport({
            dataDir,
            loopId,
            projectId: options.projectId,
            open: options.open
          });
          console.log(written.fileUrl);
          return;
        }

        const location = await findReportLocation(
          dataDir,
          loopId,
          options.projectId
        );
        const manifest = await readManifest(location.layout);
        const report = JSON.parse(
          await readFile(
            path.join(location.layout.reports, 'eval-report.json'),
            'utf8'
          )
        ) as {
          decision: string;
          decision_reasons: Array<{ code: string; message: string }>;
          changed_files: unknown[];
          gate_runs: Array<{ status: string }>;
        };
        const statusCounts = report.gate_runs.reduce<Record<string, number>>(
          (acc, gate) => {
            acc[gate.status] = (acc[gate.status] ?? 0) + 1;
            return acc;
          },
          {}
        );
        console.table([
          {
            loop_id: loopId,
            project_id: location.projectId,
            status: manifest.status,
            decision: report.decision,
            reason: report.decision_reasons[0]?.code ?? '',
            changed_files: report.changed_files.length,
            gates: JSON.stringify(statusCounts)
          }
        ]);
      }
    );
}

import type { Command } from 'commander';
import { EXIT_CODES, isPrCandidate, runOnce } from '@vibeloop/sdk';

interface RunCommandOptions {
  repo: string;
  task: string;
  eval: string;
  agent: string;
  out?: string | undefined;
  projectId?: string | undefined;
  loopId?: string | undefined;
  baseCommit?: string | undefined;
  llmProxyUrl?: string | undefined;
  logJson?: boolean | undefined;
  skipDependencyInstall?: boolean | undefined;
}

function globalDataDir(command: Command): string {
  return (command.parent?.opts<{ dataDir: string }>().dataDir ??
    command.opts<{ dataDir: string }>().dataDir) as string;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run the VibeLoop 16-step verification kernel once')
    .requiredOption('--repo <path>', 'target git repository path')
    .requiredOption('--task <path>', 'task.yaml path')
    .requiredOption('--eval <path>', 'eval.yaml path')
    .requiredOption(
      '--agent <spec>',
      'agent adapter, e.g. mock:scenario.json, command:<shell command>, or codex'
    )
    .option('--out <path>', 'artifact data directory override')
    .option('--project-id <id>', 'project id override')
    .option('--loop-id <id>', 'loop id override')
    .option('--base-commit <sha>', 'base commit override')
    .option(
      '--llm-proxy-url <url>',
      'localhost LLM proxy base URL for codex agent'
    )
    .option('--log-json', 'print structured loop state logs to stdout', false)
    .option(
      '--skip-dependency-install',
      'skip dependency provisioning (test/debug only)',
      false
    )
    .action(async (options: RunCommandOptions, command: Command) => {
      const controller = new AbortController();
      let sigintCount = 0;
      const onSigint = (): void => {
        sigintCount += 1;
        if (sigintCount === 1) {
          controller.abort();
          return;
        }
        process.exit(EXIT_CODES.cancelled);
      };
      process.on('SIGINT', onSigint);
      try {
        const result = await runOnce({
          repoPath: options.repo,
          taskFile: options.task,
          evalFile: options.eval,
          dataDir: options.out ?? globalDataDir(command),
          agentSpec: options.agent,
          projectId: options.projectId,
          loopId: options.loopId,
          baseCommit: options.baseCommit,
          proxyBaseUrl: options.llmProxyUrl,
          signal: controller.signal,
          logToStdout: options.logJson,
          skipDependencyInstall: options.skipDependencyInstall
        });
        process.exitCode = result.exitCode;
        console.log(
          JSON.stringify(
            {
              loop_id: result.loopId,
              project_id: result.projectId,
              status: result.status,
              decision: result.decision ?? null,
              qualified: result.qualified,
              pr_candidate: isPrCandidate({
                decision: result.decision ?? null,
                allPass: result.decision === 'accept',
                qualified: result.qualified
              }),
              report: result.reportPath ?? null,
              artifact_root: result.artifactRoot
            },
            null,
            2
          )
        );
      } finally {
        process.off('SIGINT', onSigint);
      }
    });
}

import path from 'node:path';
import type { Command } from 'commander';
import { EXIT_CODES, runImprovementLoop } from '@vibeloop/sdk';

interface ImproveCommandOptions {
  repo: string;
  task: string;
  eval: string;
  agent: string[];
  challenger: string[];
  out?: string | undefined;
  projectId?: string | undefined;
  loopId?: string | undefined;
  baseCommit?: string | undefined;
  llmProxyUrl?: string | undefined;
  skipDependencyInstall?: boolean | undefined;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function globalDataDir(command: Command): string {
  return (command.parent?.opts<{ dataDir: string }>().dataDir ??
    command.opts<{ dataDir: string }>().dataDir) as string;
}

export function registerImproveCommand(program: Command): void {
  program
    .command('improve')
    .description(
      'Run multiple builder candidates and deterministically select the best-known accepted candidate'
    )
    .requiredOption('--repo <path>', 'target git repository path')
    .requiredOption('--task <path>', 'task.yaml path')
    .requiredOption('--eval <path>', 'eval.yaml path')
    .option(
      '--agent <spec>',
      'builder agent spec (repeatable; one candidate per spec)',
      collect,
      []
    )
    .option(
      '--challenger <spec>',
      'challenger agent spec (repeatable; runs even after acceptance to search for a better candidate)',
      collect,
      []
    )
    .option('--out <path>', 'artifact data directory override')
    .option('--project-id <id>', 'project id override')
    .option('--loop-id <id>', 'loop id override')
    .option('--base-commit <sha>', 'base commit override')
    .option(
      '--llm-proxy-url <url>',
      'localhost LLM proxy base URL for codex agent'
    )
    .option(
      '--skip-dependency-install',
      'skip dependency provisioning (test/debug only)',
      false
    )
    .action(async (options: ImproveCommandOptions, command: Command) => {
      if (options.agent.length === 0) {
        throw new Error('improve requires at least one --agent <spec>');
      }
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
        const result = await runImprovementLoop({
          repoPath: options.repo,
          taskFile: options.task,
          evalFile: options.eval,
          dataDir: options.out ?? globalDataDir(command),
          builders: options.agent,
          ...(options.challenger.length > 0
            ? { challengerRounds: [options.challenger] }
            : {}),
          projectId: options.projectId,
          loopId: options.loopId,
          baseCommit: options.baseCommit,
          proxyBaseUrl: options.llmProxyUrl,
          signal: controller.signal,
          skipDependencyInstall: options.skipDependencyInstall
        });
        // A selected (accepted ∧ qualified) candidate is a PR candidate; otherwise
        // nothing cleared the bar (no PR candidate from this pool).
        process.exitCode = result.selected
          ? EXIT_CODES.accept
          : EXIT_CODES.reject;
        console.log(
          JSON.stringify(
            {
              loop_id: result.loopId,
              project_id: result.projectId,
              base_commit: result.baseCommit,
              candidate_count: result.candidates.length,
              accepted_count: result.candidates.filter((c) => c.accepted)
                .length,
              selected_candidate_id: result.selected?.candidateId ?? null,
              selected_artifact_root: result.selected?.artifactRoot ?? null,
              selected_report: result.selected?.reportPath ?? null,
              selected_patch: result.selected
                ? path.join(
                    result.selected.artifactRoot,
                    'patches/candidate.patch'
                  )
                : null,
              selection_report: result.selectionReportPath ?? null
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

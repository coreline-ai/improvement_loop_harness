import path from 'node:path';
import type { Command } from 'commander';
import {
  EXIT_CODES,
  commandQualityJudge,
  promoteSelectedPatch,
  runImprovementLoop
} from '@vibeloop/sdk';

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
  maxCandidates?: string | undefined;
  skipFinalReverify?: boolean | undefined;
  allowDirty?: boolean | undefined;
  qualityJudge?: string | undefined;
  promoteBranch?: string | undefined;
  promoteCommitMessage?: string | undefined;
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
    .option(
      '--max-candidates <n>',
      'hard ceiling on total candidate runs across all rounds (cost backstop)',
      '24'
    )
    .option(
      '--skip-final-reverify',
      'skip re-executing the selected patch (keep only provenance hash binding)',
      false
    )
    .option(
      '--allow-dirty',
      'proceed even if the source repo has uncommitted changes (auto base only)',
      false
    )
    .option(
      '--quality-judge <command>',
      'advisory tie-break: shell command (separate context) that ranks score-tied candidates (reads JSON on stdin, prints {winner_candidate_id} JSON)'
    )
    .option(
      '--promote-branch <name>',
      'create a local PR-candidate branch from the selected, final-verified patch (no push, no merge)'
    )
    .option(
      '--promote-commit-message <message>',
      'commit message for --promote-branch',
      'vibeloop: apply selected patch'
    )
    .action(async (options: ImproveCommandOptions, command: Command) => {
      if (options.agent.length === 0) {
        throw new Error('improve requires at least one --agent <spec>');
      }
      const maxCandidates = Number(options.maxCandidates ?? '24');
      if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
        throw new Error('--max-candidates must be a positive integer');
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
          skipDependencyInstall: options.skipDependencyInstall,
          maxCandidates,
          skipFinalReverify: options.skipFinalReverify,
          allowDirty: options.allowDirty,
          ...(options.qualityJudge
            ? { qualityJudge: commandQualityJudge(options.qualityJudge) }
            : {})
        });
        // A selected (accepted ∧ qualified) candidate is a PR candidate; otherwise
        // nothing cleared the bar (no PR candidate from this pool).
        const selectedPatch = result.selected
          ? path.join(result.selected.artifactRoot, 'patches/candidate.patch')
          : null;
        const promotion =
          result.selected && options.promoteBranch && selectedPatch
            ? await promoteSelectedPatch({
                repoPath: options.repo,
                baseCommit: result.baseCommit,
                branchName: options.promoteBranch,
                patchPath: selectedPatch,
                commitMessage:
                  options.promoteCommitMessage ??
                  'vibeloop: apply selected patch'
              })
            : null;
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
              selected_patch: selectedPatch,
              pr_candidate: !!result.selected,
              promotion,
              final_verification: result.finalVerification ?? null,
              advisory_tie_break: result.advisoryTieBreak ?? null,
              limits: result.limits ?? null,
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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  EXIT_CODES,
  commandAdversaryReviewer,
  commandQualityJudge,
  publishSelectedPatchDraftPr,
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
  adversaryReview?: string | undefined;
  adversaryReviewerProvider?: string | undefined;
  adversaryRequireDifferentProvider?: boolean | undefined;
  promoteBranch?: string | undefined;
  promoteCommitMessage?: string | undefined;
  githubDraftPr?: boolean | undefined;
  githubRepo?: string | undefined;
  githubTokenEnv?: string | undefined;
  githubBase?: string | undefined;
  githubBranch?: string | undefined;
  githubPushUrl?: string | undefined;
  githubApiBaseUrl?: string | undefined;
  githubTitle?: string | undefined;
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
      '--adversary-review <command>',
      'advisory adversary reviewer command; proposes findings/tests for M2/M4, never changes accept/selection'
    )
    .option(
      '--adversary-reviewer-provider <provider>',
      'declared provider for --adversary-review independence reporting (e.g. openai, anthropic)'
    )
    .option(
      '--adversary-require-different-provider',
      'record that the adversary reviewer is expected to use a different provider; unmet/unknown identity keeps same_model_review=true',
      false
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
    .option(
      '--github-draft-pr',
      'push the selected final-verified patch branch and create/reuse a GitHub draft PR (no merge)',
      false
    )
    .option(
      '--github-repo <owner/repo>',
      'GitHub repository for --github-draft-pr (owner/repo or github.com URL)'
    )
    .option(
      '--github-token-env <name>',
      'environment variable containing a GitHub token for --github-draft-pr',
      'GITHUB_TOKEN'
    )
    .option(
      '--github-base <branch>',
      'base branch for --github-draft-pr',
      'main'
    )
    .option(
      '--github-branch <name>',
      'remote branch name for --github-draft-pr (defaults to --promote-branch or pr-candidate/<loop-id>)'
    )
    .option(
      '--github-push-url <url>',
      'override git push URL for --github-draft-pr (test/enterprise use)'
    )
    .option(
      '--github-api-base-url <url>',
      'override GitHub API base URL for --github-draft-pr'
    )
    .option('--github-title <title>', 'draft PR title override')
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
            : {}),
          ...(options.adversaryReview
            ? {
                adversaryReviewer: commandAdversaryReviewer(
                  options.adversaryReview
                ),
                ...(options.adversaryReviewerProvider
                  ? {
                      adversaryReviewerProvider:
                        options.adversaryReviewerProvider
                    }
                  : {}),
                adversaryRequireDifferentProvider:
                  options.adversaryRequireDifferentProvider === true
              }
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
        const draftPr =
          result.selected && selectedPatch && options.githubDraftPr
            ? await (async () => {
                if (!options.githubRepo) {
                  throw new Error(
                    '--github-draft-pr requires --github-repo <owner/repo>'
                  );
                }
                const tokenEnv = options.githubTokenEnv ?? 'GITHUB_TOKEN';
                const token = process.env[tokenEnv];
                if (!token) {
                  throw new Error(
                    `--github-draft-pr requires ${tokenEnv} to be set`
                  );
                }
                const report = result.selected?.reportPath
                  ? (JSON.parse(
                      await readFile(result.selected.reportPath, 'utf8')
                    ) as Record<string, unknown>)
                  : undefined;
                return publishSelectedPatchDraftPr({
                  repoPath: options.repo,
                  baseRef: options.githubBase ?? 'main',
                  branchName:
                    options.githubBranch ??
                    options.promoteBranch ??
                    `pr-candidate/${result.loopId}`,
                  patchPath: selectedPatch,
                  commitMessage:
                    options.promoteCommitMessage ??
                    'vibeloop: apply selected patch',
                  githubRepo: options.githubRepo,
                  token,
                  title: options.githubTitle ?? `VibeLoop: ${result.loopId}`,
                  ...(result.adversaryReview
                    ? { adversaryReview: result.adversaryReview }
                    : {}),
                  ...(options.githubPushUrl
                    ? { pushUrl: options.githubPushUrl }
                    : {}),
                  ...(options.githubApiBaseUrl
                    ? { apiBaseUrl: options.githubApiBaseUrl }
                    : {}),
                  ...(report ? { report } : {})
                });
              })()
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
              draft_pr: draftPr,
              final_verification: result.finalVerification ?? null,
              advisory_tie_break: result.advisoryTieBreak ?? null,
              selection_quality: result.selectionQuality ?? null,
              adversary_review: result.adversaryReview ?? null,
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

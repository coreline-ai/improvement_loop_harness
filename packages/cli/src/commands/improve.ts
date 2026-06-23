import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  EXIT_CODES,
  commandAdversaryReviewer,
  commandQualityJudge,
  isPrCandidate,
  publishSelectedPatchDraftPr,
  promoteSelectedPatch,
  runImprovementLoop
} from '@vibeloop/sdk';
import {
  loadEvalConfig,
  type EvalConfig,
  type EvalGate
} from '@vibeloop/task-protocol';
import { buildTokenBudgetLoopOptions } from '../token-usage.js';

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
  deadline?: string | undefined;
  tokenBudgetTotal?: string | undefined;
  tokenUsageUrl?: string | undefined;
  skipFinalReverify?: boolean | undefined;
  allowDirty?: boolean | undefined;
  qualityJudge?: string | undefined;
  adversaryReview?: string | undefined;
  adversaryReviewerProvider?: string | undefined;
  adversaryRequireDifferentProvider?: boolean | undefined;
  rulepackSemantic?: string | undefined;
  rulepackSemanticImage?: string | undefined;
  rulepackSemanticTimeoutMs?: string | undefined;
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

function warnRiskyFlags(options: ImproveCommandOptions): void {
  if (options.githubDraftPr && options.skipFinalReverify) {
    throw new Error(
      '--skip-final-reverify cannot be used with --github-draft-pr; draft PR creation requires final re-execution'
    );
  }
  if (options.skipFinalReverify) {
    console.error(
      'warning: --skip-final-reverify skips B2 final re-execution; only provenance hash binding remains'
    );
  }
  if (options.allowDirty) {
    console.error(
      'warning: --allow-dirty permits auto-base runs from a dirty source repo'
    );
  }
}

function parseNonNegativeInt(
  value: string | undefined,
  name: string
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInt(
  value: string | undefined,
  name: string
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const PROJECT_COMMAND_GATE_TYPES = new Set<EvalGate['type']>([
  'hard',
  'task_acceptance',
  'regression',
  'security',
  'performance',
  'hidden_acceptance'
]);

function addRulepackSemanticGate(gates: EvalGate[]): EvalGate[] {
  const conflictingGate = gates.find(
    (gate) =>
      gate.name === 'rulepack_semantic' &&
      gate.command !== 'builtin:rulepack-semantic'
  );
  if (conflictingGate) {
    throw new Error(
      "--rulepack-semantic cannot overlay eval with an existing 'rulepack_semantic' gate that uses a different command"
    );
  }

  if (gates.some((gate) => gate.command === 'builtin:rulepack-semantic')) {
    return gates.map((gate) =>
      gate.command === 'builtin:rulepack-semantic'
        ? {
            ...gate,
            name: gate.name || 'rulepack_semantic',
            type: 'integrity',
            required: true
          }
        : gate
    );
  }

  const semanticGate: EvalGate = {
    name: 'rulepack_semantic',
    type: 'integrity',
    command: 'builtin:rulepack-semantic',
    required: true
  };
  const firstProjectGateIndex = gates.findIndex((gate) =>
    PROJECT_COMMAND_GATE_TYPES.has(gate.type)
  );
  if (firstProjectGateIndex === -1) {
    return [...gates, semanticGate];
  }
  return [
    ...gates.slice(0, firstProjectGateIndex),
    semanticGate,
    ...gates.slice(firstProjectGateIndex)
  ];
}

async function buildRulepackSemanticEvalOverlay(options: {
  evalFile: string;
  dataDir: string;
  projectId: string;
  loopId: string;
  rulepackFile: string;
  image: string;
  timeoutMs?: number | undefined;
}): Promise<{ evalFile: string; evalConfig: EvalConfig }> {
  const evalConfig = await loadEvalConfig(options.evalFile);
  const protectedPaths = [...(evalConfig.protected_paths ?? [])];
  if (
    !path.isAbsolute(options.rulepackFile) &&
    !protectedPaths.includes(options.rulepackFile)
  ) {
    protectedPaths.push(options.rulepackFile);
  }

  const overlay: EvalConfig = {
    ...evalConfig,
    ...(protectedPaths.length > 0 ? { protected_paths: protectedPaths } : {}),
    gates: addRulepackSemanticGate(evalConfig.gates),
    rulepack_semantic: {
      file: options.rulepackFile,
      image: options.image,
      network: 'none',
      current_loop_id: options.loopId,
      required_authority: 'fixed_next_loop_gate',
      required_decision_impact: 'next_loop_only',
      ...(options.timeoutMs ? { timeout_ms: options.timeoutMs } : {})
    }
  };

  const outputPath = path.join(
    options.dataDir,
    'projects',
    options.projectId,
    'improve',
    options.loopId,
    'eval.rulepack-semantic.json'
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(overlay, null, 2)}\n`);
  return { evalFile: outputPath, evalConfig: overlay };
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
      '--deadline <ms>',
      'wall-clock deadline in milliseconds before launching another candidate'
    )
    .option(
      '--token-budget-total <tokens>',
      'provider token budget before launching another candidate (default applies with --token-usage-url or stats-capable --llm-proxy-url; override with VIBELOOP_TOKEN_BUDGET_TOTAL)'
    )
    .option(
      '--token-usage-url <url>',
      'HTTP(S) JSON usage endpoint returning {total_tokens} or {usage:{total_tokens}}; defaults to <llm-proxy-url>/__vibeloop_proxy_stats when a token budget is set'
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
      '--rulepack-semantic <path>',
      'overlay --eval with builtin:rulepack-semantic required gate for an executable frozen next-loop rulepack'
    )
    .option(
      '--rulepack-semantic-image <image>',
      'container image for --rulepack-semantic execution'
    )
    .option(
      '--rulepack-semantic-timeout-ms <n>',
      'per semantic-rule timeout for --rulepack-semantic'
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
      const deadlineMs = parseNonNegativeInt(options.deadline, '--deadline');
      const tokenBudgetOptions = buildTokenBudgetLoopOptions(options);
      if (options.rulepackSemantic && !options.rulepackSemanticImage) {
        throw new Error(
          '--rulepack-semantic requires --rulepack-semantic-image <image>'
        );
      }
      const semanticTimeoutMs = parsePositiveInt(
        options.rulepackSemanticTimeoutMs,
        '--rulepack-semantic-timeout-ms'
      );
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
        warnRiskyFlags(options);
        const dataDir = options.out ?? globalDataDir(command);
        const projectId = options.projectId ?? 'default';
        const loopId =
          options.rulepackSemantic && !options.loopId
            ? `iloop-${Date.now()}`
            : options.loopId;
        const evalSource =
          options.rulepackSemantic && loopId
            ? await buildRulepackSemanticEvalOverlay({
                evalFile: options.eval,
                dataDir,
                projectId,
                loopId,
                rulepackFile: options.rulepackSemantic,
                image: options.rulepackSemanticImage!,
                ...(semanticTimeoutMs ? { timeoutMs: semanticTimeoutMs } : {})
              })
            : {
                evalFile: options.eval,
                evalConfig: undefined
              };
        const result = await runImprovementLoop({
          repoPath: options.repo,
          taskFile: options.task,
          evalFile: evalSource.evalFile,
          dataDir,
          builders: options.agent,
          ...(options.challenger.length > 0
            ? { challengerRounds: [options.challenger] }
            : {}),
          projectId: options.projectId,
          loopId,
          baseCommit: options.baseCommit,
          proxyBaseUrl: options.llmProxyUrl,
          signal: controller.signal,
          skipDependencyInstall: options.skipDependencyInstall,
          maxCandidates,
          deadlineMs,
          ...tokenBudgetOptions,
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
        const prCandidate = isPrCandidate({
          decision: result.selected?.decision ?? null,
          allPass: result.selected?.decision === 'accept',
          qualified: result.selected?.qualified ?? null,
          selected: result.selected,
          finalVerification: result.finalVerification ?? null
        });
        const promotionArtifactLeak =
          result.selected &&
          selectedPatch &&
          prCandidate &&
          (options.promoteBranch || options.githubDraftPr)
            ? (
                evalSource.evalConfig ??
                (await loadEvalConfig(evalSource.evalFile))
              ).artifact_leak
            : undefined;
        const promotion =
          result.selected &&
          options.promoteBranch &&
          selectedPatch &&
          prCandidate
            ? await promoteSelectedPatch({
                repoPath: options.repo,
                baseCommit: result.baseCommit,
                branchName: options.promoteBranch,
                patchPath: selectedPatch,
                expectedPatchHash:
                  result.finalVerification?.candidate_patch_hash,
                artifactLeak: promotionArtifactLeak,
                commitMessage:
                  options.promoteCommitMessage ??
                  'vibeloop: apply selected patch'
              })
            : null;
        const draftPr =
          result.selected &&
          selectedPatch &&
          options.githubDraftPr &&
          prCandidate
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
                  expectedPatchHash:
                    result.finalVerification?.candidate_patch_hash,
                  artifactLeak: promotionArtifactLeak,
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
              pr_candidate: prCandidate,
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

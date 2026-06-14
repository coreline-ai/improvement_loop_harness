import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  discoverCandidates,
  generateTaskFromCandidate
} from '@vibeloop/discovery';
import {
  loadEvalConfig,
  type EvalConfig,
  type EvalGate
} from '@vibeloop/task-protocol';
import {
  EXIT_CODES,
  commandQualityJudge,
  checkoutPromotionBranch,
  commitSelectedPatchOnCurrentBranch,
  runImprovementLoop
} from '@vibeloop/sdk';

interface OrchestrateCommandOptions {
  repo: string;
  eval?: string | undefined;
  agent: string[];
  challenger: string[];
  maxIssues?: string | undefined;
  maxCandidates?: string | undefined;
  out?: string | undefined;
  projectId?: string | undefined;
  loopId?: string | undefined;
  baseCommit?: string | undefined;
  llmProxyUrl?: string | undefined;
  skipDependencyInstall?: boolean | undefined;
  skipFinalReverify?: boolean | undefined;
  allowDirty?: boolean | undefined;
  qualityJudge?: string | undefined;
  generateEval?: boolean | undefined;
  evalCommand?: string[] | undefined;
  promoteBranch?: string | undefined;
  promoteCommitMessagePrefix?: string | undefined;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function globalDataDir(command: Command): string {
  return (command.parent?.opts<{ dataDir: string }>().dataDir ??
    command.opts<{ dataDir: string }>().dataDir) as string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function gateForCommand(name: string, command: string): EvalGate {
  const lower = name.toLowerCase();
  return {
    name,
    type:
      lower.includes('lint') || lower.includes('typecheck')
        ? 'hard'
        : 'task_acceptance',
    command,
    required: true
  };
}

async function detectedProjectCommands(repoPath: string): Promise<EvalGate[]> {
  const packageJson = path.join(repoPath, 'package.json');
  if (!(await exists(packageJson))) return [];
  const parsed = JSON.parse(await readFile(packageJson, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = parsed.scripts ?? {};
  const gates: EvalGate[] = [];
  if (scripts.test) gates.push(gateForCommand('unit_tests', 'npm test'));
  if (scripts.typecheck)
    gates.push(gateForCommand('typecheck', 'npm run typecheck'));
  if (scripts.lint) gates.push(gateForCommand('lint', 'npm run lint'));
  return gates;
}

async function generateMinimalEvalContract(options: {
  repoPath: string;
  projectId: string;
  evalCommands: string[];
  outputPath: string;
}): Promise<{ evalFile: string; evalConfig: EvalConfig; generated: boolean }> {
  const manualGates = options.evalCommands.map((command, index) =>
    gateForCommand(`auto_command_${index}`, command)
  );
  const projectGates = manualGates.length
    ? manualGates
    : await detectedProjectCommands(options.repoPath);
  if (projectGates.length === 0) {
    throw new Error(
      'orchestrate --generate-eval could not detect test/lint/typecheck scripts; pass --eval-command <command> or provide --eval'
    );
  }

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  const evalConfig: EvalConfig = {
    schema_version: '1.0',
    project: `${options.projectId}-generated-eval`,
    protected_paths: ['.env', '.env.*', 'eval.yaml', 'tests/hidden/'],
    risk_classification: {
      none: ['src/', 'lib/', 'app/', 'packages/', 'tests/']
    },
    limits: {
      max_changed_files: 10,
      max_changed_lines: 300,
      agent_timeout_seconds: 120
    },
    test_integrity: {
      forbidden_patterns: ['test.skip', 'it.only', 'describe.only'],
      suspicious_patterns: ['expect(true).toBe(true)', 'assert.ok(true)']
    },
    evaluator: {
      required: true,
      max_changed_files: 10,
      max_changed_lines: 300,
      forbid_protected: true,
      min_evidence_present: 1,
      require_test_on_base_pass: true
    },
    gates: [
      {
        name: 'protected_files',
        type: 'scope',
        command: 'builtin:protected-files',
        required: true
      },
      {
        name: 'diff_scope',
        type: 'scope',
        command: 'builtin:diff-scope',
        required: true
      },
      {
        name: 'limits',
        type: 'integrity',
        command: 'builtin:limits',
        required: true
      },
      {
        name: 'test_integrity',
        type: 'integrity',
        command: 'builtin:test-integrity',
        required: true
      },
      ...projectGates
    ]
  };

  await writeFile(
    options.outputPath,
    `${JSON.stringify(evalConfig, null, 2)}\n`
  );
  return { evalFile: options.outputPath, evalConfig, generated: true };
}

/**
 * Autonomous orchestrator (the "auto" mode of the skill flow, as a deterministic
 * core command rather than a manual LLM session): discover problems → persist a
 * discovery report → select the top N by deterministic priority → for EACH, auto-
 * generate a task from the candidate and run the full improvement loop (which
 * itself selects + final-verifies a PR candidate). Bounded by `--max-issues`
 * (and the loop's own `--max-candidates`); the candidate list is finite so the
 * loop always terminates.
 *
 * With `--promote-branch`, orchestrate becomes the local RU-3 substrate:
 * checkout a local integration branch, discover one issue on the current branch,
 * run improve, commit the selected/final-verified patch, then rediscover on the
 * updated branch for the next issue. It still does NOT push/open a GitHub PR.
 *
 * Orchestration is deterministic (no LLM): the only LLM is the builder/challenger
 * agent inside each loop. accept/select stay the decision engine + Arbiter's job.
 */
export function registerOrchestrateCommand(program: Command): void {
  program
    .command('orchestrate')
    .description(
      'Auto mode: discover problems, select the top N, and run the improvement loop on each (one issue at a time)'
    )
    .requiredOption('--repo <path>', 'target git repository path')
    .option(
      '--eval <path>',
      'eval.yaml contract (discovery + verification); defaults to <repo>/eval.yaml'
    )
    .option(
      '--agent <spec>',
      'builder agent spec (repeatable; one candidate per spec)',
      collect,
      []
    )
    .option(
      '--challenger <spec>',
      'challenger agent spec (repeatable; runs even after acceptance)',
      collect,
      []
    )
    .option(
      '--max-issues <n>',
      'maximum number of discovered issues to process sequentially',
      '1'
    )
    .option(
      '--max-candidates <n>',
      'hard ceiling on candidate runs per issue (cost backstop)',
      '24'
    )
    .option('--out <path>', 'artifact data directory override')
    .option('--project-id <id>', 'project id override')
    .option('--loop-id <id>', 'orchestrate run id override')
    .option(
      '--base-commit <sha>',
      'base commit override (applied to every issue)'
    )
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
      'advisory tie-break command (separate context) for score-tied candidates'
    )
    .option(
      '--generate-eval',
      'generate a minimal visible-test eval contract when --eval/<repo>/eval.yaml is absent (no hidden acceptance)',
      false
    )
    .option(
      '--eval-command <command>',
      'project command to include in --generate-eval (repeatable; defaults to detected package.json test/typecheck/lint scripts)',
      collect,
      []
    )
    .option(
      '--promote-branch <name>',
      'local integration branch for cumulative selected patches; enables rediscovery after each accepted issue (no push, no merge)'
    )
    .option(
      '--promote-commit-message-prefix <message>',
      'commit message prefix for --promote-branch commits',
      'vibeloop: apply orchestrated fix'
    )
    .action(async (options: OrchestrateCommandOptions, command: Command) => {
      if (options.agent.length === 0) {
        throw new Error('orchestrate requires at least one --agent <spec>');
      }
      const maxIssues = Number(options.maxIssues ?? '1');
      if (!Number.isInteger(maxIssues) || maxIssues < 1) {
        throw new Error('--max-issues must be a positive integer');
      }
      const maxCandidates = Number(options.maxCandidates ?? '24');
      if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
        throw new Error('--max-candidates must be a positive integer');
      }

      const dataDir = options.out ?? globalDataDir(command);
      const projectId = options.projectId ?? 'orchestrate';
      const baseLoopId = options.loopId ?? `orchestrate-${Date.now()}`;

      const requestedEvalPath =
        options.eval ?? path.join(options.repo, 'eval.yaml');
      const generatedEvalPath = path.join(
        dataDir,
        'projects',
        projectId,
        'orchestrate',
        baseLoopId,
        'eval.generated.json'
      );
      const requestedEvalExists = await exists(requestedEvalPath);
      if (!requestedEvalExists && options.generateEval !== true) {
        throw new Error(
          `orchestrate requires an eval.yaml contract for discovery + verification (looked at ${requestedEvalPath}); pass --eval or --generate-eval`
        );
      }
      const evalSource = requestedEvalExists
        ? {
            evalFile: requestedEvalPath,
            evalConfig: await loadEvalConfig(requestedEvalPath),
            generated: false
          }
        : await generateMinimalEvalContract({
            repoPath: options.repo,
            projectId,
            evalCommands: options.evalCommand ?? [],
            outputPath: generatedEvalPath
          });
      const evalPath = evalSource.evalFile;
      const evalConfig = evalSource.evalConfig;

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
        const discoveryDir = path.join(
          dataDir,
          'projects',
          projectId,
          'discovery'
        );
        await mkdir(discoveryDir, { recursive: true });

        const cumulative = options.promoteBranch
          ? await checkoutPromotionBranch({
              repoPath: options.repo,
              branchName: options.promoteBranch,
              baseCommit: options.baseCommit
            })
          : null;
        let currentBaseCommit = cumulative?.head_sha ?? options.baseCommit;

        // one issue at a time: discover on the current branch/state, auto-generate
        // a task, run the full loop, and (when promoting) commit the selected
        // patch before rediscovering. Without --promote-branch this preserves the
        // old initial top-N behavior.
        const issues: Array<Record<string, unknown>> = [];
        const discoveryReports: string[] = [];
        let totalDiscovered = 0;
        let staticCandidates:
          | Awaited<ReturnType<typeof discoverCandidates>>
          | undefined;
        for (let index = 0; index < maxIssues; index += 1) {
          if (controller.signal.aborted) break;
          let candidates:
            | Awaited<ReturnType<typeof discoverCandidates>>
            | undefined;
          if (options.promoteBranch || !staticCandidates) {
            candidates = await discoverCandidates({
              repoPath: options.repo,
              evalConfig
            });
            if (!options.promoteBranch) staticCandidates = candidates;
            totalDiscovered += candidates.length;
            const discoveryReportPath = path.join(
              discoveryDir,
              options.promoteBranch
                ? `${baseLoopId}-i${index}.json`
                : `${baseLoopId}.json`
            );
            await writeFile(
              discoveryReportPath,
              `${JSON.stringify(
                {
                  schema_version: '1.0',
                  loop_id: baseLoopId,
                  iteration: index,
                  repo: options.repo,
                  eval_file: evalPath,
                  generated_eval: evalSource.generated,
                  base_commit: currentBaseCommit ?? null,
                  discovered: candidates.length,
                  candidates
                },
                null,
                2
              )}\n`
            );
            discoveryReports.push(discoveryReportPath);
          } else {
            candidates = staticCandidates;
          }
          const candidate = options.promoteBranch
            ? candidates[0]
            : candidates[index];
          if (!candidate) break;
          const generated = generateTaskFromCandidate(candidate, {
            evalConfig,
            baseBranch: 'HEAD'
          });
          const issueDir = path.join(
            dataDir,
            'projects',
            projectId,
            'orchestrate',
            baseLoopId,
            `issue-${index}`
          );
          await mkdir(issueDir, { recursive: true });
          // JSON is valid YAML; loadTask parses it back to the same task object.
          const taskFile = path.join(issueDir, 'task.generated.yaml');
          await writeFile(
            taskFile,
            `${JSON.stringify(generated.task, null, 2)}\n`
          );

          try {
            const result = await runImprovementLoop({
              repoPath: options.repo,
              taskFile,
              evalFile: evalPath,
              dataDir,
              builders: options.agent,
              ...(options.challenger.length > 0
                ? { challengerRounds: [options.challenger] }
                : {}),
              projectId,
              loopId: `${baseLoopId}-i${index}`,
              baseCommit: currentBaseCommit,
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
            const selectedPatch = result.selected
              ? path.join(
                  result.selected.artifactRoot,
                  'patches/candidate.patch'
                )
              : null;
            const promotion =
              result.selected && selectedPatch && options.promoteBranch
                ? await commitSelectedPatchOnCurrentBranch({
                    repoPath: options.repo,
                    patchPath: selectedPatch,
                    commitMessage: `${options.promoteCommitMessagePrefix}: ${generated.task.id}`
                  })
                : null;
            if (promotion) currentBaseCommit = promotion.head_sha;
            issues.push({
              index,
              candidate_fingerprint: candidate.fingerprint,
              title: candidate.title,
              source: candidate.source,
              task_id: generated.task.id,
              selected_candidate_id: result.selected?.candidateId ?? null,
              pr_candidate: !!result.selected,
              selected_patch: selectedPatch,
              final_verification: result.finalVerification ?? null,
              selection_report: result.selectionReportPath ?? null,
              promotion
            });
            if (options.promoteBranch && !promotion) break;
          } catch (error) {
            // A single issue failing (e.g. dirty guard, no candidate) must not
            // abort the whole sweep — record it and continue.
            issues.push({
              index,
              candidate_fingerprint: candidate.fingerprint,
              title: candidate.title,
              source: candidate.source,
              task_id: generated.task.id,
              pr_candidate: false,
              error: error instanceof Error ? error.message : String(error)
            });
            if (options.promoteBranch) break;
          }
          if (!options.promoteBranch && index + 1 >= candidates.length) break;
        }

        const prCandidates = issues.filter(
          (issue) => issue.pr_candidate
        ).length;
        process.exitCode =
          prCandidates > 0 ? EXIT_CODES.accept : EXIT_CODES.reject;
        console.log(
          JSON.stringify(
            {
              mode: 'auto',
              scenario: 'orchestrate',
              loop_id: baseLoopId,
              project_id: projectId,
              repo: options.repo,
              eval_file: evalPath,
              generated_eval: evalSource.generated,
              discovered: totalDiscovered,
              processed: issues.length,
              max_issues: maxIssues,
              pr_candidates: prCandidates,
              false_pass: 0,
              discovery_report: discoveryReports[0] ?? null,
              discovery_reports: discoveryReports,
              cumulative_promotion: cumulative
                ? {
                    ...cumulative,
                    head_sha: currentBaseCommit,
                    applied_issue_count: issues.filter(
                      (issue) => issue.promotion
                    ).length,
                    rediscovery_after_each_fix: true
                  }
                : null,
              issues
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

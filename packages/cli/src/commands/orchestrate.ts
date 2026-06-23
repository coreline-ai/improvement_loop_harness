import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  discoverCandidatesWithReport,
  generateTaskFromCandidate
} from '@vibeloop/discovery';
import {
  loadEvalConfig,
  type ArtifactLeakConfig,
  type EvalConfig,
  type EvalGate
} from '@vibeloop/task-protocol';
import {
  EXIT_CODES,
  commandAdversaryReviewer,
  commandQualityJudge,
  checkoutPromotionBranch,
  commitSelectedPatchOnCurrentBranch,
  isPrCandidate,
  publishSelectedPatchDraftPr,
  runImprovementLoop
} from '@vibeloop/sdk';
import { buildTokenBudgetLoopOptions } from '../token-usage.js';

interface OrchestrateCommandOptions {
  repo: string;
  eval?: string | undefined;
  agent: string[];
  challenger: string[];
  maxIssues?: string | undefined;
  maxCandidates?: string | undefined;
  deadline?: string | undefined;
  tokenBudgetTotal?: string | undefined;
  tokenUsageUrl?: string | undefined;
  out?: string | undefined;
  projectId?: string | undefined;
  loopId?: string | undefined;
  baseCommit?: string | undefined;
  llmProxyUrl?: string | undefined;
  skipDependencyInstall?: boolean | undefined;
  skipFinalReverify?: boolean | undefined;
  allowDirty?: boolean | undefined;
  qualityJudge?: string | undefined;
  adversaryReview?: string | undefined;
  adversaryReviewerProvider?: string | undefined;
  adversaryRequireDifferentProvider?: boolean | undefined;
  generateEval?: boolean | undefined;
  evalCommand?: string[] | undefined;
  evalArtifactLeak?: boolean | undefined;
  evalForbiddenLiteral: string[];
  evalScanPatch?: boolean | undefined;
  evalRedactGateLogs?: boolean | undefined;
  evalTokenLikeReject?: boolean | undefined;
  evalMaxScanBytes?: string | undefined;
  evalRulepackLock?: string | undefined;
  evalRulepackSemantic?: string | undefined;
  evalRulepackSemanticImage?: string | undefined;
  evalRulepackSemanticTimeoutMs?: string | undefined;
  carryRulepack?: string | undefined;
  carryRulepackImage?: string | undefined;
  carryRulepackTimeoutMs?: string | undefined;
  evalHiddenTest: string[];
  promoteBranch?: string | undefined;
  promoteCommitMessagePrefix?: string | undefined;
  githubDraftPr?: boolean | undefined;
  githubRepo?: string | undefined;
  githubTokenEnv?: string | undefined;
  githubBase?: string | undefined;
  githubBranchPrefix?: string | undefined;
  githubPushUrl?: string | undefined;
  githubApiBaseUrl?: string | undefined;
  githubTitlePrefix?: string | undefined;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function globalDataDir(command: Command): string {
  return (command.parent?.opts<{ dataDir: string }>().dataDir ??
    command.opts<{ dataDir: string }>().dataDir) as string;
}

function warnRiskyFlags(options: OrchestrateCommandOptions): void {
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

function parseForbiddenLiteral(value: string): {
  label: string;
  value: string;
} {
  const index = value.indexOf('=');
  if (index <= 0 || index === value.length - 1) {
    throw new Error(
      '--eval-forbidden-literal must be label=value (raw value is written to eval.yaml; do not pass secrets on a shared shell)'
    );
  }
  return {
    label: value.slice(0, index),
    value: value.slice(index + 1)
  };
}

interface GeneratedHiddenTest {
  name: string;
  source_path: string;
  target_path: string;
  command: string;
}

function parseGeneratedHiddenTest(value: string): GeneratedHiddenTest {
  const assignIndex = value.indexOf('=');
  if (assignIndex <= 0 || assignIndex === value.length - 1) {
    throw new Error(
      '--eval-hidden-test must be name=source_path:target_path:command'
    );
  }
  const name = value.slice(0, assignIndex);
  const rest = value.slice(assignIndex + 1);
  const sourceEnd = rest.indexOf(':');
  const targetEnd = sourceEnd >= 0 ? rest.indexOf(':', sourceEnd + 1) : -1;
  if (sourceEnd <= 0 || targetEnd <= sourceEnd + 1) {
    throw new Error(
      '--eval-hidden-test must be name=source_path:target_path:command'
    );
  }
  const source_path = rest.slice(0, sourceEnd);
  const target_path = rest.slice(sourceEnd + 1, targetEnd);
  const command = rest.slice(targetEnd + 1);
  if (!/^[a-z0-9_:-]+$/.test(name)) {
    throw new Error('--eval-hidden-test name must match ^[a-z0-9_:-]+$');
  }
  if (!source_path || !target_path || !command) {
    throw new Error(
      '--eval-hidden-test source_path, target_path, and command must be non-empty'
    );
  }
  return { name, source_path, target_path, command };
}

function buildGeneratedArtifactLeak(options: {
  enabled: boolean;
  forbiddenLiteral: string[];
  scanPatch: boolean;
  redactGateLogs: boolean;
  tokenLikeReject: boolean;
  maxScanBytes?: number | undefined;
}): ArtifactLeakConfig | undefined {
  const forbidden_literals = options.forbiddenLiteral.map(
    parseForbiddenLiteral
  );
  const shouldEnable =
    options.enabled ||
    forbidden_literals.length > 0 ||
    options.scanPatch ||
    options.redactGateLogs ||
    options.tokenLikeReject ||
    options.maxScanBytes !== undefined;
  if (!shouldEnable) return undefined;
  return {
    scan_agent_stdout: true,
    scan_agent_stderr: true,
    scan_patch: options.scanPatch,
    redact_gate_logs: options.redactGateLogs,
    ...(options.maxScanBytes ? { max_scan_bytes: options.maxScanBytes } : {}),
    ...(forbidden_literals.length > 0 ? { forbidden_literals } : {}),
    builtins: {
      token_like: options.tokenLikeReject
    }
  };
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
      "--carry-rulepack cannot overlay eval with an existing 'rulepack_semantic' gate that uses a different command"
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

async function overlayRulepackSemanticEvalContract(options: {
  evalFile: string;
  evalConfig: EvalConfig;
  outputPath: string;
  rulepackFile: string;
  image: string;
  currentLoopId: string;
  timeoutMs?: number | undefined;
}): Promise<{ evalFile: string; evalConfig: EvalConfig; generated: boolean }> {
  const protectedPaths = [...(options.evalConfig.protected_paths ?? [])];
  if (
    !path.isAbsolute(options.rulepackFile) &&
    !protectedPaths.includes(options.rulepackFile)
  ) {
    protectedPaths.push(options.rulepackFile);
  }

  const evalConfig: EvalConfig = {
    ...options.evalConfig,
    ...(protectedPaths.length > 0 ? { protected_paths: protectedPaths } : {}),
    gates: addRulepackSemanticGate(options.evalConfig.gates),
    rulepack_semantic: {
      file: options.rulepackFile,
      image: options.image,
      network: 'none',
      current_loop_id: options.currentLoopId,
      required_authority: 'fixed_next_loop_gate',
      required_decision_impact: 'next_loop_only',
      ...(options.timeoutMs ? { timeout_ms: options.timeoutMs } : {})
    }
  };

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(
    options.outputPath,
    `${JSON.stringify(evalConfig, null, 2)}\n`
  );
  return { evalFile: options.outputPath, evalConfig, generated: false };
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
  artifactLeak?: ArtifactLeakConfig | undefined;
  rulepackLock?: string | undefined;
  rulepackSemantic?:
    | {
        file: string;
        image: string;
        currentLoopId: string;
        timeoutMs?: number | undefined;
      }
    | undefined;
  hiddenTests?: GeneratedHiddenTest[] | undefined;
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
  const protectedPaths = ['.env', '.env.*', 'eval.yaml', 'tests/hidden/'];
  if (options.rulepackLock && !path.isAbsolute(options.rulepackLock)) {
    protectedPaths.push(options.rulepackLock);
  }
  if (
    options.rulepackSemantic?.file &&
    !path.isAbsolute(options.rulepackSemantic.file) &&
    !protectedPaths.includes(options.rulepackSemantic.file)
  ) {
    protectedPaths.push(options.rulepackSemantic.file);
  }
  for (const hidden of options.hiddenTests ?? []) {
    protectedPaths.push(hidden.target_path);
  }

  const evalConfig: EvalConfig = {
    schema_version: '1.0',
    project: `${options.projectId}-generated-eval`,
    protected_paths: protectedPaths,
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
    execution: { isolation: 'none' },
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
      ...(options.artifactLeak
        ? [
            {
              name: 'artifact_leak',
              type: 'integrity' as const,
              command: 'builtin:artifact-leak',
              required: true
            }
          ]
        : []),
      ...(options.rulepackLock
        ? [
            {
              name: 'rulepack_lock',
              type: 'integrity' as const,
              command: 'builtin:rulepack-lock',
              required: true
            }
          ]
        : []),
      ...(options.rulepackSemantic
        ? [
            {
              name: 'rulepack_semantic',
              type: 'integrity' as const,
              command: 'builtin:rulepack-semantic',
              required: true
            }
          ]
        : []),
      ...(options.hiddenTests ?? []).map((hidden) => ({
        name: hidden.name,
        type: 'hidden_acceptance' as const,
        group: 'hidden_acceptance' as const,
        command: hidden.command,
        required: true
      })),
      ...projectGates
    ],
    ...(options.artifactLeak ? { artifact_leak: options.artifactLeak } : {}),
    ...(options.rulepackLock
      ? {
          rulepack_lock: {
            file: options.rulepackLock,
            required_authority: 'fixed_next_loop_gate',
            required_decision_impact: 'next_loop_only'
          }
        }
      : {}),
    ...(options.rulepackSemantic
      ? {
          rulepack_semantic: {
            file: options.rulepackSemantic.file,
            image: options.rulepackSemantic.image,
            network: 'none' as const,
            current_loop_id: options.rulepackSemantic.currentLoopId,
            required_authority: 'fixed_next_loop_gate' as const,
            required_decision_impact: 'next_loop_only' as const,
            ...(options.rulepackSemantic.timeoutMs
              ? { timeout_ms: options.rulepackSemantic.timeoutMs }
              : {})
          }
        }
      : {}),
    ...((options.hiddenTests ?? []).length > 0
      ? {
          hidden_acceptance: {
            tests: (options.hiddenTests ?? []).map((hidden) => ({
              name: hidden.name,
              source_path: hidden.source_path,
              target_path: hidden.target_path
            }))
          }
        }
      : {})
  };

  await writeFile(
    options.outputPath,
    `${JSON.stringify(evalConfig, null, 2)}\n`
  );
  return { evalFile: options.outputPath, evalConfig, generated: true };
}

function evalConfigForCandidate(
  evalConfig: EvalConfig,
  reproCommand: string | null | undefined
): EvalConfig {
  if (!reproCommand) return evalConfig;
  return {
    ...evalConfig,
    gates: evalConfig.gates.map((gate) =>
      gate.type === 'task_acceptance'
        ? {
            ...gate,
            name: `${gate.name}_focused`,
            command: reproCommand
          }
        : gate
    )
  };
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
 * updated branch for the next issue. With `--github-draft-pr`, it also pushes
 * each selected patch as a stacked draft PR branch. It never merges.
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
    .option(
      '--deadline <ms>',
      'wall-clock deadline in milliseconds per issue before launching another candidate'
    )
    .option(
      '--token-budget-total <tokens>',
      'provider token budget before launching another candidate across the orchestrated run (default applies with --token-usage-url or stats-capable --llm-proxy-url; override with VIBELOOP_TOKEN_BUDGET_TOTAL)'
    )
    .option(
      '--token-usage-url <url>',
      'HTTP(S) JSON usage endpoint returning {total_tokens} or {usage:{total_tokens}}; defaults to <llm-proxy-url>/__vibeloop_proxy_stats when a token budget is set'
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
      '--eval-artifact-leak',
      'with --generate-eval, add builtin:artifact-leak guard for agent stdout/stderr redaction and fail-closed leak verdicts',
      false
    )
    .option(
      '--eval-forbidden-literal <label=value>',
      'with --generate-eval, reject/redact this precise literal via artifact_leak (repeatable; do not pass real secrets on shared shell)',
      collect,
      []
    )
    .option(
      '--eval-scan-patch',
      'with --generate-eval artifact_leak, reject if a forbidden literal/token appears in the selected patch',
      false
    )
    .option(
      '--eval-redact-gate-logs',
      'with --generate-eval artifact_leak, redact project gate stdout/stderr logs before persisting',
      false
    )
    .option(
      '--eval-token-like-reject',
      'with --generate-eval artifact_leak, reject built-in token-like matches (opt-in due false positive risk)',
      false
    )
    .option(
      '--eval-max-scan-bytes <n>',
      'with --generate-eval artifact_leak, cap scanned output/patch bytes'
    )
    .option(
      '--eval-rulepack-lock <path>',
      'with --generate-eval, add builtin:rulepack-lock gate for a frozen next-loop rulepack lock (relative path is protected)'
    )
    .option(
      '--eval-rulepack-semantic <path>',
      'with --generate-eval, add builtin:rulepack-semantic required gate for an executable frozen next-loop rulepack'
    )
    .option(
      '--eval-rulepack-semantic-image <image>',
      'container image for --eval-rulepack-semantic execution'
    )
    .option(
      '--eval-rulepack-semantic-timeout-ms <n>',
      'per semantic-rule timeout for --eval-rulepack-semantic'
    )
    .option(
      '--carry-rulepack <path>',
      'carry a frozen next-loop rulepack into the orchestrated eval contract (works with --eval or --generate-eval)'
    )
    .option(
      '--carry-rulepack-image <image>',
      'container image for --carry-rulepack semantic execution'
    )
    .option(
      '--carry-rulepack-timeout-ms <n>',
      'per semantic-rule timeout for --carry-rulepack'
    )
    .option(
      '--eval-hidden-test <name=source:target:command>',
      'with --generate-eval, add an explicit hidden acceptance test stored outside the agent context (repeatable; no LLM-generated hidden tests)',
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
    .option(
      '--github-draft-pr',
      'with --promote-branch, push each selected patch as a stacked GitHub draft PR (no merge)',
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
      'base branch for the first --github-draft-pr',
      'main'
    )
    .option(
      '--github-branch-prefix <prefix>',
      'branch prefix for orchestrated --github-draft-pr branches',
      'pr-candidate'
    )
    .option(
      '--github-push-url <url>',
      'override git push/fetch URL for --github-draft-pr (test/enterprise use)'
    )
    .option(
      '--github-api-base-url <url>',
      'override GitHub API base URL for --github-draft-pr'
    )
    .option(
      '--github-title-prefix <title>',
      'draft PR title prefix for --github-draft-pr',
      'VibeLoop'
    )
    .action(async (options: OrchestrateCommandOptions, command: Command) => {
      warnRiskyFlags(options);
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
      const deadlineMs = parseNonNegativeInt(options.deadline, '--deadline');
      const tokenBudgetOptions = buildTokenBudgetLoopOptions(options);
      if (options.githubDraftPr && !options.promoteBranch) {
        throw new Error(
          'orchestrate --github-draft-pr requires --promote-branch so fixes are applied locally before rediscovery'
        );
      }
      if (options.githubDraftPr && !options.githubRepo) {
        throw new Error(
          'orchestrate --github-draft-pr requires --github-repo <owner/repo>'
        );
      }
      const githubTokenEnv = options.githubTokenEnv ?? 'GITHUB_TOKEN';
      const githubToken = options.githubDraftPr
        ? process.env[githubTokenEnv]
        : undefined;
      if (options.githubDraftPr && !githubToken) {
        throw new Error(
          `orchestrate --github-draft-pr requires ${githubTokenEnv} to be set`
        );
      }
      const generatedArtifactLeak = buildGeneratedArtifactLeak({
        enabled: options.evalArtifactLeak === true,
        forbiddenLiteral: options.evalForbiddenLiteral,
        scanPatch: options.evalScanPatch === true,
        redactGateLogs: options.evalRedactGateLogs === true,
        tokenLikeReject: options.evalTokenLikeReject === true,
        maxScanBytes: parsePositiveInt(
          options.evalMaxScanBytes,
          '--eval-max-scan-bytes'
        )
      });
      if (options.evalRulepackSemantic && !options.evalRulepackSemanticImage) {
        throw new Error(
          '--eval-rulepack-semantic requires --eval-rulepack-semantic-image <image>'
        );
      }
      if (options.carryRulepack && !options.carryRulepackImage) {
        throw new Error(
          '--carry-rulepack requires --carry-rulepack-image <image>'
        );
      }
      if (options.evalRulepackSemantic && options.carryRulepack) {
        throw new Error(
          '--carry-rulepack cannot be combined with --eval-rulepack-semantic; use one semantic rulepack source'
        );
      }
      const semanticTimeoutMs = parsePositiveInt(
        options.evalRulepackSemanticTimeoutMs,
        '--eval-rulepack-semantic-timeout-ms'
      );
      const carryRulepackTimeoutMs = parsePositiveInt(
        options.carryRulepackTimeoutMs,
        '--carry-rulepack-timeout-ms'
      );

      const dataDir = options.out ?? globalDataDir(command);
      const projectId = options.projectId ?? 'orchestrate';
      const baseLoopId = options.loopId ?? `orchestrate-${Date.now()}`;
      const carriedRulepack = options.carryRulepack
        ? {
            file: options.carryRulepack,
            image: options.carryRulepackImage!,
            currentLoopId: baseLoopId,
            ...(carryRulepackTimeoutMs
              ? { timeoutMs: carryRulepackTimeoutMs }
              : {})
          }
        : undefined;

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
      if (requestedEvalExists && options.evalRulepackSemantic) {
        throw new Error(
          '--eval-rulepack-semantic only applies with --generate-eval; use --carry-rulepack to overlay an existing eval'
        );
      }
      const evalSource = requestedEvalExists
        ? carriedRulepack
          ? await overlayRulepackSemanticEvalContract({
              evalFile: requestedEvalPath,
              evalConfig: await loadEvalConfig(requestedEvalPath),
              outputPath: path.join(
                dataDir,
                'projects',
                projectId,
                'orchestrate',
                baseLoopId,
                'eval.carry-rulepack.json'
              ),
              rulepackFile: carriedRulepack.file,
              image: carriedRulepack.image,
              currentLoopId: carriedRulepack.currentLoopId,
              ...(carriedRulepack.timeoutMs
                ? { timeoutMs: carriedRulepack.timeoutMs }
                : {})
            })
          : {
              evalFile: requestedEvalPath,
              evalConfig: await loadEvalConfig(requestedEvalPath),
              generated: false
            }
        : await generateMinimalEvalContract({
            repoPath: options.repo,
            projectId,
            evalCommands: options.evalCommand ?? [],
            artifactLeak: generatedArtifactLeak,
            rulepackLock: options.evalRulepackLock,
            ...(carriedRulepack
              ? {
                  rulepackSemantic: carriedRulepack
                }
              : options.evalRulepackSemantic
                ? {
                    rulepackSemantic: {
                      file: options.evalRulepackSemantic,
                      image: options.evalRulepackSemanticImage!,
                      currentLoopId: baseLoopId,
                      ...(semanticTimeoutMs
                        ? { timeoutMs: semanticTimeoutMs }
                        : {})
                    }
                  }
                : {}),
            hiddenTests: options.evalHiddenTest.map(parseGeneratedHiddenTest),
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
        let currentPublishBaseRef = options.githubBase ?? 'main';

        // one issue at a time: discover on the current branch/state, auto-generate
        // a task, run the full loop, and (when promoting) commit the selected
        // patch before rediscovering. Without --promote-branch this preserves the
        // old initial top-N behavior.
        const issues: Array<Record<string, unknown>> = [];
        const discoveryReports: string[] = [];
        let totalDiscovered = 0;
        let totalRawDiscovered = 0;
        let totalDroppedByDiscoveryCap = 0;
        let staticCandidates:
          | Awaited<
              ReturnType<typeof discoverCandidatesWithReport>
            >['candidates']
          | undefined;
        for (let index = 0; index < maxIssues; index += 1) {
          if (controller.signal.aborted) break;
          let candidates:
            | Awaited<
                ReturnType<typeof discoverCandidatesWithReport>
              >['candidates']
            | undefined;
          let discoveryReport:
            | Awaited<ReturnType<typeof discoverCandidatesWithReport>>['report']
            | undefined;
          if (options.promoteBranch || !staticCandidates) {
            const discovery = await discoverCandidatesWithReport({
              repoPath: options.repo,
              evalConfig
            });
            candidates = discovery.candidates;
            discoveryReport = discovery.report;
            if (!options.promoteBranch) staticCandidates = candidates;
            totalDiscovered += candidates.length;
            totalRawDiscovered += discoveryReport.raw_count;
            totalDroppedByDiscoveryCap += discoveryReport.dropped_count;
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
                  raw_discovered: discoveryReport.raw_count,
                  dropped_by_discovery_cap: discoveryReport.dropped_count,
                  discovery_cap: discoveryReport,
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
          const issueEvalConfig = evalSource.generated
            ? evalConfigForCandidate(evalConfig, candidate.reproCommand)
            : evalConfig;
          const issueEvalPath =
            issueEvalConfig === evalConfig
              ? evalPath
              : path.join(issueDir, 'eval.generated.issue.json');
          if (issueEvalPath !== evalPath) {
            await writeFile(
              issueEvalPath,
              `${JSON.stringify(issueEvalConfig, null, 2)}\n`
            );
          }

          try {
            const result = await runImprovementLoop({
              repoPath: options.repo,
              taskFile,
              evalFile: issueEvalPath,
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
            const selectedPatch = result.selected
              ? path.join(
                  result.selected.artifactRoot,
                  'patches/candidate.patch'
                )
              : null;
            const prCandidate = isPrCandidate({
              decision: result.selected?.decision ?? null,
              allPass: result.selected?.decision === 'accept',
              qualified: result.selected?.qualified ?? null,
              selected: result.selected,
              finalVerification: result.finalVerification ?? null
            });
            const promotion =
              result.selected &&
              selectedPatch &&
              options.promoteBranch &&
              prCandidate
                ? await commitSelectedPatchOnCurrentBranch({
                    repoPath: options.repo,
                    patchPath: selectedPatch,
                    expectedPatchHash:
                      result.finalVerification?.candidate_patch_hash,
                    artifactLeak: issueEvalConfig.artifact_leak,
                    commitMessage: `${options.promoteCommitMessagePrefix}: ${generated.task.id}`
                  })
                : null;
            if (promotion) currentBaseCommit = promotion.head_sha;
            const draftPr =
              result.selected &&
              selectedPatch &&
              prCandidate &&
              options.githubDraftPr &&
              options.githubRepo &&
              githubToken
                ? await (async () => {
                    const report = result.selected?.reportPath
                      ? (JSON.parse(
                          await readFile(result.selected.reportPath, 'utf8')
                        ) as Record<string, unknown>)
                      : undefined;
                    const branchName = `${options.githubBranchPrefix ?? 'pr-candidate'}/${baseLoopId}-i${index}/${generated.task.id}`;
                    const published = await publishSelectedPatchDraftPr({
                      repoPath: options.repo,
                      baseRef: currentPublishBaseRef,
                      branchName,
                      patchPath: selectedPatch,
                      expectedPatchHash:
                        result.finalVerification?.candidate_patch_hash,
                      artifactLeak: issueEvalConfig.artifact_leak,
                      commitMessage: `${options.promoteCommitMessagePrefix}: ${generated.task.id}`,
                      githubRepo: options.githubRepo!,
                      token: githubToken,
                      title: `${options.githubTitlePrefix ?? 'VibeLoop'}: ${generated.task.title}`,
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
                    currentPublishBaseRef = published.branch_name;
                    return published;
                  })()
                : null;
            issues.push({
              index,
              candidate_fingerprint: candidate.fingerprint,
              title: candidate.title,
              source: candidate.source,
              task_id: generated.task.id,
              selected_candidate_id: result.selected?.candidateId ?? null,
              pr_candidate: prCandidate,
              issue_eval_file: issueEvalPath,
              selected_patch: selectedPatch,
              final_verification: result.finalVerification ?? null,
              selection_quality: result.selectionQuality ?? null,
              adversary_review: result.adversaryReview ?? null,
              selection_report: result.selectionReportPath ?? null,
              promotion,
              draft_pr: draftPr
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
              issue_eval_file: issueEvalPath,
              error: error instanceof Error ? error.message : String(error)
            });
            if (options.promoteBranch) break;
          }
          if (!options.promoteBranch && index + 1 >= candidates.length) break;
        }

        const prCandidates = issues.filter(
          (issue) => issue.pr_candidate
        ).length;
        const errorCount = issues.filter(
          (issue) => typeof issue.error === 'string'
        ).length;
        const status =
          prCandidates > 0
            ? 'accepted'
            : errorCount > 0
              ? 'failed'
              : 'rejected';
        process.exitCode =
          status === 'accepted'
            ? EXIT_CODES.accept
            : status === 'failed'
              ? EXIT_CODES.failed
              : EXIT_CODES.reject;
        console.log(
          JSON.stringify(
            {
              mode: 'auto',
              scenario: 'orchestrate',
              status,
              loop_id: baseLoopId,
              project_id: projectId,
              repo: options.repo,
              eval_file: evalPath,
              generated_eval: evalSource.generated,
              carried_rulepack: carriedRulepack
                ? {
                    file: carriedRulepack.file,
                    image: carriedRulepack.image,
                    current_loop_id: carriedRulepack.currentLoopId,
                    ...(carriedRulepack.timeoutMs
                      ? { timeout_ms: carriedRulepack.timeoutMs }
                      : {})
                  }
                : null,
              discovered: totalDiscovered,
              raw_discovered: totalRawDiscovered,
              dropped_by_discovery_cap: totalDroppedByDiscoveryCap,
              processed: issues.length,
              max_issues: maxIssues,
              pr_candidates: prCandidates,
              error_count: errorCount,
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

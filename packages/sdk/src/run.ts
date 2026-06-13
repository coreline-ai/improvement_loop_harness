import { randomUUID } from 'node:crypto';
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {
  createRunDir,
  finalizeManifest,
  initializeManifest,
  writeArtifact,
  type RunLayout,
  type TerminalRunStatus
} from '@vibeloop/artifacts';
import {
  providerForAgentSpec,
  resolveAgentAdapter,
  type AgentRunResult
} from '@vibeloop/agent-adapters';
import {
  buildEvalReport,
  writeEvalReport,
  fallbackProvenance,
  hashArtifactRefs,
  localVerifierFromDecision,
  sha256Text,
  captureBaseline,
  decide,
  evaluateRequiredEvidence,
  runGates,
  verifyTestOnBase,
  collectMetricsForGates,
  CANDIDATE_METRICS_SCOPE,
  type BaselineMetrics,
  type EvalReportProvenance,
  type GateReportEntry,
  type MetricRejection,
  type TestOnBaseReport
} from '@vibeloop/eval-engine';
import {
  annotateScope,
  applyPatch,
  extractDiff,
  type ChangedFilesArtifact,
  type GuardChangedFile
} from '@vibeloop/guards';
import type { Decision } from '@vibeloop/shared';
import {
  classifyRisk,
  loadEvalConfig,
  loadTask,
  mergeLimits,
  type EvalConfig,
  type TaskDefinition
} from '@vibeloop/task-protocol';
import {
  createWorktree,
  prepareAgentEnv,
  provisionDependencies,
  removeWorktree,
  resolveBaseCommit,
  safeGit,
  snapshotGitMetadata,
  type DependencyProvisionResult,
  type WorktreeRef
} from '@vibeloop/workspace-runner';
import {
  EXIT_CODES,
  exitCodeForDecision,
  type CliExitCode
} from './exit-codes.js';

export type LoopStateName =
  | 'draft'
  | 'queued'
  | 'workspace_preparing'
  | 'workspace_ready'
  | 'agent_running'
  | 'patch_created'
  | 'guards_running'
  | 'eval_running'
  | 'critic_running'
  | 'decision_ready'
  | 'accepted'
  | 'rejected'
  | 'needs_human_review'
  | 'needs_more_tests'
  | 'cancelled'
  | 'failed';

export interface LoopEvent {
  seq: number;
  ts: string;
  state: LoopStateName;
  message: string;
}

export interface RunKernelOptions {
  repoPath: string;
  taskFile: string;
  evalFile: string;
  dataDir: string;
  agentSpec: string;
  projectId?: string | undefined;
  loopId?: string | undefined;
  baseCommit?: string | undefined;
  proxyBaseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  evalOnlyPatch?: string | undefined;
  retryOf?: string | undefined;
  retryMode?: RetryMode | undefined;
  logToStdout?: boolean | undefined;
  skipDependencyInstall?: boolean | undefined;
}

export interface RunKernelResult {
  loopId: string;
  projectId: string;
  layout: RunLayout;
  status: TerminalRunStatus;
  decision?: Decision | undefined;
  exitCode: CliExitCode;
  reportPath?: string | undefined;
  events: LoopEvent[];
}

export type RetryMode =
  | 'retry_same_base'
  | 'retry_latest_base'
  | 'retry_eval_only'
  | 'retry_critic_only';

interface WorkspaceRefArtifact {
  repo_path: string;
  worktree_path: string;
  project_id: string;
  loop_id: string;
  base_commit: string;
  lock_path: string;
  dependency_provisioning: DependencyProvisionResult;
  retry_of?: string | undefined;
  retry_mode?: RetryMode | undefined;
}

class CancelledError extends Error {
  constructor() {
    super('loop cancelled');
    this.name = 'CancelledError';
  }
}

function isCancelledError(error: unknown): error is CancelledError {
  return error instanceof CancelledError;
}

function generatedLoopId(): string {
  return `loop-${randomUUID()}`;
}

function sanitizeProjectId(project: string): string {
  return (
    project
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  );
}

function terminalStatusForDecision(decision: Decision): TerminalRunStatus {
  switch (decision) {
    case 'accept':
      return 'accepted';
    case 'reject':
      return 'rejected';
    case 'needs_human_review':
      return 'needs_human_review';
    case 'needs_more_tests':
      return 'needs_more_tests';
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeLoopEvent(
  layout: RunLayout | undefined,
  events: LoopEvent[],
  state: LoopStateName,
  message: string,
  logToStdout: boolean
): Promise<void> {
  const event: LoopEvent = {
    seq: events.length + 1,
    ts: new Date().toISOString(),
    state,
    message
  };
  events.push(event);
  if (logToStdout) {
    console.log(JSON.stringify(event));
  }
  if (layout) {
    await appendFile(
      layout.path('logs/loop-events.jsonl'),
      `${JSON.stringify(event)}\n`
    );
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CancelledError();
  }
}

async function cancellable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) {
    return promise;
  }
  throwIfCancelled(signal);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(new CancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise
        .finally(() => signal.removeEventListener('abort', onAbort))
        .catch(() => undefined);
    })
  ]);
}

async function collectCandidateMetrics(
  artifactRoot: string,
  gateRuns: readonly GateReportEntry[]
): Promise<{ metrics: BaselineMetrics; rejected: MetricRejection[] }> {
  const gates = await Promise.all(
    gateRuns.map(async (gate) => ({
      name: gate.name,
      stdout: gate.stdout_ref
        ? await readFile(
            path.join(artifactRoot, gate.stdout_ref),
            'utf8'
          ).catch(() => '')
        : ''
    }))
  );
  return collectMetricsForGates({
    artifactRoot,
    scope: CANDIDATE_METRICS_SCOPE,
    gates
  });
}

function toAnnotatedChangedFilesArtifact(
  baseCommit: string,
  files: readonly GuardChangedFile[]
): ChangedFilesArtifact {
  return {
    base_commit: baseCommit,
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      ...(file.oldPath ? { old_path: file.oldPath } : {}),
      is_symlink: file.isSymlink,
      added_lines: file.addedLines,
      deleted_lines: file.deletedLines,
      ...(file.allowedByWriteScope !== undefined
        ? { allowed_by_write_scope: file.allowedByWriteScope }
        : {}),
      ...(file.protected !== undefined ? { protected: file.protected } : {})
    })),
    untracked_files: files
      .filter((file) => file.status === 'untracked')
      .map((file) => file.path),
    renames: files.flatMap((file) =>
      file.status === 'renamed' && file.oldPath
        ? [{ old_path: file.oldPath, path: file.path }]
        : []
    ),
    symlinks: files.filter((file) => file.isSymlink).map((file) => file.path)
  };
}

async function candidateCommit(worktreePath: string): Promise<string | null> {
  const result = await safeGit(worktreePath, ['rev-parse', 'HEAD']).catch(
    () => undefined
  );
  return result?.stdout.trim() ?? null;
}

async function finalizeIfRunning(
  layout: RunLayout | undefined,
  status: TerminalRunStatus,
  decision?: string | undefined
): Promise<void> {
  if (!layout) {
    return;
  }
  await finalizeManifest(layout, {
    status,
    ...(decision ? { decision } : {})
  }).catch(() => undefined);
}

function inferGateGroups(evalConfig: EvalConfig): EvalConfig {
  return {
    ...evalConfig,
    gates: evalConfig.gates.map((gate) => {
      if (gate.group) return gate;
      if (gate.type === 'hidden_acceptance')
        return { ...gate, group: 'hidden_acceptance' as const };
      if (
        gate.required &&
        ['task_acceptance', 'regression', 'hard'].includes(gate.type)
      ) {
        return { ...gate, group: 'pass_to_pass' as const };
      }
      return gate;
    })
  };
}

async function injectHiddenAcceptanceTests(options: {
  evalConfig: EvalConfig;
  evalFile: string;
  worktreePath: string;
}): Promise<Array<() => Promise<void>>> {
  const cleanups: Array<() => Promise<void>> = [];
  for (const test of options.evalConfig.hidden_acceptance?.tests ?? []) {
    const sourcePath = path.isAbsolute(test.source_path)
      ? test.source_path
      : path.resolve(path.dirname(options.evalFile), test.source_path);
    const targetPath = path.join(options.worktreePath, test.target_path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    cleanups.push(() => rm(targetPath, { force: true }));
  }
  return cleanups;
}

/**
 * Decides whether the advisory review must be treated as NOT independent of the
 * builder (`same_model_review = true` means independence is not guaranteed).
 *
 * Promotion from the prior adapter-shape heuristic to real provider identity:
 * compare the builder provider with the declared reviewer provider. Different
 * known providers → independent (false). Same provider → not independent (true).
 * Unknown/undeclared → conservative true.
 */
export function resolveSameModelReview(
  agentSpec: string,
  criticConfig: EvalConfig['critic'] | undefined
): boolean {
  if (criticConfig?.require_different_provider === true) {
    return false;
  }

  const builderProvider = providerForAgentSpec(agentSpec);
  // mock builders are test-only and never an LLM self-review.
  if (builderProvider === 'mock') {
    return false;
  }

  const reviewerProvider = criticConfig?.reviewer_provider?.trim();
  if (reviewerProvider) {
    if (reviewerProvider === 'unknown' || builderProvider === 'unknown') {
      return true;
    }
    return builderProvider === reviewerProvider;
  }

  // No reviewer provider declared: independence cannot be proven.
  return true;
}

function advisoryFindingsFor(options: {
  gateRuns: readonly GateReportEntry[];
  agentSpec: string;
  evalConfig: EvalConfig;
}): Array<Record<string, unknown>> {
  const sameModelReview = resolveSameModelReview(
    options.agentSpec,
    options.evalConfig.critic
  );
  const builderProvider = providerForAgentSpec(options.agentSpec);
  const reviewerProvider =
    options.evalConfig.critic?.reviewer_provider?.trim() || 'undeclared';
  return options.gateRuns
    .filter((gate) => gate.type === 'advisory')
    .map((gate) => ({
      source: 'advisory_gate',
      gate: gate.name,
      status: gate.status,
      authority: 'advisory',
      builder_provider: builderProvider,
      reviewer_provider: reviewerProvider,
      same_model_review: sameModelReview
    }));
}

async function writeFailureReport(options: {
  layout: RunLayout;
  loopId: string;
  projectId: string;
  task: TaskDefinition;
  baseCommit: string;
  code: string;
  message: string;
  provenance?: EvalReportProvenance | undefined;
}): Promise<string> {
  const report = buildEvalReport({
    loopId: options.loopId,
    taskId: options.task.id,
    projectId: options.projectId,
    baseCommit: options.baseCommit,
    decision: 'reject',
    decisionReasons: [
      {
        code: options.code as never,
        message: options.message
      }
    ],
    changedFiles: [],
    gateRuns: [],
    improvementEvidence: [],
    risk: { areas: [], human_approval_required: false, reason: 'system_error' },
    provenance: options.provenance ?? fallbackProvenance(),
    provenanceVerified: true
  });
  return writeEvalReport(options.layout.root, report);
}

export async function runKernel(
  options: RunKernelOptions
): Promise<RunKernelResult> {
  const loopId = options.loopId ?? generatedLoopId();
  const events: LoopEvent[] = [];
  const logToStdout = options.logToStdout ?? false;
  let layout: RunLayout | undefined;
  let task: TaskDefinition | undefined;
  let evalConfig: EvalConfig | undefined;
  let baseCommit = options.baseCommit;
  let projectId = options.projectId;
  const cleanupRefs: WorktreeRef[] = [];

  try {
    await writeLoopEvent(
      undefined,
      events,
      'draft',
      'loading task and eval config',
      logToStdout
    );
    const rawTask = await readFile(options.taskFile, 'utf8');
    const rawEval = await readFile(options.evalFile, 'utf8');
    const inputProvenance = {
      ...fallbackProvenance(),
      task_hash: sha256Text(rawTask),
      eval_config_hash: sha256Text(rawEval)
    };
    task = await loadTask(options.taskFile);
    evalConfig = inferGateGroups(await loadEvalConfig(options.evalFile));
    projectId = projectId ?? sanitizeProjectId(evalConfig.project);

    await writeLoopEvent(
      undefined,
      events,
      'workspace_preparing',
      'resolving base commit',
      logToStdout
    );
    baseCommit =
      baseCommit ??
      (await resolveBaseCommit(options.repoPath, task.base_branch ?? 'HEAD'));

    layout = await createRunDir({
      dataDir: options.dataDir,
      projectId,
      loopId
    });
    await initializeManifest(layout, { taskId: task.id, baseCommit });
    await writeLoopEvent(
      layout,
      events,
      'queued',
      'run directory initialized',
      logToStdout
    );

    await writeArtifact(layout.root, 'input/task.yaml', rawTask);
    await writeArtifact(layout.root, 'input/eval.yaml', rawEval);
    await writeArtifact(
      layout.root,
      'input/base_commit.txt',
      `${baseCommit}\n`
    );

    const agentEnv = await prepareAgentEnv({
      env: process.env,
      dataDir: options.dataDir,
      projectId,
      loopId
    });
    await writeArtifact(
      layout.root,
      'input/env-snapshot.json',
      `${JSON.stringify({ keys: Object.keys(agentEnv).sort(), env: agentEnv }, null, 2)}\n`
    );

    throwIfCancelled(options.signal);
    await writeLoopEvent(
      layout,
      events,
      'workspace_preparing',
      'creating isolated worktree',
      logToStdout
    );
    const worktree = await cancellable(
      createWorktree({
        repoPath: options.repoPath,
        dataDir: options.dataDir,
        projectId,
        loopId,
        baseCommit
      }),
      options.signal
    );
    cleanupRefs.push(worktree);

    const dependencyProvisioning = options.skipDependencyInstall
      ? { status: 'skipped' as const }
      : await cancellable(
          provisionDependencies({
            workspaceRoot: worktree.path,
            dataDir: options.dataDir,
            projectId,
            env: agentEnv
          }),
          options.signal
        );

    const workspaceRef: WorkspaceRefArtifact = {
      repo_path: worktree.repoPath,
      worktree_path: worktree.path,
      project_id: projectId,
      loop_id: loopId,
      base_commit: baseCommit,
      lock_path: worktree.lockPath,
      dependency_provisioning: dependencyProvisioning,
      ...(options.retryOf ? { retry_of: options.retryOf } : {}),
      ...(options.retryMode ? { retry_mode: options.retryMode } : {})
    };
    await writeJson(
      path.join(layout.workspace, 'workspace-ref.json'),
      workspaceRef
    );

    await writeLoopEvent(
      layout,
      events,
      'workspace_preparing',
      'capturing baseline metrics',
      logToStdout
    );
    const baseline = await cancellable(
      captureBaseline({
        evalConfig,
        projectId,
        baseCommit,
        worktreeRoot: worktree.path,
        artifactRoot: layout.root,
        dataDir: options.dataDir,
        env: agentEnv,
        taskFile: path.join(layout.input, 'task.yaml'),
        loopId
      }),
      options.signal
    );

    await writeLoopEvent(
      layout,
      events,
      'workspace_preparing',
      'capturing git metadata snapshot',
      logToStdout
    );
    const gitMetadataBefore = await cancellable(
      snapshotGitMetadata(worktree.path),
      options.signal
    );
    await writeJson(
      path.join(layout.integrity, 'git-metadata-before.json'),
      gitMetadataBefore
    );
    await writeLoopEvent(
      layout,
      events,
      'workspace_ready',
      'workspace fixed at base commit',
      logToStdout
    );

    let agentResult: AgentRunResult | undefined;
    if (options.evalOnlyPatch !== undefined) {
      await writeLoopEvent(
        layout,
        events,
        'agent_running',
        'agent skipped; applying stored candidate.patch',
        logToStdout
      );
      await writeArtifact(
        layout.root,
        'logs/agent.stdout.log',
        'agent skipped for retry_eval_only; stored candidate.patch reapplied\n'
      );
      await writeArtifact(layout.root, 'logs/agent.stderr.log', '');
      await cancellable(
        applyPatch(worktree.path, options.evalOnlyPatch),
        options.signal
      );
    } else {
      await writeLoopEvent(
        layout,
        events,
        'agent_running',
        'running builder agent',
        logToStdout
      );
      const adapter = resolveAgentAdapter(options.agentSpec, {
        loopId,
        limits: mergeLimits(task.limits, evalConfig.limits),
        proxyBaseUrl: options.proxyBaseUrl
      });
      const agentTaskFile = path.join(layout.input, 'task.yaml');
      agentResult = await cancellable(
        adapter.run({
          worktree: worktree.path,
          taskFile: agentTaskFile,
          env: {
            ...agentEnv,
            VIBELOOP_LOOP_ID: loopId,
            VIBELOOP_PROJECT_ID: projectId,
            VIBELOOP_TASK_FILE: agentTaskFile,
            VIBELOOP_WORKTREE: worktree.path
          },
          timeoutMs: mergeLimits(task.limits, evalConfig.limits)
            .agent_timeout_seconds
            ? mergeLimits(task.limits, evalConfig.limits)
                .agent_timeout_seconds! * 1000
            : undefined,
          stdoutFile: path.join(layout.logs, 'agent.stdout.log'),
          stderrFile: path.join(layout.logs, 'agent.stderr.log')
        }),
        options.signal
      );
      await writeArtifact(
        layout.root,
        'logs/agent.stdout.log',
        agentResult.stdout
      );
      await writeArtifact(
        layout.root,
        'logs/agent.stderr.log',
        agentResult.stderr
      );
      if (agentResult.status !== 'pass') {
        const reportPath = await writeFailureReport({
          layout,
          loopId,
          projectId,
          task,
          baseCommit,
          code: 'AGENT_FAILED',
          message: `agent failed: ${agentResult.stderr || agentResult.status}`,
          provenance: inputProvenance
        });
        await writeLoopEvent(
          layout,
          events,
          'decision_ready',
          'agent failure report generated',
          logToStdout
        );
        await finalizeIfRunning(layout, 'failed', 'failed');
        return {
          loopId,
          projectId,
          layout,
          status: 'failed',
          exitCode: EXIT_CODES.failed,
          reportPath,
          events
        };
      }
    }

    const gitMetadataAfter = await cancellable(
      snapshotGitMetadata(worktree.path),
      options.signal
    );
    await writeJson(
      path.join(layout.integrity, 'git-metadata-after.json'),
      gitMetadataAfter
    );

    const diff = await cancellable(
      extractDiff({
        repoPath: worktree.path,
        baseCommit,
        artifactRoot: layout.root
      }),
      options.signal
    );
    const changedFiles = annotateScope(diff.changedFiles, {
      writeScope: task.write_scope,
      protectedPaths: evalConfig.protected_paths
    });
    await writeArtifact(
      layout.root,
      'patches/changed-files.json',
      `${JSON.stringify(toAnnotatedChangedFilesArtifact(baseCommit, changedFiles), null, 2)}\n`
    );
    await writeLoopEvent(
      layout,
      events,
      'patch_created',
      `${changedFiles.length} changed file(s) detected`,
      logToStdout
    );

    await writeLoopEvent(
      layout,
      events,
      'guards_running',
      'running builtin guards',
      logToStdout
    );
    if (
      evalConfig.gates.some((gate) =>
        [
          'hard',
          'task_acceptance',
          'regression',
          'security',
          'performance'
        ].includes(gate.type)
      )
    ) {
      await writeLoopEvent(
        layout,
        events,
        'eval_running',
        'running eval.yaml project gates',
        logToStdout
      );
    }
    if (evalConfig.gates.some((gate) => gate.type === 'advisory')) {
      await writeLoopEvent(
        layout,
        events,
        'critic_running',
        'running advisory gates',
        logToStdout
      );
    }

    const testOnBase = await maybeVerifyTestOnBase({
      options,
      task,
      projectId,
      baseCommit,
      candidateWorktree: worktree,
      candidatePatch: diff.candidatePatch,
      changedFiles,
      layout,
      env: agentEnv,
      cleanupRefs
    });

    const hiddenCleanups = await injectHiddenAcceptanceTests({
      evalConfig,
      evalFile: options.evalFile,
      worktreePath: worktree.path
    });
    let gateResult;
    try {
      gateResult = await cancellable(
        runGates({
          evalConfig,
          task,
          taskFile: path.join(layout.input, 'task.yaml'),
          baseCommit,
          loopId,
          worktreeRoot: worktree.path,
          artifactRoot: layout.root,
          env: agentEnv,
          changedFiles,
          gitMetadataBefore,
          gitMetadataAfter
        }),
        options.signal
      );
    } finally {
      await Promise.all(
        hiddenCleanups.map((cleanup) => cleanup().catch(() => undefined))
      );
    }

    const candidate = await collectCandidateMetrics(
      layout.root,
      gateResult.report.gates
    );
    const candidateMetrics = candidate.metrics;
    if (candidate.rejected.length > 0) {
      await writeArtifact(
        layout.root,
        'reports/metrics-debug.json',
        `${JSON.stringify({ rejected: candidate.rejected }, null, 2)}\n`
      );
    }
    const evidence = evaluateRequiredEvidence(task.required_evidence, {
      changedFiles,
      baseline,
      candidateMetrics,
      testOnBase,
      gateRuns: gateResult.report.gates
    });
    await writeArtifact(
      layout.root,
      'reports/evidence-summary.json',
      `${JSON.stringify(evidence, null, 2)}\n`
    );

    const risk = classifyRisk(
      changedFiles.map((file) => file.path),
      evalConfig.risk_classification
    );
    const verifierPolicy = evalConfig.verifier?.policy ?? 'local';
    const verifierMismatch = verifierPolicy === 'strict';
    const decision = decide({
      changedFiles,
      gateRuns: gateResult.report.gates,
      improvementEvidence: evidence.evidence,
      risk: {
        areas: risk.areas,
        unknown: risk.unknown,
        humanApprovalRiskAreas: evalConfig.human_approval_risk_areas ?? [],
        humanApprovalRequired: task.human_approval_required ?? false
      },
      taskRiskArea: task.risk_area,
      taskHumanApprovalRequired: task.human_approval_required,
      metaEvaluationEnabled: task.risk_area === 'eval_system',
      provenanceVerified: true,
      verifierMismatch
    });

    await writeLoopEvent(
      layout,
      events,
      'decision_ready',
      `decision=${decision.decision}`,
      logToStdout
    );
    const gateArtifactHashes = await hashArtifactRefs(layout.root, [
      'reports/gate-report.json',
      'reports/evidence-summary.json',
      ...gateResult.report.gates.flatMap((gate) => [
        gate.stdout_ref,
        gate.stderr_ref
      ])
    ]);
    const provenance: EvalReportProvenance = {
      ...inputProvenance,
      candidate_patch_hash: sha256Text(diff.candidatePatch),
      gate_artifact_hashes: gateArtifactHashes
    };
    const verifier = localVerifierFromDecision({
      policy: verifierPolicy,
      decision: decision.decision,
      gateRuns: gateResult.report.gates
    });
    const report = buildEvalReport({
      loopId,
      taskId: task.id,
      projectId,
      baseCommit,
      candidateCommit: await candidateCommit(worktree.path),
      decision: decision.decision,
      decisionReasons: decision.reasons,
      changedFiles,
      gateRuns: gateResult.report.gates,
      improvementEvidence: evidence.evidence,
      risk: {
        areas: risk.areas,
        human_approval_required:
          (task.human_approval_required ?? false) ||
          risk.unknown ||
          risk.areas.some((area) =>
            (evalConfig!.human_approval_risk_areas ?? []).includes(area)
          ),
        reason: risk.unknown ? 'unknown' : 'classified'
      },
      advisoryFindings: advisoryFindingsFor({
        gateRuns: gateResult.report.gates,
        agentSpec: options.agentSpec,
        evalConfig
      }),
      provenance,
      provenanceVerified: true,
      verifier,
      artifactRefs: [
        'input/task.yaml',
        'input/eval.yaml',
        'input/base_commit.txt',
        'input/env-snapshot.json',
        'workspace/workspace-ref.json',
        'patches/candidate.patch',
        'patches/changed-files.json',
        'metrics/baseline.json',
        'reports/gate-report.json',
        'reports/evidence-summary.json'
      ]
    });
    const reportPath = await writeEvalReport(layout.root, report);
    const status = terminalStatusForDecision(decision.decision);
    await writeLoopEvent(
      layout,
      events,
      statusToState(status),
      'loop completed',
      logToStdout
    );
    await finalizeIfRunning(layout, status, status);
    return {
      loopId,
      projectId,
      layout,
      status,
      decision: decision.decision,
      exitCode: exitCodeForDecision(decision.decision),
      reportPath,
      events
    };
  } catch (error) {
    const cancelled = isCancelledError(error);
    const status: TerminalRunStatus = cancelled ? 'cancelled' : 'failed';
    let reportPath: string | undefined;
    if (layout && task && baseCommit && projectId) {
      reportPath = await writeFailureReport({
        layout,
        loopId,
        projectId,
        task,
        baseCommit,
        code: cancelled ? 'CANCELLED' : 'SYSTEM_ERROR',
        message: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
    }
    await writeLoopEvent(
      layout,
      events,
      cancelled ? 'cancelled' : 'failed',
      error instanceof Error ? error.message : String(error),
      logToStdout
    ).catch(() => undefined);
    await finalizeIfRunning(layout, status, status);
    if (!layout || !projectId) {
      throw error;
    }
    return {
      loopId,
      projectId,
      layout,
      status,
      exitCode: cancelled ? EXIT_CODES.cancelled : EXIT_CODES.failed,
      reportPath,
      events
    };
  } finally {
    await Promise.all(
      cleanupRefs.reverse().map(async (ref) => {
        await removeWorktree(ref).catch(async () => {
          await rm(ref.path, { recursive: true, force: true }).catch(
            () => undefined
          );
        });
      })
    );
  }
}

async function maybeVerifyTestOnBase(options: {
  options: RunKernelOptions;
  task: TaskDefinition;
  projectId: string;
  baseCommit: string;
  candidateWorktree: WorktreeRef;
  candidatePatch: string;
  changedFiles: GuardChangedFile[];
  layout: RunLayout;
  env: NodeJS.ProcessEnv;
  cleanupRefs: WorktreeRef[];
}): Promise<TestOnBaseReport | undefined> {
  const requiredTests = options.task.acceptance?.required_tests ?? [];
  if (requiredTests.length === 0) {
    return undefined;
  }

  const baseLoopId = `${options.candidateWorktree.loopId}-base`;
  const baseWorktree = await createWorktree({
    repoPath: options.candidateWorktree.repoPath,
    dataDir: options.options.dataDir,
    projectId: options.projectId,
    loopId: baseLoopId,
    baseCommit: options.baseCommit
  });
  options.cleanupRefs.push(baseWorktree);
  if (!options.options.skipDependencyInstall) {
    await provisionDependencies({
      workspaceRoot: baseWorktree.path,
      dataDir: options.options.dataDir,
      projectId: options.projectId,
      env: options.env
    }).catch(() => ({ status: 'skipped' as const }));
  }
  return verifyTestOnBase({
    baseRepoPath: baseWorktree.path,
    candidateRepoPath: options.candidateWorktree.path,
    candidatePatch: options.candidatePatch,
    changedFiles: options.changedFiles,
    requiredTests,
    artifactRoot: options.layout.root,
    env: options.env
  });
}

function statusToState(status: TerminalRunStatus): LoopStateName {
  switch (status) {
    case 'accepted':
    case 'approved':
    case 'pr_created':
    case 'completed':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'needs_human_review':
      return 'needs_human_review';
    case 'needs_more_tests':
      return 'needs_more_tests';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
  }
}

export async function copyRetryInputs(options: {
  previousRunRoot: string;
  newTaskFile: string;
  newEvalFile: string;
}): Promise<void> {
  await copyFile(
    path.join(options.previousRunRoot, 'input', 'task.yaml'),
    options.newTaskFile
  );
  await copyFile(
    path.join(options.previousRunRoot, 'input', 'eval.yaml'),
    options.newEvalFile
  );
}

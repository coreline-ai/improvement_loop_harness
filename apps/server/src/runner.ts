import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runKernel } from '@vibeloop/cli';
import type { RunKernelResult } from '@vibeloop/cli';
import type { LoopRunner, LoopRunnerInput, LoopRunnerResult } from './queue.js';
import type { JsonValue, Store } from './types.js';

interface ArtifactManifestEntry {
  path: string;
  sha256: string;
  size_bytes: number;
}

interface RunManifestJson {
  artifacts?: ArtifactManifestEntry[] | undefined;
  base_commit?: string | undefined;
}

interface EvalReportJson {
  decision?: string | undefined;
  summary?: string | undefined;
  base_commit?: string | undefined;
  candidate_commit?: string | null | undefined;
  decision_reasons?: JsonValue | undefined;
}

interface GateReportJson {
  gates?: Array<{
    name: string;
    type: string;
    required: boolean;
    command: string;
    status: string;
    exit_code: number | null;
    duration_ms: number | null;
    stdout_ref: string | null;
    stderr_ref: string | null;
    summary: string | null;
    started_at: string | null;
    finished_at: string | null;
  }> | undefined;
}

interface WorkspaceRefJson {
  worktree_path?: string | undefined;
  base_commit?: string | undefined;
}

export interface KernelLoopRunnerOptions {
  store: Store;
  dataDir: string;
  defaultAgentSpec: string;
  proxyBaseUrl?: string | undefined;
  skipDependencyInstall?: boolean | undefined;
}

function resolveEvalFile(projectRoot: string, evalConfigPath: string): string {
  return path.isAbsolute(evalConfigPath) ? evalConfigPath : path.join(projectRoot, evalConfigPath);
}

function artifactKind(artifactPath: string): string {
  if (artifactPath === 'manifest.json') return 'manifest';
  const [topLevel] = artifactPath.split('/');
  switch (topLevel) {
    case 'reports':
      return 'report';
    case 'logs':
      return 'log';
    case 'patches':
      return 'patch';
    case 'input':
      return 'input';
    case 'metrics':
      return 'metric';
    case 'integrity':
      return 'integrity';
    case 'workspace':
      return 'workspace';
    default:
      return 'artifact';
  }
}

function agentType(agentSpec: string): string {
  if (agentSpec.startsWith('mock:')) return 'mock';
  if (agentSpec === 'codex' || agentSpec.startsWith('codex:')) return 'codex';
  return agentSpec.split(':')[0] || 'unknown';
}

async function readJson<T>(filePath: string): Promise<T | null> {
  const raw = await readFile(filePath, 'utf8').catch(() => undefined);
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

async function persistKernelArtifacts(
  store: Store,
  input: LoopRunnerInput,
  agentSpec: string,
  startedAt: Date,
  finishedAt: Date,
  result: RunKernelResult
): Promise<void> {
  const root = result.layout.root;
  const evalReport = await readJson<EvalReportJson>(path.join(root, 'reports', 'eval-report.json'));
  const gateReport = await readJson<GateReportJson>(path.join(root, 'reports', 'gate-report.json'));
  const manifest = await readJson<RunManifestJson>(path.join(root, 'manifest.json'));
  const workspaceRef = await readJson<WorkspaceRefJson>(path.join(root, 'workspace', 'workspace-ref.json'));

  if (evalReport) {
    await store.createReport({
      loopRunId: input.loop.id,
      type: 'eval',
      status: result.status,
      reportJson: evalReport,
      summary: evalReport.summary ?? null,
      artifactRef: 'reports/eval-report.json'
    });
    await store.updateLoop(input.loop.id, {
      baseCommit: evalReport.base_commit ?? manifest?.base_commit ?? input.loop.baseCommit ?? null,
      candidateCommit: evalReport.candidate_commit ?? null,
      decisionReasons: evalReport.decision_reasons ?? null
    });
  }

  for (const gate of gateReport?.gates ?? []) {
    await store.createGateRun({
      loopRunId: input.loop.id,
      name: gate.name,
      type: gate.type,
      required: gate.required,
      command: gate.command,
      status: gate.status,
      exitCode: gate.exit_code,
      durationMs: gate.duration_ms,
      stdoutRef: gate.stdout_ref,
      stderrRef: gate.stderr_ref,
      summary: gate.summary,
      startedAt: gate.started_at ? new Date(gate.started_at) : startedAt,
      finishedAt: gate.finished_at ? new Date(gate.finished_at) : finishedAt
    });
  }

  if (workspaceRef?.worktree_path && (workspaceRef.base_commit ?? manifest?.base_commit ?? input.loop.baseCommit)) {
    await store.createWorkspaceRun({
      loopRunId: input.loop.id,
      kind: 'git_worktree',
      path: workspaceRef.worktree_path,
      baseCommit: workspaceRef.base_commit ?? manifest?.base_commit ?? input.loop.baseCommit!,
      status: 'cleaned',
      cleanedAt: finishedAt
    });
  }

  await store.createAgentRun({
    loopRunId: input.loop.id,
    agentType: agentType(agentSpec),
    command: agentSpec,
    model: agentSpec === 'codex' ? 'codex-default' : null,
    status: result.status,
    exitCode: result.exitCode,
    stdoutRef: 'logs/agent.stdout.log',
    stderrRef: 'logs/agent.stderr.log',
    startedAt,
    finishedAt
  });

  for (const artifact of manifest?.artifacts ?? []) {
    await store.createArtifact({
      loopRunId: input.loop.id,
      kind: artifactKind(artifact.path),
      path: artifact.path,
      sha256: artifact.sha256,
      sizeBytes: artifact.size_bytes,
      redacted: false
    });
  }

  for (const event of result.events) {
    await store.addLoopEvent(input.loop.id, `kernel.${event.state}`, {
      kernel_seq: event.seq,
      state: event.state,
      message: event.message,
      ts: event.ts
    });
  }
}

export function createKernelLoopRunner(options: KernelLoopRunnerOptions): LoopRunner {
  return async (input: LoopRunnerInput): Promise<LoopRunnerResult> => {
    const project = await options.store.getProject(input.task.projectId);
    if (!project?.localPath) {
      throw new Error(`project ${input.task.projectId} requires localPath for kernel runner`);
    }

    const agentSpec = input.loop.agentSpec ?? options.defaultAgentSpec;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-server-task-'));
    const taskFile = path.join(tempDir, 'task.yaml');
    const evalFile = resolveEvalFile(project.localPath, project.evalConfigPath);
    const startedAt = new Date();

    try {
      await writeFile(taskFile, `${JSON.stringify(input.task.taskYaml, null, 2)}\n`);
      const result = await runKernel({
        repoPath: project.localPath,
        taskFile,
        evalFile,
        dataDir: options.dataDir,
        agentSpec,
        projectId: project.id,
        loopId: input.loop.id,
        ...(input.loop.baseCommit ? { baseCommit: input.loop.baseCommit } : {}),
        ...(options.proxyBaseUrl ? { proxyBaseUrl: options.proxyBaseUrl } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        skipDependencyInstall: options.skipDependencyInstall ?? false
      });
      const finishedAt = new Date();
      await persistKernelArtifacts(options.store, input, agentSpec, startedAt, finishedAt, result);
      return {
        status: result.status,
        decision: result.decision,
        artifactRoot: result.layout.root,
        tokenUsageTotal: 0
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

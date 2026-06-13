import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '@vibeloop/shared';
import type { EvalConfig, EvalGate } from '@vibeloop/task-protocol';
import { interpolate, interpolationValues } from './interpolate.js';
import {
  BASELINE_METRICS_SCOPE,
  collectMetricsForGates,
  ensureStructuredMetricsDir,
  structuredMetricsPath,
  STRUCTURED_METRICS_ENV,
  type BaselineMetrics
} from './metrics.js';
import type { GateReportEntry } from './types.js';

export interface BaselineReport {
  schema_version: '1.0';
  project: string;
  project_id: string;
  base_commit: string;
  eval_config_hash: string;
  cache_key: string;
  cache_hit: boolean;
  generated_at: string;
  gate_runs: GateReportEntry[];
  base_red_tests: string[];
  metrics: BaselineMetrics;
}

export interface CaptureBaselineOptions {
  evalConfig: EvalConfig;
  projectId: string;
  baseCommit: string;
  worktreeRoot: string;
  artifactRoot: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  taskFile?: string | undefined;
  loopId?: string | undefined;
}

const COMPARATIVE_GATE_TYPES = new Set(['performance', 'security']);

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashEvalConfig(evalConfig: EvalConfig): string {
  return createHash('sha256').update(stableStringify(evalConfig)).digest('hex');
}

export function baselineCacheKey(
  projectId: string,
  baseCommit: string,
  evalConfigHash: string
): string {
  return createHash('sha256')
    .update(`${projectId}\0${baseCommit}\0${evalConfigHash}`)
    .digest('hex');
}

function baselineCachePath(
  dataDir: string,
  projectId: string,
  cacheKey: string
): string {
  return path.resolve(
    dataDir,
    'projects',
    projectId,
    'baseline-cache',
    `${cacheKey}.json`
  );
}

function baselineArtifactPath(artifactRoot: string): string {
  return path.join(artifactRoot, 'metrics', 'baseline.json');
}

function isBaselineGate(gate: EvalGate): boolean {
  const lower = `${gate.name} ${gate.command}`.toLowerCase();
  return (
    COMPARATIVE_GATE_TYPES.has(gate.type) ||
    lower.includes('coverage') ||
    lower.includes('coverage_percent')
  );
}

function collectBaseRedTests(gateRuns: readonly GateReportEntry[]): string[] {
  return gateRuns
    .filter((gate) => gate.status === 'fail' || gate.status === 'error')
    .map((gate) => gate.name)
    .sort();
}

async function writeBaselineArtifact(
  artifactRoot: string,
  report: BaselineReport
): Promise<string> {
  const filePath = baselineArtifactPath(artifactRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`);
  return filePath;
}

export async function captureBaseline(
  options: CaptureBaselineOptions
): Promise<BaselineReport> {
  const evalConfigHash = hashEvalConfig(options.evalConfig);
  const cacheKey = baselineCacheKey(
    options.projectId,
    options.baseCommit,
    evalConfigHash
  );
  const cachePath = baselineCachePath(
    options.dataDir,
    options.projectId,
    cacheKey
  );
  const cached = await readFile(cachePath, 'utf8').catch(() => undefined);
  if (cached && options.evalConfig.baseline?.mode !== 'per_loop') {
    const cachedReport = JSON.parse(cached) as BaselineReport;
    const report: BaselineReport = {
      ...cachedReport,
      cache_hit: true,
      // On a cache hit, generated_at means "this loop verified/reused the cached baseline at",
      // not "the baseline commands were re-executed at".
      generated_at: new Date().toISOString()
    };
    await writeBaselineArtifact(options.artifactRoot, report);
    return report;
  }

  const values = interpolationValues({
    taskFile:
      options.taskFile ?? path.join(options.artifactRoot, 'input', 'task.yaml'),
    baseCommit: options.baseCommit,
    loopId: options.loopId ?? 'baseline',
    worktreeRoot: options.worktreeRoot,
    artifactRoot: options.artifactRoot
  });
  const baselineGates = options.evalConfig.gates.filter(isBaselineGate);
  const stdoutByGate = new Map<string, string>();
  const gateRuns: GateReportEntry[] = [];
  await ensureStructuredMetricsDir(
    options.artifactRoot,
    BASELINE_METRICS_SCOPE
  );

  for (const gate of baselineGates) {
    const startedAt = new Date();
    const command = interpolate(
      gate.command,
      values,
      `baseline gate '${gate.name}' command`
    );
    const result = await runCommand(command, {
      cwd: options.worktreeRoot,
      env: {
        ...(options.env ?? process.env),
        [STRUCTURED_METRICS_ENV]: structuredMetricsPath(
          options.artifactRoot,
          BASELINE_METRICS_SCOPE,
          gate.name
        )
      },
      ...(gate.timeout_seconds
        ? { timeoutMs: gate.timeout_seconds * 1000 }
        : {})
    });
    const finishedAt = new Date();
    stdoutByGate.set(gate.name, result.stdout);
    gateRuns.push({
      name: gate.name,
      type: gate.type,
      required: gate.required,
      command,
      status: result.status,
      exit_code: result.exitCode,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      stdout_ref: null,
      stderr_ref: null,
      summary: result.timedOut
        ? 'baseline gate timed out'
        : `baseline gate ${result.status}`
    });
  }

  const { metrics } = await collectMetricsForGates({
    artifactRoot: options.artifactRoot,
    scope: BASELINE_METRICS_SCOPE,
    gates: gateRuns.map((gate) => ({
      name: gate.name,
      stdout: stdoutByGate.get(gate.name) ?? ''
    }))
  });

  const report: BaselineReport = {
    schema_version: '1.0',
    project: options.evalConfig.project,
    project_id: options.projectId,
    base_commit: options.baseCommit,
    eval_config_hash: evalConfigHash,
    cache_key: cacheKey,
    cache_hit: false,
    generated_at: new Date().toISOString(),
    gate_runs: gateRuns,
    base_red_tests: collectBaseRedTests(gateRuns),
    metrics
  };

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(report, null, 2)}\n`);
  await writeBaselineArtifact(options.artifactRoot, report);
  return report;
}

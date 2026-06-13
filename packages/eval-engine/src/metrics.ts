import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Metric collection trust model (N4):
 *
 * Project gate commands may emit metrics two ways. The structured channel is a
 * JSON file the harness designates via {@link STRUCTURED_METRICS_ENV}; the legacy
 * channel is regex-scraped from gate stdout. Structured values win per key and
 * stdout is only a fallback, so a candidate that prints a fake `coverage: 100`
 * line cannot override a structured metric.
 *
 * The structured file lives under the harness-controlled artifact root, outside
 * the worktree and the builder write_scope, so the builder agent cannot pre-seed
 * it and it never appears in the candidate diff. The file is still untrusted gate
 * output, so values pass schema validation (known key + finite number) before use.
 */

export const METRIC_KEYS = [
  'coverage_percent',
  'latency_ms',
  'security_findings',
  'critical_security_findings',
  'duplicate_score'
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export type BaselineMetrics = Partial<Record<MetricKey, number>>;

/** Env var naming the structured metrics JSON file a gate may write. */
export const STRUCTURED_METRICS_ENV = 'VIBELOOP_METRICS_FILE';

/** Artifact subdirectory for candidate gate metrics. */
export const CANDIDATE_METRICS_SCOPE = 'gates';
/** Artifact subdirectory for baseline gate metrics. */
export const BASELINE_METRICS_SCOPE = 'baseline-gates';

const STDOUT_ALIASES: Record<MetricKey, readonly string[]> = {
  coverage_percent: ['coverage', 'coverage_percent'],
  latency_ms: ['latency', 'latency_ms', 'p95_ms'],
  security_findings: ['security_findings', 'findings'],
  critical_security_findings: ['critical_security_findings', 'critical'],
  duplicate_score: ['duplicate_score', 'duplication', 'duplicates']
};

const KNOWN_METRIC_KEYS = new Set<string>(METRIC_KEYS);

export interface MetricRejection {
  gate?: string | undefined;
  key: string;
  reason: 'unknown-key' | 'non-finite' | 'not-an-object' | 'invalid-json';
}

function sanitizeGateName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, '_');
}

export function structuredMetricsRef(scope: string, gateName: string): string {
  return path.posix.join(
    'metrics',
    scope,
    `${sanitizeGateName(gateName)}.json`
  );
}

export function structuredMetricsPath(
  artifactRoot: string,
  scope: string,
  gateName: string
): string {
  return path.join(
    artifactRoot,
    'metrics',
    scope,
    `${sanitizeGateName(gateName)}.json`
  );
}

export async function ensureStructuredMetricsDir(
  artifactRoot: string,
  scope: string
): Promise<void> {
  await mkdir(path.join(artifactRoot, 'metrics', scope), { recursive: true });
}

function parseMetricFromStdout(
  stdout: string,
  names: readonly string[]
): number | undefined {
  for (const name of names) {
    const pattern = new RegExp(
      `${name}\\s*[:=]\\s*([0-9]+(?:\\.[0-9]+)?)`,
      'i'
    );
    const match = stdout.match(pattern);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return undefined;
}

export function collectStdoutMetrics(stdout: string): BaselineMetrics {
  const metrics: BaselineMetrics = {};
  for (const key of METRIC_KEYS) {
    const value = parseMetricFromStdout(stdout, STDOUT_ALIASES[key]);
    if (value !== undefined) {
      metrics[key] = value;
    }
  }
  return metrics;
}

export function validateStructuredMetrics(raw: unknown): {
  metrics: BaselineMetrics;
  rejected: MetricRejection[];
} {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { metrics: {}, rejected: [{ key: '*', reason: 'not-an-object' }] };
  }
  const metrics: BaselineMetrics = {};
  const rejected: MetricRejection[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_METRIC_KEYS.has(key)) {
      rejected.push({ key, reason: 'unknown-key' });
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      rejected.push({ key, reason: 'non-finite' });
      continue;
    }
    metrics[key as MetricKey] = value;
  }
  return { metrics, rejected };
}

export async function readStructuredMetricsFile(absPath: string): Promise<{
  metrics: BaselineMetrics;
  rejected: MetricRejection[];
}> {
  let raw: string;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch {
    // Absent file means the gate emitted no structured metrics.
    return { metrics: {}, rejected: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { metrics: {}, rejected: [{ key: '*', reason: 'invalid-json' }] };
  }
  return validateStructuredMetrics(parsed);
}

/** Returns a copy where keys present in `primary` override `fallback`. */
export function mergeMetrics(
  fallback: BaselineMetrics,
  primary: BaselineMetrics
): BaselineMetrics {
  const merged: BaselineMetrics = { ...fallback };
  for (const key of METRIC_KEYS) {
    const value = primary[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export interface GateMetricSource {
  name: string;
  stdout: string;
}

/**
 * Collects metrics across gates. Per gate, the structured file wins over stdout;
 * across gates, later gates override earlier ones (preserving prior behavior).
 */
export async function collectMetricsForGates(options: {
  artifactRoot: string;
  scope: string;
  gates: ReadonlyArray<GateMetricSource>;
}): Promise<{ metrics: BaselineMetrics; rejected: MetricRejection[] }> {
  let metrics: BaselineMetrics = {};
  const rejected: MetricRejection[] = [];
  for (const gate of options.gates) {
    const structured = await readStructuredMetricsFile(
      structuredMetricsPath(options.artifactRoot, options.scope, gate.name)
    );
    for (const rejection of structured.rejected) {
      rejected.push({ ...rejection, gate: gate.name });
    }
    const gateMetrics = mergeMetrics(
      collectStdoutMetrics(gate.stdout),
      structured.metrics
    );
    metrics = mergeMetrics(metrics, gateMetrics);
  }
  return { metrics, rejected };
}

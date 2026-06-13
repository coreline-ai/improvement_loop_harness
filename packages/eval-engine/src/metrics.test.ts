import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_METRICS_SCOPE,
  collectMetricsForGates,
  collectStdoutMetrics,
  mergeMetrics,
  readStructuredMetricsFile,
  structuredMetricsPath,
  validateStructuredMetrics
} from './metrics.js';

async function tempArtifactRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'vibeloop-metrics-'));
}

async function writeStructured(
  artifactRoot: string,
  gateName: string,
  body: string
): Promise<void> {
  const filePath = structuredMetricsPath(
    artifactRoot,
    CANDIDATE_METRICS_SCOPE,
    gateName
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
}

describe('collectStdoutMetrics', () => {
  it('parses known metric aliases from stdout', () => {
    expect(
      collectStdoutMetrics('coverage: 82.5\np95_ms = 120\nfindings: 3')
    ).toEqual({
      coverage_percent: 82.5,
      latency_ms: 120,
      security_findings: 3
    });
  });
});

describe('validateStructuredMetrics', () => {
  it('accepts known finite numbers and rejects unknown/non-finite values', () => {
    const result = validateStructuredMetrics({
      coverage_percent: 91,
      latency_ms: 'fast',
      duplicate_score: Number.POSITIVE_INFINITY,
      bogus: 5
    });
    expect(result.metrics).toEqual({ coverage_percent: 91 });
    expect(result.rejected).toEqual([
      { key: 'latency_ms', reason: 'non-finite' },
      { key: 'duplicate_score', reason: 'non-finite' },
      { key: 'bogus', reason: 'unknown-key' }
    ]);
  });

  it('rejects arrays and non-objects', () => {
    expect(validateStructuredMetrics([1, 2]).rejected).toEqual([
      { key: '*', reason: 'not-an-object' }
    ]);
    expect(validateStructuredMetrics(42).rejected).toEqual([
      { key: '*', reason: 'not-an-object' }
    ]);
  });
});

describe('mergeMetrics', () => {
  it('lets the primary source win per key', () => {
    expect(
      mergeMetrics(
        { coverage_percent: 50, latency_ms: 200 },
        { coverage_percent: 90 }
      )
    ).toEqual({ coverage_percent: 90, latency_ms: 200 });
  });
});

describe('readStructuredMetricsFile', () => {
  it('returns empty without rejections when the file is absent', async () => {
    const root = await tempArtifactRoot();
    await expect(
      readStructuredMetricsFile(
        structuredMetricsPath(root, CANDIDATE_METRICS_SCOPE, 'missing')
      )
    ).resolves.toEqual({ metrics: {}, rejected: [] });
  });

  it('flags malformed JSON', async () => {
    const root = await tempArtifactRoot();
    await writeStructured(root, 'broken', '{not json');
    const result = await readStructuredMetricsFile(
      structuredMetricsPath(root, CANDIDATE_METRICS_SCOPE, 'broken')
    );
    expect(result.metrics).toEqual({});
    expect(result.rejected).toEqual([{ key: '*', reason: 'invalid-json' }]);
  });
});

describe('collectMetricsForGates', () => {
  it('prefers structured metrics over stdout and ignores a spoofed stdout metric', async () => {
    const root = await tempArtifactRoot();
    await writeStructured(root, 'coverage', '{"coverage_percent": 88}');
    const { metrics } = await collectMetricsForGates({
      artifactRoot: root,
      scope: CANDIDATE_METRICS_SCOPE,
      gates: [{ name: 'coverage', stdout: 'coverage: 100' }]
    });
    expect(metrics).toEqual({ coverage_percent: 88 });
  });

  it('falls back to stdout when no structured file exists', async () => {
    const root = await tempArtifactRoot();
    const { metrics, rejected } = await collectMetricsForGates({
      artifactRoot: root,
      scope: CANDIDATE_METRICS_SCOPE,
      gates: [{ name: 'legacy', stdout: 'coverage: 73' }]
    });
    expect(metrics).toEqual({ coverage_percent: 73 });
    expect(rejected).toEqual([]);
  });

  it('does not turn invalid structured metrics into evidence and records rejections', async () => {
    const root = await tempArtifactRoot();
    await writeStructured(
      root,
      'bad',
      '{"coverage_percent": "NaN", "evil": 1}'
    );
    const { metrics, rejected } = await collectMetricsForGates({
      artifactRoot: root,
      scope: CANDIDATE_METRICS_SCOPE,
      gates: [{ name: 'bad', stdout: '' }]
    });
    expect(metrics).toEqual({});
    expect(rejected).toEqual([
      { gate: 'bad', key: 'coverage_percent', reason: 'non-finite' },
      { gate: 'bad', key: 'evil', reason: 'unknown-key' }
    ]);
  });

  it('lets a later gate override an earlier gate metric', async () => {
    const root = await tempArtifactRoot();
    const { metrics } = await collectMetricsForGates({
      artifactRoot: root,
      scope: CANDIDATE_METRICS_SCOPE,
      gates: [
        { name: 'first', stdout: 'coverage: 60' },
        { name: 'second', stdout: 'coverage: 95' }
      ]
    });
    expect(metrics).toEqual({ coverage_percent: 95 });
  });
});

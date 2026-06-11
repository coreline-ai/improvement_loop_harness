import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvalGate } from '@vibeloop/task-protocol';
import type { GateReport, GateReportEntry, GateStatus } from './types.js';

export function gateLogRefs(gateName: string): {
  stdoutRef: string;
  stderrRef: string;
} {
  const safeName = gateName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    stdoutRef: `logs/gates/${safeName}.stdout.log`,
    stderrRef: `logs/gates/${safeName}.stderr.log`
  };
}

export function gateLogPaths(
  artifactRoot: string,
  gateName: string
): {
  stdoutFile: string;
  stderrFile: string;
  stdoutRef: string;
  stderrRef: string;
} {
  const refs = gateLogRefs(gateName);
  return {
    ...refs,
    stdoutFile: path.join(artifactRoot, refs.stdoutRef),
    stderrFile: path.join(artifactRoot, refs.stderrRef)
  };
}

export function skippedGateResult(
  gate: EvalGate,
  summary: string
): GateReportEntry {
  return {
    name: gate.name,
    type: gate.type,
    required: gate.required,
    command: gate.command,
    status: 'skipped',
    exit_code: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    stdout_ref: null,
    stderr_ref: null,
    summary
  };
}

export function createGateResult(options: {
  gate: EvalGate;
  status: GateStatus;
  exitCode: number | null;
  startedAt: Date;
  finishedAt: Date;
  stdoutRef: string | null;
  stderrRef: string | null;
  summary: string | null;
}): GateReportEntry {
  return {
    name: options.gate.name,
    type: options.gate.type,
    required: options.gate.required,
    command: options.gate.command,
    status: options.status,
    exit_code: options.exitCode,
    started_at: options.startedAt.toISOString(),
    finished_at: options.finishedAt.toISOString(),
    duration_ms: options.finishedAt.getTime() - options.startedAt.getTime(),
    stdout_ref: options.stdoutRef,
    stderr_ref: options.stderrRef,
    summary: options.summary
  };
}

export function createGateReport(
  loopId: string,
  gates: GateReportEntry[],
  generatedAt = new Date()
): GateReport {
  return {
    schema_version: '1.0',
    generated_at: generatedAt.toISOString(),
    loop_id: loopId,
    gates
  };
}

export async function writeGateReport(
  artifactRoot: string,
  report: GateReport
): Promise<string> {
  const reportPath = path.join(artifactRoot, 'reports', 'gate-report.json');
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

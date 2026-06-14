import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactForLeak } from '@vibeloop/guards';
import { runCommand } from '@vibeloop/shared';
import type { EvalGate } from '@vibeloop/task-protocol';
import {
  interpolate,
  interpolateRecord,
  interpolationValues
} from './interpolate.js';
import { createGateResult, gateLogPaths } from './gate-report.js';
import {
  CANDIDATE_METRICS_SCOPE,
  ensureStructuredMetricsDir,
  structuredMetricsPath,
  STRUCTURED_METRICS_ENV
} from './metrics.js';
import type { GateReportEntry, GateRunContext } from './types.js';

function statusFromRunCommand(
  status: 'pass' | 'fail' | 'error'
): 'pass' | 'fail' | 'error' {
  return status;
}

export async function executeCommandGate(
  gate: EvalGate,
  context: GateRunContext
): Promise<GateReportEntry> {
  const startedAt = new Date();
  const values = interpolationValues(context);
  const command = interpolate(
    gate.command,
    values,
    `gate '${gate.name}' command`
  );
  const cwd = gate.cwd
    ? path.resolve(interpolate(gate.cwd, values, `gate '${gate.name}' cwd`))
    : context.worktreeRoot;
  const gateEnv = interpolateRecord(gate.env, values);
  const logPaths = gateLogPaths(context.artifactRoot, gate.name);

  // N4: hand the gate a harness-controlled structured metrics path (outside the
  // worktree/write_scope) so it can emit trustworthy metrics instead of stdout text.
  await ensureStructuredMetricsDir(
    context.artifactRoot,
    CANDIDATE_METRICS_SCOPE
  );
  const metricsFile = structuredMetricsPath(
    context.artifactRoot,
    CANDIDATE_METRICS_SCOPE,
    gate.name
  );

  // v2 redact-only: when opted in, capture gate stdout/stderr in memory (omit
  // the file targets so runCommand never writes raw output to disk), redact
  // forbidden literals / tokens, then persist the redacted logs. Gate pass/fail
  // (from exit code) is unaffected. Structured metrics use a separate JSON
  // channel; the stdout-regex fallback reads the (redacted) log but metric keys
  // never match leak patterns.
  const redactLogs =
    context.evalConfig.artifact_leak?.redact_gate_logs === true;
  const result = await runCommand(command, {
    cwd,
    env: {
      ...(context.env ?? process.env),
      [STRUCTURED_METRICS_ENV]: metricsFile,
      ...gateEnv
    },
    ...(gate.timeout_seconds ? { timeoutMs: gate.timeout_seconds * 1000 } : {}),
    ...(redactLogs
      ? {}
      : { stdoutFile: logPaths.stdoutFile, stderrFile: logPaths.stderrFile })
  });
  if (redactLogs) {
    const config = context.evalConfig.artifact_leak;
    await writeFile(logPaths.stdoutFile, redactForLeak(result.stdout, config));
    await writeFile(logPaths.stderrFile, redactForLeak(result.stderr, config));
  }
  const finishedAt = new Date();

  return createGateResult({
    gate: { ...gate, command },
    status: statusFromRunCommand(result.status),
    exitCode: result.exitCode,
    startedAt,
    finishedAt,
    stdoutRef: logPaths.stdoutRef,
    stderrRef: logPaths.stderrRef,
    summary: result.timedOut
      ? 'gate timed out'
      : result.status === 'pass'
        ? 'command exited 0'
        : `command exited ${result.exitCode ?? 'with error'}`
  });
}

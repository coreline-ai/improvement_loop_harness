import path from 'node:path';
import { runCommand } from '@vibeloop/shared';
import type { EvalGate } from '@vibeloop/task-protocol';
import {
  interpolate,
  interpolateRecord,
  interpolationValues
} from './interpolate.js';
import { createGateResult, gateLogPaths } from './gate-report.js';
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

  const result = await runCommand(command, {
    cwd,
    env: { ...(context.env ?? process.env), ...gateEnv },
    ...(gate.timeout_seconds ? { timeoutMs: gate.timeout_seconds * 1000 } : {}),
    stdoutFile: logPaths.stdoutFile,
    stderrFile: logPaths.stderrFile
  });
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

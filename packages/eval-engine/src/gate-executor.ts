import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactForLeak } from '@vibeloop/guards';
import {
  isContainerRuntimeAvailable,
  runCommand,
  runCommandInContainer,
  type RunCommandResult
} from '@vibeloop/shared';
import type { EvalGate, GateType } from '@vibeloop/task-protocol';
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

const PROJECT_COMMAND_GATE_TYPES = new Set<GateType>([
  'hard',
  'task_acceptance',
  'regression',
  'security',
  'performance',
  'hidden_acceptance'
]);

function statusFromRunCommand(
  status: 'pass' | 'fail' | 'error'
): 'pass' | 'fail' | 'error' {
  return status;
}

async function gateConfigError(
  gate: EvalGate,
  command: string,
  logPaths: ReturnType<typeof gateLogPaths>,
  startedAt: Date,
  message: string
): Promise<GateReportEntry> {
  const finishedAt = new Date();
  await writeFile(logPaths.stdoutFile, '');
  await writeFile(logPaths.stderrFile, `${message}\n`);
  return createGateResult({
    gate: { ...gate, command },
    status: 'error',
    exitCode: null,
    startedAt,
    finishedAt,
    stdoutRef: logPaths.stdoutRef,
    stderrRef: logPaths.stderrRef,
    summary: message
  });
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
  // Ensure the gate log dir exists for branches that write logs directly
  // (isolated / redact / config-error); the host runCommand path mkdirs itself.
  await mkdir(path.dirname(logPaths.stdoutFile), { recursive: true });

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

  const execution = context.evalConfig.execution;
  if (
    PROJECT_COMMAND_GATE_TYPES.has(gate.type) &&
    execution?.isolation === undefined
  ) {
    return gateConfigError(
      gate,
      command,
      logPaths,
      startedAt,
      'project command gates require explicit execution.isolation: container or none'
    );
  }
  const isolated = execution?.isolation === 'container';
  // v2 redact-only: when opted in, redact forbidden literals/tokens from the
  // persisted gate logs (no reject; gate pass/fail from exit code is unaffected).
  const redactLogs =
    context.evalConfig.artifact_leak?.redact_gate_logs === true;
  // Both isolation and redaction need the output in memory before persisting.
  const captureInMemory = isolated || redactLogs;
  const timeoutMs = gate.timeout_seconds
    ? gate.timeout_seconds * 1000
    : undefined;

  let result: RunCommandResult;
  if (isolated) {
    // R1: run the project command inside a throwaway, network-isolated
    // container. Mount the worktree and the structured-metrics dir at their SAME
    // absolute host paths so cwd, ${WORKTREE_ROOT}, and VIBELOOP_METRICS_FILE
    // resolve unchanged inside the container. Host PATH/env is NOT passed
    // through — the image provides the toolchain.
    if (!execution?.image) {
      return gateConfigError(
        gate,
        command,
        logPaths,
        startedAt,
        'execution.isolation=container requires execution.image'
      );
    }
    if (!(await isContainerRuntimeAvailable())) {
      return gateConfigError(
        gate,
        command,
        logPaths,
        startedAt,
        'execution.isolation=container requires an available container runtime'
      );
    }
    result = await runCommandInContainer(command, {
      image: execution.image,
      mounts: [
        {
          hostPath: context.worktreeRoot,
          containerPath: context.worktreeRoot
        },
        {
          hostPath: path.dirname(metricsFile),
          containerPath: path.dirname(metricsFile)
        }
      ],
      workdir: cwd,
      network: execution.network ?? 'none',
      env: { [STRUCTURED_METRICS_ENV]: metricsFile, ...gateEnv },
      signal: context.signal,
      ...(timeoutMs ? { timeoutMs } : {})
    });
  } else {
    result = await runCommand(command, {
      cwd,
      env: {
        ...(context.env ?? process.env),
        [STRUCTURED_METRICS_ENV]: metricsFile,
        ...gateEnv
      },
      signal: context.signal,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(captureInMemory
        ? {}
        : { stdoutFile: logPaths.stdoutFile, stderrFile: logPaths.stderrFile })
    });
  }
  if (captureInMemory) {
    const alConfig = context.evalConfig.artifact_leak;
    await writeFile(
      logPaths.stdoutFile,
      redactLogs ? redactForLeak(result.stdout, alConfig) : result.stdout
    );
    await writeFile(
      logPaths.stderrFile,
      redactLogs ? redactForLeak(result.stderr, alConfig) : result.stderr
    );
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

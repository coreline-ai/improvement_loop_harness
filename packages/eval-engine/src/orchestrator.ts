import type { EvalGate, GateType } from '@vibeloop/task-protocol';
import { executeBuiltinGate, isBuiltinGate } from './builtin.js';
import { executeCommandGate } from './gate-executor.js';
import {
  createGateReport,
  skippedGateResult,
  writeGateReport
} from './gate-report.js';
import type { GateReport, GateReportEntry, GateRunContext } from './types.js';

const GUARD_TYPES = new Set<GateType>(['scope', 'integrity']);
const PROJECT_COMMAND_TYPES = new Set<GateType>([
  'hard',
  'task_acceptance',
  'regression',
  'security',
  'performance'
]);

function isGuardGate(gate: EvalGate): boolean {
  return GUARD_TYPES.has(gate.type);
}

function isProjectCommandGate(gate: EvalGate): boolean {
  return PROJECT_COMMAND_TYPES.has(gate.type);
}

function shouldTriggerFailFast(
  gate: EvalGate,
  result: GateReportEntry
): boolean {
  return (
    gate.required && (result.status === 'fail' || result.status === 'error')
  );
}

export interface RunGatesResult {
  report: GateReport;
  reportPath: string;
}

export async function runGates(
  context: GateRunContext
): Promise<RunGatesResult> {
  const results: GateReportEntry[] = [];
  let skipAfterRequiredGuardFailure = false;
  let skipAfterRequiredProjectFailure = false;

  for (const gate of context.evalConfig.gates) {
    if (skipAfterRequiredGuardFailure) {
      results.push(
        skippedGateResult(gate, 'skipped after required guard failure')
      );
      continue;
    }

    if (
      skipAfterRequiredProjectFailure &&
      (isProjectCommandGate(gate) || gate.type === 'advisory')
    ) {
      results.push(
        skippedGateResult(gate, 'skipped after required project gate failure')
      );
      continue;
    }

    const result =
      isBuiltinGate(gate) || isGuardGate(gate)
        ? await executeBuiltinGate(gate, context)
        : await executeCommandGate(gate, context);
    results.push(result);

    if (isGuardGate(gate) && shouldTriggerFailFast(gate, result)) {
      skipAfterRequiredGuardFailure = true;
    } else if (
      isProjectCommandGate(gate) &&
      shouldTriggerFailFast(gate, result)
    ) {
      skipAfterRequiredProjectFailure = true;
    }
  }

  const report = createGateReport(context.loopId, results);
  const reportPath = await writeGateReport(context.artifactRoot, report);
  return { report, reportPath };
}

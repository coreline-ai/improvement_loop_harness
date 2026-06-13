import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  annotateScope,
  checkDiffScope,
  checkGitMetadataIntegrity,
  checkLimits,
  checkProtectedFiles,
  checkTestIntegrity,
  type GuardCheckResult
} from '@vibeloop/guards';
import { mergeLimits, type EvalGate } from '@vibeloop/task-protocol';
import { BuiltinGateError } from './errors.js';
import { createGateResult, gateLogPaths } from './gate-report.js';
import type { GateReportEntry, GateRunContext } from './types.js';

function builtinName(command: string): string {
  return command.startsWith('builtin:')
    ? command.slice('builtin:'.length)
    : command;
}

async function writeBuiltinLogs(
  context: GateRunContext,
  gate: EvalGate,
  result: GuardCheckResult
): Promise<{ stdoutRef: string; stderrRef: string }> {
  const logs = gateLogPaths(context.artifactRoot, gate.name);
  await mkdir(path.dirname(logs.stdoutFile), { recursive: true });
  await writeFile(logs.stdoutFile, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(logs.stderrFile, '');
  return { stdoutRef: logs.stdoutRef, stderrRef: logs.stderrRef };
}

async function runBuiltinCheck(
  gate: EvalGate,
  context: GateRunContext
): Promise<GuardCheckResult> {
  switch (builtinName(gate.command)) {
    case 'git-meta-integrity': {
      if (!context.gitMetadataBefore || !context.gitMetadataAfter) {
        throw new BuiltinGateError(
          'git-meta-integrity requires before and after git metadata snapshots'
        );
      }
      return checkGitMetadataIntegrity(
        context.gitMetadataBefore,
        context.gitMetadataAfter
      );
    }
    case 'protected-files':
      return checkProtectedFiles(
        context.changedFiles,
        context.evalConfig.protected_paths
      );
    case 'diff-scope':
      return checkDiffScope(
        annotateScope(context.changedFiles, {
          writeScope: context.task.write_scope,
          protectedPaths: context.evalConfig.protected_paths
        }),
        {
          writeScope: context.task.write_scope,
          protectedPaths: context.evalConfig.protected_paths
        }
      );
    case 'limits':
      return checkLimits(
        context.changedFiles,
        mergeLimits(context.task.limits, context.evalConfig.limits)
      );
    case 'test-integrity':
      return checkTestIntegrity(
        context.worktreeRoot,
        context.changedFiles,
        context.evalConfig.test_integrity ?? {},
        { baseCommit: context.baseCommit }
      );
    case 'artifact-leak':
      // Scan runs in the kernel (where agent stdout/stderr is available); this
      // gate only surfaces the precomputed verdict.
      return (
        context.artifactLeak ?? {
          status: 'pass',
          summary: 'artifact-leak not evaluated',
          violations: []
        }
      );
    default:
      throw new BuiltinGateError(
        `unsupported builtin gate command: ${gate.command}`
      );
  }
}

export function isBuiltinGate(gate: EvalGate): boolean {
  return gate.command.startsWith('builtin:');
}

export async function executeBuiltinGate(
  gate: EvalGate,
  context: GateRunContext
): Promise<GateReportEntry> {
  const startedAt = new Date();
  try {
    const result = await runBuiltinCheck(gate, context);
    const finishedAt = new Date();
    const refs = await writeBuiltinLogs(context, gate, result);
    return createGateResult({
      gate,
      status: result.status,
      exitCode: result.status === 'pass' ? 0 : 1,
      startedAt,
      finishedAt,
      stdoutRef: refs.stdoutRef,
      stderrRef: refs.stderrRef,
      summary: result.summary
    });
  } catch (error) {
    const finishedAt = new Date();
    const message = error instanceof Error ? error.message : String(error);
    const result: GuardCheckResult = {
      status: 'fail',
      code: 'BUILTIN_GATE_ERROR',
      summary: message,
      violations: [{ code: 'BUILTIN_GATE_ERROR', message }]
    };
    const refs = await writeBuiltinLogs(context, gate, result);
    return createGateResult({
      gate,
      status: 'error',
      exitCode: null,
      startedAt,
      finishedAt,
      stdoutRef: refs.stdoutRef,
      stderrRef: refs.stderrRef,
      summary: message
    });
  }
}

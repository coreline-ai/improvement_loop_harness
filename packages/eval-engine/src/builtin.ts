import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
    case 'artifact-leak': {
      // Scan runs in the kernel (where agent stdout/stderr is available); this
      // gate only surfaces the precomputed verdict.
      if (context.artifactLeak) {
        return context.artifactLeak;
      }
      // Fail closed: if artifact_leak is configured, a missing precomputed
      // result means the scan never reached this gate. Never silently pass — a
      // not-evaluated guard must not look like a clean guard (fail-open).
      if (context.evalConfig.artifact_leak) {
        throw new BuiltinGateError(
          'artifact_leak is configured but no precomputed scan result reached builtin:artifact-leak'
        );
      }
      // Not configured: there is nothing to scan; backward-compatible pass.
      return {
        status: 'pass',
        summary: 'artifact-leak not configured',
        violations: []
      };
    }
    case 'rulepack-lock':
      return checkRulepackLock(context);
    default:
      throw new BuiltinGateError(
        `unsupported builtin gate command: ${gate.command}`
      );
  }
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRule(value: unknown): value is { id: string; hash: string } {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.hash === 'string' &&
    value.hash.startsWith('sha256:')
  );
}

async function checkRulepackLock(
  context: GateRunContext
): Promise<GuardCheckResult> {
  const config = context.evalConfig.rulepack_lock;
  if (!config?.file) {
    throw new BuiltinGateError(
      'rulepack_lock config is required for builtin:rulepack-lock'
    );
  }
  const filePath = path.isAbsolute(config.file)
    ? config.file
    : path.resolve(context.worktreeRoot, config.file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'fail',
      code: 'RULEPACK_LOCK_UNREADABLE',
      summary: `rulepack lock unreadable: ${message}`,
      violations: [{ code: 'RULEPACK_LOCK_UNREADABLE', message }]
    };
  }

  const violations: Array<{ code: string; message: string }> = [];
  const record = isRecord(parsed) ? parsed : undefined;
  const requiredAuthority = config.required_authority ?? 'fixed_next_loop_gate';
  const requiredImpact = config.required_decision_impact ?? 'next_loop_only';
  if (!record) {
    violations.push({
      code: 'RULEPACK_LOCK_INVALID',
      message: 'not an object'
    });
  }
  if (record?.kind !== 'frozen_rulepack') {
    violations.push({
      code: 'RULEPACK_LOCK_KIND',
      message: 'kind must be frozen_rulepack'
    });
  }
  if (record?.authority !== requiredAuthority) {
    violations.push({
      code: 'RULEPACK_LOCK_AUTHORITY',
      message: `authority must be ${requiredAuthority}`
    });
  }
  if (record?.decision_impact !== requiredImpact) {
    violations.push({
      code: 'RULEPACK_LOCK_DECISION_IMPACT',
      message: `decision_impact must be ${requiredImpact}`
    });
  }
  const rules = Array.isArray(record?.rules) ? record.rules : [];
  const addedRules = Array.isArray(record?.added_rules)
    ? record.added_rules
    : [];
  if (rules.length === 0 || !rules.every(isRule)) {
    violations.push({
      code: 'RULEPACK_LOCK_RULES',
      message: 'rules must be non-empty sha256-hashed rules'
    });
  }
  if (addedRules.length === 0 || !addedRules.every(isRule)) {
    violations.push({
      code: 'RULEPACK_LOCK_ADDED_RULES',
      message: 'added_rules must be non-empty sha256-hashed rules'
    });
  }
  if (!isRecord(record?.diff) || record.diff.appendOnly !== true) {
    violations.push({
      code: 'RULEPACK_LOCK_NOT_APPEND_ONLY',
      message: 'diff.appendOnly must be true'
    });
  }
  if (!isRecord(record?.replay) || record.replay.replaySafe !== true) {
    violations.push({
      code: 'RULEPACK_LOCK_REPLAY_UNSAFE',
      message: 'replay.replaySafe must be true'
    });
  }
  if (
    typeof record?.lock_hash !== 'string' ||
    !record.lock_hash.startsWith('sha256:')
  ) {
    violations.push({
      code: 'RULEPACK_LOCK_HASH_MISSING',
      message: 'lock_hash must be a sha256 hash'
    });
  } else if (record) {
    const expected = sha256({
      source_candidate_ref: record.source_candidate_ref,
      source_replay_ref: record.source_replay_ref,
      rules: record.rules,
      added_rules: record.added_rules,
      diff: record.diff,
      replay: record.replay
    });
    if (record.lock_hash !== expected) {
      violations.push({
        code: 'RULEPACK_LOCK_HASH_MISMATCH',
        message: 'lock_hash does not match frozen rulepack content'
      });
    }
  }

  return violations.length === 0
    ? {
        status: 'pass',
        summary:
          'rulepack lock is frozen, append-only, replay-safe, and next-loop-only',
        violations: []
      }
    : {
        status: 'fail',
        code: 'RULEPACK_LOCK_INVALID',
        summary: `rulepack lock failed ${violations.length} check(s)`,
        violations
      };
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

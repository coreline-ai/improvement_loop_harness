import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanArtifactLeak, type ArtifactLeakConfig } from '@vibeloop/guards';
import {
  isContainerRuntimeAvailable,
  runCommandInContainer,
  type RunCommandResult
} from '@vibeloop/shared';
import {
  hashRuleSpec,
  normalizeRuleTargetPath,
  type RulepackRule,
  type RulepackRuleSpec
} from './rulepack-shadow.js';

export interface FrozenRulepackForRunner {
  kind: 'frozen_rulepack';
  authority: 'fixed_next_loop_gate';
  decision_impact: 'next_loop_only';
  source_loop_id?: string | undefined;
  rules: RulepackRule[];
  added_rules?: RulepackRule[] | undefined;
  diff?: { appendOnly?: boolean | undefined } | undefined;
  replay?: { replaySafe?: boolean | undefined } | undefined;
}

export interface RunFrozenRulepackOptions {
  worktreePath: string;
  image: string;
  network?: 'none' | 'default' | undefined;
  timeoutMs?: number | undefined;
  currentLoopId?: string | undefined;
  artifactLeak?: ArtifactLeakConfig | undefined;
  runtimeAvailable?: (() => Promise<boolean>) | undefined;
  commandRunner?:
    | ((
        command: string,
        options: {
          image: string;
          worktreePath: string;
          network: 'none' | 'default';
          timeoutMs?: number | undefined;
        }
      ) => Promise<Pick<RunCommandResult, 'status' | 'stdout' | 'stderr'>>)
    | undefined;
}

export interface RulepackSemanticResult {
  ruleId: string;
  status: 'pass' | 'fail' | 'error';
  expected: 'pass';
  actual: 'pass' | 'fail' | 'error';
  summary: string;
}

export interface RunFrozenRulepackResult {
  allPass: boolean;
  status: 'pass' | 'fail' | 'error';
  total: number;
  passed: number;
  results: RulepackSemanticResult[];
  errors: Array<{ code: string; message: string; ruleId?: string | undefined }>;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function executableRules(frozen: FrozenRulepackForRunner): RulepackRule[] {
  const addedIds = new Set((frozen.added_rules ?? []).map((rule) => rule.id));
  const candidates =
    addedIds.size > 0
      ? frozen.rules.filter((rule) => addedIds.has(rule.id))
      : frozen.rules;
  return candidates.filter((rule) => rule.spec);
}

function validateFrozenRulepack(
  frozen: FrozenRulepackForRunner,
  options: Pick<RunFrozenRulepackOptions, 'currentLoopId'>
): Array<{
  code: string;
  message: string;
}> {
  const errors: Array<{ code: string; message: string }> = [];
  if (frozen.kind !== 'frozen_rulepack') {
    errors.push({
      code: 'RULEPACK_KIND',
      message: 'kind must be frozen_rulepack'
    });
  }
  if (frozen.authority !== 'fixed_next_loop_gate') {
    errors.push({
      code: 'RULEPACK_AUTHORITY',
      message: 'authority must be fixed_next_loop_gate'
    });
  }
  if (frozen.decision_impact !== 'next_loop_only') {
    errors.push({
      code: 'RULEPACK_DECISION_IMPACT',
      message: 'decision_impact must be next_loop_only'
    });
  }
  if (frozen.diff?.appendOnly !== true) {
    errors.push({
      code: 'RULEPACK_NOT_APPEND_ONLY',
      message: 'diff.appendOnly must be true'
    });
  }
  if (frozen.replay?.replaySafe !== true) {
    errors.push({
      code: 'RULEPACK_REPLAY_UNSAFE',
      message: 'replay.replaySafe must be true'
    });
  }
  if (options.currentLoopId) {
    if (
      typeof frozen.source_loop_id !== 'string' ||
      frozen.source_loop_id.length === 0
    ) {
      errors.push({
        code: 'RULEPACK_SOURCE_LOOP_MISSING',
        message: 'source_loop_id is required for next-loop semantic execution'
      });
    } else if (frozen.source_loop_id === options.currentLoopId) {
      errors.push({
        code: 'RULEPACK_CURRENT_LOOP_APPLICATION',
        message: 'frozen rulepack cannot be applied to its source loop'
      });
    }
  }
  if (executableRules(frozen).length === 0) {
    errors.push({
      code: 'RULEPACK_NO_EXECUTABLE_RULES',
      message: 'at least one added rule must contain an executable spec'
    });
  }
  return errors;
}

async function withMaterializedRule<T>(
  worktreePath: string,
  spec: RulepackRuleSpec,
  fn: () => Promise<T>
): Promise<T> {
  const targetPath = path.resolve(
    worktreePath,
    normalizeRuleTargetPath(spec.target_path)
  );
  if (!isInside(path.resolve(worktreePath), targetPath)) {
    throw new Error(`rule target escapes worktree: ${spec.target_path}`);
  }

  let previous: string | null = null;
  try {
    previous = await readFile(targetPath, 'utf8');
  } catch {
    previous = null;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, spec.body);
  try {
    return await fn();
  } finally {
    if (previous === null) {
      await rm(targetPath, { force: true }).catch(() => undefined);
    } else {
      await writeFile(targetPath, previous);
    }
  }
}

async function defaultCommandRunner(
  command: string,
  options: {
    image: string;
    worktreePath: string;
    network: 'none' | 'default';
    timeoutMs?: number | undefined;
  }
): Promise<Pick<RunCommandResult, 'status' | 'stdout' | 'stderr'>> {
  return runCommandInContainer(command, {
    image: options.image,
    mounts: [
      {
        hostPath: options.worktreePath,
        containerPath: options.worktreePath,
        readonly: true
      }
    ],
    workdir: options.worktreePath,
    network: options.network,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  });
}

export async function runFrozenRulepack(
  frozen: FrozenRulepackForRunner,
  options: RunFrozenRulepackOptions
): Promise<RunFrozenRulepackResult> {
  const errors = validateFrozenRulepack(frozen, options);
  if (errors.length > 0) {
    return {
      allPass: false,
      status: 'error',
      total: 0,
      passed: 0,
      results: [],
      errors
    };
  }

  const runtimeAvailable = await (
    options.runtimeAvailable ?? isContainerRuntimeAvailable
  )();
  if (!runtimeAvailable) {
    return {
      allPass: false,
      status: 'error',
      total: 0,
      passed: 0,
      results: [],
      errors: [
        {
          code: 'CONTAINER_RUNTIME_UNAVAILABLE',
          message:
            'container runtime unavailable; rulepack semantic execution not performed'
        }
      ]
    };
  }

  const runner = options.commandRunner ?? defaultCommandRunner;
  const results: RulepackSemanticResult[] = [];
  const executionErrors: RunFrozenRulepackResult['errors'] = [];
  for (const rule of executableRules(frozen)) {
    if (!rule.spec || rule.hash !== hashRuleSpec(rule.spec)) {
      executionErrors.push({
        code: 'RULE_SPEC_HASH_MISMATCH',
        message: 'rule hash does not match executable spec',
        ruleId: rule.id
      });
      results.push({
        ruleId: rule.id,
        status: 'error',
        expected: 'pass',
        actual: 'error',
        summary: 'rule spec hash mismatch'
      });
      continue;
    }
    if (rule.spec.network !== 'none') {
      executionErrors.push({
        code: 'RULE_NETWORK_NOT_NONE',
        message: 'rule semantic execution requires network=none',
        ruleId: rule.id
      });
      results.push({
        ruleId: rule.id,
        status: 'error',
        expected: 'pass',
        actual: 'error',
        summary: 'rule requested network access'
      });
      continue;
    }
    const specLeak = scanArtifactLeak({
      stdout: rule.spec.body,
      config: options.artifactLeak
    });
    if (specLeak.result.status === 'fail') {
      executionErrors.push({
        code: 'RULE_SPEC_ARTIFACT_LEAK',
        message: specLeak.result.summary,
        ruleId: rule.id
      });
      results.push({
        ruleId: rule.id,
        status: 'error',
        expected: 'pass',
        actual: 'error',
        summary: 'rule spec failed artifact-leak scan'
      });
      continue;
    }

    const result = await withMaterializedRule(
      options.worktreePath,
      rule.spec,
      () =>
        runner(rule.spec!.command, {
          image: options.image,
          worktreePath: options.worktreePath,
          network: options.network ?? 'none',
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
        })
    );
    const outputLeak = scanArtifactLeak({
      stdout: result.stdout,
      stderr: result.stderr,
      config: options.artifactLeak
    });
    if (outputLeak.result.status === 'fail') {
      executionErrors.push({
        code: 'RULE_OUTPUT_ARTIFACT_LEAK',
        message: outputLeak.result.summary,
        ruleId: rule.id
      });
      results.push({
        ruleId: rule.id,
        status: 'error',
        expected: 'pass',
        actual: 'error',
        summary: 'rule output failed artifact-leak scan'
      });
      continue;
    }
    const actual = result.status;
    results.push({
      ruleId: rule.id,
      status: actual === 'pass' ? 'pass' : 'fail',
      expected: 'pass',
      actual,
      summary:
        actual === 'pass'
          ? 'semantic rule passed on candidate'
          : `semantic rule expected pass on candidate, got ${actual}`
    });
  }

  const passed = results.filter((result) => result.status === 'pass').length;
  const allPass =
    results.length > 0 &&
    passed === results.length &&
    executionErrors.length === 0;
  return {
    allPass,
    status: allPass ? 'pass' : executionErrors.length > 0 ? 'error' : 'fail',
    total: results.length,
    passed,
    results,
    errors: executionErrors
  };
}

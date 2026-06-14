import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { EvalConfigError } from './errors.js';
import { assertAllowedInterpolation } from './interpolation.js';
import { normalizePathList, normalizeRepoPath } from './paths.js';
import { EVAL_SCHEMA_ID, validateOrThrow } from './schema.js';
import type { EvalConfig, EvalGate, GateType } from './types.js';

const PROJECT_COMMAND_GATE_TYPES = new Set<GateType>([
  'hard',
  'task_acceptance',
  'regression',
  'security',
  'performance',
  'hidden_acceptance'
]);

const GUARD_GATE_TYPES = new Set<GateType>(['scope', 'integrity']);

export const BUILTIN_GUARD_COMMANDS = new Set([
  'git-meta-integrity',
  'protected-files',
  'diff-scope',
  'limits',
  'test-integrity',
  'artifact-leak',
  'rulepack-lock',
  'snapshot-delta'
]);

function assertGateOrder(gates: EvalGate[]): void {
  let projectCommandSeen = false;

  for (const gate of gates) {
    if (PROJECT_COMMAND_GATE_TYPES.has(gate.type)) {
      projectCommandSeen = true;
    }

    if (projectCommandSeen && GUARD_GATE_TYPES.has(gate.type)) {
      throw new EvalConfigError(
        `Guard gate '${gate.name}' (${gate.type}) must appear before project command gates`
      );
    }
  }
}

function assertBuiltinGuardCommand(gate: EvalGate): void {
  if (!GUARD_GATE_TYPES.has(gate.type)) {
    return;
  }

  if (!gate.command.startsWith('builtin:')) {
    throw new EvalConfigError(
      `Guard gate '${gate.name}' must use builtin:<guard-name> command`
    );
  }

  const builtinName = gate.command.slice('builtin:'.length);
  if (!BUILTIN_GUARD_COMMANDS.has(builtinName)) {
    throw new EvalConfigError(
      `Guard gate '${gate.name}' uses unsupported builtin guard: ${builtinName}`
    );
  }
}

function normalizeRiskClassification(
  riskClassification: Record<string, string[]> | undefined
): Record<string, string[]> | undefined {
  if (!riskClassification) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(riskClassification).map(([area, paths]) => [
      area,
      normalizePathList(paths, `risk_classification.${area}`) ?? []
    ])
  );
}

export async function loadEvalConfig(filePath: string): Promise<EvalConfig> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = YAML.parse(raw) as unknown;
  const config = validateOrThrow<EvalConfig>(EVAL_SCHEMA_ID, parsed, filePath);

  assertGateOrder(config.gates);
  for (const gate of config.gates) {
    assertBuiltinGuardCommand(gate);
    assertAllowedInterpolation(gate.command, `gate '${gate.name}' command`);
    if (gate.cwd) {
      assertAllowedInterpolation(gate.cwd, `gate '${gate.name}' cwd`);
    }
    for (const [envName, envValue] of Object.entries(gate.env ?? {})) {
      assertAllowedInterpolation(
        envValue,
        `gate '${gate.name}' env.${envName}`
      );
    }
  }

  const protectedPaths = normalizePathList(
    config.protected_paths,
    'protected_paths'
  );
  const riskClassification = normalizeRiskClassification(
    config.risk_classification
  );
  const hiddenAcceptance = config.hidden_acceptance
    ? {
        tests: config.hidden_acceptance.tests.map((test, index) => ({
          ...test,
          target_path: normalizeRepoPath(
            test.target_path,
            `hidden_acceptance.tests[${index}].target_path`
          )
        }))
      }
    : undefined;

  return {
    ...config,
    ...(protectedPaths ? { protected_paths: protectedPaths } : {}),
    ...(riskClassification ? { risk_classification: riskClassification } : {}),
    ...(hiddenAcceptance ? { hidden_acceptance: hiddenAcceptance } : {})
  };
}

import { EvalInterpolationError } from './errors.js';
import type { InterpolationValues } from './types.js';

export const EVAL_INTERPOLATION_VARIABLES = [
  'TASK_FILE',
  'BASE_COMMIT',
  'LOOP_ID',
  'WORKTREE_ROOT',
  'ARTIFACT_ROOT'
] as const;

const VARIABLE_PATTERN = /\$\{([A-Z0-9_]+)\}/g;
const ALLOWED = new Set<string>(EVAL_INTERPOLATION_VARIABLES);
const SHELL_META_PATTERN = /[;&|$`<>()\n\r]/;

export function findVariables(input: string): string[] {
  return [...input.matchAll(VARIABLE_PATTERN)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

export function assertAllowedVariables(
  input: string,
  context = 'command'
): void {
  const unknown = [
    ...new Set(findVariables(input).filter((name) => !ALLOWED.has(name)))
  ];
  if (unknown.length > 0) {
    throw new EvalInterpolationError(
      `${context} contains unsupported interpolation variable(s): ${unknown.join(', ')}`
    );
  }
}

export function interpolationValues(context: {
  taskFile: string;
  baseCommit: string;
  loopId: string;
  worktreeRoot: string;
  artifactRoot: string;
}): InterpolationValues {
  return {
    TASK_FILE: context.taskFile,
    BASE_COMMIT: context.baseCommit,
    LOOP_ID: context.loopId,
    WORKTREE_ROOT: context.worktreeRoot,
    ARTIFACT_ROOT: context.artifactRoot
  };
}

export function interpolate(
  input: string,
  values: InterpolationValues,
  context = 'command'
): string {
  assertAllowedVariables(input, context);
  const output = input.replace(
    VARIABLE_PATTERN,
    (placeholder, name: keyof InterpolationValues) => {
      const replacement = values[name] ?? placeholder;
      if (replacement !== placeholder && SHELL_META_PATTERN.test(replacement)) {
        throw new EvalInterpolationError(
          `${context} interpolation value ${name} contains shell metacharacters`
        );
      }
      return replacement;
    }
  );
  const residual = findVariables(output);
  if (residual.length > 0) {
    throw new EvalInterpolationError(
      `${context} left unresolved interpolation variable(s): ${[...new Set(residual)].join(', ')}`
    );
  }
  return output;
}

export function interpolateRecord(
  values: Record<string, string> | undefined,
  replacements: InterpolationValues
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    output[key] = interpolate(value, replacements, `env.${key}`);
  }
  return output;
}

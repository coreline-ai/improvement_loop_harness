import { InterpolationError } from './errors.js';

export const ALLOWED_INTERPOLATION_VARIABLES = new Set([
  'TASK_FILE',
  'BASE_COMMIT',
  'LOOP_ID',
  'WORKTREE_ROOT',
  'ARTIFACT_ROOT'
]);

const VARIABLE_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

export function findInterpolationVariables(input: string): string[] {
  return [...input.matchAll(VARIABLE_PATTERN)].map((match) => match[1]).filter((name): name is string => Boolean(name));
}

export function assertAllowedInterpolation(input: string, context = 'command'): void {
  const unknown = [...new Set(findInterpolationVariables(input).filter((name) => !ALLOWED_INTERPOLATION_VARIABLES.has(name)))];
  if (unknown.length > 0) {
    throw new InterpolationError(`${context} contains unsupported interpolation variable(s): ${unknown.join(', ')}`);
  }
}

export function interpolateCommand(input: string, values: Record<string, string>): string {
  assertAllowedInterpolation(input);
  return input.replace(VARIABLE_PATTERN, (placeholder, name: string) => values[name] ?? placeholder);
}

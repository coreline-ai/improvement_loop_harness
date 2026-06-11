import type {
  GuardChangedFile,
  GuardCheckResult,
  LimitsConfig
} from './types.js';

export function countChangedLines(
  changedFiles: readonly GuardChangedFile[]
): number {
  return changedFiles.reduce(
    (total, file) => total + file.addedLines + file.deletedLines,
    0
  );
}

export function checkLimits(
  changedFiles: readonly GuardChangedFile[],
  limits: LimitsConfig
): GuardCheckResult {
  const violations = [];
  if (
    limits.max_changed_files !== undefined &&
    changedFiles.length > limits.max_changed_files
  ) {
    violations.push({
      code: 'GUARD_LIMIT_EXCEEDED',
      message: `changed file count ${changedFiles.length} exceeds limit ${limits.max_changed_files}`
    });
  }

  const changedLines = countChangedLines(changedFiles);
  if (
    limits.max_changed_lines !== undefined &&
    changedLines > limits.max_changed_lines
  ) {
    violations.push({
      code: 'GUARD_LIMIT_EXCEEDED',
      message: `changed line count ${changedLines} exceeds limit ${limits.max_changed_lines}`
    });
  }

  return violations.length === 0
    ? {
        status: 'pass',
        summary: `changed files=${changedFiles.length}, changed lines=${changedLines}`,
        violations: []
      }
    : {
        status: 'fail',
        code: 'GUARD_LIMIT_EXCEEDED',
        summary: `${violations.length} limit violation(s)`,
        violations
      };
}

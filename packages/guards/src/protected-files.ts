import { pathMatchesAny } from './path-match.js';
import type { GuardChangedFile, GuardCheckResult } from './types.js';

export const DEFAULT_PROTECTED_PATHS = [
  '.env',
  '.env.*',
  'eval.yaml',
  'scripts/eval.sh',
  '.github/workflows/',
  'SECURITY.md'
] as const;

export function isProtectedPath(
  filePath: string,
  protectedPaths: readonly string[] = DEFAULT_PROTECTED_PATHS
): boolean {
  return pathMatchesAny(filePath, protectedPaths);
}

export function checkProtectedFiles(
  changedFiles: readonly GuardChangedFile[],
  protectedPaths: readonly string[] = DEFAULT_PROTECTED_PATHS
): GuardCheckResult {
  const violations = changedFiles
    .filter(
      (file) =>
        isProtectedPath(file.path, protectedPaths) ||
        (file.oldPath ? isProtectedPath(file.oldPath, protectedPaths) : false)
    )
    .map((file) => ({
      code: 'GUARD_PROTECTED_PATH',
      path: file.path,
      message: `protected path changed: ${file.path}`
    }));

  return violations.length === 0
    ? { status: 'pass', summary: 'no protected files changed', violations: [] }
    : {
        status: 'fail',
        code: 'GUARD_PROTECTED_PATH',
        summary: `${violations.length} protected path change(s)`,
        violations
      };
}

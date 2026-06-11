import { isProtectedPath, DEFAULT_PROTECTED_PATHS } from './protected-files.js';
import { pathMatchesAny } from './path-match.js';
import type {
  GuardChangedFile,
  GuardCheckResult,
  WriteScope
} from './types.js';

export interface DiffScopeOptions {
  writeScope: WriteScope;
  protectedPaths?: string[] | undefined;
}

function classifyScopeViolation(
  file: GuardChangedFile,
  options: DiffScopeOptions
): { code: string; message: string } | undefined {
  const protectedPaths = options.protectedPaths ?? [...DEFAULT_PROTECTED_PATHS];
  if (
    isProtectedPath(file.path, protectedPaths) ||
    (file.oldPath ? isProtectedPath(file.oldPath, protectedPaths) : false)
  ) {
    return {
      code: 'GUARD_PROTECTED_PATH',
      message: `protected path changed: ${file.path}`
    };
  }
  if (file.isSymlink) {
    return {
      code: 'GUARD_SYMLINK_CHANGED',
      message: `symlink change is not allowed: ${file.path}`
    };
  }
  if (
    pathMatchesAny(file.path, options.writeScope.forbidden) ||
    (file.oldPath
      ? pathMatchesAny(file.oldPath, options.writeScope.forbidden)
      : false)
  ) {
    return {
      code: 'GUARD_FORBIDDEN_PATH',
      message: `forbidden path changed: ${file.path}`
    };
  }
  if (!pathMatchesAny(file.path, options.writeScope.allowed)) {
    return {
      code: 'GUARD_SCOPE_VIOLATION',
      message: `path outside write_scope.allowed: ${file.path}`
    };
  }
  if (
    file.oldPath &&
    !pathMatchesAny(file.oldPath, options.writeScope.allowed)
  ) {
    return {
      code: 'GUARD_SCOPE_VIOLATION',
      message: `rename source outside write_scope.allowed: ${file.oldPath}`
    };
  }
  return undefined;
}

export function annotateScope(
  changedFiles: readonly GuardChangedFile[],
  options: DiffScopeOptions
): GuardChangedFile[] {
  const protectedPaths = options.protectedPaths ?? [...DEFAULT_PROTECTED_PATHS];
  return changedFiles.map((file) => ({
    ...file,
    protected:
      isProtectedPath(file.path, protectedPaths) ||
      (file.oldPath ? isProtectedPath(file.oldPath, protectedPaths) : false),
    allowedByWriteScope:
      pathMatchesAny(file.path, options.writeScope.allowed) &&
      (!file.oldPath ||
        pathMatchesAny(file.oldPath, options.writeScope.allowed))
  }));
}

export function checkDiffScope(
  changedFiles: readonly GuardChangedFile[],
  options: DiffScopeOptions
): GuardCheckResult {
  const violations = changedFiles.flatMap((file) => {
    const violation = classifyScopeViolation(file, options);
    return violation ? [{ ...violation, path: file.path }] : [];
  });

  return violations.length === 0
    ? {
        status: 'pass',
        summary: 'all changed files are inside write scope',
        violations: []
      }
    : {
        status: 'fail',
        code: violations[0]?.code,
        summary: `${violations.length} scope violation(s)`,
        violations
      };
}

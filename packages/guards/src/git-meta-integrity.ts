import {
  diffGitMetadataSnapshots,
  type GitMetadataSnapshot
} from '@vibeloop/workspace-runner';
import type { GuardCheckResult } from './types.js';

export function checkGitMetadataIntegrity(
  before: GitMetadataSnapshot,
  after: GitMetadataSnapshot
): GuardCheckResult {
  const diff = diffGitMetadataSnapshots(before, after);
  const violations = [
    ...diff.added.map((entryPath) => ({
      code: 'GUARD_GIT_META_TAMPER',
      path: entryPath,
      message: `git metadata added: ${entryPath}`
    })),
    ...diff.removed.map((entryPath) => ({
      code: 'GUARD_GIT_META_TAMPER',
      path: entryPath,
      message: `git metadata removed: ${entryPath}`
    })),
    ...diff.changed.map((entryPath) => ({
      code: 'GUARD_GIT_META_TAMPER',
      path: entryPath,
      message: `git metadata changed: ${entryPath}`
    }))
  ];

  return violations.length === 0
    ? { status: 'pass', summary: 'git metadata unchanged', violations: [] }
    : {
        status: 'fail',
        code: 'GUARD_GIT_META_TAMPER',
        summary: `${violations.length} git metadata change(s)`,
        violations
      };
}

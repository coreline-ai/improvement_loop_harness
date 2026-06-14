import { safeGit, worktreeStatus } from '@vibeloop/workspace-runner';

export interface PromoteSelectedPatchOptions {
  repoPath: string;
  baseCommit: string;
  branchName: string;
  patchPath: string;
  commitMessage: string;
  timeoutMs?: number | undefined;
}

export interface PromotionResult {
  branch_name: string;
  head_sha: string;
  base_commit: string;
  patch_path: string;
  pushed: false;
}

export interface PromotionBranchResult {
  branch_name: string;
  head_sha: string;
  base_commit: string;
  pushed: false;
}

export interface CheckoutPromotionBranchOptions {
  repoPath: string;
  branchName: string;
  baseCommit?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface CommitSelectedPatchOptions {
  repoPath: string;
  patchPath: string;
  commitMessage: string;
  timeoutMs?: number | undefined;
}

export function sanitizePromotionBranch(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[/.-]+|[/.-]+$/g, '')
    .slice(0, 120);
  return sanitized.length > 0 ? sanitized : 'pr-candidate/vibeloop';
}

async function assertClean(repoPath: string, timeoutMs: number): Promise<void> {
  const status = await worktreeStatus(repoPath, { timeoutMs });
  if (status.dirty) {
    throw new Error(
      `Cannot promote selected patch into a branch while source repo is dirty (${status.entries.length} change(s)). Commit/stash first.`
    );
  }
}

export async function checkoutPromotionBranch(
  options: CheckoutPromotionBranchOptions
): Promise<PromotionBranchResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  await assertClean(options.repoPath, timeoutMs);
  const baseCommit =
    options.baseCommit ??
    (
      await safeGit(options.repoPath, ['rev-parse', 'HEAD'], { timeoutMs })
    ).stdout.trim();
  const branchName = sanitizePromotionBranch(options.branchName);
  await safeGit(
    options.repoPath,
    ['checkout', '-B', branchName, baseCommit],
    { timeoutMs }
  );
  const headSha = (
    await safeGit(options.repoPath, ['rev-parse', 'HEAD'], { timeoutMs })
  ).stdout.trim();
  return {
    branch_name: branchName,
    head_sha: headSha,
    base_commit: baseCommit,
    pushed: false
  };
}

export async function commitSelectedPatchOnCurrentBranch(
  options: CommitSelectedPatchOptions
): Promise<PromotionResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  await assertClean(options.repoPath, timeoutMs);
  const branchName = (
    await safeGit(options.repoPath, ['branch', '--show-current'], { timeoutMs })
  ).stdout.trim();
  const baseCommit = (
    await safeGit(options.repoPath, ['rev-parse', 'HEAD'], { timeoutMs })
  ).stdout.trim();
  await safeGit(options.repoPath, ['apply', '--index', options.patchPath], {
    timeoutMs
  });
  await safeGit(options.repoPath, ['commit', '-m', options.commitMessage], {
    timeoutMs
  });
  const headSha = (
    await safeGit(options.repoPath, ['rev-parse', 'HEAD'], { timeoutMs })
  ).stdout.trim();
  return {
    branch_name: branchName,
    head_sha: headSha,
    base_commit: baseCommit,
    patch_path: options.patchPath,
    pushed: false
  };
}

/**
 * Core local PR-candidate branch promotion.
 *
 * This intentionally creates only a local branch+commit. It does not push, open a
 * PR, merge, or relax any verifier decision. Callers should invoke it only after
 * `runImprovementLoop` returned a selected candidate (already accept ∧ qualified
 * ∧ final reverify/provenance passed). A dirty source worktree is refused so the
 * promotion cannot accidentally mix user edits with the verified candidate patch.
 */
export async function promoteSelectedPatch(
  options: PromoteSelectedPatchOptions
): Promise<PromotionResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  await checkoutPromotionBranch({
    repoPath: options.repoPath,
    branchName: options.branchName,
    baseCommit: options.baseCommit,
    timeoutMs
  });
  return commitSelectedPatchOnCurrentBranch({
    repoPath: options.repoPath,
    patchPath: options.patchPath,
    commitMessage: options.commitMessage,
    timeoutMs
  });
}

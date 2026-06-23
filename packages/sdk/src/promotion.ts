import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  buildPullRequestBody,
  createDraftPullRequest,
  deleteRemoteBranch,
  parseGitHubRepo,
  prepareBranchAndPush,
  type EvalReportSummaryInput,
  type SelectionEvidenceSummaryInput
} from '@vibeloop/github-integration';
import { scanPatchForLeak, type ArtifactLeakConfig } from '@vibeloop/guards';
import { safeGit, worktreeStatus } from '@vibeloop/workspace-runner';
import type { AdversaryReviewReport } from './adversary-review.js';

export interface PromoteSelectedPatchOptions {
  repoPath: string;
  baseCommit: string;
  branchName: string;
  patchPath: string;
  expectedPatchHash?: string | undefined;
  artifactLeak?: ArtifactLeakConfig | undefined;
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

export interface PublishDraftPrOptions {
  repoPath: string;
  baseRef: string;
  branchName: string;
  patchPath: string;
  expectedPatchHash?: string | undefined;
  artifactLeak?: ArtifactLeakConfig | undefined;
  commitMessage: string;
  githubRepo: string;
  token: string;
  title: string;
  pushUrl?: string | undefined;
  body?: string | undefined;
  report?: EvalReportSummaryInput | undefined;
  selectionEvidence?: SelectionEvidenceSummaryInput | undefined;
  adversaryReview?: AdversaryReviewReport | undefined;
  apiBaseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface DraftPrPromotionResult {
  branch_name: string;
  head_sha: string;
  base_ref: string;
  patch_path: string;
  pushed: true;
  github_repo: string;
  pr_url: string;
  pr_number: number;
  pr_reused: boolean;
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
  expectedPatchHash?: string | undefined;
  artifactLeak?: ArtifactLeakConfig | undefined;
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

async function assertPatchHash(
  patchPath: string,
  expectedPatchHash: string | undefined
): Promise<void> {
  if (!expectedPatchHash) return;
  const actual = createHash('sha256')
    .update(await readFile(patchPath))
    .digest('hex');
  if (actual !== expectedPatchHash) {
    throw new Error(
      `candidate patch hash mismatch before promotion: expected ${expectedPatchHash}, got ${actual}`
    );
  }
}

async function assertPatchLeakClean(
  patchPath: string,
  artifactLeak: ArtifactLeakConfig | undefined
): Promise<void> {
  if (artifactLeak?.scan_patch !== true) return;
  const scan = scanPatchForLeak(await readFile(patchPath, 'utf8'), artifactLeak);
  if (scan.result.status === 'fail') {
    throw new Error(
      `candidate patch failed artifact-leak rescan before promotion: ${scan.result.summary}`
    );
  }
}

async function assertPromotionPatchSafe(options: {
  patchPath: string;
  expectedPatchHash?: string | undefined;
  artifactLeak?: ArtifactLeakConfig | undefined;
}): Promise<void> {
  await assertPatchHash(options.patchPath, options.expectedPatchHash);
  await assertPatchLeakClean(options.patchPath, options.artifactLeak);
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
  await safeGit(options.repoPath, ['checkout', '-B', branchName, baseCommit], {
    timeoutMs
  });
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
  await assertPromotionPatchSafe({
    patchPath: options.patchPath,
    expectedPatchHash: options.expectedPatchHash,
    artifactLeak: options.artifactLeak
  });
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
  await assertPromotionPatchSafe({
    patchPath: options.patchPath,
    expectedPatchHash: options.expectedPatchHash,
    artifactLeak: options.artifactLeak
  });
  await checkoutPromotionBranch({
    repoPath: options.repoPath,
    branchName: options.branchName,
    baseCommit: options.baseCommit,
    timeoutMs
  });
  return commitSelectedPatchOnCurrentBranch({
    repoPath: options.repoPath,
    patchPath: options.patchPath,
    expectedPatchHash: options.expectedPatchHash,
    artifactLeak: options.artifactLeak,
    commitMessage: options.commitMessage,
    timeoutMs
  });
}

/**
 * Core GitHub draft-PR promotion.
 *
 * This publishes only a verified selected patch supplied by the caller. It never
 * runs builders, never overrides selection, and never merges. The remote branch
 * is created from `baseRef`, the selected patch is applied as one commit, and a
 * draft PR is opened or reused.
 */
export async function publishSelectedPatchDraftPr(
  options: PublishDraftPrOptions
): Promise<DraftPrPromotionResult> {
  const repo = parseGitHubRepo(options.githubRepo);
  if (!repo) {
    throw new Error(
      `--github-repo must be owner/repo or a github.com URL: ${options.githubRepo}`
    );
  }
  const branchName = sanitizePromotionBranch(options.branchName);
  const pushUrl =
    options.pushUrl ?? `https://github.com/${repo.owner}/${repo.repo}.git`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  await assertPromotionPatchSafe({
    patchPath: options.patchPath,
    expectedPatchHash: options.expectedPatchHash,
    artifactLeak: options.artifactLeak
  });
  const originalRef = await safeGit(
    options.repoPath,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    { timeoutMs }
  )
    .then((result) => result.stdout.trim())
    .catch(async () =>
      (
        await safeGit(options.repoPath, ['rev-parse', 'HEAD'], { timeoutMs })
      ).stdout.trim()
    );
  try {
    const branch = await prepareBranchAndPush({
      repoPath: options.repoPath,
      baseRef: options.baseRef,
      branchName,
      candidatePatchPath: options.patchPath,
      expectedPatchHash: options.expectedPatchHash,
      commitMessage: options.commitMessage,
      pushUrl,
      token: options.token,
      timeoutMs
    });
    const body =
      options.body ??
      buildPullRequestBody(options.report ?? {}, {
        adversaryReview: options.adversaryReview ?? null,
        selectionEvidence: options.selectionEvidence ?? null
      });
    let pr: Awaited<ReturnType<typeof createDraftPullRequest>>;
    try {
      pr = await createDraftPullRequest({
        owner: repo.owner,
        repo: repo.repo,
        token: options.token,
        headBranch: branch.branchName,
        baseBranch: options.baseRef,
        title: options.title,
        body,
        apiBaseUrl: options.apiBaseUrl
      });
    } catch (error) {
      if (!branch.remotePreexisting) {
        await deleteRemoteBranch({
          repoPath: options.repoPath,
          pushUrl,
          branchName: branch.branchName,
          token: options.token,
          timeoutMs
        }).catch(() => undefined);
      }
      throw error;
    }
    return {
      branch_name: branch.branchName,
      head_sha: branch.headSha,
      base_ref: options.baseRef,
      patch_path: options.patchPath,
      pushed: true,
      github_repo: `${repo.owner}/${repo.repo}`,
      pr_url: pr.url,
      pr_number: pr.number,
      pr_reused: pr.reused
    };
  } finally {
    await safeGit(options.repoPath, ['checkout', originalRef], {
      timeoutMs
    }).catch(() => undefined);
  }
}

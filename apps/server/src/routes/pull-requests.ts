import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  buildPullRequestBody,
  createDraftPullRequest,
  defaultBranchName,
  parseGitHubRepo,
  prepareBranchAndPush
} from '@vibeloop/github-integration';
import type { FastifyInstance } from 'fastify';
import { ApiError, requireRecord } from '../errors.js';
import type { EvalReportRecord, LoopRunRecord, ProjectRecord, PullRequestRecord, Store, TaskRecord } from '../types.js';

export interface PullRequestCreationContext {
  loop: LoopRunRecord;
  task: TaskRecord;
  project: ProjectRecord;
  report: EvalReportRecord | null;
  branchName: string;
  title: string;
}

export interface CreatedPullRequest {
  branchName: string;
  prUrl: string;
  prNumber: number;
}

export interface PullRequestManager {
  create(context: PullRequestCreationContext): Promise<CreatedPullRequest>;
}

export class GitHubPullRequestManager implements PullRequestManager {
  async create(context: PullRequestCreationContext): Promise<CreatedPullRequest> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN is required for GitHub draft PR creation');
    }
    if (!context.project.localPath) {
      throw new Error('project.localPath is required for branch creation');
    }
    if (!context.loop.artifactRoot) {
      throw new Error('loop.artifactRoot is required to locate patches/candidate.patch');
    }

    const repoUrl = context.project.repoUrl;
    const repoRef = repoUrl ? parseGitHubRepo(repoUrl) : null;
    if (!repoRef || !repoUrl) {
      throw new Error('project.repoUrl must point to a GitHub repository');
    }

    const candidatePatchPath = path.join(context.loop.artifactRoot, 'patches', 'candidate.patch');
    const patchStat = await stat(candidatePatchPath).catch(() => null);
    if (!patchStat?.isFile()) {
      throw new Error('candidate patch artifact is missing: patches/candidate.patch');
    }

    const remoteUrl = repoUrl.replace(/\.git$/, '.git');
    await prepareBranchAndPush({
      repoPath: context.project.localPath,
      baseRef: context.project.defaultBranch,
      branchName: context.branchName,
      candidatePatchPath,
      commitMessage: context.title,
      pushUrl: remoteUrl,
      token
    });

    const reportJson = (context.report?.reportJson ?? {}) as Record<string, unknown>;
    const result = await createDraftPullRequest({
      owner: repoRef.owner,
      repo: repoRef.repo,
      token,
      headBranch: context.branchName,
      baseBranch: context.project.defaultBranch,
      title: context.title,
      body: buildPullRequestBody(reportJson)
    });

    return { branchName: context.branchName, prUrl: result.url, prNumber: result.number };
  }
}

const ALLOWED_LOOP_STATUSES = new Set(['accepted', 'approved']);
const FORBIDDEN_LOOP_STATUSES = new Set(['rejected', 'cancelled', 'failed', 'needs_more_tests', 'needs_human_review']);

function prTitle(task: TaskRecord, loop: LoopRunRecord): string {
  return `VibeLoop: ${task.title} (${loop.id})`;
}

function latestReport(reports: EvalReportRecord[]): EvalReportRecord | null {
  return [...reports].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

function assertPrAllowed(loop: LoopRunRecord): void {
  if (ALLOWED_LOOP_STATUSES.has(loop.status)) return;
  if (FORBIDDEN_LOOP_STATUSES.has(loop.status)) {
    throw new ApiError(403, 'PR_FORBIDDEN_FOR_LOOP_STATUS', `pull request creation is not allowed from ${loop.status}`);
  }
  throw new ApiError(403, 'PR_FORBIDDEN_FOR_LOOP_STATUS', `pull request creation requires accepted or approved loop, got ${loop.status}`);
}

async function loadContext(store: Store, loopId: string): Promise<PullRequestCreationContext> {
  const loop = requireRecord(await store.getLoop(loopId), 'LOOP_NOT_FOUND', 'loop not found');
  assertPrAllowed(loop);
  const task = requireRecord(await store.getTask(loop.taskId), 'TASK_NOT_FOUND', 'task not found');
  const project = requireRecord(await store.getProject(task.projectId), 'PROJECT_NOT_FOUND', 'project not found');
  return {
    loop,
    task,
    project,
    report: latestReport(await store.listReports(loop.id)),
    branchName: defaultBranchName(loop.id),
    title: prTitle(task, loop)
  };
}

export async function createPullRequestForLoop(
  store: Store,
  manager: PullRequestManager,
  loopId: string
): Promise<PullRequestRecord> {
  const context = await loadContext(store, loopId);
  const existing = await store.getPullRequest(context.loop.id);
  if (existing?.status === 'draft_created') {
    return existing;
  }
  if (existing?.status === 'creating') {
    throw new ApiError(409, 'PULL_REQUEST_CREATING', 'pull request creation is already in progress');
  }

  const record = existing
    ? requireRecord(
        await store.updatePullRequest(existing.id, { status: 'creating', branchName: context.branchName }),
        'PULL_REQUEST_NOT_FOUND',
        'pull request not found'
      )
    : await store.createPullRequest({
        loopRunId: context.loop.id,
        branchName: context.branchName,
        status: 'creating'
      });

  try {
    const created = await manager.create(context);
    const updated = requireRecord(
      await store.updatePullRequest(record.id, {
        branchName: created.branchName,
        prUrl: created.prUrl,
        prNumber: created.prNumber,
        status: 'draft_created'
      }),
      'PULL_REQUEST_NOT_FOUND',
      'pull request not found'
    );
    await store.addLoopEvent(context.loop.id, 'pr.created', {
      pull_request_id: updated.id,
      pr_number: updated.prNumber,
      pr_url: updated.prUrl
    });
    return updated;
  } catch (error) {
    const failed = requireRecord(
      await store.updatePullRequest(record.id, { status: 'create_failed' }),
      'PULL_REQUEST_NOT_FOUND',
      'pull request not found'
    );
    await store.addLoopEvent(context.loop.id, 'pr.create_failed', {
      pull_request_id: failed.id,
      reason: error instanceof Error ? error.message : String(error)
    });
    throw new ApiError(502, 'PULL_REQUEST_CREATE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export async function registerPullRequestRoutes(
  app: FastifyInstance,
  store: Store,
  manager: PullRequestManager = new GitHubPullRequestManager()
): Promise<void> {
  app.get('/api/loops/:loopId/pull-request', async (request) => {
    const params = request.params as { loopId: string };
    requireRecord(await store.getLoop(params.loopId), 'LOOP_NOT_FOUND', 'loop not found');
    return requireRecord(await store.getPullRequest(params.loopId), 'PULL_REQUEST_NOT_FOUND', 'pull request not found');
  });

  app.post('/api/loops/:loopId/pull-request', async (request) => {
    const params = request.params as { loopId: string };
    return createPullRequestForLoop(store, manager, params.loopId);
  });
}

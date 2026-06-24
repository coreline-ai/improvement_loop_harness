import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  buildPullRequestBody,
  createDraftPullRequest,
  defaultBranchName,
  parseGitHubRepo,
  prepareBranchAndPush
} from '@vibeloop/github-integration';
import { isPrCandidate } from '@vibeloop/sdk';
import type { FastifyInstance } from 'fastify';
import { ApiError, requireRecord } from '../errors.js';
import type {
  EvalReportRecord,
  LoopRunRecord,
  ProjectRecord,
  PullRequestRecord,
  Store,
  TaskRecord
} from '../types.js';

export interface PullRequestCreationContext {
  loop: LoopRunRecord;
  task: TaskRecord;
  project: ProjectRecord;
  report: EvalReportRecord | null;
  branchName: string;
  title: string;
  candidatePatchHash: string;
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
  async create(
    context: PullRequestCreationContext
  ): Promise<CreatedPullRequest> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN is required for GitHub draft PR creation');
    }
    if (!context.project.localPath) {
      throw new Error('project.localPath is required for branch creation');
    }
    if (!context.loop.artifactRoot) {
      throw new Error(
        'loop.artifactRoot is required to locate patches/candidate.patch'
      );
    }

    const repoUrl = context.project.repoUrl;
    const repoRef = repoUrl ? parseGitHubRepo(repoUrl) : null;
    if (!repoRef || !repoUrl) {
      throw new Error('project.repoUrl must point to a GitHub repository');
    }

    const candidatePatchPath = path.join(
      context.loop.artifactRoot,
      'patches',
      'candidate.patch'
    );
    const patchStat = await stat(candidatePatchPath).catch(() => null);
    if (!patchStat?.isFile()) {
      throw new Error(
        'candidate patch artifact is missing: patches/candidate.patch'
      );
    }

    const remoteUrl = repoUrl.replace(/\.git$/, '.git');
    await prepareBranchAndPush({
      repoPath: context.project.localPath,
      baseRef: context.project.defaultBranch,
      branchName: context.branchName,
      candidatePatchPath,
      expectedPatchHash: context.candidatePatchHash,
      commitMessage: context.title,
      pushUrl: remoteUrl,
      token
    });

    const reportJson = (context.report?.reportJson ?? {}) as Record<
      string,
      unknown
    >;
    const result = await createDraftPullRequest({
      owner: repoRef.owner,
      repo: repoRef.repo,
      token,
      headBranch: context.branchName,
      baseBranch: context.project.defaultBranch,
      title: context.title,
      body: buildPullRequestBody(reportJson)
    });

    return {
      branchName: context.branchName,
      prUrl: result.url,
      prNumber: result.number
    };
  }
}

const ALLOWED_LOOP_STATUSES = new Set(['accepted', 'approved']);
const FORBIDDEN_LOOP_STATUSES = new Set([
  'rejected',
  'cancelled',
  'failed',
  'needs_more_tests',
  'needs_human_review'
]);
const SHA256_RE = /^[a-f0-9]{64}$/;

function prTitle(task: TaskRecord, loop: LoopRunRecord): string {
  return `VibeLoop: ${task.title} (${loop.id})`;
}

function latestReport(reports: EvalReportRecord[]): EvalReportRecord | null {
  return (
    [...reports].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    )[0] ?? null
  );
}

function assertPrAllowed(loop: LoopRunRecord): void {
  if (ALLOWED_LOOP_STATUSES.has(loop.status)) return;
  if (FORBIDDEN_LOOP_STATUSES.has(loop.status)) {
    throw new ApiError(
      403,
      'PR_FORBIDDEN_FOR_LOOP_STATUS',
      `pull request creation is not allowed from ${loop.status}`
    );
  }
  throw new ApiError(
    403,
    'PR_FORBIDDEN_FOR_LOOP_STATUS',
    `pull request creation requires accepted or approved loop, got ${loop.status}`
  );
}

function trustFloorError(message: string): ApiError {
  return new ApiError(403, 'PR_FORBIDDEN_TRUST_FLOOR', message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasAllPassDecision(reportJson: Record<string, unknown>): boolean {
  const reasons = Array.isArray(reportJson.decision_reasons)
    ? reportJson.decision_reasons
    : [];
  const hasAllPass = reasons.some(
    (reason) => asRecord(reason)?.code === 'ALL_PASS'
  );
  const gates = Array.isArray(reportJson.gate_runs) ? reportJson.gate_runs : [];
  const requiredGatesPassed = gates.every((gate) => {
    const entry = asRecord(gate);
    return entry?.required !== true || entry.status === 'pass';
  });
  return hasAllPass && requiredGatesPassed;
}

async function readJsonRecord(
  filePath: string
): Promise<Record<string, unknown> | null> {
  const raw = await readFile(filePath, 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function resolveEvidencePath(
  artifactRoot: string,
  evidencePath: unknown
): string | null {
  if (typeof evidencePath !== 'string' || evidencePath.trim().length === 0) {
    return null;
  }
  if (path.isAbsolute(evidencePath)) return evidencePath;

  const root = path.resolve(artifactRoot);
  const resolved = path.resolve(root, evidencePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return resolved;
}

function artifactRootForReport(reportPath: string): string | null {
  const reportsDir = path.dirname(reportPath);
  if (path.basename(reportsDir) !== 'reports') return null;
  return path.dirname(reportsDir);
}

async function qualifiedFromArtifacts(
  artifactRoot: string,
  reportJson: Record<string, unknown>
): Promise<boolean | null> {
  if (typeof reportJson.qualified === 'boolean') {
    return reportJson.qualified;
  }
  const embeddedQuality = asRecord(reportJson.quality);
  if (typeof embeddedQuality?.met === 'boolean') {
    return embeddedQuality.met;
  }
  const qualityReport = await readJsonRecord(
    path.join(artifactRoot, 'reports', 'quality-report.json')
  );
  if (typeof qualityReport?.met === 'boolean') {
    return qualityReport.met;
  }
  return null;
}

async function assertFinalReverifyEvidence(
  loop: LoopRunRecord,
  finalVerification: Record<string, unknown>
): Promise<void> {
  if (finalVerification.reverify_attempted !== true) {
    throw trustFloorError(
      'final verification must re-execute the selected patch before PR creation'
    );
  }
  if (finalVerification.reverified !== true) {
    throw trustFloorError(
      'final verification must complete fresh re-execution before PR creation'
    );
  }
  if (finalVerification.reverify_qualified !== true) {
    throw trustFloorError(
      'final verification quality gate must pass before PR creation'
    );
  }

  const reverifyReportPath = resolveEvidencePath(
    loop.artifactRoot!,
    finalVerification.reverify_report
  );
  if (!reverifyReportPath) {
    throw trustFloorError(
      'final reverify report is required before PR creation'
    );
  }
  const reverifyStat = await stat(reverifyReportPath).catch(() => null);
  if (!reverifyStat?.isFile()) {
    throw trustFloorError(
      'final reverify report artifact is missing before PR creation'
    );
  }
  const reverifyReport = await readJsonRecord(reverifyReportPath);
  if (!reverifyReport) {
    throw trustFloorError('final reverify report JSON must be an object');
  }
  const reverifyProvenance = asRecord(reverifyReport.provenance);
  const expectedPatchHash =
    typeof finalVerification.candidate_patch_hash === 'string'
      ? finalVerification.candidate_patch_hash
      : null;
  const reverifyPatchHash =
    typeof reverifyProvenance?.candidate_patch_hash === 'string'
      ? reverifyProvenance.candidate_patch_hash
      : null;
  if (
    !expectedPatchHash ||
    !SHA256_RE.test(expectedPatchHash) ||
    reverifyPatchHash !== expectedPatchHash
  ) {
    throw trustFloorError(
      'final reverify report patch hash must match selected candidate provenance'
    );
  }
  if (
    reverifyReport.decision !== 'accept' ||
    !hasAllPassDecision(reverifyReport)
  ) {
    throw trustFloorError(
      'final reverify report must independently accept the selected patch'
    );
  }

  const reverifyArtifactRoot = artifactRootForReport(reverifyReportPath);
  const reverifyQualified = reverifyArtifactRoot
    ? await qualifiedFromArtifacts(reverifyArtifactRoot, reverifyReport)
    : null;
  if (reverifyQualified !== true) {
    throw trustFloorError(
      'final reverify report quality evidence must pass before PR creation'
    );
  }
}

function reportPatchHash(
  reportJson: Record<string, unknown>,
  finalVerification: Record<string, unknown> | null
): string | null {
  const provenance = asRecord(reportJson.provenance);
  const provenanceHash =
    typeof provenance?.candidate_patch_hash === 'string'
      ? provenance.candidate_patch_hash
      : null;
  const finalHash =
    typeof finalVerification?.candidate_patch_hash === 'string'
      ? finalVerification.candidate_patch_hash
      : null;
  if (provenanceHash && finalHash && provenanceHash !== finalHash) {
    throw trustFloorError(
      'final verification patch hash does not match eval report provenance'
    );
  }
  const hash = finalHash ?? provenanceHash;
  if (!hash) return null;
  if (!SHA256_RE.test(hash)) {
    throw trustFloorError('candidate patch hash is missing or malformed');
  }
  return hash;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function assertServerPrTrustFloor(
  loop: LoopRunRecord,
  report: EvalReportRecord | null
): Promise<string> {
  if (!loop.artifactRoot) {
    throw trustFloorError(
      'loop.artifactRoot is required for PR candidate verification'
    );
  }
  if (!report) {
    throw trustFloorError(
      'eval report is required for PR candidate verification'
    );
  }
  const reportJson = asRecord(report.reportJson);
  if (!reportJson) {
    throw trustFloorError('eval report JSON must be an object');
  }

  const trustSummary = asRecord(reportJson.trust_summary);
  if (trustSummary?.provenance_verified !== true) {
    throw trustFloorError(
      'eval report provenance must be verified before PR creation'
    );
  }

  const qualified = await qualifiedFromArtifacts(loop.artifactRoot, reportJson);
  const finalVerification = asRecord(
    reportJson.final_verification ?? reportJson.finalVerification
  );
  if (!finalVerification) {
    throw trustFloorError(
      'final verification is required before PR creation'
    );
  }
  if (finalVerification.provenance_ok !== true) {
    throw trustFloorError(
      'final verification provenance must pass before PR creation'
    );
  }
  await assertFinalReverifyEvidence(loop, finalVerification);

  const evidence = {
    decision:
      typeof reportJson.decision === 'string' ? reportJson.decision : null,
    allPass: hasAllPassDecision(reportJson),
    qualified,
    selected: true,
    finalVerification: {
      passed: finalVerification.passed === true,
      reverified: finalVerification.reverified === true
    }
  };
  if (!isPrCandidate(evidence)) {
    throw trustFloorError(
      'loop evidence does not satisfy the SDK PR candidate contract'
    );
  }

  const expectedPatchHash = reportPatchHash(reportJson, finalVerification);
  if (!expectedPatchHash) {
    throw trustFloorError(
      'candidate patch hash is required before PR creation'
    );
  }
  const candidatePatchPath = path.join(
    loop.artifactRoot,
    'patches',
    'candidate.patch'
  );
  const patchStat = await stat(candidatePatchPath).catch(() => null);
  if (!patchStat?.isFile()) {
    throw trustFloorError(
      'candidate patch artifact is missing: patches/candidate.patch'
    );
  }
  const actualPatchHash = await sha256File(candidatePatchPath);
  if (actualPatchHash !== expectedPatchHash) {
    throw trustFloorError(
      'candidate patch artifact does not match report provenance hash'
    );
  }
  return expectedPatchHash;
}

async function loadContext(
  store: Store,
  loopId: string
): Promise<PullRequestCreationContext> {
  const loop = requireRecord(
    await store.getLoop(loopId),
    'LOOP_NOT_FOUND',
    'loop not found'
  );
  assertPrAllowed(loop);
  const task = requireRecord(
    await store.getTask(loop.taskId),
    'TASK_NOT_FOUND',
    'task not found'
  );
  const project = requireRecord(
    await store.getProject(task.projectId),
    'PROJECT_NOT_FOUND',
    'project not found'
  );
  const report = latestReport(await store.listReports(loop.id));
  const candidatePatchHash = await assertServerPrTrustFloor(loop, report);
  return {
    loop,
    task,
    project,
    report,
    branchName: defaultBranchName(loop.id),
    title: prTitle(task, loop),
    candidatePatchHash
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
    throw new ApiError(
      409,
      'PULL_REQUEST_CREATING',
      'pull request creation is already in progress'
    );
  }

  const record = existing
    ? requireRecord(
        await store.updatePullRequest(existing.id, {
          status: 'creating',
          branchName: context.branchName
        }),
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
    throw new ApiError(
      502,
      'PULL_REQUEST_CREATE_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function registerPullRequestRoutes(
  app: FastifyInstance,
  store: Store,
  manager: PullRequestManager = new GitHubPullRequestManager()
): Promise<void> {
  app.get('/api/loops/:loopId/pull-request', async (request) => {
    const params = request.params as { loopId: string };
    requireRecord(
      await store.getLoop(params.loopId),
      'LOOP_NOT_FOUND',
      'loop not found'
    );
    return requireRecord(
      await store.getPullRequest(params.loopId),
      'PULL_REQUEST_NOT_FOUND',
      'pull request not found'
    );
  });

  app.post('/api/loops/:loopId/pull-request', async (request) => {
    const params = request.params as { loopId: string };
    return createPullRequestForLoop(store, manager, params.loopId);
  });
}

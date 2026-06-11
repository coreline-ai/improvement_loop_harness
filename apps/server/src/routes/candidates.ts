import path from 'node:path';
import {
  candidateFingerprint,
  discoverCandidates,
  generateTaskFromCandidate,
  type CandidateSource,
  type DiscoveryCandidate,
  type StructuredLocation
} from '@vibeloop/discovery';
import { loadEvalConfig, type EvalConfig } from '@vibeloop/task-protocol';
import type { FastifyInstance } from 'fastify';
import { ApiError, requireRecord } from '../errors.js';
import type { ImprovementCandidateRecord, ProjectRecord, Store } from '../types.js';

const DEFAULT_MAX_PROPOSED = 50;
const VALID_SOURCES = new Set<CandidateSource>(['test_failure', 'typecheck', 'lint', 'security_scan', 'manual']);

function errorCodeForSource(source: CandidateSource): string {
  switch (source) {
    case 'test_failure':
      return 'TEST_FAILURE';
    case 'typecheck':
      return 'TYPECHECK_FAILURE';
    case 'lint':
      return 'LINT_FAILURE';
    case 'security_scan':
      return 'SECURITY_SCAN_FAILURE';
    case 'manual':
      return 'MANUAL_CANDIDATE';
  }
}

function locationFromRecord(candidate: ImprovementCandidateRecord): StructuredLocation {
  const [prefix] = candidate.title.split(':');
  return {
    filePath: prefix && prefix !== candidate.title ? prefix : 'project',
    errorCode: errorCodeForSource(candidate.source as CandidateSource)
  };
}

function candidateFromRecord(candidate: ImprovementCandidateRecord): DiscoveryCandidate {
  return {
    id: candidate.id,
    projectId: candidate.projectId,
    source: candidate.source as CandidateSource,
    fingerprint: candidate.fingerprint,
    title: candidate.title,
    evidenceRefs: Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs.filter((entry): entry is string => typeof entry === 'string') : [],
    riskAreaHint: candidate.riskAreaHint,
    priority: candidate.priority,
    status: candidate.status as DiscoveryCandidate['status'],
    location: locationFromRecord(candidate)
  };
}

async function loadProjectEvalConfig(project: ProjectRecord): Promise<EvalConfig | undefined> {
  if (!project.localPath) return undefined;
  return loadEvalConfig(path.join(project.localPath, project.evalConfigPath)).catch(() => undefined);
}

async function createCandidateIfNew(store: Store, input: DiscoveryCandidate & { projectId: string }): Promise<ImprovementCandidateRecord> {
  const existing = await store.findCandidateByFingerprint(input.projectId, input.fingerprint);
  if (existing) return existing;
  return store.createCandidate({
    projectId: input.projectId,
    source: input.source,
    fingerprint: input.fingerprint,
    title: input.title,
    evidenceRefs: input.evidenceRefs,
    riskAreaHint: input.riskAreaHint ?? null,
    priority: input.priority,
    status: input.status
  });
}

function manualCandidate(projectId: string, body: Record<string, unknown>): DiscoveryCandidate & { projectId: string } {
  const filePath = typeof body.filePath === 'string' && body.filePath.trim() ? body.filePath.trim() : 'project';
  const requestedSource = typeof body.source === 'string' ? (body.source as CandidateSource) : 'manual';
  const source = VALID_SOURCES.has(requestedSource) ? requestedSource : 'manual';
  const location: StructuredLocation = {
    filePath,
    errorCode: typeof body.errorCode === 'string' && body.errorCode.trim() ? body.errorCode.trim() : errorCodeForSource(source)
  };
  const fingerprint = candidateFingerprint(source, location);
  return {
    projectId,
    source,
    fingerprint,
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : `${filePath}: manual ${location.errorCode}`,
    evidenceRefs: [],
    riskAreaHint: typeof body.riskAreaHint === 'string' ? body.riskAreaHint : null,
    priority: typeof body.priority === 'number' ? body.priority : 60,
    status: 'proposed',
    location
  };
}

export async function registerCandidateRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.get('/api/projects/:projectId/candidates', async (request) => {
    const params = request.params as { projectId: string };
    requireRecord(await store.getProject(params.projectId), 'PROJECT_NOT_FOUND', 'project not found');
    return store.listCandidates(params.projectId);
  });

  app.post('/api/projects/:projectId/candidates', async (request) => {
    const params = request.params as { projectId: string };
    requireRecord(await store.getProject(params.projectId), 'PROJECT_NOT_FOUND', 'project not found');
    const body = (request.body ?? {}) as Record<string, unknown>;
    return createCandidateIfNew(store, manualCandidate(params.projectId, body));
  });

  app.post('/api/projects/:projectId/discovery/run', async (request) => {
    const params = request.params as { projectId: string };
    const project = requireRecord(await store.getProject(params.projectId), 'PROJECT_NOT_FOUND', 'project not found');
    if (!project.localPath) {
      throw new ApiError(400, 'PROJECT_LOCAL_PATH_REQUIRED', 'project.localPath is required for discovery');
    }
    const evalConfig = await loadProjectEvalConfig(project);
    if (!evalConfig) {
      throw new ApiError(400, 'EVAL_CONFIG_NOT_FOUND', 'eval config could not be loaded');
    }
    const existing = await store.listCandidates(project.id);
    const proposedCount = existing.filter((candidate) => candidate.status === 'proposed').length;
    const remaining = Math.max(0, DEFAULT_MAX_PROPOSED - proposedCount);
    if (remaining === 0) return [];
    const discovered = await discoverCandidates({
      repoPath: project.localPath,
      evalConfig,
      existingFingerprints: existing.map((candidate) => candidate.fingerprint),
      maxProposed: remaining
    });
    return Promise.all(discovered.map((candidate) => createCandidateIfNew(store, { ...candidate, projectId: project.id })));
  });

  app.post('/api/candidates/:candidateId/approve', async (request) => {
    const params = request.params as { candidateId: string };
    const candidate = requireRecord(await store.getCandidate(params.candidateId), 'CANDIDATE_NOT_FOUND', 'candidate not found');
    const project = requireRecord(await store.getProject(candidate.projectId), 'PROJECT_NOT_FOUND', 'project not found');
    if (candidate.status === 'dismissed') {
      throw new ApiError(409, 'CANDIDATE_DISMISSED', 'dismissed candidate cannot be approved');
    }
    if (candidate.taskId) {
      return requireRecord(await store.updateCandidate(candidate.id, { status: 'approved' }), 'CANDIDATE_NOT_FOUND', 'candidate not found');
    }
    const evalConfig = await loadProjectEvalConfig(project);
    const generated = generateTaskFromCandidate(candidateFromRecord(candidate), {
      evalConfig,
      baseBranch: project.defaultBranch
    });
    const task = await store.createTask({
      projectId: project.id,
      title: generated.task.title,
      objective: generated.task.objective,
      status: 'draft',
      riskArea: generated.riskArea,
      writeScope: generated.writeScope,
      acceptance: generated.task.acceptance ?? null,
      taskYaml: generated.task
    });
    return requireRecord(
      await store.updateCandidate(candidate.id, { status: 'approved', taskId: task.id }),
      'CANDIDATE_NOT_FOUND',
      'candidate not found'
    );
  });

  app.post('/api/candidates/:candidateId/dismiss', async (request) => {
    const params = request.params as { candidateId: string };
    const candidate = requireRecord(await store.getCandidate(params.candidateId), 'CANDIDATE_NOT_FOUND', 'candidate not found');
    const body = (request.body ?? {}) as Record<string, unknown>;
    return requireRecord(
      await store.updateCandidate(candidate.id, {
        status: 'dismissed',
        dismissReason: typeof body.reason === 'string' ? body.reason : 'dismissed'
      }),
      'CANDIDATE_NOT_FOUND',
      'candidate not found'
    );
  });
}

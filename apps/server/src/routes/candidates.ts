import {
  candidateFingerprint,
  discoverCandidates,
  injectionIndicatorsForText,
  trustLevelForSource,
  type CandidateSource,
  type DiscoveryCandidate,
  type StructuredLocation
} from '@vibeloop/discovery';
import type { FastifyInstance } from 'fastify';
import { ApiError, requireRecord } from '../errors.js';
import { approveCandidate, errorCodeForSource, loadProjectEvalConfig } from '../candidate-service.js';
import type { ImprovementCandidateRecord, Store } from '../types.js';

const DEFAULT_MAX_PROPOSED = 50;
const VALID_SOURCES = new Set<CandidateSource>(['test_failure', 'typecheck', 'lint', 'security_scan', 'manual']);

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
    trustLevel: input.trustLevel ?? trustLevelForSource(input.source),
    injectionIndicators: input.injectionIndicators ?? [],
    reproCommand: input.reproCommand ?? null,
    priority: input.priority,
    status: input.status
  });
}

function manualCandidate(projectId: string, body: Record<string, unknown>): DiscoveryCandidate & { projectId: string } {
  const filePath = typeof body.filePath === 'string' && body.filePath.trim() ? body.filePath.trim() : 'project';
  const requestedSource = typeof body.source === 'string' ? (body.source as CandidateSource) : 'manual';
  const source = VALID_SOURCES.has(requestedSource) ? requestedSource : 'manual';
  const rawText = [body.title, body.errorCode, body.filePath, body.reproCommand].filter((value): value is string => typeof value === 'string').join('\n');
  const indicators = injectionIndicatorsForText(rawText);
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
    riskAreaHint: indicators.length > 0 ? 'prompt_injection' : typeof body.riskAreaHint === 'string' ? body.riskAreaHint : null,
    trustLevel: trustLevelForSource(source),
    injectionIndicators: indicators,
    reproCommand: typeof body.reproCommand === 'string' ? body.reproCommand : null,
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
    return approveCandidate(store, params.candidateId);
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

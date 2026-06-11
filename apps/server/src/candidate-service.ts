import path from 'node:path';
import {
  generateTaskFromCandidate,
  type CandidateSource,
  type DiscoveryCandidate,
  type StructuredLocation
} from '@vibeloop/discovery';
import { loadEvalConfig, type EvalConfig } from '@vibeloop/task-protocol';
import { ApiError, requireRecord } from './errors.js';
import type { ImprovementCandidateRecord, ProjectRecord, Store } from './types.js';

export function errorCodeForSource(source: CandidateSource): string {
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

export function locationFromRecord(candidate: ImprovementCandidateRecord): StructuredLocation {
  const [prefix] = candidate.title.split(':');
  return {
    filePath: prefix && prefix !== candidate.title ? prefix : 'project',
    errorCode: errorCodeForSource(candidate.source as CandidateSource)
  };
}

export function candidateFromRecord(candidate: ImprovementCandidateRecord): DiscoveryCandidate {
  return {
    id: candidate.id,
    projectId: candidate.projectId,
    source: candidate.source as CandidateSource,
    fingerprint: candidate.fingerprint,
    title: candidate.title,
    evidenceRefs: Array.isArray(candidate.evidenceRefs)
      ? candidate.evidenceRefs.filter((entry): entry is string => typeof entry === 'string')
      : [],
    riskAreaHint: candidate.riskAreaHint,
    priority: candidate.priority,
    status: candidate.status as DiscoveryCandidate['status'],
    location: locationFromRecord(candidate)
  };
}

export async function loadProjectEvalConfig(project: ProjectRecord): Promise<EvalConfig | undefined> {
  if (!project.localPath) return undefined;
  return loadEvalConfig(path.join(project.localPath, project.evalConfigPath)).catch(() => undefined);
}

export async function approveCandidate(store: Store, candidateId: string, status = 'approved'): Promise<ImprovementCandidateRecord> {
  const candidate = requireRecord(await store.getCandidate(candidateId), 'CANDIDATE_NOT_FOUND', 'candidate not found');
  const project = requireRecord(await store.getProject(candidate.projectId), 'PROJECT_NOT_FOUND', 'project not found');
  if (candidate.status === 'dismissed') {
    throw new ApiError(409, 'CANDIDATE_DISMISSED', 'dismissed candidate cannot be approved');
  }
  if (candidate.taskId) {
    return requireRecord(await store.updateCandidate(candidate.id, { status }), 'CANDIDATE_NOT_FOUND', 'candidate not found');
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
    await store.updateCandidate(candidate.id, { status, taskId: task.id }),
    'CANDIDATE_NOT_FOUND',
    'candidate not found'
  );
}

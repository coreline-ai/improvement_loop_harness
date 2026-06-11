import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ApiError, requireRecord } from '../errors.js';
import type { Store } from '../types.js';

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveArtifactPath(root: string, artifactPath: string): Promise<string | null> {
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return null;
  const target = path.resolve(rootReal, artifactPath);
  const targetReal = await realpath(target).catch(() => null);
  if (!targetReal || !isInside(rootReal, targetReal)) return null;
  return targetReal;
}

export async function registerArtifactRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.get('/api/loops/:loopId/reports', async (request) => {
    const params = request.params as { loopId: string };
    requireRecord(await store.getLoop(params.loopId), 'LOOP_NOT_FOUND', 'loop not found');
    return store.listReports(params.loopId);
  });

  app.get('/api/reports/:reportId', async (request) => {
    const params = request.params as { reportId: string };
    return requireRecord(await store.getReport(params.reportId), 'REPORT_NOT_FOUND', 'report not found');
  });

  app.get('/api/loops/:loopId/artifacts', async (request) => {
    const params = request.params as { loopId: string };
    requireRecord(await store.getLoop(params.loopId), 'LOOP_NOT_FOUND', 'loop not found');
    return store.listArtifacts(params.loopId);
  });

  app.get('/api/loops/:loopId/artifacts/*', async (request, reply) => {
    const params = request.params as { loopId: string; '*': string };
    const loop = requireRecord(await store.getLoop(params.loopId), 'LOOP_NOT_FOUND', 'loop not found');
    if (!loop.artifactRoot) {
      throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'artifact root is not available');
    }
    const resolved = await resolveArtifactPath(loop.artifactRoot, params['*']);
    if (!resolved) {
      throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'artifact not found');
    }
    const fileStat = await stat(resolved).catch(() => null);
    if (!fileStat?.isFile()) {
      throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'artifact not found');
    }
    return reply.type('application/octet-stream').send(await readFile(resolved));
  });
}

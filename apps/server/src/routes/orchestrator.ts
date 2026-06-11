import type { FastifyInstance } from 'fastify';
import { ApiError, requireRecord } from '../errors.js';
import type { OrchestratorMode, Store, UpsertOrchestratorStateInput } from '../types.js';
import type { LoopOrchestratorScheduler } from '../orchestrator/scheduler.js';

const MODES = new Set<OrchestratorMode>(['supervised', 'auto']);

function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function startOptions(body: Record<string, unknown>): UpsertOrchestratorStateInput {
  const mode = typeof body.mode === 'string' && MODES.has(body.mode as OrchestratorMode)
    ? (body.mode as OrchestratorMode)
    : 'supervised';
  const options: UpsertOrchestratorStateInput = { mode };
  const tokenBudgetDaily = numberField(body, 'tokenBudgetDaily');
  const dailyLoopBudget = numberField(body, 'dailyLoopBudget');
  const openDraftPrLimit = numberField(body, 'openDraftPrLimit');
  const discoveryIntervalMinutes = numberField(body, 'discoveryIntervalMinutes');
  if (tokenBudgetDaily !== undefined) options.tokenBudgetDaily = tokenBudgetDaily;
  if (dailyLoopBudget !== undefined) options.dailyLoopBudget = dailyLoopBudget;
  if (openDraftPrLimit !== undefined) options.openDraftPrLimit = openDraftPrLimit;
  if (discoveryIntervalMinutes !== undefined) options.discoveryIntervalMinutes = discoveryIntervalMinutes;
  return options;
}

export async function registerOrchestratorRoutes(
  app: FastifyInstance,
  store: Store,
  scheduler: LoopOrchestratorScheduler
): Promise<void> {
  app.get('/api/projects/:projectId/orchestrator', async (request) => {
    const params = request.params as { projectId: string };
    requireRecord(await store.getProject(params.projectId), 'PROJECT_NOT_FOUND', 'project not found');
    const state = await scheduler.ensureState(params.projectId);
    const candidates = await store.listCandidates(params.projectId);
    return {
      state,
      queue: {
        proposed: candidates.filter((candidate) => candidate.status === 'proposed').length,
        approved: candidates.filter((candidate) => candidate.status === 'approved').length,
        queued: candidates.filter((candidate) => candidate.status === 'queued').length,
        running: candidates.filter((candidate) => candidate.status === 'running').length,
        processed: candidates.filter((candidate) => candidate.status === 'processed').length,
        dismissed: candidates.filter((candidate) => candidate.status === 'dismissed').length
      },
      openDraftPrCount: await store.countOpenDraftPullRequests(params.projectId),
      recentEvents: await store.listOrchestratorEvents(params.projectId, 20)
    };
  });

  app.post('/api/projects/:projectId/orchestrator/start', async (request) => {
    const params = request.params as { projectId: string };
    requireRecord(await store.getProject(params.projectId), 'PROJECT_NOT_FOUND', 'project not found');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const options = startOptions(body);
    if (body.mode !== undefined && (typeof body.mode !== 'string' || !MODES.has(body.mode as OrchestratorMode))) {
      throw new ApiError(400, 'INVALID_ORCHESTRATOR_MODE', 'mode must be supervised or auto');
    }
    const state = await scheduler.start(params.projectId, options);
    return { state };
  });

  app.post('/api/projects/:projectId/orchestrator/stop', async (request) => {
    const params = request.params as { projectId: string };
    requireRecord(await store.getProject(params.projectId), 'PROJECT_NOT_FOUND', 'project not found');
    const state = await scheduler.stop(params.projectId, 'kill_switch');
    return { state };
  });
}

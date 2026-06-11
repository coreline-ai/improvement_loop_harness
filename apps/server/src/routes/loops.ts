import type { FastifyInstance } from 'fastify';
import { ApiError, requireRecord } from '../errors.js';
import { requestHash } from '../hash.js';
import type { InProcessLoopQueue } from '../queue.js';
import { ACTIVE_LOOP_STATUSES, TERMINAL_LOOP_STATUSES, type Store } from '../types.js';

type RetryMode = 'retry_same_base' | 'retry_latest_base' | 'retry_eval_only' | 'retry_critic_only';

const RETRY_ALLOWED: Record<RetryMode, Set<string>> = {
  retry_same_base: new Set(['failed', 'rejected', 'needs_more_tests']),
  retry_latest_base: new Set(['failed', 'rejected', 'needs_more_tests']),
  retry_eval_only: new Set(['failed', 'rejected']),
  retry_critic_only: new Set(['failed'])
};

function idempotencyKey(headers: Record<string, string | string[] | undefined>): string {
  const value = headers['idempotency-key'];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

async function appendStatusEvent(store: Store, loopId: string, type: string, status: string, payload: object = {}): Promise<void> {
  await store.addLoopEvent(loopId, type, { status, ...payload });
}

export async function registerLoopRoutes(
  app: FastifyInstance,
  store: Store,
  queue: InProcessLoopQueue
): Promise<void> {
  app.post('/api/tasks/:taskId/loops', async (request, reply) => {
    const params = request.params as { taskId: string };
    const task = requireRecord(await store.getTask(params.taskId), 'TASK_NOT_FOUND', 'task not found');
    const key = idempotencyKey(request.headers);
    if (!key) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const hash = requestHash(body);
    const existing = await store.findLoopByIdempotency(params.taskId, key);
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'same Idempotency-Key was used with a different request body');
      }
      return reply.code(200).send({ loop: existing, replay: true });
    }

    const active = await store.findActiveLoop(params.taskId);
    if (active) {
      throw new ApiError(409, 'ACTIVE_LOOP_EXISTS', 'same task already has an active loop');
    }

    const loop = await store.createLoop({
      taskId: params.taskId,
      iteration: await store.nextLoopIteration(params.taskId),
      status: 'queued',
      baseCommit: typeof body.baseCommit === 'string' ? body.baseCommit : null,
      artifactRoot: typeof body.artifactRoot === 'string' ? body.artifactRoot : null,
      idempotencyKey: key,
      requestHash: hash
    });
    queue.enqueue(loop, task);
    return reply.code(202).send({ loop, replay: false });
  });

  app.get('/api/tasks/:taskId/loops', async (request) => {
    const params = request.params as { taskId: string };
    requireRecord(await store.getTask(params.taskId), 'TASK_NOT_FOUND', 'task not found');
    return store.listLoops(params.taskId);
  });

  app.get('/api/loops/:loopId', async (request) => {
    const params = request.params as { loopId: string };
    return requireRecord(await store.getLoop(params.loopId), 'LOOP_NOT_FOUND', 'loop not found');
  });

  app.post('/api/loops/:loopId/cancel', async (request) => {
    const params = request.params as { loopId: string };
    const loop = requireRecord(await store.getLoop(params.loopId), 'LOOP_NOT_FOUND', 'loop not found');
    if (TERMINAL_LOOP_STATUSES.has(loop.status)) {
      throw new ApiError(409, 'LOOP_TERMINAL', 'terminal loop cannot be cancelled');
    }
    const updated = requireRecord(
      await store.updateLoop(loop.id, { status: 'cancelled', finishedAt: new Date() }),
      'LOOP_NOT_FOUND',
      'loop not found'
    );
    await appendStatusEvent(store, loop.id, 'loop.cancelled', updated.status);
    return updated;
  });

  app.post('/api/loops/:loopId/retry', async (request, reply) => {
    const params = request.params as { loopId: string };
    const previous = requireRecord(await store.getLoop(params.loopId), 'LOOP_NOT_FOUND', 'loop not found');
    const task = requireRecord(await store.getTask(previous.taskId), 'TASK_NOT_FOUND', 'task not found');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const mode = body.mode as RetryMode;
    if (!RETRY_ALLOWED[mode]?.has(previous.status)) {
      throw new ApiError(409, 'RETRY_NOT_ALLOWED', `retry mode ${String(mode)} is not allowed from ${previous.status}`);
    }
    const active = await store.findActiveLoop(previous.taskId);
    if (active && active.id !== previous.id && ACTIVE_LOOP_STATUSES.has(active.status)) {
      throw new ApiError(409, 'ACTIVE_LOOP_EXISTS', 'same task already has an active loop');
    }
    const loop = await store.createLoop({
      taskId: previous.taskId,
      iteration: await store.nextLoopIteration(previous.taskId),
      status: 'queued',
      baseCommit: mode === 'retry_latest_base' ? null : previous.baseCommit ?? null,
      artifactRoot: previous.artifactRoot ?? null
    });
    await store.addLoopEvent(loop.id, 'loop.retry_created', {
      retry_of: previous.id,
      retry_mode: mode,
      reason: typeof body.reason === 'string' ? body.reason : null
    });
    queue.enqueue(loop, task);
    return reply.code(202).send({ loop, retry_of: previous.id, retry_mode: mode });
  });
}

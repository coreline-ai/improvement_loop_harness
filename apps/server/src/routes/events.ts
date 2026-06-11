import type { FastifyInstance } from 'fastify';
import { requireRecord } from '../errors.js';
import type { LoopEventRecord, Store } from '../types.js';

function eventEnvelope(event: LoopEventRecord): string {
  return [
    `id: ${event.seq}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify({
      id: String(event.seq),
      loop_id: event.loopRunId,
      type: event.type,
      created_at: event.createdAt.toISOString(),
      payload: event.payload ?? {}
    })}`,
    '',
    ''
  ].join('\n');
}

export async function registerEventRoutes(
  app: FastifyInstance,
  store: Store,
  options: { replayOnly?: boolean } = {}
): Promise<void> {
  app.get('/api/loops/:loopId/events', async (request, reply) => {
    const params = request.params as { loopId: string };
    requireRecord(await store.getLoop(params.loopId), 'LOOP_NOT_FOUND', 'loop not found');
    const lastEventId = Number(request.headers['last-event-id'] ?? 0);
    const afterSeq = Number.isFinite(lastEventId) ? lastEventId : 0;
    const events = await store.listLoopEventsAfter(params.loopId, afterSeq);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: options.replayOnly ? 'close' : 'keep-alive'
    });
    for (const event of events) {
      reply.raw.write(eventEnvelope(event));
    }
    if (options.replayOnly) {
      reply.raw.end();
      return reply;
    }
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
    request.raw.on('close', () => clearInterval(keepAlive));
    return reply;
  });
}

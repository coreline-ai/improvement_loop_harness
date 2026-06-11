import fastify, { type FastifyInstance } from 'fastify';
import { ApiError, sendError } from './errors.js';
import { registerAuth } from './auth.js';
import { MemoryStore } from './memory-store.js';
import { PrismaStore } from './prisma-store.js';
import { InProcessLoopQueue, type LoopRunner } from './queue.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerEventRoutes } from './routes/events.js';
import { registerLoopRoutes } from './routes/loops.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerPullRequestRoutes, type PullRequestManager } from './routes/pull-requests.js';
import { registerTaskRoutes } from './routes/tasks.js';
import type { Store } from './types.js';

export interface CreateAppOptions {
  token?: string | undefined;
  store?: Store | undefined;
  runner?: LoopRunner | undefined;
  sseReplayOnly?: boolean | undefined;
  logger?: boolean | undefined;
  pullRequestManager?: PullRequestManager | undefined;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger ?? false });
  const store = options.store ?? (process.env.DATABASE_URL ? new PrismaStore() : new MemoryStore());
  const queue = new InProcessLoopQueue(store, options.runner);

  app.setErrorHandler((error, _request, reply) => sendError(reply, error));
  app.setNotFoundHandler((_request, reply) => {
    sendError(reply, new ApiError(404, 'NOT_FOUND', 'route not found'));
  });

  await registerAuth(app, { token: options.token });
  await registerProjectRoutes(app, store);
  await registerTaskRoutes(app, store);
  await registerLoopRoutes(app, store, queue);
  await registerEventRoutes(app, store, options.sseReplayOnly === undefined ? {} : { replayOnly: options.sseReplayOnly });
  await registerApprovalRoutes(app, store);
  await registerArtifactRoutes(app, store);
  await registerPullRequestRoutes(app, store, options.pullRequestManager);

  return app;
}

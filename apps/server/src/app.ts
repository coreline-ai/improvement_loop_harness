import fastify, { type FastifyInstance } from 'fastify';
import { ApiError, sendError } from './errors.js';
import { registerAuth } from './auth.js';
import { MemoryStore } from './memory-store.js';
import { PrismaStore } from './prisma-store.js';
import { InProcessLoopQueue, type LoopRunner } from './queue.js';
import { LoopOrchestratorScheduler, type FetchLatestBase } from './orchestrator/scheduler.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerCandidateRoutes } from './routes/candidates.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerEventRoutes } from './routes/events.js';
import { registerLoopRoutes } from './routes/loops.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerOrchestratorRoutes } from './routes/orchestrator.js';
import { registerPullRequestRoutes, type PullRequestManager } from './routes/pull-requests.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerSecurity, type SecurityOptions } from './security.js';
import type { AgentSpecPolicy } from './agent-policy.js';
import type { Store } from './types.js';

export interface CreateAppOptions {
  token?: string | undefined;
  store?: Store | undefined;
  runner?: LoopRunner | undefined;
  sseReplayOnly?: boolean | undefined;
  logger?: boolean | undefined;
  pullRequestManager?: PullRequestManager | undefined;
  fetchLatestBase?: FetchLatestBase | undefined;
  agentSpecPolicy?: AgentSpecPolicy | undefined;
  security?: SecurityOptions | undefined;
}

export async function createApp(options: CreateAppOptions = {}): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger ?? false });
  const store = options.store ?? (process.env.DATABASE_URL ? new PrismaStore() : new MemoryStore());
  const queue = new InProcessLoopQueue(store, options.runner);
  const orchestrator = new LoopOrchestratorScheduler(store, {
    runner: options.runner,
    pullRequestManager: options.pullRequestManager,
    fetchLatestBase: options.fetchLatestBase
  });
  await orchestrator.recoverAll();
  app.addHook('onClose', async () => {
    for (const state of await store.listOrchestratorStates()) {
      if (state.status === 'running' || state.status === 'stopping') {
        await orchestrator.stop(state.projectId, 'app_shutdown');
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => sendError(reply, error));
  app.setNotFoundHandler((_request, reply) => {
    sendError(reply, new ApiError(404, 'NOT_FOUND', 'route not found'));
  });

  await registerSecurity(app, options.security);
  await registerAuth(app, { token: options.token });
  await registerProjectRoutes(app, store);
  await registerTaskRoutes(app, store);
  await registerLoopRoutes(app, store, queue, options.agentSpecPolicy);
  await registerEventRoutes(app, store, options.sseReplayOnly === undefined ? {} : { replayOnly: options.sseReplayOnly });
  await registerApprovalRoutes(app, store);
  await registerCandidateRoutes(app, store);
  await registerOrchestratorRoutes(app, store, orchestrator);
  await registerArtifactRoutes(app, store);
  await registerPullRequestRoutes(app, store, options.pullRequestManager);

  return app;
}

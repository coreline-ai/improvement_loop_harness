import { getDataDir } from '@vibeloop/shared';
import { createApp } from './app.js';
import { MemoryStore } from './memory-store.js';
import { PrismaStore } from './prisma-store.js';
import { createKernelLoopRunner } from './runner.js';
import type { Store } from './types.js';

export interface ServerConfig {
  token: string;
  host: string;
  port: number;
  dataDir: string;
  agentSpec: string;
  proxyBaseUrl?: string | undefined;
  skipDependencyInstall: boolean;
  storeMode: 'memory' | 'prisma';
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function envFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const token = requiredEnv(env, 'VIBELOOP_API_TOKEN');
  const storeMode = env.DATABASE_URL ? 'prisma' : env.VIBELOOP_STORE === 'memory' ? 'memory' : null;
  if (!storeMode) {
    throw new Error('DATABASE_URL is required unless VIBELOOP_STORE=memory is set');
  }
  return {
    token,
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3001),
    dataDir: getDataDir(env),
    agentSpec: env.VIBELOOP_AGENT_SPEC ?? 'codex',
    ...(env.VIBELOOP_PROXY_BASE_URL ? { proxyBaseUrl: env.VIBELOOP_PROXY_BASE_URL } : {}),
    skipDependencyInstall: envFlag(env.VIBELOOP_SKIP_DEPENDENCY_INSTALL),
    storeMode
  };
}

export function createStore(config: ServerConfig): Store {
  if (config.storeMode === 'memory') {
    console.warn('VIBELOOP_STORE=memory: using non-persistent in-memory store');
    return new MemoryStore();
  }
  return new PrismaStore();
}

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<{ close: () => Promise<void>; url: string }> {
  const config = loadServerConfig(env);
  const store = createStore(config);
  const runner = createKernelLoopRunner({
    store,
    dataDir: config.dataDir,
    defaultAgentSpec: config.agentSpec,
    proxyBaseUrl: config.proxyBaseUrl,
    skipDependencyInstall: config.skipDependencyInstall
  });
  const app = await createApp({ token: config.token, store, runner, logger: true });
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host}:${port}`;
  console.log(`VibeLoop server listening on ${url}`);

  return {
    url,
    close: async () => {
      await app.close();
      if ('disconnect' in store && typeof store.disconnect === 'function') {
        await store.disconnect();
      }
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startServer();
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`${signal} received; shutting down VibeLoop server`);
    await server.close();
    process.exit(0);
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));
}

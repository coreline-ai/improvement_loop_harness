import type { Limits } from '@vibeloop/task-protocol';
import { CommandAgentAdapter, type AgentAdapter } from './adapter.js';
import { CodexAgentAdapter } from './codex.js';
import { MockAgentAdapter } from './mock.js';

export const CODEX_AGENT_SPEC = 'codex';

export interface ResolveAgentAdapterOptions {
  loopId: string;
  limits?: Limits | undefined;
  proxyBaseUrl?: string | undefined;
}

export function resolveAgentAdapter(
  spec: string,
  options: ResolveAgentAdapterOptions
): AgentAdapter {
  if (spec.startsWith('mock:')) {
    const scenarioPath = spec.slice('mock:'.length);
    if (!scenarioPath) {
      throw new Error('mock agent requires mock:<scenario.json>');
    }
    return new MockAgentAdapter(scenarioPath);
  }

  if (spec === CODEX_AGENT_SPEC) {
    return new CodexAgentAdapter({
      loopId: options.loopId,
      proxyBaseUrl: options.proxyBaseUrl ?? 'http://127.0.0.1:1',
      limits: options.limits
    });
  }

  if (spec.startsWith('command:')) {
    const command = spec.slice('command:'.length).trim();
    if (!command) {
      throw new Error('command agent requires command:<shell command>');
    }
    return new CommandAgentAdapter(() => command);
  }

  throw new Error(`unsupported agent spec: ${spec}`);
}

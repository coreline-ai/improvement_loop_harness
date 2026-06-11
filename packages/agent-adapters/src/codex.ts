import { scrubEnv } from '@vibeloop/workspace-runner';
import type { Limits } from '@vibeloop/task-protocol';
import {
  CommandAgentAdapter,
  type AgentRunOptions,
  type AgentRunResult
} from './adapter.js';
import { joinShellCommand, shellQuote } from './shell.js';

export interface CodexEnvOptions {
  sourceEnv?: NodeJS.ProcessEnv | undefined;
  proxyBaseUrl: string;
  loopId: string;
  taskFile: string;
  homeDir?: string | undefined;
}

export interface CodexCommandOptions {
  binary?: string | undefined;
  worktree: string;
  taskFile: string;
  appendDefaultArgs?: boolean | undefined;
  args?: string[] | undefined;
}

export interface CodexAgentAdapterOptions {
  binary?: string | undefined;
  args?: string[] | undefined;
  appendDefaultArgs?: boolean | undefined;
  proxyBaseUrl: string;
  loopId: string;
  limits?: Limits | undefined;
}

export function agentTimeoutMsFromLimits(
  limits: Limits | undefined
): number | undefined {
  return limits?.agent_timeout_seconds
    ? limits.agent_timeout_seconds * 1000
    : undefined;
}

export function buildCodexEnv(options: CodexEnvOptions): NodeJS.ProcessEnv {
  const env = scrubEnv(
    options.sourceEnv ?? process.env,
    options.homeDir ? { homeDir: options.homeDir } : {}
  );
  env.OPENAI_BASE_URL = options.proxyBaseUrl;
  env.VIBELOOP_LOOP_ID = options.loopId;
  env.VIBELOOP_TASK_FILE = options.taskFile;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.GITHUB_TOKEN;
  return env;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexProxyBaseUrl(proxyBaseUrl: string): string {
  const trimmed = proxyBaseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function buildCodexProxyConfigArgs(proxyBaseUrl: string): string[] {
  const providerId = 'vibeloop-proxy';
  return [
    '-c',
    `model_provider=${tomlString(providerId)}`,
    '-c',
    `model_providers.${providerId}.name=${tomlString('VibeLoop Proxy')}`,
    '-c',
    `model_providers.${providerId}.base_url=${tomlString(
      buildCodexProxyBaseUrl(proxyBaseUrl)
    )}`,
    '-c',
    `model_providers.${providerId}.wire_api=${tomlString('responses')}`,
    '-c',
    `model_providers.${providerId}.experimental_bearer_token=${tomlString(
      'vibeloop-proxy-placeholder'
    )}`
  ];
}

export function buildCodexDefaultArgs(proxyBaseUrl: string): string[] {
  return [
    '-c',
    `sandbox_mode=${tomlString('workspace-write')}`,
    '-c',
    `approval_policy=${tomlString('never')}`,
    ...buildCodexProxyConfigArgs(proxyBaseUrl)
  ];
}

export function buildCodexCommand(options: CodexCommandOptions): string {
  const binary = options.binary ?? 'codex';
  const appendDefaultArgs = options.appendDefaultArgs ?? true;
  if (!appendDefaultArgs) {
    return joinShellCommand([binary, ...(options.args ?? [])]);
  }

  const command = joinShellCommand([
    binary,
    'exec',
    '--cd',
    options.worktree,
    ...(options.args ?? []),
    '-'
  ]);
  return `${command} < ${shellQuote(options.taskFile)}`;
}

export class CodexAgentAdapter extends CommandAgentAdapter {
  constructor(private readonly options: CodexAgentAdapterOptions) {
    super((runOptions) =>
      buildCodexCommand({
        binary: options.binary,
        worktree: runOptions.worktree,
        taskFile: runOptions.taskFile,
        appendDefaultArgs: options.appendDefaultArgs,
        args:
          options.appendDefaultArgs === false
            ? options.args
            : [
                ...buildCodexDefaultArgs(options.proxyBaseUrl),
                ...(options.args ?? [])
              ]
      })
    );
  }

  override async run(options: AgentRunOptions): Promise<AgentRunResult> {
    return super.run({
      ...options,
      env: buildCodexEnv({
        sourceEnv: options.env,
        proxyBaseUrl: this.options.proxyBaseUrl,
        loopId: this.options.loopId,
        taskFile: options.taskFile,
        homeDir: options.env?.HOME
      }),
      timeoutMs:
        options.timeoutMs ?? agentTimeoutMsFromLimits(this.options.limits)
    });
  }
}

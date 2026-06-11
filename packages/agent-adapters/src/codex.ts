import { scrubEnv } from '@vibeloop/workspace-runner';
import type { Limits } from '@vibeloop/task-protocol';
import {
  CommandAgentAdapter,
  type AgentRunOptions,
  type AgentRunResult
} from './adapter.js';
import { joinShellCommand } from './shell.js';

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

export function buildCodexCommand(options: CodexCommandOptions): string {
  const binary = options.binary ?? 'codex';
  const appendDefaultArgs = options.appendDefaultArgs ?? true;
  const defaultArgs = appendDefaultArgs
    ? ['exec', '--cwd', options.worktree, '--task', options.taskFile]
    : [];
  return joinShellCommand([binary, ...defaultArgs, ...(options.args ?? [])]);
}

export class CodexAgentAdapter extends CommandAgentAdapter {
  constructor(private readonly options: CodexAgentAdapterOptions) {
    super((runOptions) =>
      buildCodexCommand({
        binary: options.binary,
        worktree: runOptions.worktree,
        taskFile: runOptions.taskFile,
        appendDefaultArgs: options.appendDefaultArgs,
        args: options.args
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

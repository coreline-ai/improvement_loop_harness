import { runCommand, type RunCommandStatus } from '@vibeloop/shared';

export interface AgentRunOptions {
  worktree: string;
  taskFile: string;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  stdoutFile?: string | undefined;
  stderrFile?: string | undefined;
}

export interface AgentRunResult {
  status: RunCommandStatus;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface AgentAdapter {
  run(options: AgentRunOptions): Promise<AgentRunResult>;
}

export type CommandBuilder = (options: AgentRunOptions) => string;

export class CommandAgentAdapter implements AgentAdapter {
  constructor(private readonly buildCommand: CommandBuilder) {}

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const result = await runCommand(this.buildCommand(options), {
      cwd: options.worktree,
      env: options.env ?? process.env,
      signal: options.signal,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      stdoutFile: options.stdoutFile,
      stderrFile: options.stderrFile
    });

    return {
      status: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}

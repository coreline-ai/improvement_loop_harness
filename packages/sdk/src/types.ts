import type { TerminalRunStatus } from '@vibeloop/artifacts';
import type { Decision } from '@vibeloop/shared';
import type { RetryMode, RunKernelOptions } from './run.js';

export interface RunOnceOptions {
  repoPath: string;
  taskFile: string;
  evalFile: string;
  dataDir: string;
  agentSpec: string;
  projectId?: string | undefined;
  loopId?: string | undefined;
  baseCommit?: string | undefined;
  proxyBaseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  logToStdout?: boolean | undefined;
  skipDependencyInstall?: boolean | undefined;
}

export interface RunOnceResult {
  loopId: string;
  projectId: string;
  status: TerminalRunStatus;
  decision?: Decision | undefined;
  reportPath?: string | undefined;
  artifactRoot: string;
  exitCode: number;
}

export interface VerifyPatchOptions extends Omit<RunOnceOptions, 'agentSpec'> {
  patch: string;
  retryOf?: string | undefined;
  retryMode?: RetryMode | undefined;
  agentSpec?: string | undefined;
}

export type VerifyPatchResult = RunOnceResult;

export type RunOnceKernelOptions = Pick<
  RunKernelOptions,
  | 'repoPath'
  | 'taskFile'
  | 'evalFile'
  | 'dataDir'
  | 'agentSpec'
  | 'projectId'
  | 'loopId'
  | 'baseCommit'
  | 'proxyBaseUrl'
  | 'signal'
  | 'logToStdout'
  | 'skipDependencyInstall'
>;

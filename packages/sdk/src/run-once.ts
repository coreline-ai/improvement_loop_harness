import { runKernel } from './run.js';
import type { RunKernelResult } from './run.js';
import type {
  RunOnceOptions,
  RunOnceResult,
  VerifyPatchOptions,
  VerifyPatchResult
} from './types.js';

function toRunOnceResult(result: RunKernelResult): RunOnceResult {
  return {
    loopId: result.loopId,
    projectId: result.projectId,
    status: result.status,
    decision: result.decision,
    reportPath: result.reportPath,
    artifactRoot: result.layout.root,
    exitCode: result.exitCode,
    qualified: result.qualified
  };
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  return toRunOnceResult(await runKernel(options));
}

export async function verifyPatch(
  options: VerifyPatchOptions
): Promise<VerifyPatchResult> {
  const result = await runKernel({
    repoPath: options.repoPath,
    taskFile: options.taskFile,
    evalFile: options.evalFile,
    dataDir: options.dataDir,
    agentSpec: options.agentSpec ?? 'patch',
    projectId: options.projectId,
    loopId: options.loopId,
    baseCommit: options.baseCommit,
    proxyBaseUrl: options.proxyBaseUrl,
    signal: options.signal,
    logToStdout: options.logToStdout,
    skipDependencyInstall: options.skipDependencyInstall,
    evalOnlyPatch: options.patch,
    retryOf: options.retryOf,
    retryMode: options.retryMode
  });
  return toRunOnceResult(result);
}

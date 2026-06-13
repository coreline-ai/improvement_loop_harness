import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { createRunLayout, readManifest, type RunManifest } from '@vibeloop/artifacts';
import { EXIT_CODES, runKernel, type RetryMode } from '@vibeloop/sdk';

interface RetryCommandOptions {
  mode: RetryMode;
  out?: string | undefined;
  agent?: string | undefined;
  loopId?: string | undefined;
  projectId?: string | undefined;
  repo?: string | undefined;
  logJson?: boolean | undefined;
  skipDependencyInstall?: boolean | undefined;
}

interface PreviousRunRef {
  manifest: RunManifest;
  runRoot: string;
}

interface WorkspaceRefArtifact {
  repo_path: string;
  base_commit: string;
}

const RETRY_MODES: RetryMode[] = [
  'retry_same_base',
  'retry_latest_base',
  'retry_eval_only',
  'retry_critic_only'
];

function globalDataDir(command: Command): string {
  return (command.parent?.opts<{ dataDir: string }>().dataDir ?? command.opts<{ dataDir: string }>().dataDir) as string;
}

async function findPreviousRun(dataDir: string, loopId: string): Promise<PreviousRunRef> {
  const { readdir } = await import('node:fs/promises');
  const projectsRoot = path.join(dataDir, 'projects');
  const projectIds = await readdir(projectsRoot).catch(() => []);
  for (const projectId of projectIds) {
    const layout = createRunLayout(dataDir, projectId, loopId);
    const manifest = await readManifest(layout).catch(() => undefined);
    if (manifest) {
      return { manifest, runRoot: layout.root };
    }
  }
  throw new Error(`previous loop not found: ${loopId}`);
}

async function readWorkspaceRef(runRoot: string): Promise<WorkspaceRefArtifact> {
  return JSON.parse(await readFile(path.join(runRoot, 'workspace', 'workspace-ref.json'), 'utf8')) as WorkspaceRefArtifact;
}

export async function retryLoop(options: {
  dataDir: string;
  previousLoopId: string;
  mode: RetryMode;
  agentSpec?: string | undefined;
  newLoopId?: string | undefined;
  repoPath?: string | undefined;
  logToStdout?: boolean | undefined;
  skipDependencyInstall?: boolean | undefined;
}): Promise<Awaited<ReturnType<typeof runKernel>>> {
  if (!RETRY_MODES.includes(options.mode)) {
    throw new Error(`unsupported retry mode: ${options.mode}`);
  }
  const previous = await findPreviousRun(options.dataDir, options.previousLoopId);
  const workspaceRef = await readWorkspaceRef(previous.runRoot);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-retry-input-'));
  const taskFile = path.join(temp, 'task.yaml');
  const evalFile = path.join(temp, 'eval.yaml');
  await Promise.all([
    import('node:fs/promises').then(({ copyFile }) =>
      copyFile(path.join(previous.runRoot, 'input', 'task.yaml'), taskFile)
    ),
    import('node:fs/promises').then(({ copyFile }) =>
      copyFile(path.join(previous.runRoot, 'input', 'eval.yaml'), evalFile)
    )
  ]);

  const isPatchOnly = options.mode === 'retry_eval_only' || options.mode === 'retry_critic_only';
  const patch = isPatchOnly
    ? await readFile(path.join(previous.runRoot, 'patches', 'candidate.patch'), 'utf8')
    : undefined;
  const agentSpec = isPatchOnly ? 'mock:__agent_not_used__.json' : options.agentSpec;
  if (!agentSpec) {
    throw new Error(`${options.mode} requires --agent because the builder must be rerun`);
  }

  return runKernel({
    repoPath: options.repoPath ?? workspaceRef.repo_path,
    taskFile,
    evalFile,
    dataDir: options.dataDir,
    agentSpec,
    projectId: previous.manifest.project_id,
    loopId: options.newLoopId ?? `loop-${randomUUID()}`,
    baseCommit: options.mode === 'retry_latest_base' ? undefined : workspaceRef.base_commit,
    evalOnlyPatch: patch,
    retryOf: options.previousLoopId,
    retryMode: options.mode,
    logToStdout: options.logToStdout,
    skipDependencyInstall: options.skipDependencyInstall
  });
}

export function registerRetryCommand(program: Command): void {
  program
    .command('retry <loop-id>')
    .description('Create a new loop from an immutable previous run')
    .requiredOption('--mode <mode>', `retry mode: ${RETRY_MODES.join('|')}`)
    .option('--out <path>', 'artifact data directory override')
    .option('--agent <spec>', 'agent spec for retry_same_base/retry_latest_base')
    .option('--loop-id <id>', 'new loop id override')
    .option('--project-id <id>', 'reserved project id override')
    .option('--repo <path>', 'repo override when previous workspace-ref is unavailable')
    .option('--log-json', 'print structured loop state logs to stdout', false)
    .option('--skip-dependency-install', 'skip dependency provisioning (test/debug only)', false)
    .action(async (previousLoopId: string, options: RetryCommandOptions, command: Command) => {
      if (!RETRY_MODES.includes(options.mode)) {
        console.error(`Invalid --mode. Expected one of: ${RETRY_MODES.join(', ')}`);
        process.exitCode = EXIT_CODES.failed;
        return;
      }
      const result = await retryLoop({
        dataDir: options.out ?? globalDataDir(command),
        previousLoopId,
        mode: options.mode,
        agentSpec: options.agent,
        newLoopId: options.loopId,
        repoPath: options.repo,
        logToStdout: options.logJson,
        skipDependencyInstall: options.skipDependencyInstall
      });
      process.exitCode = result.exitCode;
      console.log(
        JSON.stringify(
          {
            loop_id: result.loopId,
            retry_of: previousLoopId,
            mode: options.mode,
            status: result.status,
            decision: result.decision ?? null,
            report: result.reportPath ?? null,
            artifact_root: result.layout.root
          },
          null,
          2
        )
      );
    });
}

import {
  runCommand,
  type RunCommandOptions,
  type RunCommandResult
} from './exec.js';

// R1 (security workstream): run an untrusted command inside a throwaway,
// network-isolated container instead of on the host. This is the OS-level
// isolation boundary SECURITY_MODEL.md §2/§6 declares as the post-MVP defense
// for "eval gate project commands == arbitrary code execution". Implemented as a
// thin wrapper over runCommand so all timeout/buffer/process-group handling is
// shared. The inner command is passed via env (never on any argv), so a leaked
// value cannot land in the host or container process table.

export interface ContainerRunOptions {
  /** Container image to run the command in (e.g. 'node:22-alpine'). */
  image: string;
  /** Host directory mounted read-write at /work (the candidate worktree). */
  mountDir: string;
  /** Network policy. Default 'none' — untrusted code gets no network. */
  network?: 'none' | 'default';
  /** Env keys/values passed THROUGH to the container (via -e KEY, value in env). */
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

const CONTAINER_CMD_ENV = 'VIBELOOP_CONTAINER_CMD';

function shSingleQuote(value: string): string {
  // POSIX-safe single quoting: close, escaped quote, reopen.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * True when a Docker-compatible daemon is reachable. Callers gate isolated
 * execution (and tests) on this so behavior degrades honestly when no runtime
 * is available rather than silently running unisolated.
 */
export async function isContainerRuntimeAvailable(): Promise<boolean> {
  const probe = await runCommand('docker info', { timeoutMs: 15_000 });
  return probe.status === 'pass';
}

export async function runCommandInContainer(
  command: string,
  options: ContainerRunOptions
): Promise<RunCommandResult> {
  const network = options.network ?? 'none';
  const passThroughKeys = Object.keys(options.env ?? {});
  const envFlags = [CONTAINER_CMD_ENV, ...passThroughKeys]
    .map((key) => `-e ${key}`)
    .join(' ');

  // The container command is `sh -lc "$VIBELOOP_CONTAINER_CMD"`, single-quoted on
  // the host so the host shell does NOT expand it; docker passes the var in via
  // -e and the container's shell expands it.
  const dockerCommand = [
    'docker run --rm',
    `--network ${network}`,
    '-w /work',
    `-v ${shSingleQuote(`${options.mountDir}:/work`)}`,
    envFlags,
    shSingleQuote(options.image),
    `sh -lc ${shSingleQuote(`"$${CONTAINER_CMD_ENV}"`)}`
  ]
    .filter(Boolean)
    .join(' ');

  const runOptions: RunCommandOptions = {
    env: {
      ...process.env,
      ...(options.env ?? {}),
      [CONTAINER_CMD_ENV]: command
    }
  };
  if (options.timeoutMs) runOptions.timeoutMs = options.timeoutMs;
  if (options.maxBufferBytes)
    runOptions.maxBufferBytes = options.maxBufferBytes;

  return runCommand(dockerCommand, runOptions);
}

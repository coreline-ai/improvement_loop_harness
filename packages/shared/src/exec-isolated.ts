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

export interface ContainerMount {
  /**
   * Host path to bind-mount. Must be on a path the container runtime exposes to
   * its VM — e.g. under $HOME for colima (macOS `/var/folders` tmpdirs are NOT
   * mounted). VibeLoop worktrees/artifacts live under the data dir (default
   * ~/.vibeloop), which satisfies this.
   */
  hostPath: string;
  /** Mount point inside the container. Mounting at the SAME absolute path keeps
   * host-absolute paths (cwd, ${WORKTREE_ROOT}, metrics file) valid in-container. */
  containerPath: string;
  readonly?: boolean;
}

export interface ContainerRunOptions {
  /** Container image to run the command in (e.g. 'node:22-alpine'). */
  image: string;
  /** Bind mounts (worktree, artifact/metrics dir, ...). */
  mounts: ContainerMount[];
  /** Working directory inside the container (a container path under a mount). */
  workdir: string;
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

/**
 * Build the host `docker run` invocation (pure, no I/O) so its security-critical
 * properties are unit-testable without a daemon: network isolation, the bind
 * mounts/workdir, and that the untrusted command is passed via env (`-e`) — it
 * is NEVER interpolated into the docker argv. The command value lives only in
 * the returned `env` map.
 */
export function buildContainerInvocation(
  command: string,
  options: ContainerRunOptions
): { dockerCommand: string; env: Record<string, string> } {
  const network = options.network ?? 'none';
  const passThroughKeys = Object.keys(options.env ?? {});
  const envFlags = [CONTAINER_CMD_ENV, ...passThroughKeys]
    .map((key) => `-e ${key}`)
    .join(' ');
  const mountFlags = options.mounts
    .map(
      (m) =>
        `-v ${shSingleQuote(`${m.hostPath}:${m.containerPath}${m.readonly ? ':ro' : ''}`)}`
    )
    .join(' ');

  // Container entrypoint: `sh -c 'sh -c "$VIBELOOP_CONTAINER_CMD"'`.
  // - Host single-quotes the script so the HOST shell never expands the var.
  // - The OUTER container sh expands "$VAR" (passed via -e) into a single arg.
  // - The INNER sh -c parses that arg as a full script, so shell operators
  //   (&&, ||, |, >) in the command work. (A flat `sh -c "$VAR"` would make the
  //   whole expansion one command word → "command not found".)
  const dockerCommand = [
    'docker run --rm',
    `--network ${network}`,
    `-w ${shSingleQuote(options.workdir)}`,
    mountFlags,
    envFlags,
    shSingleQuote(options.image),
    `sh -c ${shSingleQuote(`sh -c "$${CONTAINER_CMD_ENV}"`)}`
  ]
    .filter(Boolean)
    .join(' ');

  return {
    dockerCommand,
    env: {
      ...(options.env ?? {}),
      [CONTAINER_CMD_ENV]: command
    }
  };
}

export async function runCommandInContainer(
  command: string,
  options: ContainerRunOptions
): Promise<RunCommandResult> {
  const { dockerCommand, env } = buildContainerInvocation(command, options);

  const runOptions: RunCommandOptions = {
    env: { ...process.env, ...env }
  };
  if (options.timeoutMs) runOptions.timeoutMs = options.timeoutMs;
  if (options.maxBufferBytes)
    runOptions.maxBufferBytes = options.maxBufferBytes;

  return runCommand(dockerCommand, runOptions);
}

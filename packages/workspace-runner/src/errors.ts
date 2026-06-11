export class WorkspaceRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRunnerError';
  }
}

export class GitCommandError extends WorkspaceRunnerError {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      args: readonly string[];
      cwd: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }
  ) {
    super(message);
    this.name = 'GitCommandError';
    this.args = options.args;
    this.cwd = options.cwd;
    this.exitCode = options.exitCode;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }
}

export class BranchNotFoundError extends WorkspaceRunnerError {
  constructor(ref: string) {
    super(`git ref does not resolve to a commit: ${ref}`);
    this.name = 'BranchNotFoundError';
  }
}

export class WorktreeError extends WorkspaceRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export class DependencyProvisionError extends WorkspaceRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyProvisionError';
  }
}

export class EnvPolicyError extends WorkspaceRunnerError {
  constructor(message: string) {
    super(message);
    this.name = 'EnvPolicyError';
  }
}

export class LockTimeoutError extends WorkspaceRunnerError {
  constructor(lockPath: string) {
    super(`timed out waiting for repo lock: ${lockPath}`);
    this.name = 'LockTimeoutError';
  }
}

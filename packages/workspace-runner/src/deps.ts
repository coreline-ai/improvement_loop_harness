import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DependencyProvisionError } from './errors.js';

export type DependencyManager = 'npm' | 'pnpm';
export type DependencyProvisionStatus = 'cache_hit' | 'cache_miss' | 'skipped';

export interface DependencyLockfile {
  manager: DependencyManager;
  path: string;
  sha256: string;
}

export interface DependencyProvisionOptions {
  workspaceRoot: string;
  dataDir: string;
  projectId: string;
  env?: NodeJS.ProcessEnv;
  installer?: (context: {
    workspaceRoot: string;
    lockfile: DependencyLockfile;
  }) => Promise<void>;
}

export interface DependencyProvisionResult {
  status: DependencyProvisionStatus;
  manager?: DependencyManager;
  lockfilePath?: string;
  cacheKey?: string;
  cachePath?: string;
}

const LOCKFILE_MANAGERS: Array<{ name: string; manager: DependencyManager }> = [
  { name: 'pnpm-lock.yaml', manager: 'pnpm' },
  { name: 'package-lock.json', manager: 'npm' },
  { name: 'npm-shrinkwrap.json', manager: 'npm' }
];

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

export async function detectDependencyLockfile(
  workspaceRoot: string
): Promise<DependencyLockfile | undefined> {
  for (const candidate of LOCKFILE_MANAGERS) {
    const lockfilePath = path.join(workspaceRoot, candidate.name);
    if (await exists(lockfilePath)) {
      return {
        manager: candidate.manager,
        path: lockfilePath,
        sha256: await sha256File(lockfilePath)
      };
    }
  }
  return undefined;
}

function resolveCachePath(
  dataDir: string,
  projectId: string,
  lockfile: DependencyLockfile
): string {
  return path.resolve(
    dataDir,
    'projects',
    projectId,
    'dependency-cache',
    `${lockfile.manager}-${lockfile.sha256}`,
    'node_modules'
  );
}

async function copyNodeModules(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true });
}

function installCommand(lockfile: DependencyLockfile): {
  command: string;
  args: string[];
} {
  if (lockfile.manager === 'pnpm') {
    return { command: 'pnpm', args: ['install', '--frozen-lockfile'] };
  }
  return { command: 'npm', args: ['ci'] };
}

async function runDefaultInstaller(
  workspaceRoot: string,
  lockfile: DependencyLockfile,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const command = installCommand(lockfile);
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const subprocess = spawn(command.command, command.args, {
      cwd: workspaceRoot,
      env: env ?? process.env,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    subprocess.stderr.setEncoding('utf8');
    subprocess.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    subprocess.on('error', reject);
    subprocess.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      reject(
        new DependencyProvisionError(
          `${command.command} ${command.args.join(' ')} failed: ${stderr.trim()}`
        )
      );
    });
  });
}

export async function provisionDependencies(
  options: DependencyProvisionOptions
): Promise<DependencyProvisionResult> {
  const lockfile = await detectDependencyLockfile(options.workspaceRoot);
  if (!lockfile) {
    return { status: 'skipped' };
  }

  const cachePath = resolveCachePath(
    options.dataDir,
    options.projectId,
    lockfile
  );
  const cacheKey = `${lockfile.manager}-${lockfile.sha256}`;
  const workspaceNodeModules = path.join(options.workspaceRoot, 'node_modules');

  if (await exists(cachePath)) {
    await copyNodeModules(cachePath, workspaceNodeModules);
    return {
      status: 'cache_hit',
      manager: lockfile.manager,
      lockfilePath: lockfile.path,
      cacheKey,
      cachePath
    };
  }

  if (options.installer) {
    await options.installer({ workspaceRoot: options.workspaceRoot, lockfile });
  } else {
    await runDefaultInstaller(options.workspaceRoot, lockfile, options.env);
  }

  const nodeModulesStat = await stat(workspaceNodeModules).catch(
    () => undefined
  );
  if (!nodeModulesStat?.isDirectory()) {
    throw new DependencyProvisionError(
      `dependency install did not create node_modules: ${workspaceNodeModules}`
    );
  }

  await copyNodeModules(workspaceNodeModules, cachePath);
  return {
    status: 'cache_miss',
    manager: lockfile.manager,
    lockfilePath: lockfile.path,
    cacheKey,
    cachePath
  };
}

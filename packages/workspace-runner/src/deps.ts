import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { DependencyProvisionError } from './errors.js';
import { scrubEnv } from './env.js';

export type DependencyManager = 'npm' | 'pnpm' | 'yarn';
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
  { name: 'npm-shrinkwrap.json', manager: 'npm' },
  { name: 'yarn.lock', manager: 'yarn' }
];
const CACHE_INTEGRITY_MANIFEST = 'node_modules.integrity.json';

interface CacheIntegrityEntry {
  path: string;
  type: 'file' | 'symlink';
  sha256?: string;
  size_bytes?: number;
  target?: string;
}

interface CacheIntegrityManifest {
  schema_version: '1.0';
  files: CacheIntegrityEntry[];
}

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

async function walkIntegrityEntries(
  root: string,
  directory = root
): Promise<CacheIntegrityEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return walkIntegrityEntries(root, absolutePath);
      }
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join('/');
      if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        return [
          {
            path: relativePath,
            type: 'file' as const,
            sha256: await sha256File(absolutePath),
            size_bytes: fileStat.size
          }
        ];
      }
      if (entry.isSymbolicLink()) {
        return [
          {
            path: relativePath,
            type: 'symlink' as const,
            target: await readlink(absolutePath)
          }
        ];
      }
      return [];
    })
  );
  return results.flat().sort((a, b) => a.path.localeCompare(b.path));
}

async function buildCacheIntegrityManifest(
  cachePath: string
): Promise<CacheIntegrityManifest> {
  return {
    schema_version: '1.0',
    files: await walkIntegrityEntries(cachePath)
  };
}

function integrityManifestPath(cachePath: string): string {
  return path.join(path.dirname(cachePath), CACHE_INTEGRITY_MANIFEST);
}

async function writeCacheIntegrityManifest(cachePath: string): Promise<void> {
  const manifest = await buildCacheIntegrityManifest(cachePath);
  await writeFile(
    integrityManifestPath(cachePath),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

function cacheManifestEquals(
  actual: CacheIntegrityManifest,
  expected: CacheIntegrityManifest
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function verifyCacheIntegrity(cachePath: string): Promise<boolean> {
  const manifestPath = integrityManifestPath(cachePath);
  try {
    const expected = JSON.parse(
      await readFile(manifestPath, 'utf8')
    ) as CacheIntegrityManifest;
    if (expected.schema_version !== '1.0' || !Array.isArray(expected.files)) {
      return false;
    }
    const actual = await buildCacheIntegrityManifest(cachePath);
    return cacheManifestEquals(actual, expected);
  } catch {
    return false;
  }
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
    return {
      command: 'pnpm',
      args: [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-workspace'
      ]
    };
  }
  if (lockfile.manager === 'yarn') {
    return {
      command: 'yarn',
      args: ['install', '--frozen-lockfile', '--ignore-scripts']
    };
  }
  return { command: 'npm', args: ['ci', '--ignore-scripts'] };
}

function corepackInstallCommand(lockfile: DependencyLockfile): {
  command: string;
  args: string[];
} | undefined {
  if (lockfile.manager === 'pnpm') {
    return {
      command: 'corepack',
      args: [
        'pnpm',
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--ignore-workspace'
      ]
    };
  }
  if (lockfile.manager === 'yarn') {
    return {
      command: 'corepack',
      args: ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts']
    };
  }
  return undefined;
}

async function runInstallerProcess(
  workspaceRoot: string,
  command: { command: string; args: string[] },
  env: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const subprocess = spawn(command.command, command.args, {
      cwd: workspaceRoot,
      env,
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

async function runDefaultInstaller(
  workspaceRoot: string,
  lockfile: DependencyLockfile,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const command = installCommand(lockfile);
  const installEnv = scrubEnv(
    env ?? process.env,
    env?.HOME ? { homeDir: env.HOME } : {}
  );
  if (!installEnv.COREPACK_HOME) {
    const corepackHome =
      process.env.COREPACK_HOME ??
      (process.env.HOME
        ? path.join(process.env.HOME, '.cache', 'node', 'corepack')
        : undefined);
    if (corepackHome && (await exists(corepackHome))) {
      installEnv.COREPACK_HOME = corepackHome;
    }
  }
  if (installEnv.HOME) {
    await mkdir(installEnv.HOME, { recursive: true, mode: 0o700 });
  }
  try {
    await runInstallerProcess(workspaceRoot, command, installEnv);
  } catch (error) {
    const fallback = corepackInstallCommand(lockfile);
    if (
      fallback &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      await runInstallerProcess(workspaceRoot, fallback, installEnv);
      return;
    }
    throw error;
  }
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
    if (await verifyCacheIntegrity(cachePath)) {
      await copyNodeModules(cachePath, workspaceNodeModules);
      return {
        status: 'cache_hit',
        manager: lockfile.manager,
        lockfilePath: lockfile.path,
        cacheKey,
        cachePath
      };
    }
    await rm(path.dirname(cachePath), { recursive: true, force: true });
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
  await writeCacheIntegrityManifest(cachePath);
  return {
    status: 'cache_miss',
    manager: lockfile.manager,
    lockfilePath: lockfile.path,
    cacheKey,
    cachePath
  };
}

import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import { resolveBaseCommit } from './base-commit.js';
import { BranchNotFoundError } from './errors.js';
import { provisionDependencies } from './deps.js';
import { createEphemeralHome, scrubEnv } from './env.js';
import { buildSafeGitArgs, buildSafeGitEnv, safeGit } from './git.js';
import { diffGitMetadataSnapshots, snapshotGitMetadata } from './snapshot.js';
import { createWorktree, isPathInside, removeWorktree } from './worktree.js';

async function tempDir(prefix: string): Promise<string> {
  return import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), prefix))
  );
}

describe('safeGit', () => {
  it('adds defensive git flags and env overrides to every git invocation', () => {
    expect(buildSafeGitArgs(['status']).slice(0, 5)).toEqual([
      '--no-pager',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor='
    ]);
    expect(
      buildSafeGitEnv({
        GIT_CONFIG_GLOBAL: '/tmp/global',
        GIT_TERMINAL_PROMPT: '1'
      })
    ).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat'
    });
  });

  it('ignores a malicious repo core.pager when running status', async () => {
    const repo = await createTempGitRepo();
    const marker = path.join(await tempDir('vibeloop-pager-'), 'pager-ran');

    await safeGit(repo.repoPath, [
      'config',
      'core.pager',
      `sh -c 'touch ${marker}'`
    ]);
    await safeGit(repo.repoPath, ['status']);

    await expect(access(marker)).rejects.toThrow();
  });
});

describe('base commit and worktree isolation', () => {
  it('resolves branch names to immutable SHAs and rejects missing branches', async () => {
    const repo = await createTempGitRepo();

    await expect(resolveBaseCommit(repo.repoPath, 'main')).resolves.toBe(
      repo.initialCommit
    );
    await expect(
      resolveBaseCommit(repo.repoPath, 'missing-branch')
    ).rejects.toThrow(BranchNotFoundError);
  });

  it('creates worktrees at the fixed base commit outside the target repo', async () => {
    const repo = await createTempGitRepo();
    const dataDir = await tempDir('vibeloop-worktrees-');
    const worktree = await createWorktree({
      repoPath: repo.repoPath,
      dataDir,
      projectId: 'proj-1',
      loopId: 'loop-1',
      baseCommit: repo.initialCommit
    });

    const head = (
      await safeGit(worktree.path, ['rev-parse', 'HEAD'])
    ).stdout.trim();
    expect(head).toBe(repo.initialCommit);
    expect(isPathInside(repo.repoPath, worktree.path)).toBe(false);
  });

  it('serializes two concurrent worktree mutations through the repo lockfile', async () => {
    const repo = await createTempGitRepo();
    const dataDir = await tempDir('vibeloop-worktrees-lock-');

    const [first, second] = await Promise.all([
      createWorktree({
        repoPath: repo.repoPath,
        dataDir,
        projectId: 'proj-1',
        loopId: 'loop-a',
        baseCommit: repo.initialCommit
      }),
      createWorktree({
        repoPath: repo.repoPath,
        dataDir,
        projectId: 'proj-1',
        loopId: 'loop-b',
        baseCommit: repo.initialCommit
      })
    ]);

    await expect(
      safeGit(first.path, ['rev-parse', 'HEAD'])
    ).resolves.toMatchObject({ stdout: `${repo.initialCommit}\n` });
    await expect(
      safeGit(second.path, ['rev-parse', 'HEAD'])
    ).resolves.toMatchObject({ stdout: `${repo.initialCommit}\n` });
    await expect(access(first.lockPath)).rejects.toThrow();
  });

  it('prunes stale worktree metadata via the rm fallback without re-locking', async () => {
    const repo = await createTempGitRepo();
    const dataDir = await tempDir('vibeloop-worktrees-prune-');
    const worktree = await createWorktree({
      repoPath: repo.repoPath,
      dataDir,
      projectId: 'proj-1',
      loopId: 'loop-prune',
      baseCommit: repo.initialCommit
    });

    // Simulate the working tree disappearing so git worktree remove fails and the
    // rm fallback path (which prunes stale admin metadata) runs.
    await rm(worktree.path, { recursive: true, force: true });
    const adminEntry = path.join(
      repo.repoPath,
      '.git',
      'worktrees',
      'loop-prune'
    );
    await expect(access(adminEntry)).resolves.toBeUndefined();

    // Must resolve (no LockTimeoutError from re-acquiring the held repo lock) and
    // leave no stale .git/worktrees admin entry behind.
    await expect(removeWorktree(worktree)).resolves.toBeUndefined();
    await expect(access(adminEntry)).rejects.toThrow();
  });
});

describe('dependency provisioning', () => {
  it('runs the default installer with scrubbed env and scripts disabled', async () => {
    const dataDir = await tempDir('vibeloop-deps-safe-data-');
    const workspace = await tempDir('vibeloop-deps-safe-ws-');
    const fakeBin = await tempDir('vibeloop-deps-safe-bin-');
    const fakeNpm = path.join(fakeBin, 'npm');
    await writeFile(path.join(workspace, 'package-lock.json'), '{}\n');
    await writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify(
        {
          name: 'fixture',
          version: '1.0.0',
          scripts: { postinstall: 'node -e "process.exit(99)"' }
        },
        null,
        2
      )
    );
    await writeFile(
      fakeNpm,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$PWD/install-args.txt"',
        'env > "$PWD/install-env.txt"',
        'mkdir -p "$PWD/node_modules/fake"',
        'printf ok > "$PWD/node_modules/fake/index.js"',
        ''
      ].join('\n')
    );
    await chmod(fakeNpm, 0o700);

    await expect(
      provisionDependencies({
        workspaceRoot: workspace,
        dataDir,
        projectId: 'proj-safe-install',
        env: {
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          SECRET_TOKEN: 'must-not-leak',
          NPM_TOKEN: 'must-not-leak',
          VIBELOOP_SAFE_VALUE: 'kept'
        }
      })
    ).resolves.toMatchObject({ status: 'cache_miss', manager: 'npm' });

    await expect(readFile(path.join(workspace, 'install-args.txt'), 'utf8')).resolves.toContain(
      '--ignore-scripts'
    );
    const installEnv = await readFile(
      path.join(workspace, 'install-env.txt'),
      'utf8'
    );
    expect(installEnv).toContain('VIBELOOP_SAFE_VALUE=kept');
    expect(installEnv).not.toContain('SECRET_TOKEN=');
    expect(installEnv).not.toContain('NPM_TOKEN=');
    expect(installEnv).not.toContain('must-not-leak');
  }, 10_000);

  it('runs yarn installs with frozen lockfile and scripts disabled', async () => {
    const dataDir = await tempDir('vibeloop-deps-yarn-data-');
    const workspace = await tempDir('vibeloop-deps-yarn-ws-');
    const fakeBin = await tempDir('vibeloop-deps-yarn-bin-');
    const fakeYarn = path.join(fakeBin, 'yarn');
    await writeFile(path.join(workspace, 'yarn.lock'), '# yarn lockfile\n');
    await writeFile(
      path.join(workspace, 'package.json'),
      '{"name":"fixture","version":"1.0.0"}\n'
    );
    await writeFile(
      fakeYarn,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$PWD/install-args.txt"',
        'mkdir -p "$PWD/node_modules/fake"',
        'printf ok > "$PWD/node_modules/fake/index.js"',
        ''
      ].join('\n')
    );
    await chmod(fakeYarn, 0o700);

    await expect(
      provisionDependencies({
        workspaceRoot: workspace,
        dataDir,
        projectId: 'proj-yarn-safe-install',
        env: {
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`
        }
      })
    ).resolves.toMatchObject({ status: 'cache_miss', manager: 'yarn' });

    const installArgs = await readFile(
      path.join(workspace, 'install-args.txt'),
      'utf8'
    );
    expect(installArgs).toContain('--frozen-lockfile');
    expect(installArgs).toContain('--ignore-scripts');
  }, 10_000);

  it('falls back to corepack for pnpm lockfiles when pnpm is not on PATH', async () => {
    const dataDir = await tempDir('vibeloop-deps-pnpm-corepack-data-');
    const workspace = await tempDir('vibeloop-deps-pnpm-corepack-ws-');
    const fakeBin = await tempDir('vibeloop-deps-pnpm-corepack-bin-');
    const fakeCorepack = path.join(fakeBin, 'corepack');
    await writeFile(
      path.join(workspace, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"
    );
    await writeFile(
      path.join(workspace, 'package.json'),
      '{"name":"fixture","version":"1.0.0"}\n'
    );
    await writeFile(
      fakeCorepack,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$PWD/install-args.txt"',
        '/bin/mkdir -p "$PWD/node_modules/fake"',
        'printf ok > "$PWD/node_modules/fake/index.js"',
        ''
      ].join('\n')
    );
    await chmod(fakeCorepack, 0o700);

    await expect(
      provisionDependencies({
        workspaceRoot: workspace,
        dataDir,
        projectId: 'proj-pnpm-corepack-install',
        env: {
          PATH: fakeBin
        }
      })
    ).resolves.toMatchObject({ status: 'cache_miss', manager: 'pnpm' });

    await expect(
      readFile(path.join(workspace, 'install-args.txt'), 'utf8')
    ).resolves.toBe(
      'pnpm\ninstall\n--frozen-lockfile\n--ignore-scripts\n--ignore-workspace\n'
    );
  }, 10_000);

  it('preserves isolated HOME and Corepack cache for pnpm fallback installs', async () => {
    const dataDir = await tempDir('vibeloop-deps-corepack-home-data-');
    const workspace = await tempDir('vibeloop-deps-corepack-home-ws-');
    const fakeBin = await tempDir('vibeloop-deps-corepack-home-bin-');
    const isolatedHome = await tempDir('vibeloop-deps-corepack-home-');
    const corepackHome = await tempDir('vibeloop-deps-corepack-cache-');
    const fakeCorepack = path.join(fakeBin, 'corepack');
    await writeFile(
      path.join(workspace, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"
    );
    await writeFile(
      path.join(workspace, 'package.json'),
      '{"name":"fixture","version":"1.0.0"}\n'
    );
    await writeFile(
      fakeCorepack,
      [
        '#!/bin/sh',
        'printf "HOME=%s\\nCOREPACK_HOME=%s\\n" "$HOME" "$COREPACK_HOME" > "$PWD/install-env.txt"',
        '/bin/mkdir -p "$PWD/node_modules/fake"',
        'printf ok > "$PWD/node_modules/fake/index.js"',
        ''
      ].join('\n')
    );
    await chmod(fakeCorepack, 0o700);

    await expect(
      provisionDependencies({
        workspaceRoot: workspace,
        dataDir,
        projectId: 'proj-pnpm-corepack-home-install',
        env: {
          PATH: fakeBin,
          HOME: isolatedHome,
          COREPACK_HOME: corepackHome
        }
      })
    ).resolves.toMatchObject({ status: 'cache_miss', manager: 'pnpm' });

    await expect(
      readFile(path.join(workspace, 'install-env.txt'), 'utf8')
    ).resolves.toBe(`HOME=${isolatedHome}\nCOREPACK_HOME=${corepackHome}\n`);
  }, 10_000);

  it('falls back to corepack for yarn lockfiles when yarn is not on PATH', async () => {
    const dataDir = await tempDir('vibeloop-deps-yarn-corepack-data-');
    const workspace = await tempDir('vibeloop-deps-yarn-corepack-ws-');
    const fakeBin = await tempDir('vibeloop-deps-yarn-corepack-bin-');
    const fakeCorepack = path.join(fakeBin, 'corepack');
    await writeFile(path.join(workspace, 'yarn.lock'), '# yarn lockfile v1\n');
    await writeFile(
      path.join(workspace, 'package.json'),
      '{"name":"fixture","version":"1.0.0"}\n'
    );
    await writeFile(
      fakeCorepack,
      [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$PWD/install-args.txt"',
        '/bin/mkdir -p "$PWD/node_modules/fake"',
        'printf ok > "$PWD/node_modules/fake/index.js"',
        ''
      ].join('\n')
    );
    await chmod(fakeCorepack, 0o700);

    await expect(
      provisionDependencies({
        workspaceRoot: workspace,
        dataDir,
        projectId: 'proj-yarn-corepack-install',
        env: {
          PATH: fakeBin
        }
      })
    ).resolves.toMatchObject({ status: 'cache_miss', manager: 'yarn' });

    await expect(
      readFile(path.join(workspace, 'install-args.txt'), 'utf8')
    ).resolves.toBe('yarn\ninstall\n--frozen-lockfile\n--ignore-scripts\n');
  }, 10_000);

  it('populates dependency cache on first run and copies it on the second run', async () => {
    const dataDir = await tempDir('vibeloop-deps-cache-');
    const workspaceOne = await tempDir('vibeloop-deps-ws1-');
    const workspaceTwo = await tempDir('vibeloop-deps-ws2-');
    const lockfile = '{"lockfileVersion": 3}\n';
    let installCount = 0;

    for (const workspace of [workspaceOne, workspaceTwo]) {
      await writeFile(path.join(workspace, 'package-lock.json'), lockfile);
      await writeFile(
        path.join(workspace, 'package.json'),
        '{"name":"fixture","version":"1.0.0"}\n'
      );
    }

    const installer = async ({
      workspaceRoot
    }: {
      workspaceRoot: string;
    }): Promise<void> => {
      installCount += 1;
      await mkdir(path.join(workspaceRoot, 'node_modules', 'fixture'), {
        recursive: true
      });
      await writeFile(
        path.join(workspaceRoot, 'node_modules', 'fixture', 'index.js'),
        'module.exports = 1;\n'
      );
    };

    await expect(
      provisionDependencies({
        workspaceRoot: workspaceOne,
        dataDir,
        projectId: 'proj-1',
        installer
      })
    ).resolves.toMatchObject({ status: 'cache_miss', manager: 'npm' });
    await expect(
      provisionDependencies({
        workspaceRoot: workspaceTwo,
        dataDir,
        projectId: 'proj-1',
        installer
      })
    ).resolves.toMatchObject({ status: 'cache_hit', manager: 'npm' });

    expect(installCount).toBe(1);
    await expect(
      readFile(
        path.join(workspaceTwo, 'node_modules', 'fixture', 'index.js'),
        'utf8'
      )
    ).resolves.toBe('module.exports = 1;\n');
    expect(
      (await lstat(path.join(workspaceTwo, 'node_modules'))).isSymbolicLink()
    ).toBe(false);
  });

  it('rejects a tampered dependency cache and reinstalls before copying', async () => {
    const dataDir = await tempDir('vibeloop-deps-tamper-cache-');
    const workspaceOne = await tempDir('vibeloop-deps-tamper-ws1-');
    const workspaceTwo = await tempDir('vibeloop-deps-tamper-ws2-');
    const lockfile = '{"lockfileVersion": 3}\n';
    let installCount = 0;

    for (const workspace of [workspaceOne, workspaceTwo]) {
      await writeFile(path.join(workspace, 'package-lock.json'), lockfile);
      await writeFile(
        path.join(workspace, 'package.json'),
        '{"name":"fixture","version":"1.0.0"}\n'
      );
    }

    const installer = async ({
      workspaceRoot
    }: {
      workspaceRoot: string;
    }): Promise<void> => {
      installCount += 1;
      await mkdir(path.join(workspaceRoot, 'node_modules', 'fixture'), {
        recursive: true
      });
      await writeFile(
        path.join(workspaceRoot, 'node_modules', 'fixture', 'index.js'),
        `module.exports = ${installCount};\n`
      );
    };

    const first = await provisionDependencies({
      workspaceRoot: workspaceOne,
      dataDir,
      projectId: 'proj-tamper',
      installer
    });
    await writeFile(
      path.join(first.cachePath ?? '', 'fixture', 'index.js'),
      'module.exports = "tampered";\n'
    );

    await expect(
      provisionDependencies({
        workspaceRoot: workspaceTwo,
        dataDir,
        projectId: 'proj-tamper',
        installer
      })
    ).resolves.toMatchObject({ status: 'cache_miss', manager: 'npm' });

    expect(installCount).toBe(2);
    await expect(
      readFile(
        path.join(workspaceTwo, 'node_modules', 'fixture', 'index.js'),
        'utf8'
      )
    ).resolves.toBe('module.exports = 2;\n');
  });
});

describe('environment scrub', () => {
  it('keeps only allowed non-secret env keys and assigns an ephemeral HOME', async () => {
    const dataDir = await tempDir('vibeloop-env-');
    const homeDir = await createEphemeralHome(dataDir, 'proj-1', 'loop-1');
    const output = scrubEnv(
      {
        PATH: '/bin',
        CI: 'true',
        NODE_ENV: 'test',
        PNPM_HOME: '/tmp/pnpm-home',
        VIBELOOP_DATA_DIR: dataDir,
        VIBELOOP_PROXY_BASE_URL: 'https://user:pass@example.test',
        VIBELOOP_DATABASE_DSN: 'postgres://user:pass@example.test/db',
        VIBELOOP_CALLBACK_ENDPOINT: 'https://example.test/callback',
        ANTHROPIC_API_KEY: 'secret',
        GITHUB_TOKEN: 'secret',
        PASSWORD: 'secret',
        RANDOM: 'drop'
      },
      { homeDir }
    );

    expect(output).toMatchObject({
      PATH: '/bin',
      CI: 'true',
      NODE_ENV: 'test',
      PNPM_HOME: '/tmp/pnpm-home',
      VIBELOOP_DATA_DIR: dataDir,
      HOME: homeDir
    });
    expect(output).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(output).not.toHaveProperty('GITHUB_TOKEN');
    expect(output).not.toHaveProperty('PASSWORD');
    expect(output).not.toHaveProperty('VIBELOOP_PROXY_BASE_URL');
    expect(output).not.toHaveProperty('VIBELOOP_DATABASE_DSN');
    expect(output).not.toHaveProperty('VIBELOOP_CALLBACK_ENDPOINT');
    expect(output).not.toHaveProperty('RANDOM');
  });
});

describe('git metadata snapshot', () => {
  it('hashes shared git config/hooks metadata and detects config changes', async () => {
    const repo = await createTempGitRepo();
    const before = await snapshotGitMetadata(repo.repoPath);

    await safeGit(repo.repoPath, ['config', 'vibeloop.snapshot', 'changed']);
    const after = await snapshotGitMetadata(repo.repoPath);
    const diff = diffGitMetadataSnapshots(before, after);

    expect(before.entries.some((entry) => entry.path === 'config')).toBe(true);
    expect(diff.changed).toContain('config');
  });
});

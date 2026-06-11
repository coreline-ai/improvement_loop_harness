import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { createWorktree, isPathInside } from './worktree.js';

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
});

describe('dependency provisioning', () => {
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
        VIBELOOP_DATA_DIR: dataDir,
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
      VIBELOOP_DATA_DIR: dataDir,
      HOME: homeDir
    });
    expect(output).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(output).not.toHaveProperty('GITHUB_TOKEN');
    expect(output).not.toHaveProperty('PASSWORD');
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

import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshotGitMetadata } from '@vibeloop/workspace-runner';
import { describe, expect, it } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import { annotateScope, checkDiffScope } from './diff-scope.js';
import { applyPatch, extractDiff } from './diff.js';
import { checkGitMetadataIntegrity } from './git-meta-integrity.js';
import { checkLimits } from './limits.js';
import { checkProtectedFiles } from './protected-files.js';
import { checkTestIntegrity } from './test-integrity.js';
import type { GuardChangedFile } from './types.js';

async function tempDir(prefix: string): Promise<string> {
  return import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), prefix))
  );
}

describe('extractDiff', () => {
  it('detects modified, untracked, and renamed files against the fixed base commit', async () => {
    const repo = await createTempGitRepo();
    await repo.write('src/modified.ts', 'export const value = 1;\n');
    await repo.write('src/old-name.ts', 'export const oldName = true;\n');
    await repo.git(['add', 'src/modified.ts', 'src/old-name.ts']);
    await repo.git(['commit', '-m', 'add source files']);
    const baseCommit = (await repo.git(['rev-parse', 'HEAD'])).trim();

    await repo.write('src/modified.ts', 'export const value = 2;\n');
    await repo.git(['mv', 'src/old-name.ts', 'src/new-name.ts']);
    await repo.write('src/untracked.ts', 'export const untracked = true;\n');

    const diff = await extractDiff({ repoPath: repo.repoPath, baseCommit });

    expect(
      diff.changedFiles.map((file) => [file.path, file.status, file.oldPath])
    ).toEqual([
      ['src/modified.ts', 'modified', undefined],
      ['src/new-name.ts', 'renamed', 'src/old-name.ts'],
      ['src/untracked.ts', 'untracked', undefined]
    ]);
    expect(diff.changedFilesJson.untracked_files).toEqual(['src/untracked.ts']);
    expect(diff.changedFilesJson.renames).toEqual([
      { old_path: 'src/old-name.ts', path: 'src/new-name.ts' }
    ]);
  });

  it('does not miss changes after an agent creates its own commit', async () => {
    const repo = await createTempGitRepo();
    const baseCommit = repo.initialCommit;

    await repo.write('README.md', '# fixture repo\n\nagent committed change\n');
    await repo.git(['add', 'README.md']);
    await repo.git(['commit', '-m', 'agent commit']);

    const diff = await extractDiff({ repoPath: repo.repoPath, baseCommit });

    expect(diff.changedFiles).toEqual([
      expect.objectContaining({ path: 'README.md', status: 'modified' })
    ]);
  });

  it('writes patch artifacts and reapplies candidate.patch for retry/evaluation reuse', async () => {
    const repo = await createTempGitRepo();
    const artifactRoot = await tempDir('vibeloop-guard-artifacts-');

    await repo.write('README.md', '# fixture repo\n\npatched\n');
    await repo.write('src/new-file.ts', 'export const added = true;\n');
    const diff = await extractDiff({
      repoPath: repo.repoPath,
      baseCommit: repo.initialCommit,
      artifactRoot
    });
    await repo.git(['reset', '--hard', repo.initialCommit]);
    await rm(path.join(repo.repoPath, 'src'), { recursive: true, force: true });
    await applyPatch(repo.repoPath, diff.candidatePatch);

    await expect(
      readFile(path.join(artifactRoot, 'patches', 'candidate.patch'), 'utf8')
    ).resolves.toBe(diff.candidatePatch);
    await expect(
      readFile(path.join(repo.repoPath, 'README.md'), 'utf8')
    ).resolves.toContain('patched');
    await expect(
      readFile(path.join(repo.repoPath, 'src', 'new-file.ts'), 'utf8')
    ).resolves.toBe('export const added = true;\n');
  });
});

describe('builtin guard checks', () => {
  it('fails git-meta-integrity when .git/hooks changes', async () => {
    const repo = await createTempGitRepo();
    const before = await snapshotGitMetadata(repo.repoPath);

    await writeFile(
      path.join(repo.repoPath, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 1\n'
    );
    const after = await snapshotGitMetadata(repo.repoPath);
    const result = checkGitMetadataIntegrity(before, after);

    expect(result.status).toBe('fail');
    expect(result.code).toBe('GUARD_GIT_META_TAMPER');
    expect(
      result.violations.some(
        (violation) => violation.path === 'hooks/pre-commit'
      )
    ).toBe(true);
  });

  it('fails diff-scope for symlinks outside the allowed scope', async () => {
    const repo = await createTempGitRepo();
    const outside = await tempDir('vibeloop-symlink-target-');
    await mkdir(path.join(repo.repoPath, 'tmp'), { recursive: true });
    await symlink(
      outside,
      path.join(repo.repoPath, 'tmp', 'outside-link'),
      'dir'
    );

    const diff = await extractDiff({
      repoPath: repo.repoPath,
      baseCommit: repo.initialCommit
    });
    const result = checkDiffScope(diff.changedFiles, {
      writeScope: { allowed: ['src/'] }
    });

    expect(result.status).toBe('fail');
    expect(result.code).toBe('GUARD_SYMLINK_CHANGED');
  });

  it('fails test-integrity for forbidden focused tests', async () => {
    const repo = await createTempGitRepo();
    await repo.write(
      'tests/example.test.ts',
      'it.only("focuses", () => expect(true).toBe(true));\n'
    );
    const changedFiles: GuardChangedFile[] = [
      {
        path: 'tests/example.test.ts',
        status: 'added',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 0
      }
    ];

    const result = await checkTestIntegrity(repo.repoPath, changedFiles, {
      forbidden_patterns: ['it.only'],
      suspicious_patterns: ['expect(true).toBe(true)']
    });

    expect(result.status).toBe('fail');
    expect(result.violations.map((violation) => violation.code)).toContain(
      'GUARD_TEST_INTEGRITY'
    );
  });

  it('keeps configured forbidden test patterns even when labels match built-ins', async () => {
    const repo = await createTempGitRepo();
    await repo.write(
      'tests/example.test.ts',
      '// test.skip should be blocked by config even without a call expression.\n'
    );
    const changedFiles: GuardChangedFile[] = [
      {
        path: 'tests/example.test.ts',
        status: 'added',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 0
      }
    ];

    const result = await checkTestIntegrity(repo.repoPath, changedFiles, {
      forbidden_patterns: ['test.skip']
    });

    expect(result.status).toBe('fail');
    expect(result.code).toBe('GUARD_TEST_INTEGRITY');
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: 'GUARD_TEST_INTEGRITY',
        path: 'tests/example.test.ts',
        message: 'forbidden test pattern found: test.skip'
      })
    );
  });

  it('fails test-integrity for built-in JavaScript test weakening patterns', async () => {
    const repo = await createTempGitRepo();
    await repo.write(
      'tests/example.test.ts',
      'describe.skip("suite", () => {\n  it("weakens", () => expect(total).toBe(3));\n});\n'
    );
    const changedFiles: GuardChangedFile[] = [
      {
        path: 'tests/example.test.ts',
        status: 'added',
        isSymlink: false,
        addedLines: 3,
        deletedLines: 0
      }
    ];

    const result = await checkTestIntegrity(repo.repoPath, changedFiles, {});

    expect(result.status).toBe('fail');
    expect(result.code).toBe('GUARD_TEST_INTEGRITY');
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: 'GUARD_TEST_INTEGRITY',
        message: expect.stringContaining('describe.skip')
      })
    );
  });

  it('fails test-integrity for built-in Python and JVM skip markers', async () => {
    const repo = await createTempGitRepo();
    await repo.write(
      'tests/test_cart.py',
      'import pytest\n\n@pytest.mark.skip(reason="weakens")\ndef test_cart_total():\n    assert total == 3\n'
    );
    await repo.write(
      'tests/CartQuantityTest.java',
      'import org.junit.jupiter.api.Disabled;\n\n@Disabled\nclass CartQuantityTest {}\n'
    );
    const changedFiles: GuardChangedFile[] = [
      {
        path: 'tests/test_cart.py',
        status: 'added',
        isSymlink: false,
        addedLines: 5,
        deletedLines: 0
      },
      {
        path: 'tests/CartQuantityTest.java',
        status: 'added',
        isSymlink: false,
        addedLines: 4,
        deletedLines: 0
      }
    ];

    const result = await checkTestIntegrity(repo.repoPath, changedFiles, {});

    expect(result.status).toBe('fail');
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'tests/test_cart.py',
          message: expect.stringContaining('@pytest.mark.skip')
        }),
        expect.objectContaining({
          path: 'tests/CartQuantityTest.java',
          message: expect.stringContaining('@Disabled')
        })
      ])
    );
  });

  it('fails test-integrity for built-in suspicious no-op assertions', async () => {
    const repo = await createTempGitRepo();
    await repo.write(
      'tests/example.test.ts',
      'it("placeholder", () => {\n  assert.ok(true);\n});\n'
    );
    const changedFiles: GuardChangedFile[] = [
      {
        path: 'tests/example.test.ts',
        status: 'added',
        isSymlink: false,
        addedLines: 3,
        deletedLines: 0
      }
    ];

    const result = await checkTestIntegrity(repo.repoPath, changedFiles, {});

    expect(result.status).toBe('fail');
    expect(result.code).toBe('GUARD_TEST_SUSPICIOUS');
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: 'GUARD_TEST_SUSPICIOUS',
        message: expect.stringContaining('assert(true)')
      })
    );
  });

  it('fails test-integrity for commented-out assertions', async () => {
    const repo = await createTempGitRepo();
    await repo.write(
      'tests/example.test.ts',
      'it("placeholder", () => {\n  // expect(total).toBe(3);\n});\n'
    );
    const changedFiles: GuardChangedFile[] = [
      {
        path: 'tests/example.test.ts',
        status: 'added',
        isSymlink: false,
        addedLines: 3,
        deletedLines: 0
      }
    ];

    const result = await checkTestIntegrity(repo.repoPath, changedFiles, {});

    expect(result.status).toBe('fail');
    expect(result.code).toBe('GUARD_TEST_SUSPICIOUS');
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: 'GUARD_TEST_SUSPICIOUS',
        message: expect.stringContaining('commented assertion')
      })
    );
  });

  it('fails limits when changed lines exceed the configured maximum', () => {
    const changedFiles: GuardChangedFile[] = [
      {
        path: 'src/large.ts',
        status: 'modified',
        isSymlink: false,
        addedLines: 501,
        deletedLines: 0
      }
    ];

    const result = checkLimits(changedFiles, { max_changed_lines: 500 });

    expect(result.status).toBe('fail');
    expect(result.code).toBe('GUARD_LIMIT_EXCEEDED');
  });

  it('gives protected paths precedence over allowed scope', () => {
    const changedFiles: GuardChangedFile[] = [
      {
        path: '.env.local',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 0
      }
    ];

    expect(checkProtectedFiles(changedFiles).status).toBe('fail');
    const scoped = annotateScope(changedFiles, {
      writeScope: { allowed: ['.env.local'] }
    });
    const result = checkDiffScope(scoped, {
      writeScope: { allowed: ['.env.local'] }
    });

    expect(scoped[0]?.allowedByWriteScope).toBe(true);
    expect(scoped[0]?.protected).toBe(true);
    expect(result.status).toBe('fail');
    expect(result.code).toBe('GUARD_PROTECTED_PATH');
  });
});

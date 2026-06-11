import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { safeGit } from '@vibeloop/workspace-runner';
import type {
  GuardChangedFile,
  GuardCheckResult,
  TestIntegrityConfig
} from './types.js';

const TEST_FILE_PATTERN =
  /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;
const DEFAULT_ASSERTION_REMOVAL_PATTERNS = [
  /\bexpect\s*\(/,
  /\bassert\s*\(/,
  /\bassert\./,
  /\bstrictEqual\s*\(/,
  /\bnotStrictEqual\s*\(/,
  /\bdeepStrictEqual\s*\(/
];

export interface TestIntegrityOptions {
  baseCommit?: string | undefined;
}

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath.replaceAll('\\', '/'));
}

function removedAssertionLines(diff: string): string[] {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    .map((line) => line.slice(1).trim())
    .filter((line) =>
      DEFAULT_ASSERTION_REMOVAL_PATTERNS.some((pattern) => pattern.test(line))
    );
}

async function detectAssertionDeletion(
  repoPath: string,
  baseCommit: string | undefined,
  testFiles: readonly GuardChangedFile[]
): Promise<Array<{ code: string; path: string; message: string }>> {
  if (!baseCommit || testFiles.length === 0) {
    return [];
  }

  const violations = [];
  for (const file of testFiles) {
    const diff = await safeGit(repoPath, [
      'diff',
      '--unified=0',
      baseCommit,
      '--',
      file.path
    ]).catch(() => undefined);
    const removedAssertions = removedAssertionLines(diff?.stdout ?? '');
    for (const line of removedAssertions) {
      violations.push({
        code: 'GUARD_TEST_INTEGRITY',
        path: file.path,
        message: `test assertion removed: ${line}`
      });
    }
  }
  return violations;
}

export async function checkTestIntegrity(
  repoPath: string,
  changedFiles: readonly GuardChangedFile[],
  config: TestIntegrityConfig,
  options: TestIntegrityOptions = {}
): Promise<GuardCheckResult> {
  const forbidden = config.forbidden_patterns ?? [];
  const suspicious = config.suspicious_patterns ?? [];
  const testFiles = changedFiles.filter(
    (file) => file.status !== 'deleted' && isTestFile(file.path)
  );
  const violations = [];

  for (const file of testFiles) {
    const content = await readFile(
      path.join(repoPath, file.path),
      'utf8'
    ).catch(() => '');
    for (const pattern of forbidden) {
      if (content.includes(pattern)) {
        violations.push({
          code: 'GUARD_TEST_INTEGRITY',
          path: file.path,
          message: `forbidden test pattern found: ${pattern}`
        });
      }
    }
    for (const pattern of suspicious) {
      if (content.includes(pattern)) {
        violations.push({
          code: 'GUARD_TEST_SUSPICIOUS',
          path: file.path,
          message: `suspicious test pattern found: ${pattern}`
        });
      }
    }
  }

  violations.push(
    ...(await detectAssertionDeletion(repoPath, options.baseCommit, testFiles))
  );

  return violations.length === 0
    ? {
        status: 'pass',
        summary: `${testFiles.length} changed test file(s) checked`,
        violations: []
      }
    : {
        status: 'fail',
        code: violations[0]?.code,
        summary: `${violations.length} test integrity violation(s)`,
        violations
      };
}

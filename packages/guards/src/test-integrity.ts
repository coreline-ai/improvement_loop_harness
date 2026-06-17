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

const DEFAULT_FORBIDDEN_TEST_WEAKENING_PATTERNS = [
  { label: 'test.skip', pattern: /\btest\s*\.\s*skip\s*\(/ },
  { label: 'it.skip', pattern: /\bit\s*\.\s*skip\s*\(/ },
  { label: 'describe.skip', pattern: /\bdescribe\s*\.\s*skip\s*\(/ },
  { label: 'test.only', pattern: /\btest\s*\.\s*only\s*\(/ },
  { label: 'it.only', pattern: /\bit\s*\.\s*only\s*\(/ },
  { label: 'describe.only', pattern: /\bdescribe\s*\.\s*only\s*\(/ },
  { label: 'xit', pattern: /\bxit\s*\(/ },
  { label: 'xdescribe', pattern: /\bxdescribe\s*\(/ },
  { label: '@pytest.mark.skip', pattern: /^\s*@pytest\.mark\.skip(?:if)?\b/m },
  { label: 'pytest.skip', pattern: /\bpytest\.skip\s*\(/ },
  {
    label: '@unittest.skip',
    pattern: /^\s*@unittest\.skip(?:If|Unless)?\b/m
  },
  { label: 'unittest.skip', pattern: /\bunittest\.skip\s*\(/ },
  { label: '@Disabled', pattern: /^\s*@Disabled\b/m }
];

const DEFAULT_SUSPICIOUS_TEST_WEAKENING_PATTERNS = [
  {
    label: 'expect(true).toBe(true)',
    pattern: /\bexpect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/
  },
  {
    label: 'expect(1).toBe(1)',
    pattern: /\bexpect\s*\(\s*1\s*\)\s*\.\s*toBe\s*\(\s*1\s*\)/
  },
  { label: 'assert(true)', pattern: /\bassert(?:\.ok)?\s*\(\s*true\s*\)/ },
  { label: 'assert true', pattern: /^\s*assert\s+(?:true|True)\s*$/m },
  {
    label: 'commented assertion',
    pattern: /^\s*(?:\/\/|#)\s*(?:expect|assert(?:\.ok)?)\s*(?:\(|\b)/m
  }
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

function uniqueConfiguredPatterns(
  patterns: readonly string[] | undefined
): string[] {
  return [...new Set(patterns ?? [])];
}

export async function checkTestIntegrity(
  repoPath: string,
  changedFiles: readonly GuardChangedFile[],
  config: TestIntegrityConfig,
  options: TestIntegrityOptions = {}
): Promise<GuardCheckResult> {
  const forbidden = uniqueConfiguredPatterns(config.forbidden_patterns);
  const suspicious = uniqueConfiguredPatterns(config.suspicious_patterns);
  const testFiles = changedFiles.filter(
    (file) => file.status !== 'deleted' && isTestFile(file.path)
  );
  const violations = [];

  for (const file of testFiles) {
    const content = await readFile(
      path.join(repoPath, file.path),
      'utf8'
    ).catch(() => '');
    for (const { label, pattern } of DEFAULT_FORBIDDEN_TEST_WEAKENING_PATTERNS) {
      if (pattern.test(content)) {
        violations.push({
          code: 'GUARD_TEST_INTEGRITY',
          path: file.path,
          message: `forbidden test weakening pattern found: ${label}`
        });
      }
    }
    for (const pattern of forbidden) {
      if (content.includes(pattern)) {
        violations.push({
          code: 'GUARD_TEST_INTEGRITY',
          path: file.path,
          message: `forbidden test pattern found: ${pattern}`
        });
      }
    }
    for (const { label, pattern } of DEFAULT_SUSPICIOUS_TEST_WEAKENING_PATTERNS) {
      if (pattern.test(content)) {
        violations.push({
          code: 'GUARD_TEST_SUSPICIOUS',
          path: file.path,
          message: `suspicious test weakening pattern found: ${label}`
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

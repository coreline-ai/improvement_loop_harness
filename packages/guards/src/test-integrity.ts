import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GuardChangedFile,
  GuardCheckResult,
  TestIntegrityConfig
} from './types.js';

const TEST_FILE_PATTERN =
  /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERN.test(filePath.replaceAll('\\', '/'));
}

export async function checkTestIntegrity(
  repoPath: string,
  changedFiles: readonly GuardChangedFile[],
  config: TestIntegrityConfig
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

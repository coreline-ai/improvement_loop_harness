import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GuardChangedFile,
  GuardCheckResult,
  GuardViolation
} from './types.js';

export interface HiddenSelfInspectionConfig {
  hiddenTargetPaths?: readonly string[] | undefined;
  extraForbiddenPatterns?: readonly string[] | undefined;
}

const DEFAULT_HIDDEN_RUNTIME_PATTERNS: Array<{
  label: string;
  pattern: RegExp;
}> = [
  {
    label: 'hidden acceptance identifier',
    pattern: /\bhidden[_-]?acceptance\b/i
  },
  {
    label: 'hidden marker token',
    pattern: /\b(?:SECRET_HIDDEN|HIDDEN_ACCEPTANCE|BEGIN_HIDDEN)\b/i
  },
  {
    label: 'hidden test directory',
    pattern: /(?:^|['"`/\\])(?:tests?|specs?)[/\\]hidden(?:[/\\]|['"`])/i
  }
];

function normalize(value: string): string {
  return value.replaceAll('\\', '/');
}

function targetNeedles(hiddenTargetPaths: readonly string[]): string[] {
  const needles = new Set<string>();
  for (const target of hiddenTargetPaths) {
    const normalized = normalize(target);
    if (!normalized) continue;
    needles.add(normalized);
    const directory = path.posix.dirname(normalized);
    if (directory && directory !== '.') {
      needles.add(directory.endsWith('/') ? directory : `${directory}/`);
    }
  }
  return [...needles].sort();
}

function inspectContent(
  filePath: string,
  content: string,
  config: HiddenSelfInspectionConfig
): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const { label, pattern } of DEFAULT_HIDDEN_RUNTIME_PATTERNS) {
    if (pattern.test(content)) {
      violations.push({
        code: 'GUARD_HIDDEN_SELF_INSPECTION',
        path: filePath,
        message: `candidate references hidden runtime surface: ${label}`
      });
    }
  }
  for (const needle of targetNeedles(config.hiddenTargetPaths ?? [])) {
    if (normalize(content).includes(needle)) {
      violations.push({
        code: 'GUARD_HIDDEN_SELF_INSPECTION',
        path: filePath,
        message: 'candidate references a hidden acceptance target path'
      });
    }
  }
  for (const pattern of config.extraForbiddenPatterns ?? []) {
    if (content.includes(pattern)) {
      violations.push({
        code: 'GUARD_HIDDEN_SELF_INSPECTION',
        path: filePath,
        message: 'candidate references a configured hidden runtime pattern'
      });
    }
  }
  return violations;
}

export async function checkHiddenSelfInspection(
  repoPath: string,
  changedFiles: readonly GuardChangedFile[],
  config: HiddenSelfInspectionConfig = {}
): Promise<GuardCheckResult> {
  const inspectable = changedFiles.filter(
    (file) => file.status !== 'deleted' && !file.isSymlink
  );
  const violations: GuardViolation[] = [];
  for (const file of inspectable) {
    const content = await readFile(
      path.join(repoPath, file.path),
      'utf8'
    ).catch(() => '');
    if (!content) continue;
    violations.push(...inspectContent(file.path, content, config));
  }

  return violations.length === 0
    ? {
        status: 'pass',
        summary: `${inspectable.length} changed file(s) checked for hidden runtime self-inspection`,
        violations: []
      }
    : {
        status: 'fail',
        code: 'GUARD_HIDDEN_SELF_INSPECTION',
        summary: `${violations.length} hidden runtime self-inspection violation(s)`,
        violations
      };
}

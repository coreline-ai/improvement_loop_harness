export type GuardStatus = 'pass' | 'fail';

export type GuardChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked';

export interface GuardChangedFile {
  path: string;
  status: GuardChangedFileStatus;
  oldPath?: string | undefined;
  isSymlink: boolean;
  addedLines: number;
  deletedLines: number;
  allowedByWriteScope?: boolean | undefined;
  protected?: boolean | undefined;
}

export interface GuardViolation {
  code: string;
  path?: string | undefined;
  message: string;
}

export interface GuardCheckResult {
  status: GuardStatus;
  code?: string | undefined;
  summary: string;
  violations: GuardViolation[];
  details?: Record<string, unknown> | undefined;
}

export interface WriteScope {
  allowed: string[];
  forbidden?: string[] | undefined;
}

export interface LimitsConfig {
  max_changed_files?: number | undefined;
  max_changed_lines?: number | undefined;
}

export interface TestIntegrityConfig {
  forbidden_patterns?: string[] | undefined;
  suspicious_patterns?: string[] | undefined;
}

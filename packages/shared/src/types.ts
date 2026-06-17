export type Decision = 'accept' | 'reject' | 'needs_human_review' | 'needs_more_tests';

export type GateStatus = 'pass' | 'fail' | 'error' | 'skipped';

export type GateType =
  | 'hard'
  | 'scope'
  | 'integrity'
  | 'security'
  | 'task_acceptance'
  | 'regression'
  | 'performance'
  | 'hidden_acceptance'
  | 'advisory';

export interface GateResult {
  name: string;
  type: GateType;
  required: boolean;
  command?: string;
  status: GateStatus;
  exitCode: number | null;
  durationMs: number | null;
  stdoutRef?: string | null;
  stderrRef?: string | null;
  summary?: string | null;
}

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked';

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
  oldPath?: string | null;
  allowedByWriteScope: boolean;
  protected: boolean;
}

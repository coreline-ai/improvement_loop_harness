import type { GuardChangedFile } from '@vibeloop/guards';
import type {
  EvalConfig,
  EvalGate,
  TaskDefinition
} from '@vibeloop/task-protocol';
import type { GitMetadataSnapshot } from '@vibeloop/workspace-runner';

export type GateStatus = 'pass' | 'fail' | 'error' | 'skipped';

export interface InterpolationValues {
  TASK_FILE: string;
  BASE_COMMIT: string;
  LOOP_ID: string;
  WORKTREE_ROOT: string;
  ARTIFACT_ROOT: string;
}

export interface GateRunContext {
  evalConfig: EvalConfig;
  task: TaskDefinition;
  taskFile: string;
  baseCommit: string;
  loopId: string;
  worktreeRoot: string;
  artifactRoot: string;
  env?: NodeJS.ProcessEnv | undefined;
  changedFiles: GuardChangedFile[];
  gitMetadataBefore?: GitMetadataSnapshot | undefined;
  gitMetadataAfter?: GitMetadataSnapshot | undefined;
}

export interface GateReportEntry {
  name: string;
  type: EvalGate['type'];
  required: boolean;
  command: string;
  status: GateStatus;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  stdout_ref: string | null;
  stderr_ref: string | null;
  summary: string | null;
  group?: EvalGate['group'] | undefined;
}


export interface GateReport {
  schema_version: '1.0';
  generated_at: string;
  loop_id: string;
  gates: GateReportEntry[];
}

export type JsonValue = unknown;

export interface ProjectRecord {
  id: string;
  name: string;
  repoUrl?: string | null;
  localPath?: string | null;
  defaultBranch: string;
  evalConfigPath: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  status: string;
  riskArea?: string | null;
  writeScope: JsonValue;
  acceptance?: JsonValue | null;
  taskYaml: JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

export interface LoopRunRecord {
  id: string;
  taskId: string;
  iteration: number;
  status: string;
  decision?: string | null;
  decisionReasons?: JsonValue | null;
  baseCommit?: string | null;
  candidateCommit?: string | null;
  artifactRoot?: string | null;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LoopEventRecord {
  id: string;
  loopRunId: string;
  seq: number;
  type: string;
  payload?: JsonValue | null;
  createdAt: Date;
}

export interface ApprovalRecord {
  id: string;
  loopRunId: string;
  reason: string;
  status: string;
  reviewerId?: string | null;
  decisionReason?: string | null;
  requestedChanges?: JsonValue | null;
  approvedAt?: Date | null;
  rejectedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArtifactRecord {
  id: string;
  loopRunId: string;
  kind: string;
  path: string;
  sha256?: string | null;
  sizeBytes?: number | null;
  redacted: boolean;
  createdAt: Date;
}

export interface EvalReportRecord {
  id: string;
  loopRunId: string;
  type: string;
  status: string;
  reportJson: JsonValue;
  summary?: string | null;
  artifactRef?: string | null;
  createdAt: Date;
}

export interface CreateProjectInput {
  name: string;
  repoUrl?: string | null;
  localPath?: string | null;
  defaultBranch?: string;
  evalConfigPath?: string;
  status?: string;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  objective: string;
  status?: string;
  riskArea?: string | null;
  writeScope: JsonValue;
  acceptance?: JsonValue | null;
  taskYaml: JsonValue;
}

export interface CreateLoopInput {
  taskId: string;
  iteration: number;
  status: string;
  baseCommit?: string | null;
  artifactRoot?: string | null;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}

export interface CreateApprovalInput {
  loopRunId: string;
  reason: string;
  status?: string;
}

export interface Store {
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  listProjects(): Promise<ProjectRecord[]>;
  getProject(id: string): Promise<ProjectRecord | null>;
  updateProject(id: string, patch: Partial<CreateProjectInput>): Promise<ProjectRecord | null>;

  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  listTasks(projectId: string): Promise<TaskRecord[]>;
  getTask(id: string): Promise<TaskRecord | null>;
  updateTask(id: string, patch: Partial<Omit<CreateTaskInput, 'projectId'>>): Promise<TaskRecord | null>;

  createLoop(input: CreateLoopInput): Promise<LoopRunRecord>;
  listLoops(taskId: string): Promise<LoopRunRecord[]>;
  getLoop(id: string): Promise<LoopRunRecord | null>;
  updateLoop(id: string, patch: Partial<LoopRunRecord>): Promise<LoopRunRecord | null>;
  findLoopByIdempotency(taskId: string, key: string): Promise<LoopRunRecord | null>;
  findActiveLoop(taskId: string): Promise<LoopRunRecord | null>;
  nextLoopIteration(taskId: string): Promise<number>;

  addLoopEvent(loopRunId: string, type: string, payload?: JsonValue): Promise<LoopEventRecord>;
  listLoopEventsAfter(loopRunId: string, afterSeq: number): Promise<LoopEventRecord[]>;

  listApprovals(): Promise<ApprovalRecord[]>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  createApproval(input: CreateApprovalInput): Promise<ApprovalRecord>;
  updateApproval(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null>;

  listArtifacts(loopRunId: string): Promise<ArtifactRecord[]>;
  createArtifact(input: Omit<ArtifactRecord, 'id' | 'createdAt'>): Promise<ArtifactRecord>;

  listReports(loopRunId: string): Promise<EvalReportRecord[]>;
  getReport(id: string): Promise<EvalReportRecord | null>;
  createReport(input: Omit<EvalReportRecord, 'id' | 'createdAt'>): Promise<EvalReportRecord>;
}

export const ACTIVE_LOOP_STATUSES = new Set([
  'queued',
  'workspace_preparing',
  'workspace_ready',
  'agent_running',
  'patch_created',
  'guards_running',
  'eval_running',
  'critic_running',
  'decision_ready',
  'needs_human_review'
]);

export const TERMINAL_LOOP_STATUSES = new Set([
  'accepted',
  'approved',
  'rejected',
  'needs_more_tests',
  'cancelled',
  'failed'
]);

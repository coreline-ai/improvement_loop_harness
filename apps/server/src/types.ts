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
  agentSpec?: string | null;
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

export interface WorkspaceRunRecord {
  id: string;
  loopRunId: string;
  kind: string;
  path: string;
  baseCommit: string;
  status: string;
  createdAt: Date;
  cleanedAt?: Date | null;
}

export interface AgentRunRecord {
  id: string;
  loopRunId: string;
  agentType: string;
  command: string;
  model?: string | null;
  status: string;
  exitCode?: number | null;
  stdoutRef?: string | null;
  stderrRef?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
}

export interface GateRunRecord {
  id: string;
  loopRunId: string;
  name: string;
  type: string;
  required: boolean;
  command: string;
  status: string;
  exitCode?: number | null;
  durationMs?: number | null;
  stdoutRef?: string | null;
  stderrRef?: string | null;
  summary?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
}

export interface ImprovementCandidateRecord {
  id: string;
  projectId: string;
  source: string;
  fingerprint: string;
  title: string;
  evidenceRefs?: JsonValue | null;
  riskAreaHint?: string | null;
  priority: number;
  status: string;
  dismissReason?: string | null;
  taskId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PullRequestRecord {
  id: string;
  loopRunId: string;
  provider: string;
  branchName: string;
  prUrl?: string | null;
  prNumber?: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
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

export type OrchestratorMode = 'supervised' | 'auto';
export type OrchestratorStatus = 'stopped' | 'running' | 'paused' | 'stopping';

export interface OrchestratorStateRecord {
  id: string;
  projectId: string;
  mode: OrchestratorMode;
  status: OrchestratorStatus;
  dailyLoopBudget: number;
  loopsStartedToday: number;
  budgetDay: string;
  tokenBudgetDaily?: number | null;
  tokenUsedToday: number;
  openDraftPrLimit: number;
  discoveryIntervalMinutes: number;
  consecutiveFailures: number;
  currentCandidateId?: string | null;
  currentLoopId?: string | null;
  nextDiscoveryAt?: Date | null;
  pausedReason?: string | null;
  lastStartedAt?: Date | null;
  stoppedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrchestratorEventRecord {
  id: string;
  projectId: string;
  seq: number;
  type: string;
  payload?: JsonValue | null;
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
  agentSpec?: string | null;
  artifactRoot?: string | null;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}

export interface CreateApprovalInput {
  loopRunId: string;
  reason: string;
  status?: string;
}

export interface CreateCandidateInput {
  projectId: string;
  source: string;
  fingerprint: string;
  title: string;
  evidenceRefs?: JsonValue | null;
  riskAreaHint?: string | null;
  priority?: number;
  status?: string;
}

export interface CreatePullRequestInput {
  loopRunId: string;
  branchName: string;
  provider?: string;
  prUrl?: string | null;
  prNumber?: number | null;
  status?: string;
}

export type CreateWorkspaceRunInput = Omit<WorkspaceRunRecord, 'id' | 'createdAt'>;
export type CreateAgentRunInput = Omit<AgentRunRecord, 'id'>;
export type CreateGateRunInput = Omit<GateRunRecord, 'id'>;

export interface UpsertOrchestratorStateInput {
  mode?: OrchestratorMode;
  status?: OrchestratorStatus;
  dailyLoopBudget?: number;
  loopsStartedToday?: number;
  budgetDay?: string;
  tokenBudgetDaily?: number | null;
  tokenUsedToday?: number;
  openDraftPrLimit?: number;
  discoveryIntervalMinutes?: number;
  consecutiveFailures?: number;
  currentCandidateId?: string | null;
  currentLoopId?: string | null;
  nextDiscoveryAt?: Date | null;
  pausedReason?: string | null;
  lastStartedAt?: Date | null;
  stoppedAt?: Date | null;
}

export interface Store {
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  listProjects(): Promise<ProjectRecord[]>;
  getProject(id: string): Promise<ProjectRecord | null>;
  updateProject(id: string, patch: Partial<CreateProjectInput>): Promise<ProjectRecord | null>;

  listCandidates(projectId: string): Promise<ImprovementCandidateRecord[]>;
  getCandidate(id: string): Promise<ImprovementCandidateRecord | null>;
  findCandidateByFingerprint(projectId: string, fingerprint: string): Promise<ImprovementCandidateRecord | null>;
  createCandidate(input: CreateCandidateInput): Promise<ImprovementCandidateRecord>;
  updateCandidate(id: string, patch: Partial<ImprovementCandidateRecord>): Promise<ImprovementCandidateRecord | null>;

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

  listWorkspaceRuns(loopRunId: string): Promise<WorkspaceRunRecord[]>;
  createWorkspaceRun(input: CreateWorkspaceRunInput): Promise<WorkspaceRunRecord>;

  listAgentRuns(loopRunId: string): Promise<AgentRunRecord[]>;
  createAgentRun(input: CreateAgentRunInput): Promise<AgentRunRecord>;

  listGateRuns(loopRunId: string): Promise<GateRunRecord[]>;
  createGateRun(input: CreateGateRunInput): Promise<GateRunRecord>;

  listReports(loopRunId: string): Promise<EvalReportRecord[]>;
  getReport(id: string): Promise<EvalReportRecord | null>;
  createReport(input: Omit<EvalReportRecord, 'id' | 'createdAt'>): Promise<EvalReportRecord>;

  getPullRequest(loopRunId: string): Promise<PullRequestRecord | null>;
  countOpenDraftPullRequests(projectId: string): Promise<number>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRecord>;
  updatePullRequest(id: string, patch: Partial<PullRequestRecord>): Promise<PullRequestRecord | null>;

  getOrchestratorState(projectId: string): Promise<OrchestratorStateRecord | null>;
  listOrchestratorStates(): Promise<OrchestratorStateRecord[]>;
  upsertOrchestratorState(projectId: string, patch: UpsertOrchestratorStateInput): Promise<OrchestratorStateRecord>;
  addOrchestratorEvent(projectId: string, type: string, payload?: JsonValue): Promise<OrchestratorEventRecord>;
  listOrchestratorEvents(projectId: string, limit?: number): Promise<OrchestratorEventRecord[]>;
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

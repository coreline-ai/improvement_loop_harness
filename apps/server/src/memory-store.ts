import { randomUUID } from 'node:crypto';
import {
  ACTIVE_LOOP_STATUSES,
  type ApprovalRecord,
  type ArtifactRecord,
  type CreateApprovalInput,
  type CreateLoopInput,
  type CreateProjectInput,
  type CreatePullRequestInput,
  type CreateTaskInput,
  type EvalReportRecord,
  type JsonValue,
  type LoopEventRecord,
  type LoopRunRecord,
  type ProjectRecord,
  type PullRequestRecord,
  type Store,
  type TaskRecord
} from './types.js';

function now(): Date {
  return new Date();
}

function id(): string {
  return randomUUID();
}

function copy<T>(value: T): T {
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (Array.isArray(value)) {
    return value.map(copy) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        copy(entry)
      ])
    ) as T;
  }
  return value;
}

export class MemoryStore implements Store {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly loops = new Map<string, LoopRunRecord>();
  private readonly events = new Map<string, LoopEventRecord[]>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord[]>();
  private readonly reports = new Map<string, EvalReportRecord>();
  private readonly pullRequests = new Map<string, PullRequestRecord>();

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const record: ProjectRecord = {
      id: id(),
      name: input.name,
      repoUrl: input.repoUrl ?? null,
      localPath: input.localPath ?? null,
      defaultBranch: input.defaultBranch ?? 'main',
      evalConfigPath: input.evalConfigPath ?? 'eval.yaml',
      status: input.status ?? 'active',
      createdAt: now(),
      updatedAt: now()
    };
    this.projects.set(record.id, record);
    return copy(record);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return [...this.projects.values()].map(copy);
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    return copy(this.projects.get(id) ?? null);
  }

  async updateProject(id: string, patch: Partial<CreateProjectInput>): Promise<ProjectRecord | null> {
    const current = this.projects.get(id);
    if (!current) return null;
    const updated: ProjectRecord = { ...current, updatedAt: now() };
    if (patch.name !== undefined) updated.name = patch.name;
    if (patch.repoUrl !== undefined) updated.repoUrl = patch.repoUrl;
    if (patch.localPath !== undefined) updated.localPath = patch.localPath;
    if (patch.defaultBranch !== undefined) updated.defaultBranch = patch.defaultBranch;
    if (patch.evalConfigPath !== undefined) updated.evalConfigPath = patch.evalConfigPath;
    if (patch.status !== undefined) updated.status = patch.status;
    this.projects.set(id, updated);
    return copy(updated);
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const record: TaskRecord = {
      id: id(),
      projectId: input.projectId,
      title: input.title,
      objective: input.objective,
      status: input.status ?? 'draft',
      riskArea: input.riskArea ?? null,
      writeScope: copy(input.writeScope),
      acceptance: input.acceptance === undefined ? null : copy(input.acceptance),
      taskYaml: copy(input.taskYaml),
      createdAt: now(),
      updatedAt: now()
    };
    this.tasks.set(record.id, record);
    return copy(record);
  }

  async listTasks(projectId: string): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .filter((task) => task.projectId === projectId)
      .map(copy);
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    return copy(this.tasks.get(id) ?? null);
  }

  async updateTask(id: string, patch: Partial<Omit<CreateTaskInput, 'projectId'>>): Promise<TaskRecord | null> {
    const current = this.tasks.get(id);
    if (!current) return null;
    const updated: TaskRecord = { ...current, updatedAt: now() };
    if (patch.title !== undefined) updated.title = patch.title;
    if (patch.objective !== undefined) updated.objective = patch.objective;
    if (patch.status !== undefined) updated.status = patch.status;
    if (patch.riskArea !== undefined) updated.riskArea = patch.riskArea;
    if (patch.writeScope !== undefined) updated.writeScope = copy(patch.writeScope);
    if (patch.acceptance !== undefined) updated.acceptance = copy(patch.acceptance);
    if (patch.taskYaml !== undefined) updated.taskYaml = copy(patch.taskYaml);
    this.tasks.set(id, updated);
    return copy(updated);
  }

  async createLoop(input: CreateLoopInput): Promise<LoopRunRecord> {
    const record: LoopRunRecord = {
      id: id(),
      taskId: input.taskId,
      iteration: input.iteration,
      status: input.status,
      decision: null,
      decisionReasons: null,
      baseCommit: input.baseCommit ?? null,
      candidateCommit: null,
      artifactRoot: input.artifactRoot ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      requestHash: input.requestHash ?? null,
      startedAt: null,
      finishedAt: null,
      createdAt: now(),
      updatedAt: now()
    };
    this.loops.set(record.id, record);
    return copy(record);
  }

  async listLoops(taskId: string): Promise<LoopRunRecord[]> {
    return [...this.loops.values()]
      .filter((loop) => loop.taskId === taskId)
      .map(copy);
  }

  async getLoop(id: string): Promise<LoopRunRecord | null> {
    return copy(this.loops.get(id) ?? null);
  }

  async updateLoop(id: string, patch: Partial<LoopRunRecord>): Promise<LoopRunRecord | null> {
    const current = this.loops.get(id);
    if (!current) return null;
    const updated: LoopRunRecord = { ...current, ...patch, id, updatedAt: now() };
    this.loops.set(id, updated);
    return copy(updated);
  }

  async findLoopByIdempotency(taskId: string, key: string): Promise<LoopRunRecord | null> {
    return copy(
      [...this.loops.values()].find(
        (loop) => loop.taskId === taskId && loop.idempotencyKey === key
      ) ?? null
    );
  }

  async findActiveLoop(taskId: string): Promise<LoopRunRecord | null> {
    return copy(
      [...this.loops.values()].find(
        (loop) => loop.taskId === taskId && ACTIVE_LOOP_STATUSES.has(loop.status)
      ) ?? null
    );
  }

  async nextLoopIteration(taskId: string): Promise<number> {
    const currentMax = Math.max(
      0,
      ...[...this.loops.values()]
        .filter((loop) => loop.taskId === taskId)
        .map((loop) => loop.iteration)
    );
    return currentMax + 1;
  }

  async addLoopEvent(loopRunId: string, type: string, payload?: JsonValue): Promise<LoopEventRecord> {
    const list = this.events.get(loopRunId) ?? [];
    const record: LoopEventRecord = {
      id: id(),
      loopRunId,
      seq: list.length + 1,
      type,
      payload: payload === undefined ? null : copy(payload),
      createdAt: now()
    };
    list.push(record);
    this.events.set(loopRunId, list);
    return copy(record);
  }

  async listLoopEventsAfter(loopRunId: string, afterSeq: number): Promise<LoopEventRecord[]> {
    return (this.events.get(loopRunId) ?? [])
      .filter((event) => event.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .map(copy);
  }

  async listApprovals(): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()].map(copy);
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    return copy(this.approvals.get(id) ?? null);
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      id: id(),
      loopRunId: input.loopRunId,
      reason: input.reason,
      status: input.status ?? 'pending',
      reviewerId: null,
      decisionReason: null,
      requestedChanges: null,
      approvedAt: null,
      rejectedAt: null,
      createdAt: now(),
      updatedAt: now()
    };
    this.approvals.set(record.id, record);
    return copy(record);
  }

  async updateApproval(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const current = this.approvals.get(id);
    if (!current) return null;
    const updated: ApprovalRecord = { ...current, ...patch, id, updatedAt: now() };
    this.approvals.set(id, updated);
    return copy(updated);
  }

  async listArtifacts(loopRunId: string): Promise<ArtifactRecord[]> {
    return (this.artifacts.get(loopRunId) ?? []).map(copy);
  }

  async createArtifact(input: Omit<ArtifactRecord, 'id' | 'createdAt'>): Promise<ArtifactRecord> {
    const record: ArtifactRecord = { ...input, id: id(), createdAt: now() };
    const list = this.artifacts.get(input.loopRunId) ?? [];
    list.push(record);
    this.artifacts.set(input.loopRunId, list);
    return copy(record);
  }

  async listReports(loopRunId: string): Promise<EvalReportRecord[]> {
    return [...this.reports.values()]
      .filter((report) => report.loopRunId === loopRunId)
      .map(copy);
  }

  async getReport(id: string): Promise<EvalReportRecord | null> {
    return copy(this.reports.get(id) ?? null);
  }

  async createReport(input: Omit<EvalReportRecord, 'id' | 'createdAt'>): Promise<EvalReportRecord> {
    const record: EvalReportRecord = { ...input, id: id(), createdAt: now() };
    this.reports.set(record.id, record);
    return copy(record);
  }


  async getPullRequest(loopRunId: string): Promise<PullRequestRecord | null> {
    return copy([...this.pullRequests.values()].find((pullRequest) => pullRequest.loopRunId === loopRunId) ?? null);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRecord> {
    const record: PullRequestRecord = {
      id: id(),
      loopRunId: input.loopRunId,
      provider: input.provider ?? 'github',
      branchName: input.branchName,
      prUrl: input.prUrl ?? null,
      prNumber: input.prNumber ?? null,
      status: input.status ?? 'creating',
      createdAt: now(),
      updatedAt: now()
    };
    this.pullRequests.set(record.id, record);
    return copy(record);
  }

  async updatePullRequest(id: string, patch: Partial<PullRequestRecord>): Promise<PullRequestRecord | null> {
    const current = this.pullRequests.get(id);
    if (!current) return null;
    const updated: PullRequestRecord = { ...current, ...patch, id, updatedAt: now() };
    this.pullRequests.set(id, updated);
    return copy(updated);
  }
}

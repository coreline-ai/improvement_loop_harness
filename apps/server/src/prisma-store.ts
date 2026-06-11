import { Prisma, PrismaClient, type Approval, type Artifact, type EvalReport, type LoopEvent, type LoopRun, type Project, type PullRequest, type Task } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
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

function json(value: JsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null || value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function project(record: Project): ProjectRecord {
  return record;
}

function task(record: Task): TaskRecord {
  return {
    ...record,
    writeScope: record.writeScope,
    acceptance: record.acceptance,
    taskYaml: record.taskYaml
  };
}

function loop(record: LoopRun): LoopRunRecord {
  return {
    ...record,
    decisionReasons: record.decisionReasons
  };
}

function loopEvent(record: LoopEvent): LoopEventRecord {
  return {
    ...record,
    payload: record.payload
  };
}

function approval(record: Approval): ApprovalRecord {
  return {
    ...record,
    requestedChanges: record.requestedChanges
  };
}

function artifact(record: Artifact): ArtifactRecord {
  return record;
}

function pullRequest(record: PullRequest): PullRequestRecord {
  return record;
}

function evalReport(record: EvalReport): EvalReportRecord {
  return {
    ...record,
    reportJson: record.reportJson
  };
}

export function createPrismaClient(databaseUrl = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for PrismaStore');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export class PrismaStore implements Store {
  constructor(private readonly prisma: PrismaClient = createPrismaClient()) {}

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    return project(
      await this.prisma.project.create({
        data: {
          name: input.name,
          ...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {}),
          ...(input.localPath !== undefined ? { localPath: input.localPath } : {}),
          ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
          ...(input.evalConfigPath ? { evalConfigPath: input.evalConfigPath } : {}),
          ...(input.status ? { status: input.status } : {})
        }
      })
    );
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return (await this.prisma.project.findMany({ orderBy: { createdAt: 'asc' } })).map(project);
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    const record = await this.prisma.project.findUnique({ where: { id } });
    return record ? project(record) : null;
  }

  async updateProject(id: string, patch: Partial<CreateProjectInput>): Promise<ProjectRecord | null> {
    try {
      return project(
        await this.prisma.project.update({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl } : {}),
            ...(patch.localPath !== undefined ? { localPath: patch.localPath } : {}),
            ...(patch.defaultBranch !== undefined ? { defaultBranch: patch.defaultBranch } : {}),
            ...(patch.evalConfigPath !== undefined ? { evalConfigPath: patch.evalConfigPath } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {})
          }
        })
      );
    } catch {
      return null;
    }
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    return task(
      await this.prisma.task.create({
        data: {
          projectId: input.projectId,
          title: input.title,
          objective: input.objective,
          ...(input.status ? { status: input.status } : {}),
          ...(input.riskArea !== undefined ? { riskArea: input.riskArea } : {}),
          writeScope: json(input.writeScope),
          ...(input.acceptance !== undefined ? { acceptance: json(input.acceptance) } : {}),
          taskYaml: json(input.taskYaml)
        }
      })
    );
  }

  async listTasks(projectId: string): Promise<TaskRecord[]> {
    return (await this.prisma.task.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })).map(task);
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const record = await this.prisma.task.findUnique({ where: { id } });
    return record ? task(record) : null;
  }

  async updateTask(id: string, patch: Partial<Omit<CreateTaskInput, 'projectId'>>): Promise<TaskRecord | null> {
    try {
      return task(
        await this.prisma.task.update({
          where: { id },
          data: {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.riskArea !== undefined ? { riskArea: patch.riskArea } : {}),
            ...(patch.writeScope !== undefined ? { writeScope: json(patch.writeScope) } : {}),
            ...(patch.acceptance !== undefined ? { acceptance: json(patch.acceptance) } : {}),
            ...(patch.taskYaml !== undefined ? { taskYaml: json(patch.taskYaml) } : {})
          }
        })
      );
    } catch {
      return null;
    }
  }

  async createLoop(input: CreateLoopInput): Promise<LoopRunRecord> {
    return loop(
      await this.prisma.loopRun.create({
        data: {
          taskId: input.taskId,
          iteration: input.iteration,
          status: input.status,
          ...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
          ...(input.artifactRoot !== undefined ? { artifactRoot: input.artifactRoot } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.requestHash !== undefined ? { requestHash: input.requestHash } : {})
        }
      })
    );
  }

  async listLoops(taskId: string): Promise<LoopRunRecord[]> {
    return (await this.prisma.loopRun.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } })).map(loop);
  }

  async getLoop(id: string): Promise<LoopRunRecord | null> {
    const record = await this.prisma.loopRun.findUnique({ where: { id } });
    return record ? loop(record) : null;
  }

  async updateLoop(id: string, patch: Partial<LoopRunRecord>): Promise<LoopRunRecord | null> {
    try {
      return loop(
        await this.prisma.loopRun.update({
          where: { id },
          data: {
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
            ...(patch.decisionReasons !== undefined ? { decisionReasons: json(patch.decisionReasons) } : {}),
            ...(patch.baseCommit !== undefined ? { baseCommit: patch.baseCommit } : {}),
            ...(patch.candidateCommit !== undefined ? { candidateCommit: patch.candidateCommit } : {}),
            ...(patch.artifactRoot !== undefined ? { artifactRoot: patch.artifactRoot } : {}),
            ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
            ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {})
          }
        })
      );
    } catch {
      return null;
    }
  }

  async findLoopByIdempotency(taskId: string, key: string): Promise<LoopRunRecord | null> {
    const record = await this.prisma.loopRun.findFirst({ where: { taskId, idempotencyKey: key } });
    return record ? loop(record) : null;
  }

  async findActiveLoop(taskId: string): Promise<LoopRunRecord | null> {
    const record = await this.prisma.loopRun.findFirst({
      where: { taskId, status: { in: [...ACTIVE_LOOP_STATUSES] } },
      orderBy: { createdAt: 'asc' }
    });
    return record ? loop(record) : null;
  }

  async nextLoopIteration(taskId: string): Promise<number> {
    const aggregate = await this.prisma.loopRun.aggregate({ where: { taskId }, _max: { iteration: true } });
    return (aggregate._max.iteration ?? 0) + 1;
  }

  async addLoopEvent(loopRunId: string, type: string, payload?: JsonValue): Promise<LoopEventRecord> {
    const count = await this.prisma.loopEvent.count({ where: { loopRunId } });
    return loopEvent(
      await this.prisma.loopEvent.create({
        data: {
          loopRunId,
          seq: count + 1,
          type,
          ...(payload !== undefined ? { payload: json(payload) } : {})
        }
      })
    );
  }

  async listLoopEventsAfter(loopRunId: string, afterSeq: number): Promise<LoopEventRecord[]> {
    return (
      await this.prisma.loopEvent.findMany({
        where: { loopRunId, seq: { gt: afterSeq } },
        orderBy: { seq: 'asc' }
      })
    ).map(loopEvent);
  }

  async listApprovals(): Promise<ApprovalRecord[]> {
    return (await this.prisma.approval.findMany({ orderBy: { createdAt: 'asc' } })).map(approval);
  }

  async getApproval(id: string): Promise<ApprovalRecord | null> {
    const record = await this.prisma.approval.findUnique({ where: { id } });
    return record ? approval(record) : null;
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRecord> {
    return approval(
      await this.prisma.approval.create({
        data: {
          loopRunId: input.loopRunId,
          reason: input.reason,
          ...(input.status ? { status: input.status } : {})
        }
      })
    );
  }

  async updateApproval(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    try {
      return approval(
        await this.prisma.approval.update({
          where: { id },
          data: {
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.reviewerId !== undefined ? { reviewerId: patch.reviewerId } : {}),
            ...(patch.decisionReason !== undefined ? { decisionReason: patch.decisionReason } : {}),
            ...(patch.requestedChanges !== undefined ? { requestedChanges: json(patch.requestedChanges) } : {}),
            ...(patch.approvedAt !== undefined ? { approvedAt: patch.approvedAt } : {}),
            ...(patch.rejectedAt !== undefined ? { rejectedAt: patch.rejectedAt } : {})
          }
        })
      );
    } catch {
      return null;
    }
  }

  async listArtifacts(loopRunId: string): Promise<ArtifactRecord[]> {
    return (await this.prisma.artifact.findMany({ where: { loopRunId }, orderBy: { createdAt: 'asc' } })).map(artifact);
  }

  async createArtifact(input: Omit<ArtifactRecord, 'id' | 'createdAt'>): Promise<ArtifactRecord> {
    return artifact(
      await this.prisma.artifact.create({
        data: {
          loopRunId: input.loopRunId,
          kind: input.kind,
          path: input.path,
          ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
          ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
          redacted: input.redacted
        }
      })
    );
  }

  async listReports(loopRunId: string): Promise<EvalReportRecord[]> {
    return (await this.prisma.evalReport.findMany({ where: { loopRunId }, orderBy: { createdAt: 'asc' } })).map(evalReport);
  }

  async getReport(id: string): Promise<EvalReportRecord | null> {
    const record = await this.prisma.evalReport.findUnique({ where: { id } });
    return record ? evalReport(record) : null;
  }

  async createReport(input: Omit<EvalReportRecord, 'id' | 'createdAt'>): Promise<EvalReportRecord> {
    return evalReport(
      await this.prisma.evalReport.create({
        data: {
          loopRunId: input.loopRunId,
          type: input.type,
          status: input.status,
          reportJson: json(input.reportJson),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.artifactRef !== undefined ? { artifactRef: input.artifactRef } : {})
        }
      })
    );
  }


  async getPullRequest(loopRunId: string): Promise<PullRequestRecord | null> {
    const record = await this.prisma.pullRequest.findFirst({ where: { loopRunId }, orderBy: { createdAt: 'asc' } });
    return record ? pullRequest(record) : null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRecord> {
    return pullRequest(
      await this.prisma.pullRequest.create({
        data: {
          loopRunId: input.loopRunId,
          branchName: input.branchName,
          provider: input.provider ?? 'github',
          ...(input.prUrl !== undefined ? { prUrl: input.prUrl } : {}),
          ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
          status: input.status ?? 'creating'
        }
      })
    );
  }

  async updatePullRequest(id: string, patch: Partial<PullRequestRecord>): Promise<PullRequestRecord | null> {
    try {
      return pullRequest(
        await this.prisma.pullRequest.update({
          where: { id },
          data: {
            ...(patch.branchName !== undefined ? { branchName: patch.branchName } : {}),
            ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
            ...(patch.prUrl !== undefined ? { prUrl: patch.prUrl } : {}),
            ...(patch.prNumber !== undefined ? { prNumber: patch.prNumber } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {})
          }
        })
      );
    } catch {
      return null;
    }
  }
}

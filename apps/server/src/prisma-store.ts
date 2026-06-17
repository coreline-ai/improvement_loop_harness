import { Prisma, PrismaClient, type AgentRun, type Approval, type Artifact, type EvalReport, type GateRun, type ImprovementCandidate, type LoopEvent, type LoopRun, type OrchestratorEvent, type OrchestratorState, type Project, type PullRequest, type Task, type WorkspaceRun } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ACTIVE_LOOP_STATUSES,
  type CreateActiveLoopInput,
  type AgentRunRecord,
  type ApprovalRecord,
  type ArtifactRecord,
  type CreateApprovalInput,
  type CreateAgentRunInput,
  type CreateCandidateInput,
  type CreateGateRunInput,
  type CreateLoopInput,
  type CreateProjectInput,
  type CreatePullRequestInput,
  type CreateTaskInput,
  type CreateWorkspaceRunInput,
  type EvalReportRecord,
  type GateRunRecord,
  type ImprovementCandidateRecord,
  type JsonValue,
  type LoopEventRecord,
  type LoopRunRecord,
  type OrchestratorEventRecord,
  type OrchestratorStateRecord,
  type ProjectRecord,
  type PullRequestRecord,
  type Store,
  type UpsertOrchestratorStateInput,
  type WorkspaceRunRecord,
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

function workspaceRun(record: WorkspaceRun): WorkspaceRunRecord {
  return record;
}

function agentRun(record: AgentRun): AgentRunRecord {
  return record;
}

function gateRun(record: GateRun): GateRunRecord {
  return { ...record, lane: 'lane' in record ? record.lane : 'local' };
}

function improvementCandidate(record: ImprovementCandidate): ImprovementCandidateRecord {
  return {
    ...record,
    evidenceRefs: record.evidenceRefs,
    injectionIndicators: record.injectionIndicators
  };
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

function orchestratorState(record: OrchestratorState): OrchestratorStateRecord {
  return {
    ...record,
    mode: record.mode === 'auto' ? 'auto' : 'supervised',
    status: ['stopped', 'running', 'paused', 'stopping'].includes(record.status)
      ? (record.status as OrchestratorStateRecord['status'])
      : 'stopped'
  };
}

function orchestratorEvent(record: OrchestratorEvent): OrchestratorEventRecord {
  return {
    ...record,
    payload: record.payload
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    (typeof error === 'object' && error !== null && 'code' in error)
  ) && (error as { code?: unknown }).code === 'P2002';
}

export function createPrismaClient(databaseUrl = process.env.DATABASE_URL): PrismaClient {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for PrismaStore');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export class PrismaStore implements Store {
  constructor(private readonly prisma: PrismaClient = createPrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

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


  async listCandidates(projectId: string): Promise<ImprovementCandidateRecord[]> {
    return (
      await this.prisma.improvementCandidate.findMany({
        where: { projectId },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }]
      })
    ).map(improvementCandidate);
  }

  async getCandidate(id: string): Promise<ImprovementCandidateRecord | null> {
    const record = await this.prisma.improvementCandidate.findUnique({ where: { id } });
    return record ? improvementCandidate(record) : null;
  }

  async findCandidateByFingerprint(projectId: string, fingerprint: string): Promise<ImprovementCandidateRecord | null> {
    const record = await this.prisma.improvementCandidate.findUnique({
      where: { projectId_fingerprint: { projectId, fingerprint } }
    });
    return record ? improvementCandidate(record) : null;
  }

  async createCandidate(input: CreateCandidateInput): Promise<ImprovementCandidateRecord> {
    try {
      return improvementCandidate(
        await this.prisma.improvementCandidate.create({
          data: {
            projectId: input.projectId,
            source: input.source,
            fingerprint: input.fingerprint,
            title: input.title,
            ...(input.evidenceRefs !== undefined ? { evidenceRefs: json(input.evidenceRefs) } : {}),
            ...(input.riskAreaHint !== undefined ? { riskAreaHint: input.riskAreaHint } : {}),
            ...(input.trustLevel !== undefined ? { trustLevel: input.trustLevel } : {}),
            ...(input.injectionIndicators !== undefined ? { injectionIndicators: json(input.injectionIndicators) } : {}),
            ...(input.reproCommand !== undefined ? { reproCommand: input.reproCommand } : {}),
            priority: input.priority ?? 0,
            status: input.status ?? 'proposed'
          }
        })
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new Error(
          `candidate fingerprint already exists for project ${input.projectId}: ${input.fingerprint}`
        );
      }
      throw error;
    }
  }

  async updateCandidate(id: string, patch: Partial<ImprovementCandidateRecord>): Promise<ImprovementCandidateRecord | null> {
    try {
      return improvementCandidate(
        await this.prisma.improvementCandidate.update({
          where: { id },
          data: {
            ...(patch.source !== undefined ? { source: patch.source } : {}),
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.evidenceRefs !== undefined ? { evidenceRefs: json(patch.evidenceRefs) } : {}),
            ...(patch.riskAreaHint !== undefined ? { riskAreaHint: patch.riskAreaHint } : {}),
            ...(patch.trustLevel !== undefined ? { trustLevel: patch.trustLevel } : {}),
            ...(patch.injectionIndicators !== undefined ? { injectionIndicators: json(patch.injectionIndicators) } : {}),
            ...(patch.reproCommand !== undefined ? { reproCommand: patch.reproCommand } : {}),
            ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.dismissReason !== undefined ? { dismissReason: patch.dismissReason } : {}),
            ...(patch.taskId !== undefined ? { taskId: patch.taskId } : {})
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
          ...(input.agentSpec !== undefined ? { agentSpec: input.agentSpec } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.requestHash !== undefined ? { requestHash: input.requestHash } : {})
        }
      })
    );
  }

  async createLoopIfNoActive(input: CreateActiveLoopInput): Promise<LoopRunRecord | null> {
    const record = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${input.taskId} FOR UPDATE`;
      const active = await tx.loopRun.findFirst({
        where: { taskId: input.taskId, status: { in: [...ACTIVE_LOOP_STATUSES] } },
        orderBy: { createdAt: 'asc' }
      });
      if (active) {
        return null;
      }
      const aggregate = await tx.loopRun.aggregate({
        where: { taskId: input.taskId },
        _max: { iteration: true }
      });
      return tx.loopRun.create({
        data: {
          taskId: input.taskId,
          iteration: (aggregate._max.iteration ?? 0) + 1,
          status: input.status,
          ...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
          ...(input.artifactRoot !== undefined ? { artifactRoot: input.artifactRoot } : {}),
          ...(input.agentSpec !== undefined ? { agentSpec: input.agentSpec } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.requestHash !== undefined ? { requestHash: input.requestHash } : {})
        }
      });
    });
    return record ? loop(record) : null;
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
            ...(patch.agentSpec !== undefined ? { agentSpec: patch.agentSpec } : {}),
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const record = await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "LoopRun" WHERE id = ${loopRunId} FOR UPDATE`;
          const aggregate = await tx.loopEvent.aggregate({ where: { loopRunId }, _max: { seq: true } });
          return tx.loopEvent.create({
            data: {
              loopRunId,
              seq: (aggregate._max.seq ?? 0) + 1,
              type,
              ...(payload !== undefined ? { payload: json(payload) } : {})
            }
          });
        });
        return loopEvent(record);
      } catch (error) {
        if (isUniqueConstraintError(error) && attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, attempt + 1));
          continue;
        }
        throw error;
      }
    }
    throw new Error('failed to create loop event after retries');
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

  async listWorkspaceRuns(loopRunId: string): Promise<WorkspaceRunRecord[]> {
    return (await this.prisma.workspaceRun.findMany({ where: { loopRunId }, orderBy: { createdAt: 'asc' } })).map(workspaceRun);
  }

  async createWorkspaceRun(input: CreateWorkspaceRunInput): Promise<WorkspaceRunRecord> {
    return workspaceRun(
      await this.prisma.workspaceRun.create({
        data: {
          loopRunId: input.loopRunId,
          kind: input.kind,
          path: input.path,
          baseCommit: input.baseCommit,
          status: input.status,
          ...(input.cleanedAt !== undefined ? { cleanedAt: input.cleanedAt } : {})
        }
      })
    );
  }

  async listAgentRuns(loopRunId: string): Promise<AgentRunRecord[]> {
    return (await this.prisma.agentRun.findMany({ where: { loopRunId }, orderBy: { startedAt: 'asc' } })).map(agentRun);
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    return agentRun(
      await this.prisma.agentRun.create({
        data: {
          loopRunId: input.loopRunId,
          agentType: input.agentType,
          command: input.command,
          ...(input.model !== undefined ? { model: input.model } : {}),
          status: input.status,
          ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
          ...(input.stdoutRef !== undefined ? { stdoutRef: input.stdoutRef } : {}),
          ...(input.stderrRef !== undefined ? { stderrRef: input.stderrRef } : {}),
          startedAt: input.startedAt,
          ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {})
        }
      })
    );
  }

  async listGateRuns(loopRunId: string): Promise<GateRunRecord[]> {
    return (await this.prisma.gateRun.findMany({ where: { loopRunId }, orderBy: { startedAt: 'asc' } })).map(gateRun);
  }

  async createGateRun(input: CreateGateRunInput): Promise<GateRunRecord> {
    return gateRun(
      await this.prisma.gateRun.create({
        data: {
          loopRunId: input.loopRunId,
          name: input.name,
          type: input.type,
          required: input.required,
          lane: input.lane ?? 'local',
          command: input.command,
          status: input.status,
          ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
          ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
          ...(input.stdoutRef !== undefined ? { stdoutRef: input.stdoutRef } : {}),
          ...(input.stderrRef !== undefined ? { stderrRef: input.stderrRef } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          startedAt: input.startedAt,
          ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {})
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

  async countOpenDraftPullRequests(projectId: string): Promise<number> {
    return this.prisma.pullRequest.count({
      where: {
        status: 'draft_created',
        loopRun: { task: { projectId } }
      }
    });
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

  async getOrchestratorState(projectId: string): Promise<OrchestratorStateRecord | null> {
    const record = await this.prisma.orchestratorState.findUnique({ where: { projectId } });
    return record ? orchestratorState(record) : null;
  }

  async listOrchestratorStates(): Promise<OrchestratorStateRecord[]> {
    return (await this.prisma.orchestratorState.findMany({ orderBy: { createdAt: 'asc' } })).map(orchestratorState);
  }

  async upsertOrchestratorState(projectId: string, patch: UpsertOrchestratorStateInput): Promise<OrchestratorStateRecord> {
    return orchestratorState(
      await this.prisma.orchestratorState.upsert({
        where: { projectId },
        update: {
          ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.dailyLoopBudget !== undefined ? { dailyLoopBudget: patch.dailyLoopBudget } : {}),
          ...(patch.loopsStartedToday !== undefined ? { loopsStartedToday: patch.loopsStartedToday } : {}),
          ...(patch.budgetDay !== undefined ? { budgetDay: patch.budgetDay } : {}),
          ...(patch.tokenBudgetDaily !== undefined ? { tokenBudgetDaily: patch.tokenBudgetDaily } : {}),
          ...(patch.tokenUsedToday !== undefined ? { tokenUsedToday: patch.tokenUsedToday } : {}),
          ...(patch.openDraftPrLimit !== undefined ? { openDraftPrLimit: patch.openDraftPrLimit } : {}),
          ...(patch.discoveryIntervalMinutes !== undefined ? { discoveryIntervalMinutes: patch.discoveryIntervalMinutes } : {}),
          ...(patch.consecutiveFailures !== undefined ? { consecutiveFailures: patch.consecutiveFailures } : {}),
          ...(patch.currentCandidateId !== undefined ? { currentCandidateId: patch.currentCandidateId } : {}),
          ...(patch.currentLoopId !== undefined ? { currentLoopId: patch.currentLoopId } : {}),
          ...(patch.nextDiscoveryAt !== undefined ? { nextDiscoveryAt: patch.nextDiscoveryAt } : {}),
          ...(patch.pausedReason !== undefined ? { pausedReason: patch.pausedReason } : {}),
          ...(patch.lastStartedAt !== undefined ? { lastStartedAt: patch.lastStartedAt } : {}),
          ...(patch.stoppedAt !== undefined ? { stoppedAt: patch.stoppedAt } : {})
        },
        create: {
          projectId,
          mode: patch.mode ?? 'supervised',
          status: patch.status ?? 'stopped',
          dailyLoopBudget: patch.dailyLoopBudget ?? 20,
          loopsStartedToday: patch.loopsStartedToday ?? 0,
          budgetDay: patch.budgetDay ?? new Date().toISOString().slice(0, 10),
          tokenBudgetDaily: patch.tokenBudgetDaily ?? null,
          tokenUsedToday: patch.tokenUsedToday ?? 0,
          openDraftPrLimit: patch.openDraftPrLimit ?? 5,
          discoveryIntervalMinutes: patch.discoveryIntervalMinutes ?? 30,
          consecutiveFailures: patch.consecutiveFailures ?? 0,
          currentCandidateId: patch.currentCandidateId ?? null,
          currentLoopId: patch.currentLoopId ?? null,
          nextDiscoveryAt: patch.nextDiscoveryAt ?? null,
          pausedReason: patch.pausedReason ?? null,
          lastStartedAt: patch.lastStartedAt ?? null,
          stoppedAt: patch.stoppedAt ?? null
        }
      })
    );
  }

  async addOrchestratorEvent(projectId: string, type: string, payload?: JsonValue): Promise<OrchestratorEventRecord> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const record = await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE`;
          const aggregate = await tx.orchestratorEvent.aggregate({ where: { projectId }, _max: { seq: true } });
          return tx.orchestratorEvent.create({
            data: {
              projectId,
              seq: (aggregate._max.seq ?? 0) + 1,
              type,
              ...(payload !== undefined ? { payload: json(payload) } : {})
            }
          });
        });
        return orchestratorEvent(record);
      } catch (error) {
        if (isUniqueConstraintError(error) && attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, attempt + 1));
          continue;
        }
        throw error;
      }
    }
    throw new Error('failed to create orchestrator event after retries');
  }

  async listOrchestratorEvents(projectId: string, limit = 50): Promise<OrchestratorEventRecord[]> {
    return (
      await this.prisma.orchestratorEvent.findMany({
        where: { projectId },
        orderBy: { seq: 'desc' },
        take: limit
      })
    ).reverse().map(orchestratorEvent);
  }

}

-- Phase 13 initial PostgreSQL schema. Generated from docs/DB_SCHEMA.md,
-- excluding MVP-4 ImprovementCandidate until Phase 16.
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT,
    "localPath" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "evalConfigPath" TEXT NOT NULL DEFAULT 'eval.yaml',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "riskArea" TEXT,
    "writeScope" JSONB NOT NULL,
    "acceptance" JSONB,
    "taskYaml" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoopRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "decision" TEXT,
    "decisionReasons" JSONB,
    "baseCommit" TEXT,
    "candidateCommit" TEXT,
    "artifactRoot" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LoopRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoopEvent" (
    "id" TEXT NOT NULL,
    "loopRunId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoopEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkspaceRun" (
    "id" TEXT NOT NULL,
    "loopRunId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "baseCommit" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleanedAt" TIMESTAMP(3),
    CONSTRAINT "WorkspaceRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "loopRunId" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "exitCode" INTEGER,
    "stdoutRef" TEXT,
    "stderrRef" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GateRun" (
    "id" TEXT NOT NULL,
    "loopRunId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "command" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "exitCode" INTEGER,
    "durationMs" INTEGER,
    "stdoutRef" TEXT,
    "stderrRef" TEXT,
    "summary" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "GateRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EvalReport" (
    "id" TEXT NOT NULL,
    "loopRunId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reportJson" JSONB NOT NULL,
    "summary" TEXT,
    "artifactRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvalReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "loopRunId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT,
    "sizeBytes" INTEGER,
    "redacted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "loopRunId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewerId" TEXT,
    "decisionReason" TEXT,
    "requestedChanges" JSONB,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "loopRunId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "branchName" TEXT NOT NULL,
    "prUrl" TEXT,
    "prNumber" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SkillVersion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Learning" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "sourceLoopId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "evidenceRefs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    CONSTRAINT "Learning_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoopRun_taskId_idempotencyKey_key" ON "LoopRun"("taskId", "idempotencyKey");
CREATE UNIQUE INDEX "LoopEvent_loopRunId_seq_key" ON "LoopEvent"("loopRunId", "seq");

ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoopRun" ADD CONSTRAINT "LoopRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoopEvent" ADD CONSTRAINT "LoopEvent_loopRunId_fkey" FOREIGN KEY ("loopRunId") REFERENCES "LoopRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkspaceRun" ADD CONSTRAINT "WorkspaceRun_loopRunId_fkey" FOREIGN KEY ("loopRunId") REFERENCES "LoopRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_loopRunId_fkey" FOREIGN KEY ("loopRunId") REFERENCES "LoopRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GateRun" ADD CONSTRAINT "GateRun_loopRunId_fkey" FOREIGN KEY ("loopRunId") REFERENCES "LoopRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvalReport" ADD CONSTRAINT "EvalReport_loopRunId_fkey" FOREIGN KEY ("loopRunId") REFERENCES "LoopRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_loopRunId_fkey" FOREIGN KEY ("loopRunId") REFERENCES "LoopRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_loopRunId_fkey" FOREIGN KEY ("loopRunId") REFERENCES "LoopRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_loopRunId_fkey" FOREIGN KEY ("loopRunId") REFERENCES "LoopRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Learning" ADD CONSTRAINT "Learning_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

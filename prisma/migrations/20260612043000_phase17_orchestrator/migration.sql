-- Phase 17 Loop Orchestrator state and project-level guardrail events.
CREATE TABLE "OrchestratorState" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'supervised',
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "dailyLoopBudget" INTEGER NOT NULL DEFAULT 20,
    "loopsStartedToday" INTEGER NOT NULL DEFAULT 0,
    "budgetDay" TEXT NOT NULL,
    "tokenBudgetDaily" INTEGER,
    "tokenUsedToday" INTEGER NOT NULL DEFAULT 0,
    "openDraftPrLimit" INTEGER NOT NULL DEFAULT 5,
    "discoveryIntervalMinutes" INTEGER NOT NULL DEFAULT 30,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "currentCandidateId" TEXT,
    "currentLoopId" TEXT,
    "nextDiscoveryAt" TIMESTAMP(3),
    "pausedReason" TEXT,
    "lastStartedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrchestratorState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrchestratorEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrchestratorEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrchestratorState_projectId_key" ON "OrchestratorState"("projectId");
CREATE UNIQUE INDEX "OrchestratorEvent_projectId_seq_key" ON "OrchestratorEvent"("projectId", "seq");

ALTER TABLE "OrchestratorState" ADD CONSTRAINT "OrchestratorState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrchestratorEvent" ADD CONSTRAINT "OrchestratorEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

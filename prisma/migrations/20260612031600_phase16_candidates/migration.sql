-- Phase 16 ImprovementCandidate queue for autonomous discovery.
CREATE TABLE "ImprovementCandidate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "evidenceRefs" JSONB,
    "riskAreaHint" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "dismissReason" TEXT,
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImprovementCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImprovementCandidate_projectId_fingerprint_key" ON "ImprovementCandidate"("projectId", "fingerprint");

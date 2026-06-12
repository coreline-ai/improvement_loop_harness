ALTER TABLE "ImprovementCandidate" ADD COLUMN "trustLevel" TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE "ImprovementCandidate" ADD COLUMN "injectionIndicators" JSONB;
ALTER TABLE "ImprovementCandidate" ADD COLUMN "reproCommand" TEXT;

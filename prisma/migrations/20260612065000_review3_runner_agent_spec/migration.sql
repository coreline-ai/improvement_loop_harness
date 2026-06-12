-- Review 3 follow-up: persist per-loop agent spec so the production runner can replay the exact agent selection.
ALTER TABLE "LoopRun" ADD COLUMN "agentSpec" TEXT;

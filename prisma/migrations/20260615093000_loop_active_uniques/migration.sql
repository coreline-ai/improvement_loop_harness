CREATE UNIQUE INDEX "LoopRun_taskId_iteration_key" ON "LoopRun"("taskId", "iteration");

CREATE UNIQUE INDEX "LoopRun_one_active_per_task_key" ON "LoopRun"("taskId")
WHERE "status" IN (
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
);

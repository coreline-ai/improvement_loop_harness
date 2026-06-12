import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { createPrismaClient, PrismaStore } from './prisma-store.js';
import type { Store } from './types.js';

interface StoreHarness {
  name: string;
  create(): Promise<{ store: Store; cleanup(): Promise<void> }>;
}

const TRUNCATE_SQL = [
  'TRUNCATE TABLE',
  '"OrchestratorEvent", "OrchestratorState", "PullRequest", "Artifact", "EvalReport",',
  '"GateRun", "AgentRun", "WorkspaceRun", "Approval", "LoopEvent", "LoopRun",',
  '"Task", "ImprovementCandidate", "Learning", "SkillVersion", "Project"',
  'RESTART IDENTITY CASCADE'
].join(' ');

const harnesses: StoreHarness[] = [
  {
    name: 'MemoryStore',
    create: async () => ({ store: new MemoryStore(), cleanup: async () => undefined })
  }
];

if (process.env.TEST_DATABASE_URL) {
  harnesses.push({
    name: 'PrismaStore',
    create: async () => {
      const prisma = createPrismaClient(process.env.TEST_DATABASE_URL);
      await prisma.$executeRawUnsafe(TRUNCATE_SQL);
      return {
        store: new PrismaStore(prisma),
        cleanup: async () => {
          await prisma.$executeRawUnsafe(TRUNCATE_SQL).catch(() => undefined);
          await prisma.$disconnect();
        }
      };
    }
  });
} else {
  console.warn('TEST_DATABASE_URL is not set; PrismaStore contract tests are skipped');
}

async function seedProjectTask(store: Store) {
  const project = await store.createProject({ name: 'contract project', localPath: '/tmp/contract' });
  const task = await store.createTask({
    projectId: project.id,
    title: 'Contract task',
    objective: 'Exercise the Store contract',
    status: 'ready',
    riskArea: 'none',
    writeScope: { allowed: ['src/'] },
    taskYaml: {
      schema_version: '1.0',
      id: 'contract-task',
      title: 'Contract task',
      objective: 'Exercise the Store contract',
      write_scope: { allowed: ['src/'] },
      required_evidence: []
    }
  });
  return { project, task };
}

describe.each(harnesses)('$name contract', (harness) => {
  it('persists project/task/loop records, execution rows, candidates, PRs, and orchestrator state consistently', async () => {
    const { store, cleanup } = await harness.create();
    try {
      const { project, task } = await seedProjectTask(store);
      const loop = await store.createLoop({
        taskId: task.id,
        iteration: await store.nextLoopIteration(task.id),
        status: 'queued',
        baseCommit: 'base-1',
        agentSpec: 'mock:/tmp/scenario.json',
        idempotencyKey: 'idem-1',
        requestHash: 'hash-1'
      });

      expect(await store.findLoopByIdempotency(task.id, 'idem-1')).toMatchObject({ id: loop.id, requestHash: 'hash-1' });
      expect(await store.findActiveLoop(task.id)).toMatchObject({ id: loop.id });
      await store.updateLoop(loop.id, { status: 'accepted', decision: 'accept', candidateCommit: 'candidate-1' });
      expect(await store.findActiveLoop(task.id)).toBeNull();

      await store.addLoopEvent(loop.id, 'loop.queued', { status: 'queued' });
      await store.addLoopEvent(loop.id, 'loop.completed', { status: 'accepted' });
      expect((await store.listLoopEventsAfter(loop.id, 0)).map((event) => event.seq)).toEqual([1, 2]);

      await store.createWorkspaceRun({
        loopRunId: loop.id,
        kind: 'git_worktree',
        path: '/tmp/worktree',
        baseCommit: 'base-1',
        status: 'cleaned',
        cleanedAt: new Date()
      });
      await store.createAgentRun({
        loopRunId: loop.id,
        agentType: 'mock',
        command: 'mock:/tmp/scenario.json',
        status: 'accepted',
        exitCode: 0,
        stdoutRef: 'logs/agent.stdout.log',
        stderrRef: 'logs/agent.stderr.log',
        startedAt: new Date(),
        finishedAt: new Date()
      });
      await store.createGateRun({
        loopRunId: loop.id,
        name: 'unit_tests',
        type: 'task_acceptance',
        required: true,
        command: 'node tests/regression.test.js',
        status: 'pass',
        exitCode: 0,
        durationMs: 12,
        stdoutRef: 'logs/gates/unit.stdout.log',
        stderrRef: 'logs/gates/unit.stderr.log',
        summary: 'ok',
        startedAt: new Date(),
        finishedAt: new Date()
      });
      await store.createArtifact({
        loopRunId: loop.id,
        kind: 'report',
        path: 'reports/eval-report.json',
        sha256: 'abc',
        sizeBytes: 123,
        redacted: false
      });
      await store.createReport({
        loopRunId: loop.id,
        type: 'eval',
        status: 'accepted',
        reportJson: { decision: 'accept' },
        summary: 'accepted',
        artifactRef: 'reports/eval-report.json'
      });

      expect(await store.listWorkspaceRuns(loop.id)).toHaveLength(1);
      expect(await store.listAgentRuns(loop.id)).toHaveLength(1);
      expect(await store.listGateRuns(loop.id)).toHaveLength(1);
      expect(await store.listArtifacts(loop.id)).toHaveLength(1);
      expect(await store.listReports(loop.id)).toHaveLength(1);

      const candidate = await store.createCandidate({
        projectId: project.id,
        source: 'manual',
        fingerprint: 'same-fingerprint',
        title: 'Candidate one',
        status: 'proposed'
      });
      await store.updateCandidate(candidate.id, { status: 'dismissed', dismissReason: 'not_relevant' });
      expect(await store.findCandidateByFingerprint(project.id, 'same-fingerprint')).toMatchObject({
        id: candidate.id,
        status: 'dismissed'
      });
      await expect(
        store.createCandidate({
          projectId: project.id,
          source: 'manual',
          fingerprint: 'same-fingerprint',
          title: 'Duplicate candidate'
        })
      ).rejects.toThrow();

      await store.createPullRequest({ loopRunId: loop.id, branchName: 'vibeloop/contract', status: 'draft_created' });
      expect(await store.countOpenDraftPullRequests(project.id)).toBe(1);

      const state = await store.upsertOrchestratorState(project.id, { status: 'running', tokenBudgetDaily: 1000 });
      await store.addOrchestratorEvent(project.id, 'orchestrator.started', { mode: state.mode });
      expect(await store.getOrchestratorState(project.id)).toMatchObject({ status: 'running' });
      expect((await store.listOrchestratorEvents(project.id)).map((event) => event.seq)).toEqual([1]);
    } finally {
      await cleanup();
    }
  });

  it('assigns monotonic loop event seq values under concurrent writes', async () => {
    const { store, cleanup } = await harness.create();
    try {
      const { task } = await seedProjectTask(store);
      const loop = await store.createLoop({ taskId: task.id, iteration: 1, status: 'queued' });
      await Promise.all(Array.from({ length: 10 }, (_, index) => store.addLoopEvent(loop.id, `event.${index}`)));
      expect((await store.listLoopEventsAfter(loop.id, 0)).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      await cleanup();
    }
  });
});

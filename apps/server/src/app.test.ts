import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { CreatedPullRequest, PullRequestCreationContext, PullRequestManager } from './routes/pull-requests.js';
import { MemoryStore } from './memory-store.js';
import type { LoopRunnerInput, LoopRunnerResult } from './queue.js';
import type { LoopRunRecord, Store, TaskRecord } from './types.js';

const TOKEN = 'test-token';

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function seedProjectTask(store: Store): Promise<{ task: TaskRecord }> {
  const project = await store.createProject({ name: 'fixture', localPath: '/tmp/repo' });
  const taskYaml = {
    schema_version: '1.0',
    id: 'task-fixture',
    title: 'Fix one low risk bug',
    objective: 'Update one value and add regression test',
    risk_area: 'none',
    write_scope: { allowed: ['src/', 'tests/'] },
    required_evidence: ['adds_regression_test']
  };
  const task = await store.createTask({
    projectId: project.id,
    title: taskYaml.title,
    objective: taskYaml.objective,
    riskArea: taskYaml.risk_area,
    writeScope: taskYaml.write_scope,
    taskYaml
  });
  return { task };
}

async function seedLoop(
  store: Store,
  status = 'queued',
  artifactRoot?: string
): Promise<{ task: TaskRecord; loop: LoopRunRecord }> {
  const { task } = await seedProjectTask(store);
  const loop = await store.createLoop({
    taskId: task.id,
    iteration: 1,
    status,
    ...(artifactRoot ? { artifactRoot } : {})
  });
  return { task, loop };
}


class FakePullRequestManager implements PullRequestManager {
  calls = 0;
  createdPrCount = 0;
  failNext = false;

  async create(context: PullRequestCreationContext): Promise<CreatedPullRequest> {
    this.calls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('push failed');
    }
    this.createdPrCount += 1;
    return {
      branchName: context.branchName,
      prUrl: `https://github.com/coreline-ai/improvement_loop_harness/pull/${this.createdPrCount}`,
      prNumber: this.createdPrCount
    };
  }
}

async function seedAcceptedLoopWithReport(store: Store, status = 'accepted'): Promise<{ loop: LoopRunRecord }> {
  const { loop } = await seedLoop(store, status);
  await store.createReport({
    loopRunId: loop.id,
    type: 'eval',
    status: 'complete',
    reportJson: {
      decision: status === 'approved' || status === 'accepted' ? 'accept' : 'reject',
      decision_reasons: [{ code: 'ALL_PASS', message: 'All required gates passed.' }],
      gate_runs: [{ name: 'unit_tests', type: 'test', required: true, status: 'pass', exit_code: 0 }],
      changed_files: [{ path: 'src/value.ts', status: 'modified', allowed_by_write_scope: true, protected: false }],
      improvement_evidence: [{ type: 'adds_regression_test', status: 'present' }],
      artifact_refs: ['patches/candidate.patch']
    }
  });
  return { loop };
}

async function seedCandidate(
  store: Store,
  projectId: string,
  options: { title: string; status?: string; priority?: number; riskAreaHint?: string | null }
) {
  return store.createCandidate({
    projectId,
    source: 'manual',
    fingerprint: `fp-${options.title}`,
    title: options.title,
    evidenceRefs: [],
    riskAreaHint: options.riskAreaHint ?? 'none',
    priority: options.priority ?? 80,
    status: options.status ?? 'approved'
  });
}

async function waitFor(assertion: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

class SequencedRunner {
  active = 0;
  maxActive = 0;
  calls: string[] = [];

  constructor(private readonly results: LoopRunnerResult[]) {}

  run = async (input: LoopRunnerInput): Promise<LoopRunnerResult> => {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.calls.push(input.task.id);
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.active -= 1;
    return this.results.shift() ?? { status: 'accepted', decision: 'accept' };
  };
}

class BlockingRunner {
  aborted = false;
  started = false;

  run = async (input: LoopRunnerInput): Promise<LoopRunnerResult> => {
    this.started = true;
    if (input.signal?.aborted) {
      this.aborted = true;
      return { status: 'cancelled', decision: 'cancelled' };
    }
    return new Promise((resolve) => {
      input.signal?.addEventListener(
        'abort',
        () => {
          this.aborted = true;
          resolve({ status: 'cancelled', decision: 'cancelled' });
        },
        { once: true }
      );
    });
  };
}

function sseIds(body: string): string[] {
  return body
    .split(/\n/)
    .filter((line) => line.startsWith('id: '))
    .map((line) => line.slice('id: '.length));
}

describe('Fastify API auth and loop orchestration', () => {
  it('requires the MVP bearer token', async () => {
    const app = await createApp({ token: TOKEN, store: new MemoryStore(), sseReplayOnly: true });
    const response = await app.inject({ method: 'GET', url: '/api/projects' });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('validates stored task YAML through task-protocol', async () => {
    const store = new MemoryStore();
    const { task } = await seedProjectTask(store);
    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true });

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/validate`,
      headers: authHeaders()
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, task: { id: 'task-fixture' } });
  });

  it('replays identical Idempotency-Key requests and rejects conflicting or active-loop creates', async () => {
    const store = new MemoryStore();
    const { task } = await seedProjectTask(store);
    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true });

    const first = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/loops`,
      headers: authHeaders({ 'idempotency-key': 'key-1' }),
      payload: { baseCommit: 'abc123' }
    });
    const firstBody = first.json() as { loop: { id: string }; replay: boolean };
    const replay = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/loops`,
      headers: authHeaders({ 'idempotency-key': 'key-1' }),
      payload: { baseCommit: 'abc123' }
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/loops`,
      headers: authHeaders({ 'idempotency-key': 'key-1' }),
      payload: { baseCommit: 'different' }
    });
    const activeConflict = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/loops`,
      headers: authHeaders({ 'idempotency-key': 'key-2' }),
      payload: { baseCommit: 'abc123' }
    });
    await app.close();

    expect(first.statusCode).toBe(202);
    expect(firstBody.replay).toBe(false);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { loop: { id: string }; replay: boolean }).loop.id).toBe(firstBody.loop.id);
    expect((replay.json() as { replay: boolean }).replay).toBe(true);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(activeConflict.statusCode).toBe(409);
    expect(activeConflict.json()).toMatchObject({ error: { code: 'ACTIVE_LOOP_EXISTS' } });
  });

  it('replays SSE events after Last-Event-ID without duplicates and with monotonic seq ids', async () => {
    const store = new MemoryStore();
    const { loop } = await seedLoop(store, 'queued');
    await store.addLoopEvent(loop.id, 'loop.queued', { n: 1 });
    await store.addLoopEvent(loop.id, 'workspace.ready', { n: 2 });
    await store.addLoopEvent(loop.id, 'gate.completed', { n: 3 });
    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true });

    const response = await app.inject({
      method: 'GET',
      url: `/api/loops/${loop.id}/events`,
      headers: authHeaders({ 'last-event-id': '1' })
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(sseIds(response.body)).toEqual(['2', '3']);
    expect(response.body).not.toContain('"n":1');
  });



  it('registers, dedupes, approves, and dismisses improvement candidates', async () => {
    const store = new MemoryStore();
    const { task } = await seedProjectTask(store);
    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true });

    const projectId = task.projectId;
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/candidates`,
      headers: authHeaders(),
      payload: { filePath: 'tests/failing.test.js', title: 'tests/failing.test.js: manual failure' }
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/candidates`,
      headers: authHeaders(),
      payload: { filePath: 'tests/failing.test.js', title: 'duplicate ignored' }
    });
    const candidate = created.json() as { id: string; fingerprint: string };
    const approved = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/approve`,
      headers: authHeaders()
    });
    const dismissed = await app.inject({
      method: 'POST',
      url: `/api/candidates/${candidate.id}/dismiss`,
      headers: authHeaders(),
      payload: { reason: 'not now' }
    });
    const listed = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/candidates`,
      headers: authHeaders()
    });
    await app.close();

    expect(created.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ id: candidate.id, fingerprint: candidate.fingerprint });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved' });
    expect(approved.json().taskId).toBeTruthy();
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({ status: 'dismissed', dismissReason: 'not now' });
    expect(listed.json()).toHaveLength(1);
  });


  it('orchestrates approved candidates sequentially and creates draft PRs for accepted loops', async () => {
    const store = new MemoryStore();
    const { task } = await seedProjectTask(store);
    await seedCandidate(store, task.projectId, { title: 'tests/one.test.js: first failure', priority: 90 });
    await seedCandidate(store, task.projectId, { title: 'tests/two.test.js: second failure', priority: 80 });
    const runner = new SequencedRunner([
      { status: 'accepted', decision: 'accept', artifactRoot: '/tmp/run-1', tokenUsageTotal: 10 },
      { status: 'accepted', decision: 'accept', artifactRoot: '/tmp/run-2', tokenUsageTotal: 15 }
    ]);
    const manager = new FakePullRequestManager();
    const app = await createApp({
      token: TOKEN,
      store,
      sseReplayOnly: true,
      runner: runner.run,
      pullRequestManager: manager,
      fetchLatestBase: async () => 'base-latest'
    });

    const started = await app.inject({
      method: 'POST',
      url: `/api/projects/${task.projectId}/orchestrator/start`,
      headers: authHeaders(),
      payload: { mode: 'supervised', tokenBudgetDaily: 1_000 }
    });
    await waitFor(async () => manager.createdPrCount === 2);
    const status = await app.inject({
      method: 'GET',
      url: `/api/projects/${task.projectId}/orchestrator`,
      headers: authHeaders()
    });
    await app.close();

    expect(started.statusCode).toBe(200);
    expect(runner.maxActive).toBe(1);
    expect(manager.calls).toBe(2);
    expect(status.json()).toMatchObject({
      state: { status: 'running', loopsStartedToday: 2, tokenUsedToday: 25 },
      queue: { processed: 2 },
      openDraftPrCount: 2
    });
    expect(status.json().state.nextDiscoveryAt).toBeTruthy();
  });

  it('honors kill switch by aborting the active loop and clearing running state', async () => {
    const store = new MemoryStore();
    const { task } = await seedProjectTask(store);
    await seedCandidate(store, task.projectId, { title: 'tests/kill.test.js: hanging failure' });
    const runner = new BlockingRunner();
    const app = await createApp({
      token: TOKEN,
      store,
      sseReplayOnly: true,
      runner: runner.run,
      pullRequestManager: new FakePullRequestManager(),
      fetchLatestBase: async () => 'base-latest'
    });

    const started = await app.inject({
      method: 'POST',
      url: `/api/projects/${task.projectId}/orchestrator/start`,
      headers: authHeaders(),
      payload: { tokenBudgetDaily: 1_000 }
    });
    await waitFor(async () => Boolean((await store.getOrchestratorState(task.projectId))?.currentLoopId));
    const loopId = (await store.getOrchestratorState(task.projectId))?.currentLoopId;
    const stopped = await app.inject({
      method: 'POST',
      url: `/api/projects/${task.projectId}/orchestrator/stop`,
      headers: authHeaders()
    });
    await waitFor(async () => runner.aborted);
    const loop = loopId ? await store.getLoop(loopId) : null;
    const [candidate] = await store.listCandidates(task.projectId);
    await app.close();

    expect(started.statusCode).toBe(200);
    expect(stopped.statusCode).toBe(200);
    expect(runner.started).toBe(true);
    expect(loop).toMatchObject({ status: 'cancelled' });
    expect(candidate).toMatchObject({ status: 'queued' });
    expect(stopped.json()).toMatchObject({ state: { status: 'stopped', currentLoopId: null, currentCandidateId: null } });
  });

  it('dismisses the same candidate after two rejects and records retry-limit events', async () => {
    const store = new MemoryStore();
    const { task } = await seedProjectTask(store);
    await seedCandidate(store, task.projectId, { title: 'tests/retry.test.js: persistent failure' });
    const runner = new SequencedRunner([
      { status: 'rejected', decision: 'reject' },
      { status: 'rejected', decision: 'reject' }
    ]);
    const app = await createApp({
      token: TOKEN,
      store,
      sseReplayOnly: true,
      runner: runner.run,
      pullRequestManager: new FakePullRequestManager(),
      fetchLatestBase: async () => 'base-latest'
    });

    await app.inject({
      method: 'POST',
      url: `/api/projects/${task.projectId}/orchestrator/start`,
      headers: authHeaders(),
      payload: { tokenBudgetDaily: 1_000 }
    });
    await waitFor(async () => (await store.listCandidates(task.projectId))[0]?.status === 'dismissed');
    const [candidate] = await store.listCandidates(task.projectId);
    const events = await store.listOrchestratorEvents(task.projectId);
    await app.close();

    expect(candidate).toMatchObject({ status: 'dismissed', dismissReason: 'retry_limit' });
    expect(runner.calls).toHaveLength(2);
    expect(events.map((event) => event.type)).toContain('candidate.dismissed.retry_limit');
  });

  it('pauses on consecutive failures and on daily loop budget exhaustion', async () => {
    const store = new MemoryStore();
    const { task } = await seedProjectTask(store);
    await seedCandidate(store, task.projectId, { title: 'tests/flaky-1.test.js: system failure', priority: 90 });
    await seedCandidate(store, task.projectId, { title: 'tests/flaky-2.test.js: system failure', priority: 80 });
    await seedCandidate(store, task.projectId, { title: 'tests/flaky-3.test.js: system failure', priority: 70 });
    const runner = new SequencedRunner([
      { status: 'failed', decision: 'failed' },
      { status: 'failed', decision: 'failed' },
      { status: 'failed', decision: 'failed' },
      { status: 'failed', decision: 'failed' },
      { status: 'failed', decision: 'failed' }
    ]);
    const app = await createApp({
      token: TOKEN,
      store,
      sseReplayOnly: true,
      runner: runner.run,
      pullRequestManager: new FakePullRequestManager(),
      fetchLatestBase: async () => 'base-latest'
    });

    await app.inject({
      method: 'POST',
      url: `/api/projects/${task.projectId}/orchestrator/start`,
      headers: authHeaders(),
      payload: { tokenBudgetDaily: 1_000 }
    });
    await waitFor(async () => (await store.getOrchestratorState(task.projectId))?.status === 'paused');
    const failedState = await store.getOrchestratorState(task.projectId);

    const secondProject = await store.createProject({ name: 'budget fixture', localPath: '/tmp/repo-budget' });
    await seedCandidate(store, secondProject.id, { title: 'tests/budget-1.test.js: first' });
    await seedCandidate(store, secondProject.id, { title: 'tests/budget-2.test.js: second' });
    await app.inject({
      method: 'POST',
      url: `/api/projects/${secondProject.id}/orchestrator/start`,
      headers: authHeaders(),
      payload: { tokenBudgetDaily: 1_000, dailyLoopBudget: 1 }
    });
    await waitFor(async () => (await store.getOrchestratorState(secondProject.id))?.pausedReason === 'daily_loop_budget_exceeded');
    const budgetState = await store.getOrchestratorState(secondProject.id);
    await app.close();

    expect(failedState).toMatchObject({ status: 'paused', pausedReason: 'consecutive_failure_limit_reached', consecutiveFailures: 5 });
    expect(budgetState).toMatchObject({ status: 'paused', pausedReason: 'daily_loop_budget_exceeded', loopsStartedToday: 1 });
  });

  it('pauses before starting a new loop when open draft PR cap is reached', async () => {
    const store = new MemoryStore();
    const { task } = await seedProjectTask(store);
    for (let index = 0; index < 5; index += 1) {
      const seededTask = await store.createTask({
        projectId: task.projectId,
        title: `accepted ${index}`,
        objective: 'seed open draft PR',
        writeScope: { allowed: ['src/'] },
        taskYaml: { schema_version: '1.0', id: `seed-${index}`, title: `accepted ${index}`, objective: 'seed' }
      });
      const loop = await store.createLoop({ taskId: seededTask.id, iteration: 1, status: 'accepted' });
      await store.createPullRequest({ loopRunId: loop.id, branchName: `vibeloop/${loop.id}`, status: 'draft_created' });
    }
    await seedCandidate(store, task.projectId, { title: 'tests/pr-cap.test.js: blocked by PR cap' });
    const runner = new SequencedRunner([{ status: 'accepted', decision: 'accept' }]);
    const app = await createApp({
      token: TOKEN,
      store,
      sseReplayOnly: true,
      runner: runner.run,
      pullRequestManager: new FakePullRequestManager(),
      fetchLatestBase: async () => 'base-latest'
    });

    await app.inject({
      method: 'POST',
      url: `/api/projects/${task.projectId}/orchestrator/start`,
      headers: authHeaders(),
      payload: { tokenBudgetDaily: 1_000, openDraftPrLimit: 5 }
    });
    await waitFor(async () => (await store.getOrchestratorState(task.projectId))?.pausedReason === 'open_draft_pr_limit_reached');
    await app.close();

    expect(runner.calls).toHaveLength(0);
    expect(await store.countOpenDraftPullRequests(task.projectId)).toBe(5);
  });

  it('recovers running zombie state on app restart by failing the stale loop and requeueing the candidate', async () => {
    const store = new MemoryStore();
    const { task } = await seedProjectTask(store);
    const candidate = await seedCandidate(store, task.projectId, { title: 'tests/zombie.test.js: interrupted', status: 'running' });
    const taskForCandidate = await store.createTask({
      projectId: task.projectId,
      title: 'zombie task',
      objective: 'recover this task',
      writeScope: { allowed: ['src/'] },
      taskYaml: { schema_version: '1.0', id: 'zombie', title: 'zombie task', objective: 'recover' }
    });
    await store.updateCandidate(candidate.id, { taskId: taskForCandidate.id });
    const loop = await store.createLoop({ taskId: taskForCandidate.id, iteration: 1, status: 'workspace_preparing' });
    await store.upsertOrchestratorState(task.projectId, {
      status: 'running',
      tokenBudgetDaily: 1_000,
      currentCandidateId: candidate.id,
      currentLoopId: loop.id
    });

    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true });
    const recoveredLoop = await store.getLoop(loop.id);
    const [recoveredCandidate] = await store.listCandidates(task.projectId);
    const state = await store.getOrchestratorState(task.projectId);
    await app.close();

    expect(recoveredLoop).toMatchObject({ status: 'failed', decision: 'failed' });
    expect(recoveredCandidate).toMatchObject({ status: 'queued' });
    expect(state).toMatchObject({ status: 'stopped', pausedReason: 'recovered_running_zombie' });
  });

  it('rejects approvals for loops that are not in needs_human_review', async () => {
    const store = new MemoryStore();
    const { loop } = await seedLoop(store, 'rejected');
    const approval = await store.createApproval({ loopRunId: loop.id, reason: 'risk' });
    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true });

    const response = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}/approve`,
      headers: authHeaders(),
      payload: { reviewer_id: 'user_1', decision_reason: 'not allowed' }
    });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'APPROVAL_NOT_ALLOWED' } });
  });



  it('creates a draft PR only for accepted loops and records the PR lifecycle', async () => {
    const store = new MemoryStore();
    const { loop } = await seedAcceptedLoopWithReport(store, 'accepted');
    const manager = new FakePullRequestManager();
    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true, pullRequestManager: manager });

    const response = await app.inject({
      method: 'POST',
      url: `/api/loops/${loop.id}/pull-request`,
      headers: authHeaders()
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/api/loops/${loop.id}/pull-request`,
      headers: authHeaders()
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'draft_created', prNumber: 1 });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'draft_created', prNumber: 1 });
    expect(manager.calls).toBe(1);
  });

  it('rejects pull request creation for forbidden loop states', async () => {
    const store = new MemoryStore();
    const forbidden = ['rejected', 'cancelled', 'failed', 'needs_more_tests', 'needs_human_review'];
    const loops = [] as LoopRunRecord[];
    for (const status of forbidden) {
      loops.push((await seedAcceptedLoopWithReport(store, status)).loop);
    }
    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true, pullRequestManager: new FakePullRequestManager() });

    for (const loop of loops) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/loops/${loop.id}/pull-request`,
        headers: authHeaders()
      });
      expect(response.statusCode, loop.status).toBe(403);
      expect(response.json(), loop.status).toMatchObject({ error: { code: 'PR_FORBIDDEN_FOR_LOOP_STATUS' } });
    }
    await app.close();
  });

  it('marks create_failed on push failure and retries without creating duplicate PR records', async () => {
    const store = new MemoryStore();
    const { loop } = await seedAcceptedLoopWithReport(store, 'approved');
    const manager = new FakePullRequestManager();
    manager.failNext = true;
    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true, pullRequestManager: manager });

    const failed = await app.inject({
      method: 'POST',
      url: `/api/loops/${loop.id}/pull-request`,
      headers: authHeaders()
    });
    const afterFailure = await app.inject({
      method: 'GET',
      url: `/api/loops/${loop.id}/pull-request`,
      headers: authHeaders()
    });
    const succeeded = await app.inject({
      method: 'POST',
      url: `/api/loops/${loop.id}/pull-request`,
      headers: authHeaders()
    });
    const afterSuccess = await app.inject({
      method: 'GET',
      url: `/api/loops/${loop.id}/pull-request`,
      headers: authHeaders()
    });
    await app.close();

    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: { code: 'PULL_REQUEST_CREATE_FAILED' } });
    expect(afterFailure.statusCode).toBe(200);
    expect(afterFailure.json()).toMatchObject({ status: 'create_failed' });
    expect(succeeded.statusCode).toBe(200);
    expect(succeeded.json()).toMatchObject({ status: 'draft_created', prNumber: 1 });
    expect(afterSuccess.json().id).toBe(afterFailure.json().id);
    expect(manager.calls).toBe(2);
    expect(manager.createdPrCount).toBe(1);
  });

  it('blocks artifact path traversal with a realpath 404', async () => {
    const store = new MemoryStore();
    const root = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-artifacts-'));
    await mkdir(path.join(root, 'reports'));
    await writeFile(path.join(root, 'reports', 'eval-report.json'), '{}\n');
    const { loop } = await seedLoop(store, 'accepted', root);
    const app = await createApp({ token: TOKEN, store, sseReplayOnly: true });

    const response = await app.inject({
      method: 'GET',
      url: `/api/loops/${loop.id}/artifacts/%2e%2e/%2e%2e/etc/passwd`,
      headers: authHeaders()
    });
    await app.close();

    expect(response.statusCode).toBe(404);
  });
});

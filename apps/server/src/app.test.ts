import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { CreatedPullRequest, PullRequestCreationContext, PullRequestManager } from './routes/pull-requests.js';
import { MemoryStore } from './memory-store.js';
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

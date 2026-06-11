import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
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

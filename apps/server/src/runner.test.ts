import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadServerConfig, startServer } from './main.js';
import { MemoryStore } from './memory-store.js';
import { createKernelLoopRunner } from './runner.js';

const TOKEN = 'test-token';

interface TempRepo {
  repoPath: string;
  git(args: readonly string[]): Promise<string>;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
    });
  });
}

async function createRunnerRepo(): Promise<TempRepo> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-server-runner-repo-'));
  const git = (args: readonly string[]): Promise<string> => runGit(repoPath, args);
  await mkdir(path.join(repoPath, 'src'), { recursive: true });
  await writeFile(path.join(repoPath, 'src', 'value.cjs'), 'module.exports = 1;\n');
  await writeFile(
    path.join(repoPath, 'eval.yaml'),
    [
      'schema_version: "1.0"',
      'project: server-runner-fixture',
      'protected_paths:',
      '  - .env',
      '  - .env.*',
      '  - eval.yaml',
      '  - scripts/eval.sh',
      'risk_classification:',
      '  none:',
      '    - src/',
      '    - tests/',
      'limits:',
      '  max_changed_files: 20',
      '  max_changed_lines: 500',
      'test_integrity:',
      '  forbidden_patterns:',
      '    - test.skip',
      '    - it.only',
      '  suspicious_patterns:',
      '    - expect(true).toBe(true)',
      'gates:',
      '  - name: git_meta_integrity',
      '    type: integrity',
      '    command: builtin:git-meta-integrity',
      '    required: true',
      '  - name: protected_files',
      '    type: scope',
      '    command: builtin:protected-files',
      '    required: true',
      '  - name: diff_scope',
      '    type: scope',
      '    command: builtin:diff-scope',
      '    required: true',
      '  - name: limits',
      '    type: integrity',
      '    command: builtin:limits',
      '    required: true',
      '  - name: test_integrity',
      '    type: integrity',
      '    command: builtin:test-integrity',
      '    required: true',
      '  - name: unit_tests',
      '    type: task_acceptance',
      '    command: node tests/regression.test.js',
      '    required: true',
      ''
    ].join('\n')
  );
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'server-runner@example.test']);
  await git(['config', 'user.name', 'Server Runner Test']);
  await git(['add', '-A']);
  await git(['commit', '-m', 'initial server runner fixture']);
  return { repoPath, git };
}

async function waitFor(assertion: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

describe('kernel LoopRunner production wiring', () => {
  it('runs runKernel and persists eval report, gate runs, artifacts, agent run, and workspace run', async () => {
    const repo = await createRunnerRepo();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-server-runner-data-'));
    const store = new MemoryStore();
    const scenario = path.join(await mkdtemp(path.join(os.tmpdir(), 'vibeloop-server-runner-agent-')), 'scenario.json');
    await writeFile(
      scenario,
      `${JSON.stringify({
        actions: [
          { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
          { type: 'create', path: 'tests/regression.test.js', content: "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n" }
        ]
      })}\n`
    );
    const project = await store.createProject({ name: 'runner fixture', localPath: repo.repoPath, evalConfigPath: 'eval.yaml' });
    const task = await store.createTask({
      projectId: project.id,
      title: 'Server runner happy path',
      objective: 'Persist kernel artifacts',
      riskArea: 'none',
      writeScope: { allowed: ['src/', 'tests/'] },
      acceptance: { required_tests: ['node tests/regression.test.js'] },
      taskYaml: {
        schema_version: '1.0',
        id: 'server-runner-task',
        title: 'Server runner happy path',
        objective: 'Persist kernel artifacts',
        base_branch: 'main',
        risk_area: 'none',
        write_scope: { allowed: ['src/', 'tests/'] },
        required_evidence: ['adds_regression_test'],
        acceptance: { required_tests: ['node tests/regression.test.js'] },
        limits: { max_changed_files: 20, max_changed_lines: 500 }
      }
    });
    const loop = await store.createLoop({ taskId: task.id, iteration: 1, status: 'queued', agentSpec: `mock:${scenario}` });
    const runner = createKernelLoopRunner({ store, dataDir, defaultAgentSpec: 'codex', skipDependencyInstall: true });

    const result = await runner({ loop, task });
    const reports = await store.listReports(loop.id);
    const gateRuns = await store.listGateRuns(loop.id);
    const artifacts = await store.listArtifacts(loop.id);
    const agentRuns = await store.listAgentRuns(loop.id);
    const workspaceRuns = await store.listWorkspaceRuns(loop.id);

    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });

    expect(result).toMatchObject({ status: 'accepted', decision: 'accept' });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.reportJson).toMatchObject({ decision: 'accept' });
    expect(gateRuns.map((gate) => gate.name)).toContain('unit_tests');
    expect(artifacts.some((artifact) => artifact.path === 'reports/eval-report.json')).toBe(true);
    expect(agentRuns).toMatchObject([{ agentType: 'mock', status: 'accepted' }]);
    expect(workspaceRuns).toMatchObject([{ kind: 'git_worktree', status: 'cleaned' }]);
  });

  it('wires the runner through the HTTP loop queue so report APIs are populated', async () => {
    const repo = await createRunnerRepo();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-server-http-data-'));
    const scenario = path.join(await mkdtemp(path.join(os.tmpdir(), 'vibeloop-server-http-agent-')), 'scenario.json');
    await writeFile(
      scenario,
      `${JSON.stringify({
        actions: [
          { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
          { type: 'create', path: 'tests/regression.test.js', content: "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n" }
        ]
      })}\n`
    );
    const store = new MemoryStore();
    const project = await store.createProject({ name: 'http runner fixture', localPath: repo.repoPath, evalConfigPath: 'eval.yaml' });
    const task = await store.createTask({
      projectId: project.id,
      title: 'HTTP runner happy path',
      objective: 'Use POST /loops to invoke the kernel runner',
      riskArea: 'none',
      writeScope: { allowed: ['src/', 'tests/'] },
      acceptance: { required_tests: ['node tests/regression.test.js'] },
      taskYaml: {
        schema_version: '1.0',
        id: 'server-http-task',
        title: 'HTTP runner happy path',
        objective: 'Use POST /loops to invoke the kernel runner',
        base_branch: 'main',
        risk_area: 'none',
        write_scope: { allowed: ['src/', 'tests/'] },
        required_evidence: ['adds_regression_test'],
        acceptance: { required_tests: ['node tests/regression.test.js'] },
        limits: { max_changed_files: 20, max_changed_lines: 500 }
      }
    });
    const runner = createKernelLoopRunner({ store, dataDir, defaultAgentSpec: 'codex', skipDependencyInstall: true });
    const app = await createApp({ token: TOKEN, store, runner, sseReplayOnly: true });

    const created = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/loops`,
      headers: authHeaders({ 'idempotency-key': 'runner-http' }),
      payload: { agent_spec: `mock:${scenario}` }
    });
    const loopId = (created.json() as { loop: { id: string } }).loop.id;
    await waitFor(async () => (await store.getLoop(loopId))?.status === 'accepted');
    const reports = await app.inject({ method: 'GET', url: `/api/loops/${loopId}/reports`, headers: authHeaders() });
    const artifacts = await app.inject({ method: 'GET', url: `/api/loops/${loopId}/artifacts`, headers: authHeaders() });
    const events = await app.inject({ method: 'GET', url: `/api/loops/${loopId}/events`, headers: authHeaders() });

    await app.close();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });

    expect(created.statusCode).toBe(202);
    expect(reports.json()).toHaveLength(1);
    expect(artifacts.json().some((artifact: { path: string }) => artifact.path === 'reports/eval-report.json')).toBe(true);
    expect(events.body).toContain('kernel.decision_ready');
  });

  it('persists reject reports and skipped project gates for guard failures', async () => {
    const repo = await createRunnerRepo();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-server-guard-data-'));
    const scenario = path.join(await mkdtemp(path.join(os.tmpdir(), 'vibeloop-server-guard-agent-')), 'scenario.json');
    await writeFile(scenario, `${JSON.stringify({ actions: [{ type: 'create', path: '.env.local', content: 'token=secret\\n' }] })}\n`);
    const store = new MemoryStore();
    const project = await store.createProject({ name: 'guard fixture', localPath: repo.repoPath, evalConfigPath: 'eval.yaml' });
    const task = await store.createTask({
      projectId: project.id,
      title: 'Guard failure path',
      objective: 'Protected file changes must reject and skip project gates',
      riskArea: 'none',
      writeScope: { allowed: ['.env.local'] },
      taskYaml: {
        schema_version: '1.0',
        id: 'server-guard-task',
        title: 'Guard failure path',
        objective: 'Protected file changes must reject and skip project gates',
        base_branch: 'main',
        risk_area: 'none',
        write_scope: { allowed: ['.env.local'] },
        required_evidence: ['adds_regression_test']
      }
    });
    const loop = await store.createLoop({ taskId: task.id, iteration: 1, status: 'queued', agentSpec: `mock:${scenario}` });
    const runner = createKernelLoopRunner({ store, dataDir, defaultAgentSpec: 'codex', skipDependencyInstall: true });

    const result = await runner({ loop, task });
    const [report] = await store.listReports(loop.id);
    const gateRuns = await store.listGateRuns(loop.id);

    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });

    expect(result).toMatchObject({ status: 'rejected', decision: 'reject' });
    expect(report?.reportJson).toMatchObject({ decision: 'reject' });
    expect(gateRuns.find((gate) => gate.name === 'unit_tests')).toMatchObject({ status: 'skipped' });
  });

  it('marks queued HTTP loops failed when the production runner throws', async () => {
    const store = new MemoryStore();
    const project = await store.createProject({ name: 'missing local path' });
    const task = await store.createTask({
      projectId: project.id,
      title: 'Runner failure path',
      objective: 'Missing localPath should surface as a failed loop',
      riskArea: 'none',
      writeScope: { allowed: ['src/'] },
      taskYaml: {
        schema_version: '1.0',
        id: 'server-runner-failure',
        title: 'Runner failure path',
        objective: 'Missing localPath should surface as a failed loop',
        write_scope: { allowed: ['src/'] },
        required_evidence: []
      }
    });
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-server-fail-data-'));
    const runner = createKernelLoopRunner({ store, dataDir, defaultAgentSpec: 'codex' });
    const app = await createApp({ token: TOKEN, store, runner, sseReplayOnly: true });

    const created = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/loops`,
      headers: authHeaders({ 'idempotency-key': 'runner-failure' }),
      payload: {}
    });
    const loopId = (created.json() as { loop: { id: string } }).loop.id;
    await waitFor(async () => (await store.getLoop(loopId))?.status === 'failed');
    const loop = await store.getLoop(loopId);
    const events = await store.listLoopEventsAfter(loopId, 0);
    await app.close();
    await rm(dataDir, { recursive: true, force: true });

    expect(loop).toMatchObject({ status: 'failed', decision: 'failed' });
    expect(events.map((event) => event.type)).toContain('loop.failed');
  });
});

describe('server main bootstrap', () => {
  it('requires VIBELOOP_API_TOKEN and an explicit store mode', () => {
    expect(() => loadServerConfig({})).toThrow('VIBELOOP_API_TOKEN is required');
    expect(() => loadServerConfig({ VIBELOOP_API_TOKEN: TOKEN })).toThrow('DATABASE_URL is required unless VIBELOOP_STORE=memory is set');
  });

  it('starts an HTTP server with memory store and enforces bearer auth', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-main-data-'));
    const server = await startServer({
      VIBELOOP_API_TOKEN: TOKEN,
      VIBELOOP_STORE: 'memory',
      VIBELOOP_DATA_DIR: dataDir,
      VIBELOOP_AGENT_SPEC: 'codex',
      HOST: '127.0.0.1',
      PORT: '0'
    });
    const unauthorized = await fetch(`${server.url}/api/projects`);
    const authorized = await fetch(`${server.url}/api/projects`, { headers: authHeaders() });
    await server.close();
    await rm(dataDir, { recursive: true, force: true });

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
  });
});

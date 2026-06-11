import http from 'node:http';

const token = 'test-token';
const port = 4313;
let approvalStatus = 'pending';
let eventConnections = 0;

const project = {
  id: 'project-1',
  name: 'Fixture Project',
  localPath: '/tmp/fixture',
  repoUrl: null,
  defaultBranch: 'main',
  evalConfigPath: 'eval.yaml',
  status: 'active',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const task = {
  id: 'task-1',
  projectId: project.id,
  title: 'Happy loop task',
  objective: 'Produce an accepted report with evidence',
  status: 'ready',
  riskArea: 'none',
  writeScope: { allowed: ['src/', 'tests/'] },
  taskYaml: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const loop = {
  id: 'loop-happy',
  taskId: task.id,
  iteration: 1,
  status: 'accepted',
  decision: 'accept',
  baseCommit: 'abc123',
  artifactRoot: '/tmp/artifacts',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const report = {
  id: 'report-1',
  loopRunId: loop.id,
  type: 'eval',
  status: 'complete',
  createdAt: new Date().toISOString(),
  reportJson: {
    decision: 'accept',
    summary: 'Accepted: all required gates passed and evidence is present.',
    decision_reasons: [{ code: 'ALL_GATES_PASS', message: 'All required gates passed.' }],
    gate_runs: [
      { name: 'unit_tests', type: 'task_acceptance', required: true, status: 'pass', stdout_ref: 'logs/gates/unit.stdout.log' },
      { name: 'diff_scope', type: 'scope', required: true, status: 'pass' }
    ],
    improvement_evidence: [{ type: 'adds_regression_test', status: 'present', artifact_ref: 'logs/gates/unit.stdout.log', supporting_gate: 'unit_tests' }],
    artifact_refs: ['logs/gates/unit.stdout.log'],
    changed_files: [
      { path: 'src/value.cjs', status: 'modified', added_lines: 1, deleted_lines: 1 },
      { path: 'tests/regression.test.js', status: 'added', added_lines: 3, deleted_lines: 0 }
    ]
  }
};

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendSse(response, event) {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'token required' } });
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const path = url.pathname;

  if (request.method === 'GET' && path === '/api/projects') return sendJson(response, 200, [project]);
  if (request.method === 'GET' && path === '/api/projects/project-1') return sendJson(response, 200, project);
  if (request.method === 'GET' && path === '/api/projects/project-1/tasks') return sendJson(response, 200, [task]);
  if (request.method === 'GET' && path === '/api/tasks/task-1/loops') return sendJson(response, 200, [loop]);
  if (request.method === 'GET' && path === '/api/loops/loop-happy') return sendJson(response, 200, loop);
  if (request.method === 'GET' && path === '/api/loops/loop-happy/reports') return sendJson(response, 200, [report]);
  if (request.method === 'GET' && path === '/api/loops/loop-happy/artifacts/logs/gates/unit.stdout.log') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('unit tests passed');
    return;
  }
  if (request.method === 'GET' && path === '/api/approvals') {
    return sendJson(response, 200, [{
      id: 'approval-1',
      loopRunId: 'loop-risk',
      reason: 'Auth risk review',
      status: approvalStatus,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]);
  }
  if (request.method === 'POST' && path === '/api/approvals/approval-1/approve') {
    approvalStatus = 'approved';
    return sendJson(response, 200, { approval: { id: 'approval-1', status: approvalStatus } });
  }
  if (request.method === 'POST' && path.startsWith('/api/approvals/approval-1/')) {
    approvalStatus = path.endsWith('/reject') ? 'rejected' : 'requested_more_tests';
    return sendJson(response, 200, { approval: { id: 'approval-1', status: approvalStatus } });
  }
  if (request.method === 'GET' && path === '/api/loops/loop-happy/events') {
    eventConnections += 1;
    const after = Number(request.headers['last-event-id'] ?? 0);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const events = [
      { id: '1', loop_id: loop.id, type: 'loop.queued', created_at: new Date().toISOString(), payload: { status: 'queued' } },
      { id: '2', loop_id: loop.id, type: 'workspace.ready', created_at: new Date().toISOString(), payload: { status: 'ready' } },
      { id: '3', loop_id: loop.id, type: 'gate.completed', created_at: new Date().toISOString(), payload: { gate: 'unit_tests', status: 'pass' } }
    ];
    for (const event of events.filter((event) => Number(event.id) > after)) {
      if (eventConnections === 1 && event.id === '3') continue;
      sendSse(response, event);
    }
    response.end();
    return;
  }

  sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock api listening on ${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

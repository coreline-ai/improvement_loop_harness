import type { FastifyInstance } from 'fastify';
import { TASK_SCHEMA_ID, validateOrThrow } from '@vibeloop/task-protocol';
import type { TaskDefinition } from '@vibeloop/task-protocol';
import { ApiError, requireRecord } from '../errors.js';
import type { CreateTaskInput, Store } from '../types.js';

function taskYamlFromBody(body: Record<string, unknown>, projectId: string): TaskDefinition {
  try {
    return validateOrThrow<TaskDefinition>(
      TASK_SCHEMA_ID,
      body.taskYaml ?? {
        schema_version: '1.0',
        id: body.id,
        title: body.title,
        objective: body.objective,
        risk_area: body.riskArea,
        write_scope: body.writeScope,
        required_evidence: body.requiredEvidence ?? [],
        acceptance: body.acceptance
      },
      `project ${projectId} task`
    );
  } catch (error) {
    throw new ApiError(400, 'TASK_INVALID', error instanceof Error ? error.message : String(error));
  }
}

export async function registerTaskRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.post('/api/projects/:projectId/tasks', async (request) => {
    const params = request.params as { projectId: string };
    requireRecord(await store.getProject(params.projectId), 'PROJECT_NOT_FOUND', 'project not found');
    const body = request.body as Record<string, unknown>;
    const taskYaml = taskYamlFromBody(body, params.projectId);
    return store.createTask({
      projectId: params.projectId,
      title: taskYaml.title,
      objective: taskYaml.objective,
      riskArea: taskYaml.risk_area ?? null,
      writeScope: taskYaml.write_scope,
      acceptance: taskYaml.acceptance ?? null,
      taskYaml
    });
  });

  app.get('/api/projects/:projectId/tasks', async (request) => {
    const params = request.params as { projectId: string };
    requireRecord(await store.getProject(params.projectId), 'PROJECT_NOT_FOUND', 'project not found');
    return store.listTasks(params.projectId);
  });

  app.get('/api/tasks/:taskId', async (request) => {
    const params = request.params as { taskId: string };
    return requireRecord(await store.getTask(params.taskId), 'TASK_NOT_FOUND', 'task not found');
  });

  app.patch('/api/tasks/:taskId', async (request) => {
    const params = request.params as { taskId: string };
    const existing = requireRecord(await store.getTask(params.taskId), 'TASK_NOT_FOUND', 'task not found');
    const body = request.body as Record<string, unknown>;
    const taskYaml = body.taskYaml ? taskYamlFromBody(body, existing.projectId) : undefined;
    const patch: Partial<Omit<CreateTaskInput, 'projectId'>> = {};
    if (taskYaml) {
      patch.title = taskYaml.title;
      patch.objective = taskYaml.objective;
      patch.riskArea = taskYaml.risk_area ?? null;
      patch.writeScope = taskYaml.write_scope;
      patch.acceptance = taskYaml.acceptance ?? null;
      patch.taskYaml = taskYaml;
    } else {
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.objective === 'string') patch.objective = body.objective;
      if (typeof body.riskArea === 'string' || body.riskArea === null) patch.riskArea = body.riskArea;
    }
    if (typeof body.status === 'string') patch.status = body.status;
    const updated = await store.updateTask(params.taskId, patch);
    return requireRecord(updated, 'TASK_NOT_FOUND', 'task not found');
  });

  app.post('/api/tasks/:taskId/validate', async (request) => {
    const params = request.params as { taskId: string };
    const task = requireRecord(await store.getTask(params.taskId), 'TASK_NOT_FOUND', 'task not found');
    try {
      const validTask = validateOrThrow<TaskDefinition>(TASK_SCHEMA_ID, task.taskYaml, `task ${params.taskId}`);
      return { ok: true, task: validTask };
    } catch (error) {
      throw new ApiError(400, 'TASK_INVALID', error instanceof Error ? error.message : String(error));
    }
  });
}

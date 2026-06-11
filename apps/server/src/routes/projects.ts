import type { FastifyInstance } from 'fastify';
import { ApiError, requireRecord } from '../errors.js';
import type { CreateProjectInput, Store } from '../types.js';

export async function registerProjectRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.post('/api/projects', async (request) => {
    const body = request.body as Record<string, unknown>;
    if (typeof body.name !== 'string' || body.name.length === 0) {
      throw new ApiError(400, 'INVALID_PROJECT', 'project name is required');
    }
    const input: CreateProjectInput = { name: body.name };
    if (typeof body.repoUrl === 'string') input.repoUrl = body.repoUrl;
    if (typeof body.localPath === 'string') input.localPath = body.localPath;
    if (typeof body.defaultBranch === 'string') input.defaultBranch = body.defaultBranch;
    if (typeof body.evalConfigPath === 'string') input.evalConfigPath = body.evalConfigPath;
    return store.createProject(input);
  });

  app.get('/api/projects', async () => store.listProjects());

  app.get('/api/projects/:projectId', async (request) => {
    const params = request.params as { projectId: string };
    return requireRecord(await store.getProject(params.projectId), 'PROJECT_NOT_FOUND', 'project not found');
  });

  app.patch('/api/projects/:projectId', async (request) => {
    const params = request.params as { projectId: string };
    const body = request.body as Record<string, unknown>;
    const patch: Partial<CreateProjectInput> = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (typeof body.repoUrl === 'string' || body.repoUrl === null) patch.repoUrl = body.repoUrl;
    if (typeof body.localPath === 'string' || body.localPath === null) patch.localPath = body.localPath;
    if (typeof body.defaultBranch === 'string') patch.defaultBranch = body.defaultBranch;
    if (typeof body.evalConfigPath === 'string') patch.evalConfigPath = body.evalConfigPath;
    if (typeof body.status === 'string') patch.status = body.status;
    const updated = await store.updateProject(params.projectId, patch);
    return requireRecord(updated, 'PROJECT_NOT_FOUND', 'project not found');
  });
}

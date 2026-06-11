import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { TASK_SCHEMA_ID, validateOrThrow } from './schema.js';
import { normalizePathList } from './paths.js';
import type { TaskDefinition } from './types.js';

export async function loadTask(filePath: string): Promise<TaskDefinition> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = YAML.parse(raw) as unknown;
  const task = validateOrThrow<TaskDefinition>(TASK_SCHEMA_ID, parsed, filePath);

  const normalizedAllowed = normalizePathList(task.write_scope.allowed, 'write_scope.allowed') ?? [];
  const normalizedForbidden = task.write_scope.forbidden
    ? normalizePathList(task.write_scope.forbidden, 'write_scope.forbidden')
    : undefined;

  return {
    ...task,
    write_scope: {
      allowed: normalizedAllowed,
      ...(normalizedForbidden ? { forbidden: normalizedForbidden } : {})
    }
  };
}

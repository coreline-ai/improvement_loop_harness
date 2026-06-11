import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type AnySchema, type ErrorObject } from 'ajv/dist/2020.js';
import { SchemaValidationError } from './errors.js';

export const TASK_SCHEMA_ID = 'https://vibeloop.dev/schemas/task.schema.json';
export const EVAL_SCHEMA_ID = 'https://vibeloop.dev/schemas/eval.schema.json';
export const EVAL_REPORT_SCHEMA_ID = 'https://vibeloop.dev/schemas/eval-report.schema.json';

let cachedAjv: Ajv2020 | undefined;

function repoRootFromModule(): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dirname, '../../..');
}

function readJson(relativePath: string): AnySchema {
  const absolutePath = path.join(repoRootFromModule(), relativePath);
  return JSON.parse(readFileSync(absolutePath, 'utf8')) as AnySchema;
}

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(readJson('schemas/task.schema.json'), TASK_SCHEMA_ID);
  ajv.addSchema(readJson('schemas/eval.schema.json'), EVAL_SCHEMA_ID);
  ajv.addSchema(readJson('schemas/eval-report.schema.json'), EVAL_REPORT_SCHEMA_ID);
  return ajv;
}

export function getAjv(): Ajv2020 {
  cachedAjv ??= createAjv();
  return cachedAjv;
}

function formatError(error: ErrorObject): string {
  const instancePath = error.instancePath || '/';
  const schemaPath = error.schemaPath ? ` (${error.schemaPath})` : '';
  return `${instancePath} ${error.message ?? 'is invalid'}${schemaPath}`;
}

export function validateOrThrow<T>(schemaId: string, value: unknown, label = 'value'): T {
  const validate = getAjv().getSchema(schemaId);
  if (!validate) {
    throw new SchemaValidationError(`Schema is not registered for ${label}`, [schemaId]);
  }

  if (!validate(value)) {
    const details = (validate.errors ?? []).map(formatError);
    throw new SchemaValidationError(`${label} failed schema validation`, details);
  }

  return value as T;
}

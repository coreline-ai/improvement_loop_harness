import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EvalConfigError, InterpolationError, SchemaValidationError, TaskProtocolError } from './errors.js';
import { loadEvalConfig } from './eval-config.js';
import { assertAllowedInterpolation, interpolateCommand } from './interpolation.js';
import { mergeLimits } from './limits.js';
import { classifyRisk } from './risk.js';
import { EVAL_REPORT_SCHEMA_ID, EVAL_SCHEMA_ID, getAjv, TASK_SCHEMA_ID, validateOrThrow } from './schema.js';
import { loadTask } from './task.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = path.join(packageRoot, 'fixtures');

function fixturePath(kind: 'valid' | 'invalid', name: string): string {
  return path.join(fixturesRoot, kind, name);
}

describe('schema registry', () => {
  it('registers the three contract schemas', () => {
    const ajv = getAjv();

    expect(ajv.getSchema(TASK_SCHEMA_ID)).toBeDefined();
    expect(ajv.getSchema(EVAL_SCHEMA_ID)).toBeDefined();
    expect(ajv.getSchema(EVAL_REPORT_SCHEMA_ID)).toBeDefined();
  });

  it('includes at least three valid and invalid YAML fixtures for Phase 2', async () => {
    await expect(readdir(path.join(fixturesRoot, 'valid'))).resolves.toHaveLength(3);
    const invalidFixtures = await readdir(path.join(fixturesRoot, 'invalid'));
    expect(invalidFixtures.length).toBeGreaterThanOrEqual(3);
  });

  it('reports schema instance paths when validation fails', () => {
    try {
      validateOrThrow(TASK_SCHEMA_ID, { id: 'x', title: 'no', objective: 'short' }, 'bad task');
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError);
      expect((error as SchemaValidationError).details.some((detail) => detail.startsWith('/ '))).toBe(true);
      expect((error as SchemaValidationError).details.join(' ')).toContain("required property 'write_scope'");
    }
  });
});

describe('loadTask', () => {
  it('loads the TASK_PROTOCOL §2 task fixture and normalizes repo-relative paths', async () => {
    const task = await loadTask(fixturePath('valid', 'task-auth.yaml'));

    expect(task.id).toBe('auth-invalid-login-401');
    expect(task.write_scope.allowed).toEqual(['src/features/auth/', 'src/app/api/auth/', 'tests/auth/']);
    expect(task.limits?.max_changed_lines).toBe(300);
  });

  it('loads a minimal valid task fixture', async () => {
    const task = await loadTask(fixturePath('valid', 'task-minimal.yaml'));

    expect(task.required_evidence).toEqual(['improves_accessibility_score']);
  });

  it('rejects absolute and parent traversal write scope paths', async () => {
    await expect(loadTask(fixturePath('invalid', 'task-absolute-path.yaml'))).rejects.toThrow(TaskProtocolError);
    await expect(loadTask(fixturePath('invalid', 'task-parent-path.yaml'))).rejects.toThrow(TaskProtocolError);
  });
});

describe('loadEvalConfig', () => {
  it('loads the EVAL_ENGINE_SPEC §10 eval fixture and preserves gate order', async () => {
    const config = await loadEvalConfig(fixturePath('valid', 'eval-valid.yaml'));

    expect(config.project).toBe('vibeloop-web');
    expect(config.gates.map((gate) => gate.name).slice(0, 5)).toEqual([
      'git_meta_integrity',
      'protected_files',
      'diff_scope',
      'limits',
      'test_integrity'
    ]);
    expect(config.risk_classification?.auth).toEqual(['src/features/auth/', 'src/app/api/auth/']);
  });

  it('rejects project command gates before scope/integrity guard gates', async () => {
    await expect(loadEvalConfig(fixturePath('invalid', 'eval-order-violation.yaml'))).rejects.toThrow(
      EvalConfigError
    );
  });

  it('rejects unsupported interpolation variables in gate commands', async () => {
    await expect(loadEvalConfig(fixturePath('invalid', 'eval-unknown-var.yaml'))).rejects.toThrow(InterpolationError);
  });
});

describe('limits, interpolation, and risk helpers', () => {
  it('mergeLimits keeps the stricter numeric values', () => {
    expect(mergeLimits({ max_changed_lines: 300 }, { max_changed_lines: 500 })).toEqual({
      max_changed_lines: 300
    });
    expect(
      mergeLimits(
        { max_changed_files: 10, agent_timeout_seconds: 1800 },
        { max_changed_files: 20, max_changed_lines: 500, agent_timeout_seconds: 1200 }
      )
    ).toEqual({ max_changed_files: 10, max_changed_lines: 500, agent_timeout_seconds: 1200 });
  });

  it('allows only the five documented interpolation variables', () => {
    expect(() => assertAllowedInterpolation('npm test -- ${TASK_FILE} ${BASE_COMMIT}')).not.toThrow();
    expect(() => assertAllowedInterpolation('npm test -- ${UNKNOWN}')).toThrow(InterpolationError);
    expect(
      interpolateCommand('echo ${TASK_FILE} ${LOOP_ID}', {
        TASK_FILE: '/tmp/task.yaml',
        LOOP_ID: 'loop-1'
      })
    ).toBe('echo /tmp/task.yaml loop-1');
  });

  it('classifies changed paths into risk areas and flags unknown paths', () => {
    expect(
      classifyRisk(['src/features/auth/login.ts'], {
        auth: ['src/features/auth/'],
        database_schema: ['prisma/']
      })
    ).toEqual({ areas: ['auth'], unknown: false });

    expect(
      classifyRisk(['src/features/auth/login.ts', 'README.md'], {
        auth: ['src/features/auth/']
      })
    ).toEqual({ areas: ['auth'], unknown: true });
  });
});

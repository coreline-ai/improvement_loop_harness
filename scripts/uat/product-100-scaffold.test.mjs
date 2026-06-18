import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProduct100CorpusSpec } from './product-100-corpus.mjs';
import {
  validateProduct100BaseFailures,
  writeProduct100Scaffold
} from './product-100-scaffold.mjs';

describe('Product-100 executable scaffold', () => {
  it('creates five executable repo fixtures with ten issue metadata entries', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'product-100-scaffold-test-'));
    try {
      const report = await writeProduct100Scaffold(tmp, buildProduct100CorpusSpec());
      expect(report.repo_count).toBe(5);
      expect(report.issue_count).toBe(10);
      const issues = JSON.parse(
        await readFile(path.join(tmp, 'node-monorepo-scope/product-100-issues.json'), 'utf8')
      );
      expect(issues).toHaveLength(2);
      const issuesText = await readFile(
        path.join(tmp, 'node-monorepo-scope/product-100-issues.json'),
        'utf8'
      );
      expect(issuesText).not.toContain('HIDDEN_PRODUCT_100');
      expect(issuesText).not.toContain('secret_literal');
      expect(issues[0].hidden_tests[0]).toMatchObject({ redacted: true });
      const pythonGitignore = await readFile(
        path.join(tmp, 'python-service-quantity/.gitignore'),
        'utf8'
      );
      expect(pythonGitignore).toContain('__pycache__/');
      expect(pythonGitignore).toContain('*.pyc');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('proves every seeded issue fails visible and hidden acceptance on base', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'product-100-scaffold-test-'));
    try {
      const spec = buildProduct100CorpusSpec();
      await writeProduct100Scaffold(tmp, spec);
      const report = await validateProduct100BaseFailures(tmp, spec);
      expect(report.issue_count).toBe(10);
      expect(report.visible_base_fail_every_issue).toBe(true);
      expect(report.hidden_base_fail_every_issue).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

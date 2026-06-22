import { describe, expect, it } from 'vitest';
import {
  buildProduct100CorpusSpec,
  publicProduct100CorpusView,
  summarizeProduct100Corpus
} from './product-100-corpus.mjs';

describe('Product-100 corpus metadata', () => {
  it('defines five repo cells and at least ten sequential issues', () => {
    const spec = buildProduct100CorpusSpec({ generatedAt: '2026-06-17T00:00:00.000Z' });
    const summary = summarizeProduct100Corpus(spec);
    expect(summary.repo_count).toBe(5);
    expect(summary.issue_count).toBeGreaterThanOrEqual(10);
    expect(summary.hidden_eval_count).toBeGreaterThanOrEqual(10);
  });

  it('requires visible tests, hidden tests, adversary seed, and write scope for every issue', () => {
    const summary = summarizeProduct100Corpus();
    expect(summary.every_issue_has_visible_test).toBe(true);
    expect(summary.every_issue_has_hidden_test).toBe(true);
    expect(summary.every_issue_has_adversary_seed).toBe(true);
    expect(summary.every_issue_has_write_scope).toBe(true);
  });

  it('exposes a public view without hidden literals', () => {
    const publicView = publicProduct100CorpusView(buildProduct100CorpusSpec());
    const json = JSON.stringify(publicView);
    expect(json).not.toContain('HIDDEN_PRODUCT_100');
    for (const repo of publicView.repos) {
      for (const issue of repo.issues) {
        expect(issue.hidden_tests.every((test) => test.redacted === true)).toBe(true);
      }
    }
  });

  it('gives PY-001 enough public semantics to infer the hidden minimum-one edge', () => {
    const publicView = publicProduct100CorpusView(buildProduct100CorpusSpec());
    const py001 = publicView.repos
      .find((repo) => repo.repo_id === 'python-service-quantity')
      ?.issues.find((issue) => issue.id === 'PY-001');
    expect(py001?.public_task).toContain('minimum-one');
    expect(py001?.selection_signals).toContain('minimum one item');
  });

  it('gives SEC issues exact function-level public guidance without hidden leaks', () => {
    const publicView = publicProduct100CorpusView(buildProduct100CorpusSpec());
    const byId = new Map(
      publicView.repos.flatMap((repo) =>
        repo.issues.map((issue) => [`${repo.repo_id}/${issue.id}`, issue])
      )
    );
    const sec001 = byId.get('security-artifact-leak/SEC-001');
    const sec002 = byId.get('security-artifact-leak/SEC-002');

    expect(sec001?.public_task).toContain('redactArtifact(value)');
    expect(sec001?.selection_signals).toContain('redactArtifact export');
    expect(sec001?.selection_signals).toContain('focused string redaction');
    expect(sec001?.quality_metrics?.max_changed_lines).toBe(80);
    expect(sec002?.public_task).toContain('buildPrBody(input)');
    expect(sec002?.selection_signals).toContain('buildPrBody export');
    expect(JSON.stringify([sec001, sec002])).not.toContain('HIDDEN_PRODUCT_100');
  });

  it('marks brittle visible-test cases as implementation-only fixes', () => {
    const publicView = publicProduct100CorpusView(buildProduct100CorpusSpec());
    const byId = new Map(
      publicView.repos.flatMap((repo) =>
        repo.issues.map((issue) => [`${repo.repo_id}/${issue.id}`, issue])
      )
    );
    expect(byId.get('cli-args/CLI-001')?.write_scope).toEqual(['src/cli.cjs']);
    expect(byId.get('cli-args/CLI-001')?.expected_files).toEqual(['src/cli.cjs']);
    expect(byId.get('python-service-quantity/PY-002')?.write_scope).toEqual([
      'service/api.py'
    ]);
    expect(byId.get('python-service-quantity/PY-002')?.expected_files).toEqual([
      'service/api.py'
    ]);
    expect(byId.get('react-next-form/RX-001')?.write_scope).toEqual([
      'app/cart/page.cjs'
    ]);
    expect(byId.get('react-next-form/RX-001')?.expected_files).toEqual([
      'app/cart/page.cjs'
    ]);
    expect(byId.get('react-next-form/RX-002')?.write_scope).toEqual([
      'lib/sku.cjs'
    ]);
    expect(byId.get('react-next-form/RX-002')?.expected_files).toEqual([
      'lib/sku.cjs'
    ]);
    expect(byId.get('cli-args/CLI-002')?.write_scope).toEqual([
      'src/evidence.cjs'
    ]);
    expect(byId.get('cli-args/CLI-002')?.expected_files).toEqual([
      'src/evidence.cjs'
    ]);
    expect(byId.get('security-artifact-leak/SEC-002')?.write_scope).toEqual([
      'src/pr-body.cjs'
    ]);
    expect(byId.get('security-artifact-leak/SEC-002')?.expected_files).toEqual([
      'src/pr-body.cjs'
    ]);
    expect(byId.get('security-artifact-leak/SEC-001')?.write_scope).toEqual([
      'src/redact.cjs'
    ]);
    expect(byId.get('security-artifact-leak/SEC-001')?.expected_files).toEqual([
      'src/redact.cjs'
    ]);
  });
});

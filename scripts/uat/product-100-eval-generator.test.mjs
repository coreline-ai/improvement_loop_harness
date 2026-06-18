import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { loadEvalConfig } from '../../packages/task-protocol/src/eval-config.ts';
import { loadTask } from '../../packages/task-protocol/src/task.ts';
import { buildProduct100CorpusSpec } from './product-100-corpus.mjs';
import {
  buildProduct100IssueEvalArtifacts,
  summarizeProduct100EvalArtifacts,
  writeProduct100EvalArtifacts
} from './product-100-eval-generator.mjs';

describe('Product-100 eval generator', () => {
  it('generates private hidden evals and advisory proposals for every corpus issue', () => {
    const artifacts = buildProduct100IssueEvalArtifacts(
      buildProduct100CorpusSpec({ generatedAt: '2026-06-17T00:00:00.000Z' })
    );
    const summary = summarizeProduct100EvalArtifacts(artifacts);
    expect(summary.issue_count).toBe(10);
    expect(summary.hidden_source_count).toBe(10);
    expect(summary.every_issue_has_private_eval).toBe(true);
    expect(summary.every_issue_has_adversary_proposal).toBe(true);
    expect(summary.current_loop_adversary_impact_zero).toBe(true);
    expect(summary.public_task_hidden_leak_count).toBe(0);
  });

  it('selects execution images that match each repo runtime', () => {
    const artifacts = buildProduct100IssueEvalArtifacts(buildProduct100CorpusSpec());
    const byIssue = new Map(
      artifacts.map((artifact) => [
        `${artifact.repo_id}/${artifact.issue_id}`,
        artifact.eval.execution.image
      ])
    );
    expect(byIssue.get('python-service-quantity/PY-001')).toBe(
      'python:3.12-alpine'
    );
    expect(byIssue.get('python-service-quantity/PY-002')).toBe(
      'python:3.12-alpine'
    );
    expect(byIssue.get('node-monorepo-scope/NM-001')).toBe('node:22-alpine');
  });

  it('generates syntactically valid hidden JavaScript sources', () => {
    const artifacts = buildProduct100IssueEvalArtifacts(buildProduct100CorpusSpec());
    for (const artifact of artifacts) {
      for (const source of artifact.hidden_sources) {
        if (source.path.endsWith('.cjs') || source.path.endsWith('.mjs')) {
          expect(() => new vm.Script(source.content, { filename: source.path })).not.toThrow();
        }
      }
    }
  });

  it('keeps hidden literals out of public task artifacts while preserving private leak markers', () => {
    const [artifact] = buildProduct100IssueEvalArtifacts(buildProduct100CorpusSpec());
    expect(JSON.stringify(artifact.task)).not.toContain('HIDDEN_PRODUCT_100');
    expect(JSON.stringify(artifact.task)).not.toContain('hidden_tests');
    expect(JSON.stringify(artifact.task)).not.toContain('adversary_seed');
    expect(JSON.stringify(artifact.eval)).toContain('HIDDEN_PRODUCT_100');
    expect(artifact.eval.hidden_acceptance.tests[0].source_path).toContain('../../hidden/');
    expect(artifact.eval.gates.some((gate) => gate.type === 'hidden_acceptance')).toBe(true);
    expect(artifact.eval.gates.some((gate) => gate.command === 'builtin:artifact-leak')).toBe(true);
  });

  it('writes a materialized artifact tree with manifest hashes but no raw hidden literal in manifest', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'product-100-eval-generator-'));
    try {
      const artifacts = buildProduct100IssueEvalArtifacts(buildProduct100CorpusSpec()).slice(0, 1);
      const manifest = await writeProduct100EvalArtifacts(tmp, artifacts);
      expect(manifest.summary.issue_count).toBe(1);
      const manifestText = await readFile(path.join(tmp, 'manifest.json'), 'utf8');
      expect(manifestText).not.toContain('HIDDEN_PRODUCT_100');
      const publicTaskPath = path.join(tmp, artifacts[0].task_path);
      const publicTaskText = await readFile(publicTaskPath, 'utf8');
      expect(publicTaskText).not.toContain('HIDDEN_PRODUCT_100');
      const loadedTask = await loadTask(publicTaskPath);
      expect(loadedTask.id).toBe('nm-001');
      expect(loadedTask.metadata?.product_100?.source_issue_id).toBe('NM-001');
      const privateEvalPath = path.join(tmp, artifacts[0].eval_path);
      const privateEvalText = await readFile(privateEvalPath, 'utf8');
      expect(privateEvalText).toContain('HIDDEN_PRODUCT_100');
      const loaded = await loadEvalConfig(privateEvalPath);
      expect(loaded.hidden_acceptance?.tests).toHaveLength(1);
      expect(loaded.gates.some((gate) => gate.type === 'hidden_acceptance')).toBe(true);
      const hiddenSourceText = await readFile(path.join(tmp, artifacts[0].hidden_source_paths[0]), 'utf8');
      expect(hiddenSourceText).toContain('HIDDEN_PRODUCT_100');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

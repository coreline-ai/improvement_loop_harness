import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunManifest } from '@vibeloop/artifacts';
import type { EvalReport, GateReport } from '@vibeloop/eval-engine';
import {
  assertNoExternalRequests,
  hasExternalRequests,
  renderReportHtml,
  writeReportHtml
} from './render.js';

function baseEvalReport(decision: EvalReport['decision']): EvalReport {
  return {
    schema_version: '1.0',
    loop_id: `loop-${decision}`,
    task_id: `task-${decision}`,
    project_id: 'proj-report',
    base_commit: 'abc123',
    candidate_commit: 'def456',
    decision,
    decision_reasons: [
      {
        code: decision === 'accept' ? 'ALL_PASS' : 'GUARD_PROTECTED_PATH',
        message:
          decision === 'accept'
            ? 'All checks passed.'
            : 'Protected path changed.',
        ref: decision === 'accept' ? null : 'logs/gates/protected.stdout.log'
      }
    ],
    changed_files: [
      {
        path: decision === 'accept' ? 'src/value.cjs' : 'eval.yaml',
        status: decision === 'accept' ? 'modified' : 'added',
        allowed_by_write_scope: true,
        protected: decision !== 'accept'
      }
    ],
    gate_runs: [
      {
        name: 'unit_tests',
        type: 'task_acceptance',
        required: true,
        command: 'node tests/regression.test.js',
        status: decision === 'accept' ? 'pass' : 'skipped',
        exit_code: decision === 'accept' ? 0 : null,
        duration_ms: decision === 'accept' ? 12 : null,
        stdout_ref: 'logs/gates/unit_tests.stdout.log',
        stderr_ref: 'logs/gates/unit_tests.stderr.log',
        summary:
          decision === 'accept'
            ? 'command exited 0'
            : 'skipped after required guard failure'
      }
    ],
    improvement_evidence: [
      {
        type: 'adds_regression_test',
        status: decision === 'accept' ? 'present' : 'missing',
        artifact_ref: 'reports/test-on-base.json',
        supporting_gate: 'test-on-base'
      }
    ],
    risk: { areas: [], human_approval_required: false, reason: 'classified' },
    artifact_refs: [
      'reports/eval-report.json',
      'reports/gate-report.json',
      'logs/gates/unit_tests.stdout.log'
    ],
    summary: `Decision ${decision}`
  };
}

function gateReport(loopId: string): GateReport {
  return {
    schema_version: '1.0',
    generated_at: '2026-06-11T00:00:00.000Z',
    loop_id: loopId,
    gates: []
  };
}

function manifest(loopId: string): RunManifest {
  return {
    schema_version: '1.0',
    loop_id: loopId,
    project_id: 'proj-report',
    created_at: '2026-06-11T00:00:00.000Z',
    artifact_root: '/tmp/run',
    status: 'accepted'
  };
}

describe('renderReportHtml', () => {
  it.each(['accept', 'reject'] as const)(
    'renders %s report as self-contained static HTML with local artifact links',
    (decision) => {
      const report = baseEvalReport(
        decision === 'accept' ? 'accept' : 'reject'
      );
      const html = renderReportHtml({
        evalReport: report,
        gateReport: gateReport(report.loop_id),
        manifest: manifest(report.loop_id),
        generatedAt: new Date('2026-06-11T00:00:00.000Z')
      });

      expect(html).toContain('<style>');
      expect(html).toContain('Decision');
      expect(html).toContain('Gate Runs');
      expect(html).toContain('Improvement Evidence');
      expect(html).toContain('Changed Files');
      expect(html).toContain('../logs/gates/unit_tests.stdout.log');
      expect(hasExternalRequests(html)).toBe(false);
      expect(() => assertNoExternalRequests(html)).not.toThrow();
    }
  );

  it('escapes dynamic text used in the HTML title', () => {
    const report = baseEvalReport('accept');
    report.loop_id = '</title><script>alert(1)</script>';
    const html = renderReportHtml({
      evalReport: report,
      gateReport: gateReport(report.loop_id),
      manifest: manifest(report.loop_id)
    });

    expect(html).not.toContain('</title><script>');
    expect(html).toContain(
      '&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;'
    );
  });

  it('writes a file:// loadable report.html without external network requests', async () => {
    const runRoot = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-report-html-')
    );
    const report = baseEvalReport('accept');
    const written = await writeReportHtml({
      runRoot,
      evalReport: report,
      gateReport: gateReport(report.loop_id),
      manifest: manifest(report.loop_id),
      generatedAt: new Date('2026-06-11T00:00:00.000Z')
    });

    await writeFile(path.join(runRoot, 'logs-placeholder'), '');
    expect(written.fileUrl).toMatch(/^file:\/\//);
    const html = await readFile(written.path, 'utf8');
    expect(html).toBe(written.html);
    expect(hasExternalRequests(html)).toBe(false);
  });
});

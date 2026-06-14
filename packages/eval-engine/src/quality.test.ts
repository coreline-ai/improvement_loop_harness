import { describe, expect, it } from 'vitest';
import { evaluateQuality } from './quality.js';

const present = [{ status: 'present' as const }];

describe('evaluateQuality', () => {
  it('is met with no rules when evaluator is not configured', () => {
    const report = evaluateQuality({
      config: undefined,
      changedFiles: [{ path: 'src/a.ts', addedLines: 999, deletedLines: 0 }],
      evidence: []
    });
    expect(report.status).toBe('not_configured');
    expect(report.met).toBe(true);
    expect(report.rules).toEqual([]);
  });

  it('passes when all configured fixed rules hold', () => {
    const report = evaluateQuality({
      config: {
        min_evidence_present: 1,
        max_changed_files: 3,
        max_changed_lines: 50,
        forbid_protected: true,
        require_test_on_base_pass: true
      },
      changedFiles: [{ path: 'src/cart.ts', addedLines: 10, deletedLines: 2 }],
      evidence: present,
      testOnBase: { base_failed_candidate_passed: true },
      requiredTestCount: 1
    });
    expect(report.met).toBe(true);
    expect(report.status).toBe('pass');
    expect(report.rules.find((r) => r.id === 'Q2')?.status).toBe('pass');
  });

  it('fails Q1 when not enough evidence is present', () => {
    const report = evaluateQuality({
      config: { min_evidence_present: 1 },
      changedFiles: [{ path: 'src/a.ts', addedLines: 1, deletedLines: 0 }],
      evidence: [{ status: 'missing' }]
    });
    expect(report.met).toBe(false);
    expect(report.rules.find((r) => r.id === 'Q1')?.status).toBe('fail');
  });

  it('fails Q4 on bloated diff and protected path touch', () => {
    const report = evaluateQuality({
      config: {
        max_changed_files: 1,
        max_changed_lines: 5,
        forbid_protected: true
      },
      changedFiles: [
        { path: 'src/a.ts', addedLines: 40, deletedLines: 0 },
        { path: 'eval.yaml', addedLines: 1, deletedLines: 0, protected: true }
      ],
      evidence: present
    });
    expect(report.met).toBe(false);
    const ids = report.rules
      .filter((r) => r.status === 'fail')
      .map((r) => r.id);
    expect(ids).toContain('Q4_files');
    expect(ids).toContain('Q4_lines');
    expect(ids).toContain('Q4_protected');
  });

  it('skips Q2 when the task declares no required tests', () => {
    const report = evaluateQuality({
      config: { require_test_on_base_pass: true },
      changedFiles: [{ path: 'src/a.ts', addedLines: 1, deletedLines: 0 }],
      evidence: present,
      requiredTestCount: 0
    });
    expect(report.rules.find((r) => r.id === 'Q2')?.status).toBe('skip');
    expect(report.met).toBe(true);
  });

  it('fails Q3 target directness when changes miss the target paths', () => {
    const report = evaluateQuality({
      config: { target_paths: ['src/cart/'] },
      changedFiles: [
        { path: 'src/auth/login.ts', addedLines: 3, deletedLines: 1 }
      ],
      evidence: present
    });
    expect(report.rules.find((r) => r.id === 'Q3')?.status).toBe('fail');
    expect(report.met).toBe(false);
  });

  it('passes Q5 metric delta rules when configured thresholds hold', () => {
    const report = evaluateQuality({
      config: {
        min_coverage_delta: 2,
        max_latency_regression_ms: 5,
        max_security_findings_delta: 0,
        max_critical_security_findings_delta: 0,
        max_duplicate_score_delta: 0
      },
      changedFiles: [{ path: 'src/a.ts', addedLines: 2, deletedLines: 1 }],
      evidence: present,
      baselineMetrics: {
        coverage_percent: 80,
        latency_ms: 100,
        security_findings: 2,
        critical_security_findings: 0,
        duplicate_score: 10
      },
      candidateMetrics: {
        coverage_percent: 83,
        latency_ms: 104,
        security_findings: 1,
        critical_security_findings: 0,
        duplicate_score: 9
      }
    });
    expect(report.met).toBe(true);
    expect(report.rules.find((r) => r.id === 'Q5_coverage')).toMatchObject({
      status: 'pass',
      value: 3,
      baseline: 80,
      candidate: 83
    });
    expect(report.rules.find((r) => r.id === 'Q5_latency')).toMatchObject({
      status: 'pass',
      value: 4
    });
  });

  it('fails Q5 closed when a configured metric is missing', () => {
    const report = evaluateQuality({
      config: { min_coverage_delta: 1 },
      changedFiles: [{ path: 'src/a.ts', addedLines: 1, deletedLines: 0 }],
      evidence: present,
      baselineMetrics: { coverage_percent: 80 },
      candidateMetrics: {}
    });
    expect(report.met).toBe(false);
    expect(report.rules.find((r) => r.id === 'Q5_coverage')).toMatchObject({
      status: 'fail',
      detail: 'min_coverage_delta_missing_metric',
      baseline: 80,
      threshold: 1
    });
  });

  it('fails Q5 when metric regressions exceed deterministic thresholds', () => {
    const report = evaluateQuality({
      config: {
        min_coverage_delta: 0,
        max_latency_regression_ms: 10,
        max_security_findings_delta: 0,
        max_duplicate_score_delta: 0
      },
      changedFiles: [{ path: 'src/a.ts', addedLines: 1, deletedLines: 0 }],
      evidence: present,
      baselineMetrics: {
        coverage_percent: 80,
        latency_ms: 100,
        security_findings: 1,
        duplicate_score: 3
      },
      candidateMetrics: {
        coverage_percent: 79,
        latency_ms: 125,
        security_findings: 3,
        duplicate_score: 4
      }
    });
    expect(report.met).toBe(false);
    const failedIds = report.rules
      .filter((rule) => rule.status === 'fail')
      .map((rule) => rule.id);
    expect(failedIds).toContain('Q5_coverage');
    expect(failedIds).toContain('Q5_latency');
    expect(failedIds).toContain('Q5_security_findings');
    expect(failedIds).toContain('Q5_duplicate_score');
  });
});

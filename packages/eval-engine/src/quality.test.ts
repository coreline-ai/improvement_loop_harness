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
});

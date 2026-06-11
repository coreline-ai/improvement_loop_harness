import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GuardChangedFile } from '@vibeloop/guards';
import { describe, expect, it } from 'vitest';
import { decide, type DecideInput } from './decision/engine.js';
import {
  DECISION_RULES,
  REASON_CODES,
  type ReasonCode
} from './decision/rules.js';
import type { EvidenceResult } from './evidence.js';
import { buildEvalReport, writeEvalReport } from './report/eval-report.js';
import type { GateReportEntry } from './types.js';

function changedFile(
  overrides: Partial<GuardChangedFile> = {}
): GuardChangedFile {
  return {
    path: 'src/app.ts',
    status: 'modified',
    isSymlink: false,
    addedLines: 1,
    deletedLines: 0,
    allowedByWriteScope: true,
    protected: false,
    ...overrides
  };
}

function gate(overrides: Partial<GateReportEntry> = {}): GateReportEntry {
  return {
    name: 'unit_tests',
    type: 'hard',
    required: true,
    command: 'npm test',
    status: 'pass',
    exit_code: 0,
    started_at: '2026-06-10T00:00:00.000Z',
    finished_at: '2026-06-10T00:00:01.000Z',
    duration_ms: 1000,
    stdout_ref: 'logs/gates/unit_tests.stdout.log',
    stderr_ref: 'logs/gates/unit_tests.stderr.log',
    summary: 'ok',
    ...overrides
  };
}

function evidence(overrides: Partial<EvidenceResult> = {}): EvidenceResult {
  return {
    type: 'adds_regression_test',
    status: 'present',
    artifact_ref: 'reports/test-on-base.json',
    supporting_gate: 'test-on-base',
    ...overrides
  };
}

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    changedFiles: [changedFile()],
    gateRuns: [gate()],
    improvementEvidence: [evidence()],
    risk: { areas: [], humanApprovalRiskAreas: [], unknown: false },
    taskRiskArea: 'none',
    taskHumanApprovalRequired: false,
    metaEvaluationEnabled: false,
    ...overrides
  };
}

describe('decision rules', () => {
  it('defines the 12 first-match-wins rules in order', () => {
    expect(DECISION_RULES.map((rule) => rule.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    ]);
    expect(DECISION_RULES.map((rule) => rule.code)).toEqual([
      REASON_CODES.NO_CHANGED_FILES,
      REASON_CODES.GUARD_GIT_META_TAMPER,
      REASON_CODES.GUARD_PROTECTED_PATH,
      REASON_CODES.META_EVAL_REQUIRED,
      REASON_CODES.GUARD_SCOPE_VIOLATION,
      REASON_CODES.GUARD_TEST_INTEGRITY,
      REASON_CODES.GUARD_LIMIT_EXCEEDED,
      REASON_CODES.GATE_REQUIRED_FAILED,
      REASON_CODES.EVIDENCE_MISSING,
      REASON_CODES.EVIDENCE_INCONCLUSIVE,
      REASON_CODES.RISK_HUMAN_APPROVAL,
      REASON_CODES.ALL_PASS
    ]);
  });

  it.each<[string, Partial<DecideInput>, string, ReasonCode]>([
    ['rule 1', { changedFiles: [] }, 'reject', REASON_CODES.NO_CHANGED_FILES],
    [
      'rule 2',
      {
        gateRuns: [
          gate({
            name: 'git_meta_integrity',
            type: 'integrity',
            command: 'builtin:git-meta-integrity',
            status: 'fail',
            exit_code: 1
          })
        ]
      },
      'reject',
      REASON_CODES.GUARD_GIT_META_TAMPER
    ],
    [
      'rule 3',
      { changedFiles: [changedFile({ path: '.env.local', protected: true })] },
      'reject',
      REASON_CODES.GUARD_PROTECTED_PATH
    ],
    [
      'rule 4',
      {
        changedFiles: [changedFile({ path: 'eval.yaml', protected: true })],
        metaEvaluationEnabled: true,
        taskRiskArea: 'eval_system'
      },
      'needs_human_review',
      REASON_CODES.META_EVAL_REQUIRED
    ],
    [
      'rule 5',
      {
        changedFiles: [
          changedFile({ path: 'outside.ts', allowedByWriteScope: false })
        ]
      },
      'reject',
      REASON_CODES.GUARD_SCOPE_VIOLATION
    ],
    [
      'rule 6',
      {
        gateRuns: [
          gate({
            name: 'test_integrity',
            type: 'integrity',
            command: 'builtin:test-integrity',
            status: 'fail',
            exit_code: 1
          })
        ]
      },
      'reject',
      REASON_CODES.GUARD_TEST_INTEGRITY
    ],
    [
      'rule 7',
      {
        gateRuns: [
          gate({
            name: 'limits',
            type: 'integrity',
            command: 'builtin:limits',
            status: 'fail',
            exit_code: 1
          })
        ]
      },
      'reject',
      REASON_CODES.GUARD_LIMIT_EXCEEDED
    ],
    [
      'rule 8',
      {
        gateRuns: [gate({ name: 'unit_tests', status: 'fail', exit_code: 1 })]
      },
      'reject',
      REASON_CODES.GATE_REQUIRED_FAILED
    ],
    [
      'rule 9',
      { improvementEvidence: [evidence({ status: 'missing' })] },
      'reject',
      REASON_CODES.EVIDENCE_MISSING
    ],
    [
      'rule 10',
      { improvementEvidence: [evidence({ status: 'inconclusive' })] },
      'needs_more_tests',
      REASON_CODES.EVIDENCE_INCONCLUSIVE
    ],
    [
      'rule 11',
      {
        risk: {
          areas: ['auth'],
          humanApprovalRiskAreas: ['auth'],
          unknown: false
        }
      },
      'needs_human_review',
      REASON_CODES.RISK_HUMAN_APPROVAL
    ],
    ['rule 12', {}, 'accept', REASON_CODES.ALL_PASS]
  ])(
    '%s returns expected decision and reason code',
    (_name, overrides, expectedDecision, expectedCode) => {
      const result = decide(input(overrides));

      expect(result.decision).toBe(expectedDecision);
      expect(result.reasons[0]?.code).toBe(expectedCode);
    }
  );

  it('uses rule 5 before a simultaneous required gate failure', () => {
    const result = decide(
      input({
        changedFiles: [
          changedFile({ path: 'outside.ts', allowedByWriteScope: false })
        ],
        gateRuns: [gate({ status: 'fail', exit_code: 1 })]
      })
    );

    expect(result.decision).toBe('reject');
    expect(result.reasons[0]?.code).toBe(REASON_CODES.GUARD_SCOPE_VIOLATION);
  });

  it('is deterministic across repeated invocations for the same input', () => {
    const subject = input({
      improvementEvidence: [evidence({ status: 'inconclusive' })]
    });
    const expected = JSON.stringify(decide(subject));

    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(decide(subject))).toBe(expected);
    }
  });
});

describe('eval-report', () => {
  it('builds and writes a schema-valid report even when a guard fails and evidence is empty', async () => {
    const decision = decide(
      input({
        changedFiles: [changedFile({ path: '.env.local', protected: true })],
        improvementEvidence: []
      })
    );
    const report = buildEvalReport({
      loopId: 'loop-report',
      taskId: 'task-report',
      projectId: 'proj-report',
      baseCommit: 'abc123',
      decision: decision.decision,
      decisionReasons: decision.reasons,
      changedFiles: [changedFile({ path: '.env.local', protected: true })],
      gateRuns: [
        gate({
          name: 'protected_files',
          type: 'scope',
          command: 'builtin:protected-files',
          status: 'fail',
          exit_code: 1
        })
      ],
      improvementEvidence: [],
      artifactRefs: ['patches/changed-files.json'],
      risk: { areas: [], human_approval_required: false, reason: 'none' }
    });
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-eval-report-')
    );
    const reportPath = await writeEvalReport(artifactRoot, report);
    const persisted = JSON.parse(
      await readFile(reportPath, 'utf8')
    ) as typeof report;

    expect(report.decision).toBe('reject');
    expect(report.improvement_evidence).toEqual([]);
    expect(report.decision_reasons[0]?.code).toBe(
      REASON_CODES.GUARD_PROTECTED_PATH
    );
    expect(report.summary).toContain('Decision reject');
    expect(persisted.artifact_refs).toContain('reports/eval-report.json');
    expect(persisted.changed_files[0]).toMatchObject({
      path: '.env.local',
      allowed_by_write_scope: true,
      protected: true
    });
  });
});

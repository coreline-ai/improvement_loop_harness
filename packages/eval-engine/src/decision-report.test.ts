import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  buildEvalReport,
  collectRulepackSemanticReports,
  fallbackProvenance,
  hashArtifactRefs,
  localVerifierFromDecision,
  sha256Text,
  verifyCandidatePatchHash,
  verifyEvalReportProvenance,
  verifierLaneMatchesLocal,
  writeEvalReport
} from './report/eval-report.js';
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
  it('defines the 15 first-match-wins rules in order', () => {
    expect(DECISION_RULES.map((rule) => rule.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
    ]);
    expect(DECISION_RULES.map((rule) => rule.code)).toEqual([
      REASON_CODES.NO_CHANGED_FILES,
      REASON_CODES.GUARD_GIT_META_TAMPER,
      REASON_CODES.ARTIFACT_PROVENANCE_MISMATCH,
      REASON_CODES.GUARD_PROTECTED_PATH,
      REASON_CODES.META_EVAL_REQUIRED,
      REASON_CODES.GUARD_SCOPE_VIOLATION,
      REASON_CODES.GUARD_TEST_INTEGRITY,
      REASON_CODES.GUARD_ARTIFACT_LEAK,
      REASON_CODES.GUARD_LIMIT_EXCEEDED,
      REASON_CODES.GATE_REQUIRED_FAILED,
      REASON_CODES.EVIDENCE_MISSING,
      REASON_CODES.EVIDENCE_INCONCLUSIVE,
      REASON_CODES.RISK_HUMAN_APPROVAL,
      REASON_CODES.VERIFIER_MISMATCH,
      REASON_CODES.ALL_PASS
    ]);
  });

  it('rejects with GUARD_ARTIFACT_LEAK when the artifact-leak gate fails', () => {
    const result = decide({
      changedFiles: [
        {
          path: 'src/a.ts',
          status: 'modified',
          isSymlink: false,
          addedLines: 1,
          deletedLines: 0
        }
      ],
      gateRuns: [
        gate({
          name: 'artifact_leak',
          type: 'integrity',
          command: 'builtin:artifact-leak',
          status: 'fail',
          exit_code: 1
        })
      ],
      improvementEvidence: []
    });
    expect(result.decision).toBe('reject');
    expect(result.reasons[0]?.code).toBe(REASON_CODES.GUARD_ARTIFACT_LEAK);
  });

  it('does not accept when no required gates are configured', () => {
    const result = decide(
      input({
        gateRuns: [
          gate({
            required: false,
            name: 'advisory_only',
            type: 'advisory',
            command: 'node advisory.js'
          })
        ]
      })
    );

    expect(result.decision).toBe('needs_more_tests');
    expect(result.reasons[0]?.code).toBe(REASON_CODES.EVIDENCE_INCONCLUSIVE);
    expect(result.reasons[0]?.message).toContain('No required gates');
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
      { provenanceVerified: false },
      'reject',
      REASON_CODES.ARTIFACT_PROVENANCE_MISMATCH
    ],
    [
      'rule 4',
      { changedFiles: [changedFile({ path: '.env.local', protected: true })] },
      'reject',
      REASON_CODES.GUARD_PROTECTED_PATH
    ],
    [
      'rule 5',
      {
        changedFiles: [changedFile({ path: 'eval.yaml', protected: true })],
        metaEvaluationEnabled: true,
        taskRiskArea: 'eval_system'
      },
      'needs_human_review',
      REASON_CODES.META_EVAL_REQUIRED
    ],
    [
      'rule 6',
      {
        changedFiles: [
          changedFile({ path: 'outside.ts', allowedByWriteScope: false })
        ]
      },
      'reject',
      REASON_CODES.GUARD_SCOPE_VIOLATION
    ],
    [
      'rule 7',
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
      'rule 9',
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
      'rule 10',
      {
        gateRuns: [gate({ name: 'unit_tests', status: 'fail', exit_code: 1 })]
      },
      'reject',
      REASON_CODES.GATE_REQUIRED_FAILED
    ],
    [
      'rule 11',
      { improvementEvidence: [evidence({ status: 'missing' })] },
      'reject',
      REASON_CODES.EVIDENCE_MISSING
    ],
    [
      'rule 12',
      { improvementEvidence: [evidence({ status: 'inconclusive' })] },
      'needs_more_tests',
      REASON_CODES.EVIDENCE_INCONCLUSIVE
    ],
    [
      'rule 13',
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
    [
      'rule 14',
      { verifierMismatch: true },
      'needs_human_review',
      REASON_CODES.VERIFIER_MISMATCH
    ],
    ['rule 15', {}, 'accept', REASON_CODES.ALL_PASS]
  ])(
    '%s returns expected decision and reason code',
    (_name, overrides, expectedDecision, expectedCode) => {
      const result = decide(input(overrides));

      expect(result.decision).toBe(expectedDecision);
      expect(result.reasons[0]?.code).toBe(expectedCode);
    }
  );

  it('uses scope violation before a simultaneous required gate failure', () => {
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

  it('uses provenance mismatch before guard results derived from untrusted artifacts', () => {
    const result = decide(
      input({
        provenanceVerified: false,
        gateRuns: [
          gate({
            name: 'limits',
            type: 'integrity',
            command: 'builtin:limits',
            status: 'fail',
            exit_code: 1
          })
        ]
      })
    );

    expect(result.decision).toBe('reject');
    expect(result.reasons[0]?.code).toBe(
      REASON_CODES.ARTIFACT_PROVENANCE_MISMATCH
    );
  });

  it('does not classify project commands that merely mention limits as builtin limit failures', () => {
    const result = decide(
      input({
        gateRuns: [
          gate({
            name: 'check_rate_limits',
            type: 'task_acceptance',
            command: 'npm run check-rate-limits',
            status: 'fail',
            exit_code: 1
          })
        ]
      })
    );

    expect(result.decision).toBe('reject');
    expect(result.reasons[0]?.code).toBe(REASON_CODES.GATE_REQUIRED_FAILED);
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
      risk: { areas: [], human_approval_required: false, reason: 'none' },
      provenance: fallbackProvenance(),
      provenanceVerified: true
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

  it('records optional gate errors as trust summary signals without changing the decision', () => {
    const decision = decide(input());
    const report = buildEvalReport({
      loopId: 'loop-optional-error',
      taskId: 'task-optional-error',
      projectId: 'proj-optional-error',
      baseCommit: 'abc123',
      decision: decision.decision,
      decisionReasons: decision.reasons,
      changedFiles: [changedFile()],
      gateRuns: [
        gate(),
        gate({
          name: 'optional_timeout',
          type: 'hard',
          required: false,
          status: 'error',
          exit_code: null,
          summary: 'gate timed out',
          stdout_ref: 'logs/gates/optional_timeout.stdout.log',
          stderr_ref: 'logs/gates/optional_timeout.stderr.log'
        })
      ],
      improvementEvidence: [evidence()],
      risk: { areas: [], human_approval_required: false, reason: 'none' },
      provenance: fallbackProvenance(),
      provenanceVerified: true
    });

    expect(report.decision).toBe('accept');
    expect(report.trust_summary?.optional_gate_errors_count).toBe(1);
  });

  it('verifies gate artifact provenance hashes and rejects mutated artifacts', async () => {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-provenance-')
    );
    await mkdir(path.join(artifactRoot, 'reports'), { recursive: true });
    await writeFile(
      path.join(artifactRoot, 'reports', 'gate-report.json'),
      '{"ok":true}\n'
    );
    const provenance = {
      ...fallbackProvenance(),
      gate_artifact_hashes: await hashArtifactRefs(artifactRoot, [
        'reports/gate-report.json'
      ])
    };

    await expect(
      verifyEvalReportProvenance(artifactRoot, {
        schema_version: '1.1',
        provenance
      })
    ).resolves.toBe(true);

    await writeFile(
      path.join(artifactRoot, 'reports', 'gate-report.json'),
      '{"ok":false}\n'
    );

    await expect(
      verifyEvalReportProvenance(artifactRoot, {
        schema_version: '1.1',
        provenance
      })
    ).resolves.toBe(false);
  });

  it('records rulepack semantic verdicts in eval-report and binds their gate log provenance', async () => {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-rulepack-provenance-')
    );
    await mkdir(path.join(artifactRoot, 'logs/gates'), { recursive: true });
    const semanticRef = 'logs/gates/rulepack_semantic.stdout.log';
    await writeFile(
      path.join(artifactRoot, semanticRef),
      `${JSON.stringify(
        {
          status: 'pass',
          summary: 'rulepack semantic gate passed 1/1 rule(s)',
          violations: [],
          details: {
            rulepack_semantic: {
              file: 'policy/rulepack.lock.json',
              lock_hash: 'sha256:abc',
              source_loop_id: 'loop-n',
              current_loop_id: 'loop-n-plus-one',
              image: 'node:22-alpine',
              network: 'none',
              status: 'pass',
              total: 1,
              passed: 1,
              results: [
                {
                  rule_id: 'rule-value-edge',
                  status: 'pass',
                  expected: 'pass',
                  actual: 'pass',
                  summary: 'command exited 0'
                }
              ],
              errors: []
            }
          }
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      path.join(artifactRoot, 'logs/gates/rulepack_semantic.stderr.log'),
      ''
    );
    const semanticGate = gate({
      name: 'rulepack_semantic',
      type: 'integrity',
      command: 'builtin:rulepack-semantic',
      stdout_ref: semanticRef,
      stderr_ref: 'logs/gates/rulepack_semantic.stderr.log'
    });
    const rulepackSemantic = await collectRulepackSemanticReports(
      artifactRoot,
      [semanticGate]
    );
    const provenance = {
      ...fallbackProvenance(),
      gate_artifact_hashes: await hashArtifactRefs(artifactRoot, [
        semanticGate.stdout_ref,
        semanticGate.stderr_ref
      ])
    };
    const report = buildEvalReport({
      loopId: 'loop-n-plus-one',
      taskId: 'task-1',
      baseCommit: 'base',
      decision: 'accept',
      decisionReasons: [{ code: 'ALL_PASS', message: 'ok' }],
      changedFiles: [changedFile()],
      gateRuns: [semanticGate],
      improvementEvidence: [],
      provenance,
      verifier: localVerifierFromDecision({
        decision: 'accept',
        gateRuns: [semanticGate]
      }),
      rulepackSemantic
    });

    expect(report.rulepack_semantic?.[0]).toMatchObject({
      file: 'policy/rulepack.lock.json',
      lock_hash: 'sha256:abc',
      artifact_ref: semanticRef,
      status: 'pass',
      total: 1,
      passed: 1
    });
    await expect(
      verifyEvalReportProvenance(artifactRoot, report)
    ).resolves.toBe(true);

    await writeFile(
      path.join(artifactRoot, semanticRef),
      '{"tampered":true}\n'
    );
    await expect(
      verifyEvalReportProvenance(artifactRoot, report)
    ).resolves.toBe(false);
  });

  it('verifyCandidatePatchHash binds the report to the on-disk patch and detects tampering (B3)', async () => {
    const artifactRoot = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-patchhash-')
    );
    await mkdir(path.join(artifactRoot, 'patches'), { recursive: true });
    const patchPath = path.join(artifactRoot, 'patches', 'candidate.patch');
    const patch =
      'diff --git a/src/value.cjs b/src/value.cjs\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n';
    await writeFile(patchPath, patch);

    const provenance = {
      ...fallbackProvenance(),
      candidate_patch_hash: sha256Text(patch)
    };

    // intact patch → recorded hash matches the on-disk bytes.
    await expect(
      verifyCandidatePatchHash(artifactRoot, {
        schema_version: '1.1',
        provenance
      })
    ).resolves.toBe(true);

    // tampered patch → hash diverges → fail closed (drives ARTIFACT_PROVENANCE_MISMATCH).
    await writeFile(patchPath, `${patch}// sneaky extra line\n`);
    await expect(
      verifyCandidatePatchHash(artifactRoot, {
        schema_version: '1.1',
        provenance
      })
    ).resolves.toBe(false);

    // missing patch file → fail closed.
    await rm(patchPath);
    await expect(
      verifyCandidatePatchHash(artifactRoot, {
        schema_version: '1.1',
        provenance
      })
    ).resolves.toBe(false);

    // 1.1 without provenance cannot bind (fail closed); legacy 1.0 has no hash to bind.
    await expect(
      verifyCandidatePatchHash(artifactRoot, { schema_version: '1.1' })
    ).resolves.toBe(false);
    await expect(
      verifyCandidatePatchHash(artifactRoot, { schema_version: '1.0' })
    ).resolves.toBe(true);
  });

  it('marks strict verifier policy as missing CI evidence until a CI lane is attached', () => {
    const verifier = localVerifierFromDecision({
      policy: 'strict',
      decision: 'accept',
      gateRuns: [gate({ name: 'unit_tests', required: true, status: 'pass' })]
    });

    expect(verifier.mismatch).toBe(true);
    expect(verifier.lanes).toEqual([
      expect.objectContaining({
        lane: 'local',
        status: 'pass',
        decision: 'accept'
      }),
      expect.objectContaining({ lane: 'ci', status: 'missing', decision: null })
    ]);
  });

  it('compares verifier lanes only by decision and required gate name/status', () => {
    const local = {
      lane: 'local' as const,
      status: 'pass' as const,
      decision: 'accept',
      required_gates: [{ name: 'unit_tests', status: 'pass' }],
      artifact_ref: 'reports/eval-report.json',
      summary: 'local'
    };

    expect(
      verifierLaneMatchesLocal(local, {
        ...local,
        lane: 'ci',
        artifact_ref: 'ci/eval-report.json',
        summary: 'different duration/log/timestamp ignored'
      })
    ).toBe(true);
    expect(
      verifierLaneMatchesLocal(local, {
        ...local,
        lane: 'ci',
        decision: 'reject'
      })
    ).toBe(false);
    expect(
      verifierLaneMatchesLocal(local, {
        ...local,
        lane: 'ci',
        required_gates: [{ name: 'unit_tests', status: 'fail' }]
      })
    ).toBe(false);
  });
});

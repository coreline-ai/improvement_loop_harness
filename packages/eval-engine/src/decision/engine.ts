import type { Decision } from '@vibeloop/shared';
import type { GuardChangedFile } from '@vibeloop/guards';
import type { EvidenceResult } from '../evidence.js';
import type { GateReportEntry } from '../types.js';
import { REASON_CODES, type ReasonCode } from './rules.js';

export interface DecisionReason {
  code: ReasonCode;
  message: string;
  ref?: string | null | undefined;
}

export interface DecisionRiskInput {
  areas?: string[] | undefined;
  humanApprovalRequired?: boolean | undefined;
  unknown?: boolean | undefined;
  humanApprovalRiskAreas?: string[] | undefined;
}

export interface DecideInput {
  changedFiles: GuardChangedFile[];
  gateRuns: GateReportEntry[];
  improvementEvidence: EvidenceResult[];
  risk?: DecisionRiskInput | undefined;
  taskRiskArea?: string | undefined;
  taskHumanApprovalRequired?: boolean | undefined;
  metaEvaluationEnabled?: boolean | undefined;
  provenanceVerified?: boolean | undefined;
  verifierMismatch?: boolean | undefined;
}

export interface DecisionResult {
  decision: Decision;
  reasons: DecisionReason[];
}

function reason(
  code: ReasonCode,
  message: string,
  ref?: string | null
): DecisionReason {
  return { code, message, ...(ref !== undefined ? { ref } : {}) };
}

function gateFailed(gate: GateReportEntry): boolean {
  return gate.status === 'fail' || gate.status === 'error';
}

function gateMatchesBuiltin(
  gate: GateReportEntry,
  commands: readonly string[]
): boolean {
  const command = gate.command.toLowerCase().replaceAll('_', '-');
  return (
    gate.type === 'integrity' &&
    commands.some((candidate) => command === candidate)
  );
}

function protectedPathChanged(
  input: DecideInput
): GuardChangedFile | undefined {
  return input.changedFiles.find((file) => file.protected === true);
}

function scopeViolation(input: DecideInput): GuardChangedFile | undefined {
  return input.changedFiles.find(
    (file) => file.allowedByWriteScope === false || file.isSymlink === true
  );
}

function failedSpecificGate(
  input: DecideInput,
  commands: readonly string[]
): GateReportEntry | undefined {
  return input.gateRuns.find(
    (gate) => gateFailed(gate) && gateMatchesBuiltin(gate, commands)
  );
}

function failedRequiredGate(input: DecideInput): GateReportEntry | undefined {
  return input.gateRuns.find((gate) => gate.required && gateFailed(gate));
}

function hasRequiredGate(input: DecideInput): boolean {
  return input.gateRuns.some((gate) => gate.required);
}

function evidenceAllMissing(input: DecideInput): boolean {
  return (
    input.improvementEvidence.length > 0 &&
    input.improvementEvidence.every((item) => item.status === 'missing')
  );
}

function evidenceInconclusive(input: DecideInput): EvidenceResult | undefined {
  return input.improvementEvidence.find(
    (item) => item.status === 'inconclusive'
  );
}

function needsHumanApproval(input: DecideInput): boolean {
  const risk = input.risk;
  if (
    input.taskHumanApprovalRequired ||
    risk?.humanApprovalRequired ||
    risk?.unknown
  ) {
    return true;
  }

  const approvalAreas = new Set(risk?.humanApprovalRiskAreas ?? []);
  for (const area of risk?.areas ?? []) {
    if (approvalAreas.has(area)) {
      return true;
    }
  }
  return false;
}

export function decide(input: DecideInput): DecisionResult {
  if (input.changedFiles.length === 0) {
    return {
      decision: 'reject',
      reasons: [
        reason(REASON_CODES.NO_CHANGED_FILES, 'No changed files were detected.')
      ]
    };
  }

  const gitMetaGate = failedSpecificGate(input, [
    'builtin:git-meta-integrity'
  ]);
  if (gitMetaGate) {
    return {
      decision: 'reject',
      reasons: [
        reason(
          REASON_CODES.GUARD_GIT_META_TAMPER,
          'Git metadata changed during the loop.',
          gitMetaGate.stdout_ref
        )
      ]
    };
  }

  if (input.provenanceVerified === false) {
    return {
      decision: 'reject',
      reasons: [
        reason(
          REASON_CODES.ARTIFACT_PROVENANCE_MISMATCH,
          'Eval report provenance hash verification failed.',
          'reports/eval-report.json'
        )
      ]
    };
  }

  const protectedFile = protectedPathChanged(input);
  if (
    protectedFile &&
    !(input.metaEvaluationEnabled && input.taskRiskArea === 'eval_system')
  ) {
    return {
      decision: 'reject',
      reasons: [
        reason(
          REASON_CODES.GUARD_PROTECTED_PATH,
          `Protected path changed: ${protectedFile.path}`,
          protectedFile.path
        )
      ]
    };
  }

  if (
    protectedFile &&
    input.metaEvaluationEnabled &&
    input.taskRiskArea === 'eval_system'
  ) {
    return {
      decision: 'needs_human_review',
      reasons: [
        reason(
          REASON_CODES.META_EVAL_REQUIRED,
          `Protected eval-system path requires meta-evaluation: ${protectedFile.path}`,
          protectedFile.path
        )
      ]
    };
  }

  const scopedFile = scopeViolation(input);
  if (scopedFile) {
    return {
      decision: 'reject',
      reasons: [
        reason(
          REASON_CODES.GUARD_SCOPE_VIOLATION,
          `Change is outside allowed scope or uses a symlink: ${scopedFile.path}`,
          scopedFile.path
        )
      ]
    };
  }

  const testIntegrityGate = failedSpecificGate(input, [
    'builtin:test-integrity'
  ]);
  if (testIntegrityGate) {
    return {
      decision: 'reject',
      reasons: [
        reason(
          REASON_CODES.GUARD_TEST_INTEGRITY,
          'Test integrity guard failed.',
          testIntegrityGate.stdout_ref
        )
      ]
    };
  }

  const artifactLeakGate = failedSpecificGate(input, [
    'builtin:artifact-leak'
  ]);
  if (artifactLeakGate) {
    return {
      decision: 'reject',
      reasons: [
        reason(
          REASON_CODES.GUARD_ARTIFACT_LEAK,
          'Agent output leaked forbidden context/secret content.',
          artifactLeakGate.stdout_ref
        )
      ]
    };
  }

  const limitsGate = failedSpecificGate(input, ['builtin:limits']);
  if (limitsGate) {
    return {
      decision: 'reject',
      reasons: [
        reason(
          REASON_CODES.GUARD_LIMIT_EXCEEDED,
          'Change limits were exceeded.',
          limitsGate.stdout_ref
        )
      ]
    };
  }

  const requiredGate = failedRequiredGate(input);
  if (requiredGate) {
    return {
      decision: 'reject',
      reasons: [
        reason(
          REASON_CODES.GATE_REQUIRED_FAILED,
          `Required gate failed: ${requiredGate.name}`,
          requiredGate.stdout_ref
        )
      ]
    };
  }

  if (!hasRequiredGate(input)) {
    return {
      decision: 'needs_more_tests',
      reasons: [
        reason(
          REASON_CODES.EVIDENCE_INCONCLUSIVE,
          'No required gates were configured; at least one required verification gate is needed before accept.'
        )
      ]
    };
  }

  if (evidenceAllMissing(input)) {
    return {
      decision: 'reject',
      reasons: [
        reason(
          REASON_CODES.EVIDENCE_MISSING,
          'All required evidence is missing.'
        )
      ]
    };
  }

  const inconclusiveEvidence = evidenceInconclusive(input);
  if (inconclusiveEvidence) {
    return {
      decision: 'needs_more_tests',
      reasons: [
        reason(
          REASON_CODES.EVIDENCE_INCONCLUSIVE,
          `Evidence is inconclusive: ${inconclusiveEvidence.type}`,
          inconclusiveEvidence.artifact_ref
        )
      ]
    };
  }

  if (needsHumanApproval(input)) {
    return {
      decision: 'needs_human_review',
      reasons: [
        reason(
          REASON_CODES.RISK_HUMAN_APPROVAL,
          'Risk classification requires human approval.'
        )
      ]
    };
  }

  if (input.verifierMismatch === true) {
    return {
      decision: 'needs_human_review',
      reasons: [
        reason(
          REASON_CODES.VERIFIER_MISMATCH,
          'Verifier lane result does not match local deterministic result.',
          'reports/eval-report.json'
        )
      ]
    };
  }

  return {
    decision: 'accept',
    reasons: [
      reason(
        REASON_CODES.ALL_PASS,
        'All required guards, gates, evidence, and risk checks passed.'
      )
    ]
  };
}

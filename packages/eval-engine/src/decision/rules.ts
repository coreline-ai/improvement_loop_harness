import type { Decision } from '@vibeloop/shared';

export const REASON_CODES = {
  NO_CHANGED_FILES: 'NO_CHANGED_FILES',
  GUARD_GIT_META_TAMPER: 'GUARD_GIT_META_TAMPER',
  GUARD_PROTECTED_PATH: 'GUARD_PROTECTED_PATH',
  META_EVAL_REQUIRED: 'META_EVAL_REQUIRED',
  GUARD_SCOPE_VIOLATION: 'GUARD_SCOPE_VIOLATION',
  GUARD_TEST_INTEGRITY: 'GUARD_TEST_INTEGRITY',
  GUARD_ARTIFACT_LEAK: 'GUARD_ARTIFACT_LEAK',
  GUARD_LIMIT_EXCEEDED: 'GUARD_LIMIT_EXCEEDED',
  ARTIFACT_PROVENANCE_MISMATCH: 'ARTIFACT_PROVENANCE_MISMATCH',
  GATE_REQUIRED_FAILED: 'GATE_REQUIRED_FAILED',
  EVIDENCE_MISSING: 'EVIDENCE_MISSING',
  EVIDENCE_INCONCLUSIVE: 'EVIDENCE_INCONCLUSIVE',
  RISK_HUMAN_APPROVAL: 'RISK_HUMAN_APPROVAL',
  VERIFIER_MISMATCH: 'VERIFIER_MISMATCH',
  ALL_PASS: 'ALL_PASS'
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

export interface DecisionRuleDefinition {
  rank: number;
  code: ReasonCode;
  decision: Decision;
  description: string;
}

export const DECISION_RULES: readonly DecisionRuleDefinition[] = [
  {
    rank: 1,
    code: REASON_CODES.NO_CHANGED_FILES,
    decision: 'reject',
    description: 'changed files 없음'
  },
  {
    rank: 2,
    code: REASON_CODES.GUARD_GIT_META_TAMPER,
    decision: 'reject',
    description: 'git metadata 변조 감지'
  },
  {
    rank: 3,
    code: REASON_CODES.ARTIFACT_PROVENANCE_MISMATCH,
    decision: 'reject',
    description: 'artifact provenance hash mismatch'
  },
  {
    rank: 4,
    code: REASON_CODES.GUARD_PROTECTED_PATH,
    decision: 'reject',
    description:
      'protected path 변경, meta-eval 비활성 또는 task.risk_area != eval_system'
  },
  {
    rank: 5,
    code: REASON_CODES.META_EVAL_REQUIRED,
    decision: 'needs_human_review',
    description:
      'protected path 변경, meta-eval 활성 및 task.risk_area == eval_system'
  },
  {
    rank: 6,
    code: REASON_CODES.GUARD_SCOPE_VIOLATION,
    decision: 'reject',
    description: 'scope escape, forbidden, untracked/symlink 우회'
  },
  {
    rank: 7,
    code: REASON_CODES.GUARD_TEST_INTEGRITY,
    decision: 'reject',
    description: 'test integrity 실패'
  },
  {
    rank: 8,
    code: REASON_CODES.GUARD_ARTIFACT_LEAK,
    decision: 'reject',
    description:
      'agent stdout/stderr context·secret 누설 (forbidden literal 또는 opt-in token)'
  },
  {
    rank: 9,
    code: REASON_CODES.GUARD_LIMIT_EXCEEDED,
    decision: 'reject',
    description: 'limits 초과'
  },
  {
    rank: 10,
    code: REASON_CODES.GATE_REQUIRED_FAILED,
    decision: 'reject',
    description: 'required gate fail/error'
  },
  {
    rank: 11,
    code: REASON_CODES.EVIDENCE_MISSING,
    decision: 'reject',
    description: 'required evidence 전부 missing'
  },
  {
    rank: 12,
    code: REASON_CODES.EVIDENCE_INCONCLUSIVE,
    decision: 'needs_more_tests',
    description: 'evidence 일부 inconclusive/부족'
  },
  {
    rank: 13,
    code: REASON_CODES.RISK_HUMAN_APPROVAL,
    decision: 'needs_human_review',
    description: 'risk area human approval 대상 또는 unknown'
  },
  {
    rank: 14,
    code: REASON_CODES.VERIFIER_MISMATCH,
    decision: 'needs_human_review',
    description: 'environment-independent verifier mismatch'
  },
  {
    rank: 15,
    code: REASON_CODES.ALL_PASS,
    decision: 'accept',
    description: '위 규칙에 해당 없음'
  }
] as const;

import type { GuardChangedFile } from '@vibeloop/guards';
import type { GateReportEntry } from './types.js';
import type { BaselineReport } from './baseline.js';
import type { BaselineMetrics } from './metrics.js';
import type { TestOnBaseReport } from './test-on-base.js';
import { detectAddsRegressionTest } from './detectors/adds-regression-test.js';
import { detectFixesReproducedFailure } from './detectors/fixes-reproduced-failure.js';
import { detectImprovesLatency } from './detectors/improves-latency.js';
import { detectIncreasesCoverage } from './detectors/increases-coverage.js';
import { detectReducesSecurityRisk } from './detectors/reduces-security-risk.js';
import { detectRemovesDuplicateCode } from './detectors/removes-duplicate-code.js';

export type EvidenceStatus = 'present' | 'missing' | 'inconclusive';
export type EvidenceType =
  | 'fixes_reproduced_failure'
  | 'adds_regression_test'
  | 'increases_coverage'
  | 'improves_latency'
  | 'reduces_security_risk'
  | 'removes_duplicate_code';

export interface EvidenceResult {
  type: string;
  status: EvidenceStatus;
  artifact_ref: string | null;
  supporting_gate: string | null;
}

export interface EvidenceContext {
  changedFiles: GuardChangedFile[];
  baseline?: BaselineReport | undefined;
  candidateMetrics?: BaselineMetrics | undefined;
  testOnBase?: TestOnBaseReport | undefined;
  gateRuns?: GateReportEntry[] | undefined;
}

export interface EvidenceSummary {
  evidence: EvidenceResult[];
  allMissing: boolean;
  hasInconclusive: boolean;
  reasonCode: 'EVIDENCE_PRESENT' | 'EVIDENCE_MISSING' | 'EVIDENCE_INCONCLUSIVE';
}

export function detectEvidence(
  type: string,
  context: EvidenceContext
): EvidenceResult {
  switch (type) {
    case 'fixes_reproduced_failure':
      return detectFixesReproducedFailure(context);
    case 'adds_regression_test':
      return detectAddsRegressionTest(context);
    case 'increases_coverage':
      return detectIncreasesCoverage(context);
    case 'improves_latency':
      return detectImprovesLatency(context);
    case 'reduces_security_risk':
      return detectReducesSecurityRisk(context);
    case 'removes_duplicate_code':
      return detectRemovesDuplicateCode(context);
    default:
      return {
        type,
        status: 'missing',
        artifact_ref: null,
        supporting_gate: null
      };
  }
}

export function evaluateRequiredEvidence(
  requiredEvidence: readonly string[],
  context: EvidenceContext
): EvidenceSummary {
  const evidence = requiredEvidence.map((type) =>
    detectEvidence(type, context)
  );
  const allMissing =
    evidence.length > 0 && evidence.every((item) => item.status === 'missing');
  const hasInconclusive = evidence.some(
    (item) => item.status === 'inconclusive'
  );
  return {
    evidence,
    allMissing,
    hasInconclusive,
    reasonCode: allMissing
      ? 'EVIDENCE_MISSING'
      : hasInconclusive
        ? 'EVIDENCE_INCONCLUSIVE'
        : 'EVIDENCE_PRESENT'
  };
}

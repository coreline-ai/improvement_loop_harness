import type { EvidenceContext, EvidenceResult } from '../evidence.js';

function regressionPassed(context: EvidenceContext): boolean {
  return (context.gateRuns ?? []).some(
    (gate) => gate.type === 'regression' && gate.status === 'pass'
  );
}

export function detectRemovesDuplicateCode(
  context: EvidenceContext
): EvidenceResult {
  const baseline = context.baseline?.metrics.duplicate_score;
  const candidate = context.candidateMetrics?.duplicate_score;
  if (baseline === undefined || candidate === undefined) {
    return {
      type: 'removes_duplicate_code',
      status: 'inconclusive',
      artifact_ref: 'metrics/baseline.json',
      supporting_gate: null
    };
  }
  return {
    type: 'removes_duplicate_code',
    status:
      candidate < baseline && regressionPassed(context) ? 'present' : 'missing',
    artifact_ref: 'metrics/baseline.json',
    supporting_gate: 'regression'
  };
}

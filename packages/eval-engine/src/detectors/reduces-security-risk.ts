import type { EvidenceContext, EvidenceResult } from '../evidence.js';

export function detectReducesSecurityRisk(
  context: EvidenceContext
): EvidenceResult {
  const baselineFindings = context.baseline?.metrics.security_findings;
  const candidateFindings = context.candidateMetrics?.security_findings;
  const baselineCritical =
    context.baseline?.metrics.critical_security_findings ?? 0;
  const candidateCritical =
    context.candidateMetrics?.critical_security_findings ?? 0;
  if (baselineFindings === undefined || candidateFindings === undefined) {
    return {
      type: 'reduces_security_risk',
      status: 'inconclusive',
      artifact_ref: 'metrics/baseline.json',
      supporting_gate: null
    };
  }
  return {
    type: 'reduces_security_risk',
    status:
      candidateFindings < baselineFindings &&
      candidateCritical <= baselineCritical
        ? 'present'
        : 'missing',
    artifact_ref: 'metrics/baseline.json',
    supporting_gate: 'security'
  };
}

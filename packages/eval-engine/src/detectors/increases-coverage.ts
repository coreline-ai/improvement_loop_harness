import type { EvidenceContext, EvidenceResult } from '../evidence.js';

function testIntegrityPassed(context: EvidenceContext): boolean {
  return (
    (context.gateRuns ?? []).find(
      (gate) => gate.name === 'test_integrity' || gate.name === 'test-integrity'
    )?.status !== 'fail'
  );
}

export function detectIncreasesCoverage(
  context: EvidenceContext
): EvidenceResult {
  const baseline = context.baseline?.metrics.coverage_percent;
  const candidate = context.candidateMetrics?.coverage_percent;
  if (baseline === undefined || candidate === undefined) {
    return {
      type: 'increases_coverage',
      status: 'inconclusive',
      artifact_ref: 'metrics/baseline.json',
      supporting_gate: null
    };
  }
  return {
    type: 'increases_coverage',
    status:
      candidate > baseline && testIntegrityPassed(context)
        ? 'present'
        : 'missing',
    artifact_ref: 'metrics/baseline.json',
    supporting_gate: 'coverage'
  };
}

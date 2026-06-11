import type { EvidenceContext, EvidenceResult } from '../evidence.js';

export function detectImprovesLatency(
  context: EvidenceContext
): EvidenceResult {
  const baseline = context.baseline?.metrics.latency_ms;
  const candidate = context.candidateMetrics?.latency_ms;
  if (baseline === undefined || candidate === undefined) {
    return {
      type: 'improves_latency',
      status: 'inconclusive',
      artifact_ref: 'metrics/baseline.json',
      supporting_gate: null
    };
  }
  return {
    type: 'improves_latency',
    status: candidate < baseline ? 'present' : 'missing',
    artifact_ref: 'metrics/baseline.json',
    supporting_gate: 'benchmark'
  };
}

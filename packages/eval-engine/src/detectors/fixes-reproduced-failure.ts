import type { EvidenceContext, EvidenceResult } from '../evidence.js';

export function detectFixesReproducedFailure(
  context: EvidenceContext
): EvidenceResult {
  if (context.testOnBase?.base_failed_candidate_passed) {
    return {
      type: 'fixes_reproduced_failure',
      status: 'present',
      artifact_ref: context.testOnBase.artifact_ref,
      supporting_gate: 'test-on-base'
    };
  }
  if (!context.baseline) {
    return {
      type: 'fixes_reproduced_failure',
      status: 'inconclusive',
      artifact_ref: null,
      supporting_gate: null
    };
  }
  if (context.baseline.base_red_tests.length === 0) {
    return {
      type: 'fixes_reproduced_failure',
      status: 'missing',
      artifact_ref: 'metrics/baseline.json',
      supporting_gate: null
    };
  }

  const passingGateNames = new Set(
    (context.gateRuns ?? [])
      .filter((gate) => gate.status === 'pass')
      .map((gate) => gate.name)
  );
  const fixed = context.baseline.base_red_tests.some((name) =>
    passingGateNames.has(name)
  );
  return {
    type: 'fixes_reproduced_failure',
    status: fixed ? 'present' : 'missing',
    artifact_ref: 'metrics/baseline.json',
    supporting_gate: fixed
      ? (context.baseline.base_red_tests.find((name) =>
          passingGateNames.has(name)
        ) ?? null)
      : null
  };
}

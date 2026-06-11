import { isTestFile } from '@vibeloop/guards';
import type { EvidenceContext, EvidenceResult } from '../evidence.js';

export function detectAddsRegressionTest(
  context: EvidenceContext
): EvidenceResult {
  const hasNewTest = context.changedFiles.some(
    (file) =>
      (file.status === 'added' || file.status === 'untracked') &&
      isTestFile(file.path)
  );
  if (!hasNewTest) {
    return {
      type: 'adds_regression_test',
      status: 'missing',
      artifact_ref: null,
      supporting_gate: null
    };
  }
  if (!context.testOnBase) {
    return {
      type: 'adds_regression_test',
      status: 'inconclusive',
      artifact_ref: null,
      supporting_gate: null
    };
  }
  return {
    type: 'adds_regression_test',
    status: context.testOnBase.base_failed_candidate_passed
      ? 'present'
      : 'missing',
    artifact_ref: context.testOnBase.artifact_ref,
    supporting_gate: 'test-on-base'
  };
}

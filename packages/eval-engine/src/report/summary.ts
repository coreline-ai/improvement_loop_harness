import type { Decision } from '@vibeloop/shared';
import type { DecisionReason } from '../decision/engine.js';
import type { EvidenceResult } from '../evidence.js';
import type { GateReportEntry } from '../types.js';

export function summarizeEvalReport(options: {
  decision: Decision;
  reasons: readonly DecisionReason[];
  gateRuns: readonly GateReportEntry[];
  improvementEvidence: readonly EvidenceResult[];
  changedFileCount: number;
}): string {
  const passed = options.gateRuns.filter(
    (gate) => gate.status === 'pass'
  ).length;
  const failed = options.gateRuns.filter(
    (gate) => gate.status === 'fail' || gate.status === 'error'
  ).length;
  const skipped = options.gateRuns.filter(
    (gate) => gate.status === 'skipped'
  ).length;
  const evidencePresent = options.improvementEvidence.filter(
    (item) => item.status === 'present'
  ).length;
  const primaryReason = options.reasons[0]?.code ?? 'UNKNOWN';

  return `Decision ${options.decision} (${primaryReason}) for ${options.changedFileCount} changed file(s): gates pass=${passed}, fail/error=${failed}, skipped=${skipped}; evidence present=${evidencePresent}/${options.improvementEvidence.length}.`;
}

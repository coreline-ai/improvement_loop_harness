import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Decision } from '@vibeloop/shared';
import type { GuardChangedFile } from '@vibeloop/guards';
import {
  EVAL_REPORT_SCHEMA_ID,
  validateOrThrow
} from '@vibeloop/task-protocol';
import type { DecisionReason } from '../decision/engine.js';
import type { EvidenceResult } from '../evidence.js';
import type { GateReportEntry } from '../types.js';
import { summarizeEvalReport } from './summary.js';

export interface EvalReportChangedFile {
  path: string;
  status: GuardChangedFile['status'];
  old_path?: string | null | undefined;
  allowed_by_write_scope: boolean;
  protected: boolean;
}

export interface EvalReportGateRun {
  name: string;
  type: string;
  required: boolean;
  command?: string | undefined;
  status: GateReportEntry['status'];
  exit_code: number | null;
  duration_ms?: number | null | undefined;
  stdout_ref?: string | null | undefined;
  stderr_ref?: string | null | undefined;
  summary?: string | null | undefined;
}

export interface EvalReportRisk {
  areas?: string[] | undefined;
  human_approval_required?: boolean | undefined;
  reason?: string | undefined;
}

export interface EvalReport {
  schema_version: '1.0';
  loop_id: string;
  task_id: string;
  project_id?: string | undefined;
  base_commit: string;
  candidate_commit?: string | null | undefined;
  decision: Decision;
  decision_reasons: DecisionReason[];
  changed_files: EvalReportChangedFile[];
  gate_runs: EvalReportGateRun[];
  improvement_evidence: EvidenceResult[];
  risk?: EvalReportRisk | undefined;
  advisory_findings?: Array<Record<string, unknown>> | undefined;
  artifact_refs: string[];
  summary?: string | undefined;
}

export interface BuildEvalReportOptions {
  loopId: string;
  taskId: string;
  projectId?: string | undefined;
  baseCommit: string;
  candidateCommit?: string | null | undefined;
  decision: Decision;
  decisionReasons: DecisionReason[];
  changedFiles: GuardChangedFile[];
  gateRuns: GateReportEntry[];
  improvementEvidence: EvidenceResult[];
  risk?: EvalReportRisk | undefined;
  advisoryFindings?: Array<Record<string, unknown>> | undefined;
  artifactRefs?: string[] | undefined;
}

function mapChangedFile(file: GuardChangedFile): EvalReportChangedFile {
  return {
    path: file.path,
    status: file.status,
    ...(file.oldPath ? { old_path: file.oldPath } : {}),
    allowed_by_write_scope: file.allowedByWriteScope === true,
    protected: file.protected === true
  };
}

function mapGateRun(gate: GateReportEntry): EvalReportGateRun {
  return {
    name: gate.name,
    type: gate.type,
    required: gate.required,
    command: gate.command,
    status: gate.status,
    exit_code: gate.exit_code,
    duration_ms: gate.duration_ms,
    stdout_ref: gate.stdout_ref,
    stderr_ref: gate.stderr_ref,
    summary: gate.summary
  };
}

function collectArtifactRefs(options: BuildEvalReportOptions): string[] {
  const refs = new Set<string>(options.artifactRefs ?? []);
  refs.add('reports/eval-report.json');
  for (const gate of options.gateRuns) {
    if (gate.stdout_ref) refs.add(gate.stdout_ref);
    if (gate.stderr_ref) refs.add(gate.stderr_ref);
  }
  for (const evidence of options.improvementEvidence) {
    if (evidence.artifact_ref) refs.add(evidence.artifact_ref);
  }
  for (const reason of options.decisionReasons) {
    if (reason.ref && !reason.ref.includes('/') && !reason.ref.includes('.')) {
      continue;
    }
    if (reason.ref) refs.add(reason.ref);
  }
  return [...refs].sort();
}

export function buildEvalReport(options: BuildEvalReportOptions): EvalReport {
  const report: EvalReport = {
    schema_version: '1.0',
    loop_id: options.loopId,
    task_id: options.taskId,
    ...(options.projectId ? { project_id: options.projectId } : {}),
    base_commit: options.baseCommit,
    ...(options.candidateCommit !== undefined
      ? { candidate_commit: options.candidateCommit }
      : {}),
    decision: options.decision,
    decision_reasons: options.decisionReasons,
    changed_files: options.changedFiles.map(mapChangedFile),
    gate_runs: options.gateRuns.map(mapGateRun),
    improvement_evidence: options.improvementEvidence,
    ...(options.risk ? { risk: options.risk } : {}),
    ...(options.advisoryFindings
      ? { advisory_findings: options.advisoryFindings }
      : {}),
    artifact_refs: collectArtifactRefs(options)
  };

  report.summary = summarizeEvalReport({
    decision: report.decision,
    reasons: report.decision_reasons,
    gateRuns: options.gateRuns,
    improvementEvidence: report.improvement_evidence,
    changedFileCount: report.changed_files.length
  });

  return validateOrThrow<EvalReport>(
    EVAL_REPORT_SCHEMA_ID,
    report,
    'eval-report.json'
  );
}

export async function writeEvalReport(
  artifactRoot: string,
  report: EvalReport
): Promise<string> {
  const reportPath = path.join(artifactRoot, 'reports', 'eval-report.json');
  await mkdir(path.dirname(reportPath), { recursive: true });
  const validReport = validateOrThrow<EvalReport>(
    EVAL_REPORT_SCHEMA_ID,
    report,
    'eval-report.json'
  );
  await writeFile(reportPath, `${JSON.stringify(validReport, null, 2)}\n`);
  return reportPath;
}

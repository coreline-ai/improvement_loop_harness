import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export const CURRENT_EVAL_REPORT_SCHEMA_VERSION = '1.1' as const;
export const DECISION_ENGINE_VERSION = 'decision-rules-1.1' as const;
export const HARNESS_VERSION = '0.1.0' as const;

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
  group?: GateReportEntry['group'] | undefined;
}

export interface EvalReportRisk {
  areas?: string[] | undefined;
  human_approval_required?: boolean | undefined;
  reason?: string | undefined;
}

export interface EvalReportProvenance {
  harness_version: string;
  decision_engine_version: string;
  task_hash: string;
  eval_config_hash: string;
  candidate_patch_hash: string;
  gate_artifact_hashes: Record<string, string>;
  generated_by: 'harness';
}

export interface EvalReportVerifierLane {
  lane: 'local' | 'ci' | 'external';
  status: 'pass' | 'fail' | 'missing' | 'mismatch';
  decision: string | null;
  required_gates: Array<{ name: string; status: string }>;
  artifact_ref?: string | null | undefined;
  summary?: string | null | undefined;
}

export interface EvalReportVerifier {
  policy: 'local' | 'strict';
  lanes: EvalReportVerifierLane[];
  mismatch: boolean;
}

export interface EvalReportTrustSummary {
  deterministic_authority?: string | undefined;
  advisory_findings_count?: number | undefined;
  provenance_verified?: boolean | undefined;
  hidden_acceptance_status?: string | undefined;
  verifier_status?: string | undefined;
  human_review_reason_code?: string | null | undefined;
}

export interface EvalReport {
  schema_version: '1.0' | '1.1';
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
  provenance?: EvalReportProvenance | undefined;
  verifier?: EvalReportVerifier | undefined;
  trust_summary?: EvalReportTrustSummary | undefined;
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
  provenance: EvalReportProvenance;
  provenanceVerified?: boolean | undefined;
  verifier?: EvalReportVerifier | undefined;
  artifactRefs?: string[] | undefined;
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export function emptySha256(): string {
  return sha256Text('');
}

export function fallbackProvenance(): EvalReportProvenance {
  return {
    harness_version: HARNESS_VERSION,
    decision_engine_version: DECISION_ENGINE_VERSION,
    task_hash: emptySha256(),
    eval_config_hash: emptySha256(),
    candidate_patch_hash: emptySha256(),
    gate_artifact_hashes: {},
    generated_by: 'harness'
  };
}

export async function hashArtifactRefs(
  artifactRoot: string,
  refs: readonly (string | null | undefined)[]
): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const ref of [...new Set(refs.filter((entry): entry is string => Boolean(entry)))].sort()) {
    const absolutePath = path.join(artifactRoot, ref);
    const hash = await sha256File(absolutePath).catch(() => 'missing');
    entries.push([ref, hash]);
  }
  return Object.fromEntries(entries);
}

export async function verifyEvalReportProvenance(
  artifactRoot: string,
  report: Pick<EvalReport, 'schema_version' | 'provenance'>
): Promise<boolean> {
  if (report.schema_version === '1.0' && !report.provenance) {
    return true;
  }
  if (!report.provenance) {
    return false;
  }
  for (const [ref, expectedHash] of Object.entries(report.provenance.gate_artifact_hashes)) {
    const actualHash = await sha256File(path.join(artifactRoot, ref)).catch(() => 'missing');
    if (actualHash !== expectedHash) {
      return false;
    }
  }
  return true;
}

/**
 * Verify the on-disk candidate patch still matches the `candidate_patch_hash`
 * recorded in the report's provenance. This binds "what the gates verified" to
 * "what gets turned into a PR": if the patch file is altered or swapped between
 * the verifying run and PR promotion, the hashes diverge and this returns false.
 *
 * Separate from {@link verifyEvalReportProvenance} (which only re-hashes gate
 * artifacts) so each binding is checked independently and a caller can require
 * one without the other. A report without provenance can only be trusted on the
 * legacy 1.0 schema (no hash to bind); 1.1 without provenance fails closed.
 */
export async function verifyCandidatePatchHash(
  artifactRoot: string,
  report: Pick<EvalReport, 'schema_version' | 'provenance'>,
  patchRef = 'patches/candidate.patch'
): Promise<boolean> {
  if (!report.provenance) {
    return report.schema_version === '1.0';
  }
  const actual = await sha256File(path.join(artifactRoot, patchRef)).catch(
    () => 'missing'
  );
  return actual === report.provenance.candidate_patch_hash;
}

export function localVerifierFromDecision(options: {
  policy?: 'local' | 'strict' | undefined;
  decision: Decision;
  gateRuns: readonly GateReportEntry[];
}): EvalReportVerifier {
  const requiredGates = options.gateRuns
    .filter((gate) => gate.required)
    .map((gate) => ({ name: gate.name, status: gate.status }));
  const policy = options.policy ?? 'local';
  const lanes: EvalReportVerifierLane[] = [
    {
      lane: 'local',
      status: 'pass',
      decision: options.decision,
      required_gates: requiredGates,
      artifact_ref: 'reports/eval-report.json',
      summary: 'local deterministic harness result'
    }
  ];

  if (policy === 'strict') {
    lanes.push({
      lane: 'ci',
      status: 'missing',
      decision: null,
      required_gates: [],
      artifact_ref: null,
      summary: 'strict verifier policy requires a CI eval-report artifact before accept'
    });
  }

  const verifier: EvalReportVerifier = {
    policy,
    mismatch: false,
    lanes
  };
  return { ...verifier, mismatch: verifierHasMismatch(verifier) };
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
    summary: gate.summary,
    ...(gate.group ? { group: gate.group } : {})
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

function hiddenAcceptanceStatus(gates: readonly GateReportEntry[]): string {
  const hidden = gates.filter((gate) => gate.group === 'hidden_acceptance' || gate.type === 'hidden_acceptance');
  if (hidden.length === 0) return 'not_configured';
  if (hidden.some((gate) => gate.status === 'fail' || gate.status === 'error')) return 'failed';
  if (hidden.some((gate) => gate.status === 'skipped')) return 'skipped';
  return 'passed';
}

function verifierStatus(verifier: EvalReportVerifier | undefined): string {
  if (!verifier) return 'not_configured';
  if (verifier.mismatch) return 'mismatch';
  if (verifier.lanes.some((lane) => lane.status !== 'pass')) return 'incomplete';
  return 'passed';
}

function requiredGateSignature(lane: EvalReportVerifierLane): string {
  return lane.required_gates
    .map((gate) => `${gate.name}:${gate.status}`)
    .sort()
    .join('\n');
}

export function verifierLaneMatchesLocal(
  localLane: EvalReportVerifierLane,
  verifierLane: EvalReportVerifierLane
): boolean {
  if (verifierLane.status === 'missing') {
    return false;
  }
  return (
    localLane.decision === verifierLane.decision &&
    requiredGateSignature(localLane) === requiredGateSignature(verifierLane)
  );
}

export function verifierHasMismatch(verifier: EvalReportVerifier): boolean {
  const localLane = verifier.lanes.find((lane) => lane.lane === 'local');
  if (!localLane) {
    return true;
  }
  return verifier.lanes
    .filter((lane) => lane.lane !== 'local')
    .some((lane) => !verifierLaneMatchesLocal(localLane, lane));
}

function trustSummary(options: BuildEvalReportOptions): EvalReportTrustSummary {
  return {
    deterministic_authority: 'decision_engine',
    advisory_findings_count: options.advisoryFindings?.length ?? 0,
    provenance_verified: options.provenanceVerified ?? true,
    hidden_acceptance_status: hiddenAcceptanceStatus(options.gateRuns),
    verifier_status: verifierStatus(options.verifier),
    human_review_reason_code:
      options.decision === 'needs_human_review'
        ? options.decisionReasons[0]?.code ?? null
        : null
  };
}

export function buildEvalReport(options: BuildEvalReportOptions): EvalReport {
  const report: EvalReport = {
    schema_version: CURRENT_EVAL_REPORT_SCHEMA_VERSION,
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
    provenance: options.provenance,
    ...(options.verifier ? { verifier: options.verifier } : {}),
    trust_summary: trustSummary(options),
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

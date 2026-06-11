import { TASK_SCHEMA_ID, validateOrThrow, type EvalConfig, type TaskDefinition } from '@vibeloop/task-protocol';
import type { DiscoveryCandidate, GenerateTaskOptions, GeneratedTask } from './types.js';

const HUMAN_APPROVAL_DEFAULTS = new Set(['auth', 'permission', 'billing', 'database_schema', 'deployment', 'ci_cd', 'eval_system', 'secrets', 'admin', 'unknown']);

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'candidate';
}

function riskFromConfig(candidate: DiscoveryCandidate, evalConfig: EvalConfig | undefined): string {
  if (candidate.riskAreaHint) return candidate.riskAreaHint;
  const filePath = candidate.location.filePath.replace(/\\/g, '/');
  for (const [riskArea, prefixes] of Object.entries(evalConfig?.risk_classification ?? {})) {
    if (prefixes.some((prefix) => filePath.startsWith(prefix))) return riskArea;
  }
  return 'unknown';
}

function requiredEvidence(source: DiscoveryCandidate['source']): string[] {
  switch (source) {
    case 'test_failure':
      return ['fixes_reproduced_failure'];
    case 'typecheck':
    case 'lint':
      return ['gate_green'];
    case 'security_scan':
      return ['reduces_security_risk'];
    case 'manual':
      return ['user_reported_issue_resolved'];
  }
}

function writeScope(candidate: DiscoveryCandidate): TaskDefinition['write_scope'] {
  const filePath = candidate.location.filePath === 'project' ? '.' : candidate.location.filePath;
  return { allowed: [filePath] };
}

function humanApprovalRequired(riskArea: string, evalConfig: EvalConfig | undefined): boolean {
  const configured = new Set(evalConfig?.human_approval_risk_areas ?? []);
  return configured.has(riskArea) || HUMAN_APPROVAL_DEFAULTS.has(riskArea);
}

export function generateTaskFromCandidate(candidate: DiscoveryCandidate, options: GenerateTaskOptions = {}): GeneratedTask {
  const riskArea = riskFromConfig(candidate, options.evalConfig);
  const scope = writeScope(candidate);
  const evidence = requiredEvidence(candidate.source);
  const task = validateOrThrow<TaskDefinition>(
    TASK_SCHEMA_ID,
    {
      schema_version: '1.0',
      id: `task-${slug(candidate.fingerprint.slice(0, 12))}`,
      title: candidate.title,
      objective: `Resolve structured ${candidate.source} candidate at ${candidate.location.filePath} with evidence ${candidate.location.errorCode}.`,
      base_branch: options.baseBranch ?? 'main',
      risk_area: riskArea,
      human_approval_required: humanApprovalRequired(riskArea, options.evalConfig),
      write_scope: scope,
      required_evidence: evidence,
      ...(options.evalConfig?.limits ? { limits: options.evalConfig.limits } : {}),
      metadata: {
        candidate_fingerprint: candidate.fingerprint,
        candidate_source: candidate.source,
        evidence_refs: candidate.evidenceRefs,
        error_code: candidate.location.errorCode,
        test_name: candidate.location.testName ?? null
      }
    },
    `candidate ${candidate.fingerprint} generated task`
  );
  return { task, riskArea, writeScope: scope, requiredEvidence: evidence, limits: options.evalConfig?.limits };
}

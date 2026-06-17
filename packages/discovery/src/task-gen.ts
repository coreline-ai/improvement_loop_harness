import {
  TASK_SCHEMA_ID,
  validateOrThrow,
  type EvalConfig,
  type EvalGate,
  type TaskDefinition
} from '@vibeloop/task-protocol';
import type {
  DiscoveryCandidate,
  GenerateTaskOptions,
  GeneratedTask
} from './types.js';

const HUMAN_APPROVAL_DEFAULTS = new Set([
  'auth',
  'permission',
  'billing',
  'database_schema',
  'deployment',
  'ci_cd',
  'eval_system',
  'secrets',
  'admin',
  'prompt_injection',
  'unknown'
]);
const PROJECT_GATE_TYPES = new Set<EvalGate['type']>([
  'hard',
  'task_acceptance',
  'regression',
  'security',
  'performance'
]);

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'candidate'
  );
}

function riskFromConfig(
  candidate: DiscoveryCandidate,
  evalConfig: EvalConfig | undefined
): string {
  if (candidate.riskAreaHint) return candidate.riskAreaHint;
  const filePath = candidate.location.filePath.replace(/\\/g, '/');
  if (
    filePath === 'project' &&
    (evalConfig?.risk_classification?.none?.length ?? 0) > 0
  ) {
    return 'none';
  }
  for (const [riskArea, prefixes] of Object.entries(
    evalConfig?.risk_classification ?? {}
  )) {
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

function fallbackWriteScope(evalConfig: EvalConfig | undefined): string[] {
  const normalizeScopeEntry = (entry: string): string =>
    entry.replace(/\\/g, '/').trim().replace(/\/+$/, '');
  const protectedPaths = new Set(
    (evalConfig?.protected_paths ?? [])
      .map(normalizeScopeEntry)
      .filter(Boolean)
  );
  const configured = [
    ...new Set(Object.values(evalConfig?.risk_classification ?? {}).flat())
  ]
    .map((entry) => {
      const raw = entry.replace(/\\/g, '/').trim();
      return { raw, normalized: normalizeScopeEntry(raw) };
    })
    .filter(({ raw, normalized }) => {
      if (raw.length === 0 || normalized.startsWith('.env')) return false;
      if (protectedPaths.has(normalized)) return false;
      return ![...protectedPaths].some((protectedPath) =>
        normalized.startsWith(`${protectedPath}/`)
      );
    })
    .map(({ raw }) => raw);
  return configured.length > 0
    ? configured
    : ['src/', 'lib/', 'app/', 'packages/'];
}

function writeScope(
  candidate: DiscoveryCandidate,
  evalConfig: EvalConfig | undefined
): TaskDefinition['write_scope'] {
  const allowed =
    candidate.location.filePath === 'project'
      ? fallbackWriteScope(evalConfig)
      : [candidate.location.filePath];
  return { allowed };
}

function objectiveFor(candidate: DiscoveryCandidate): string {
  const parts = [
    `Resolve structured ${candidate.source} candidate at ${candidate.location.filePath}.`,
    `Evidence code: ${candidate.location.errorCode}.`
  ];
  if (candidate.reproCommand) {
    parts.push(`Reproduce with: ${candidate.reproCommand}.`);
  }
  if (candidate.evidenceSummary) {
    parts.push(`Observed failure excerpt:\n${candidate.evidenceSummary}`);
  }
  parts.push(
    'Make the smallest scoped fix and keep the required acceptance command green.'
  );
  return parts.join('\n\n');
}

function humanApprovalRequired(
  riskArea: string,
  evalConfig: EvalConfig | undefined
): boolean {
  const configured = new Set(evalConfig?.human_approval_risk_areas ?? []);
  return configured.has(riskArea) || HUMAN_APPROVAL_DEFAULTS.has(riskArea);
}

function isProjectGate(gate: EvalGate): boolean {
  return !gate.command.startsWith('builtin:') && PROJECT_GATE_TYPES.has(gate.type);
}

function gateMatchesSource(
  source: DiscoveryCandidate['source'],
  gate: EvalGate
): boolean {
  const text = `${gate.name} ${gate.command}`.toLowerCase();
  switch (source) {
    case 'test_failure':
      return gate.type === 'task_acceptance' || /test|spec/.test(text);
    case 'typecheck':
      return /typecheck|tsc/.test(text);
    case 'lint':
      return /lint|eslint/.test(text);
    case 'security_scan':
      return gate.type === 'security' || /security|audit|semgrep|gitleaks/.test(text);
    case 'manual':
      return true;
  }
}

function fallbackAcceptanceCommands(
  candidate: DiscoveryCandidate,
  evalConfig: EvalConfig | undefined
): string[] {
  if (candidate.reproCommand) return [candidate.reproCommand];
  const projectGates = (evalConfig?.gates ?? []).filter(
    (gate) => gate.required && isProjectGate(gate)
  );
  const matching = projectGates.filter((gate) =>
    gateMatchesSource(candidate.source, gate)
  );
  return [...new Set((matching.length > 0 ? matching : projectGates).map((gate) => gate.command))];
}

export function generateTaskFromCandidate(
  candidate: DiscoveryCandidate,
  options: GenerateTaskOptions = {}
): GeneratedTask {
  const riskArea = riskFromConfig(candidate, options.evalConfig);
  const scope = writeScope(candidate, options.evalConfig);
  const evidence = requiredEvidence(candidate.source);
  const acceptanceCommands = fallbackAcceptanceCommands(
    candidate,
    options.evalConfig
  );
  const task = validateOrThrow<TaskDefinition>(
    TASK_SCHEMA_ID,
    {
      schema_version: '1.0',
      id: `task-${slug(candidate.fingerprint.slice(0, 12))}`,
      title: candidate.title,
      objective: objectiveFor(candidate),
      base_branch: options.baseBranch ?? 'main',
      risk_area: riskArea,
      human_approval_required:
        humanApprovalRequired(riskArea, options.evalConfig) ||
        acceptanceCommands.length === 0,
      write_scope: scope,
      required_evidence: evidence,
      // The failing command becomes the acceptance test so the harness can
      // verify the required evidence (e.g. fixes_reproduced_failure via
      // test-on-base: failed on base, passes on candidate).
      ...(acceptanceCommands.length > 0
        ? { acceptance: { required_tests: acceptanceCommands } }
        : {}),
      ...(options.evalConfig?.limits
        ? { limits: options.evalConfig.limits }
        : {}),
      metadata: {
        candidate_fingerprint: candidate.fingerprint,
        candidate_source: candidate.source,
        evidence_refs: candidate.evidenceRefs,
        ...(candidate.evidenceSummary
          ? { evidence_summary: candidate.evidenceSummary }
          : {}),
        error_code: candidate.location.errorCode,
        test_name: candidate.location.testName ?? null,
        gate_name: candidate.location.gateName ?? null,
        acceptance_source: candidate.reproCommand
          ? 'candidate_repro_command'
          : acceptanceCommands.length > 0
            ? 'eval_required_gate'
            : 'missing_requires_human_review'
      }
    },
    `candidate ${candidate.fingerprint} generated task`
  );
  return {
    task,
    riskArea,
    writeScope: scope,
    requiredEvidence: evidence,
    limits: options.evalConfig?.limits
  };
}

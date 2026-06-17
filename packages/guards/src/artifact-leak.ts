import type { GuardCheckResult } from './types.js';

// Structural config shape (kept local so `guards` stays free of a task-protocol
// dependency). Compatible with task-protocol's `ArtifactLeakConfig`.
export interface ArtifactLeakConfig {
  scan_agent_stdout?: boolean | undefined;
  scan_agent_stderr?: boolean | undefined;
  /**
   * v2: scan the candidate patch (the PR deliverable) for the same forbidden
   * literals / opted-in tokens. The patch is never redacted (that would corrupt
   * the diff) — a match REJECTS the candidate. Opt-in; default off.
   */
  scan_patch?: boolean | undefined;
  /** v2: redact-only the project gate stdout/stderr logs before persisting. */
  redact_gate_logs?: boolean | undefined;
  max_scan_bytes?: number | undefined;
  forbidden_literals?:
    | ReadonlyArray<{ label: string; value: string }>
    | undefined;
  builtins?: { token_like?: boolean | undefined } | undefined;
}

/**
 * Deterministic agent stdout/stderr context-leak guard.
 *
 * Scans the agent's (already-bounded) stdout/stderr and ALWAYS redacts matches
 * before the caller persists them. It REJECTS (gate fail → GUARD_ARTIFACT_LEAK)
 * on a forbidden literal (precise: prior issue ids, hidden sentinels) and — only
 * when `builtins.token_like` is opted in — on a token-like match. Raw matched
 * values are never placed in the result/violations (label + count only).
 *
 * No execution, no LLM. See docs/SELF_IMPROVEMENT_LOOP_DESIGN.md.
 */

const DEFAULT_MAX_SCAN_BYTES = 1_048_576;

const TOKEN_PATTERNS: ReadonlyArray<{
  label: string;
  source: string;
  replacement?: string;
}> = [
  { label: 'bearer', source: 'Bearer\\s+[A-Za-z0-9._~+/-]{8,}=*' },
  { label: 'openai_key', source: '\\bsk-[A-Za-z0-9_-]{8,}' },
  {
    label: 'token_assignment',
    source:
      '(["\']?(?:(?:access|refresh)[_-]?token|api[_-]?key|secret|password)["\']?)(\\s*[:=]\\s*)(["\'])([^\\r\\n]*?)(\\3)',
    replacement: '$1$2$3[REDACTED]$5'
  },
  {
    label: 'token_assignment',
    source:
      '(["\']?(?:(?:access|refresh)[_-]?token|api[_-]?key|secret|password)["\']?)(\\s*[:=]\\s*)([^\\s"\',}]+)',
    replacement: '$1$2[REDACTED]'
  }
];

export interface ArtifactLeakFinding {
  source: 'stdout' | 'stderr' | 'patch';
  kind: 'forbidden_literal' | 'token_like';
  label: string;
  count: number;
  rejecting: boolean;
}

export interface ArtifactLeakScanInput {
  stdout?: string | undefined;
  stderr?: string | undefined;
  config?: ArtifactLeakConfig | undefined;
}

export interface ArtifactLeakScanResult {
  result: GuardCheckResult;
  redactedStdout: string;
  redactedStderr: string;
  findings: ArtifactLeakFinding[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scanSource(
  text: string,
  source: 'stdout' | 'stderr' | 'patch',
  config: ArtifactLeakConfig
): { redacted: string; findings: ArtifactLeakFinding[] } {
  const maxScan = config.max_scan_bytes ?? DEFAULT_MAX_SCAN_BYTES;
  const truncated = text.length > maxScan;
  let redacted = truncated ? text.slice(0, maxScan) : text;
  const findings: ArtifactLeakFinding[] = [];

  for (const literal of config.forbidden_literals ?? []) {
    const re = new RegExp(escapeRegex(literal.value), 'g');
    const matches = redacted.match(re);
    if (matches && matches.length > 0) {
      findings.push({
        source,
        kind: 'forbidden_literal',
        label: literal.label,
        count: matches.length,
        rejecting: true
      });
      redacted = redacted.replace(re, `[REDACTED:${literal.label}]`);
    }
  }

  const tokenRejects = config.builtins?.token_like === true;
  for (const pattern of TOKEN_PATTERNS) {
    const matches = redacted.match(new RegExp(pattern.source, 'gi'));
    if (matches && matches.length > 0) {
      // Always redact token-like content; only reject when opted in.
      findings.push({
        source,
        kind: 'token_like',
        label: pattern.label,
        count: matches.length,
        rejecting: tokenRejects
      });
      redacted = redacted.replace(
        new RegExp(pattern.source, 'gi'),
        pattern.replacement ?? `[REDACTED:${pattern.label}]`
      );
    }
  }

  if (truncated) {
    redacted += '\n…[artifact-leak scan truncated]';
  }
  return { redacted, findings };
}

export function scanArtifactLeak(
  input: ArtifactLeakScanInput
): ArtifactLeakScanResult {
  const stdout = input.stdout ?? '';
  const stderr = input.stderr ?? '';

  if (!input.config) {
    return {
      result: {
        status: 'pass',
        summary: 'artifact-leak not configured',
        violations: []
      },
      redactedStdout: stdout,
      redactedStderr: stderr,
      findings: []
    };
  }

  const config = input.config;
  const findings: ArtifactLeakFinding[] = [];
  let redactedStdout = stdout;
  let redactedStderr = stderr;

  if (config.scan_agent_stdout ?? true) {
    const scanned = scanSource(stdout, 'stdout', config);
    redactedStdout = scanned.redacted;
    findings.push(...scanned.findings);
  }
  if (config.scan_agent_stderr ?? true) {
    const scanned = scanSource(stderr, 'stderr', config);
    redactedStderr = scanned.redacted;
    findings.push(...scanned.findings);
  }

  const rejecting = findings.filter((finding) => finding.rejecting);
  const status = rejecting.length > 0 ? 'fail' : 'pass';
  const violations = rejecting.map((finding) => ({
    code: 'GUARD_ARTIFACT_LEAK',
    message: `${finding.kind} '${finding.label}' x${finding.count} detected in agent ${finding.source}`
  }));

  return {
    result: {
      status,
      ...(status === 'fail' ? { code: 'GUARD_ARTIFACT_LEAK' } : {}),
      summary:
        status === 'fail'
          ? `${rejecting.length} artifact-leak violation(s)`
          : `artifact-leak clean (${findings.length} redacted, 0 rejecting)`,
      violations
    },
    redactedStdout,
    redactedStderr,
    findings
  };
}

export interface PatchLeakScanResult {
  result: GuardCheckResult;
  findings: ArtifactLeakFinding[];
}

/**
 * v2 artifact-leak: scan the candidate patch (the PR deliverable) for forbidden
 * literals and opted-in tokens. DETECT-ONLY — the patch is never redacted (that
 * would corrupt the diff), so a rejecting match fails the candidate. forbidden
 * literals always reject; token-like matches reject only when
 * `builtins.token_like` is opted in (same false-positive policy as v1). Raw
 * values never appear in the result (label + count only).
 */
export function scanPatchForLeak(
  patchText: string,
  config: ArtifactLeakConfig | undefined
): PatchLeakScanResult {
  if (!config || config.scan_patch !== true) {
    return {
      result: {
        status: 'pass',
        summary: 'artifact-leak patch scan not configured',
        violations: []
      },
      findings: []
    };
  }

  // Reuse the matcher; the redacted text is discarded (patch stays verbatim).
  const { findings } = scanSource(patchText ?? '', 'patch', config);
  const rejecting = findings.filter((finding) => finding.rejecting);
  const status = rejecting.length > 0 ? 'fail' : 'pass';
  const violations = rejecting.map((finding) => ({
    code: 'GUARD_ARTIFACT_LEAK',
    message: `${finding.kind} '${finding.label}' x${finding.count} detected in candidate patch`
  }));

  return {
    result: {
      status,
      ...(status === 'fail' ? { code: 'GUARD_ARTIFACT_LEAK' } : {}),
      summary:
        status === 'fail'
          ? `${rejecting.length} artifact-leak violation(s) in candidate patch`
          : `artifact-leak patch clean (${findings.length} detected, 0 rejecting)`,
      violations
    },
    findings
  };
}

/**
 * Merge two artifact-leak verdicts (e.g. agent stdout/stderr + candidate patch)
 * into one: fail if either fails; violations concatenated. Used so a single
 * `artifact-leak` gate surfaces both surfaces.
 */
export function mergeArtifactLeakResults(
  base: GuardCheckResult | undefined,
  extra: GuardCheckResult
): GuardCheckResult {
  if (!base) return extra;
  const failed = base.status === 'fail' || extra.status === 'fail';
  const violations = [...base.violations, ...extra.violations];
  return {
    status: failed ? 'fail' : base.status,
    ...(failed ? { code: 'GUARD_ARTIFACT_LEAK' } : {}),
    summary: failed
      ? `${violations.length} artifact-leak violation(s) across agent output and patch`
      : base.summary,
    violations
  };
}

/**
 * Redact-only helper for project gate stdout/stderr logs (no reject, no
 * truncation). Forbidden literals and token-like matches are replaced before the
 * log is persisted; the gate's pass/fail (from exit code) is unaffected. Used
 * for opt-in `artifact_leak.redact_gate_logs`. Raw values never reach disk.
 */
export function redactForLeak(
  text: string | undefined,
  config: ArtifactLeakConfig | undefined
): string {
  let redacted = text ?? '';
  if (!config) return redacted;
  for (const literal of config.forbidden_literals ?? []) {
    redacted = redacted.replace(
      new RegExp(escapeRegex(literal.value), 'g'),
      `[REDACTED:${literal.label}]`
    );
  }
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(
      new RegExp(pattern.source, 'gi'),
      pattern.replacement ?? `[REDACTED:${pattern.label}]`
    );
  }
  return redacted;
}

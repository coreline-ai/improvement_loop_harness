import type { GuardCheckResult } from './types.js';

// Structural config shape (kept local so `guards` stays free of a task-protocol
// dependency). Compatible with task-protocol's `ArtifactLeakConfig`.
export interface ArtifactLeakConfig {
  scan_agent_stdout?: boolean | undefined;
  scan_agent_stderr?: boolean | undefined;
  max_scan_bytes?: number | undefined;
  forbidden_literals?:
    | ReadonlyArray<{ label: string; value: string }>
    | undefined;
  builtins?: { token_like?: boolean | undefined } | undefined;
}

/**
 * Deterministic agent/artifact context-leak guard.
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

const TOKEN_PATTERNS: ReadonlyArray<{ label: string; source: string }> = [
  { label: 'bearer', source: 'Bearer\\s+[A-Za-z0-9._~+/-]{8,}=*' },
  { label: 'openai_key', source: '\\bsk-[A-Za-z0-9_-]{8,}' },
  {
    label: 'token_assignment',
    source:
      '((?:access|refresh)[_-]?token|api[_-]?key|secret|password)(["\']?\\s*[:=]\\s*["\']?)([^\\s"\']+)'
  }
];

export interface ArtifactLeakFinding {
  source: 'stdout' | 'stderr';
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
  source: 'stdout' | 'stderr',
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
        pattern.label === 'token_assignment'
          ? '$1$2[REDACTED]'
          : `[REDACTED:${pattern.label}]`
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

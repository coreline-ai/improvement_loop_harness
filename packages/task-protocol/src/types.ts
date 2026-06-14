export interface Limits {
  max_changed_files?: number;
  max_changed_lines?: number;
  agent_timeout_seconds?: number;
}

export interface TaskDefinition {
  schema_version?: string;
  id: string;
  title: string;
  objective: string;
  base_branch?: string;
  risk_area?: string;
  human_approval_required?: boolean;
  write_scope: {
    allowed: string[];
    forbidden?: string[];
  };
  required_evidence: string[];
  limits?: Limits;
  acceptance?: {
    required_tests?: string[];
    required_behaviors?: string[];
    must_not?: string[];
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
}

export type TestGroup = 'fail_to_pass' | 'pass_to_pass' | 'hidden_acceptance';

export type GateType =
  | 'hard'
  | 'scope'
  | 'integrity'
  | 'security'
  | 'task_acceptance'
  | 'regression'
  | 'performance'
  | 'hidden_acceptance'
  | 'advisory';

export interface EvalGate {
  name: string;
  type: GateType;
  command: string;
  required: boolean;
  timeout_seconds?: number;
  max_regression_percent?: number;
  group?: TestGroup;
  env?: Record<string, string>;
  cwd?: string;
}

export interface EvalConfig {
  schema_version: string;
  project: string;
  mode?: string;
  protected_paths?: string[];
  human_approval_risk_areas?: string[];
  risk_classification?: Record<string, string[]>;
  limits?: Limits;
  test_integrity?: {
    forbidden_patterns?: string[];
    suspicious_patterns?: string[];
  };
  baseline?: {
    mode?: 'per_loop' | 'cached_per_base_commit';
  };
  improvement_evidence?: {
    required_any?: string[];
  };
  hidden_acceptance?: {
    tests: Array<{
      name: string;
      source_path: string;
      target_path: string;
    }>;
  };
  verifier?: {
    policy?: 'local' | 'strict';
  };
  critic?: {
    require_different_provider?: boolean;
    /**
     * Declared provider of the advisory reviewer (e.g. 'openai', 'anthropic').
     * Used to decide reviewer independence: when it differs from the builder
     * provider the review is treated as independent. Unset/'unknown' keeps the
     * conservative `same_model_review = true`.
     */
    reviewer_provider?: string;
  };
  /**
   * Deterministic improvement-quality gate (Evaluator, M0). All thresholds are
   * fixed rules computed from harness artifacts — never an LLM judgment. When
   * absent, quality is treated as met (no behavior change). See
   * docs/SELF_IMPROVEMENT_LOOP_DESIGN.md §8/§9.
   */
  evaluator?: EvaluatorConfig;
  /**
   * Deterministic agent stdout/stderr context-leak guard. When configured, the
   * harness scans the agent's (bounded) stdout/stderr and redacts matches before
   * persisting. Add the builtin `artifact-leak` gate to make the verdict reject on
   * a forbidden literal (precise) — and, only if opted in, on a token-like match.
   * Absent ⇒ no scan/redaction (backward compatible). See
   * docs/EVAL_ENGINE_SPEC.md.
   */
  artifact_leak?: ArtifactLeakConfig;
  gates: EvalGate[];
}

export interface ArtifactLeakLiteral {
  /** Stable label recorded in logs/reports (the raw value is never persisted). */
  label: string;
  /** Forbidden literal to detect and redact. */
  value: string;
}

export interface ArtifactLeakConfig {
  /** Scan agent stdout. Default true when configured. */
  scan_agent_stdout?: boolean;
  /** Scan agent stderr. Default true when configured. */
  scan_agent_stderr?: boolean;
  /**
   * v2: scan the candidate patch (the PR deliverable) for the same forbidden
   * literals / opted-in tokens. The patch is never redacted; a match REJECTS
   * the candidate (GUARD_ARTIFACT_LEAK). Opt-in; default off.
   */
  scan_patch?: boolean;
  /**
   * v2: redact-only the project gate stdout/stderr logs before persisting (no
   * reject; gate pass/fail unaffected). Opt-in; default off.
   */
  redact_gate_logs?: boolean;
  /** Byte cap for scanning (≤ the exec buffer bound). Default 1 MiB. */
  max_scan_bytes?: number;
  /** Forbidden literals → REJECT (precise; e.g. prior issue id, hidden sentinel). */
  forbidden_literals?: ArtifactLeakLiteral[];
  builtins?: {
    /**
     * Built-in token-like detector (Bearer/sk-/access_token/...). Always REDACTED
     * when configured; only REJECTS when this is true (opt-in, avoids false
     * positives on example/test code).
     */
    token_like?: boolean;
  };
}

export interface EvaluatorConfig {
  /** When true, PR candidacy requires quality.met (consumed by the PR gate). */
  required?: boolean;
  /** Q4: max changed files. */
  max_changed_files?: number;
  /** Q4: max changed lines (added + deleted). */
  max_changed_lines?: number;
  /** Q4: fail if any protected path is touched. Defaults to true when configured. */
  forbid_protected?: boolean;
  /** Q1: minimum count of required_evidence entries that must be `present`. Default 1. */
  min_evidence_present?: number;
  /**
   * Q2: require test-on-base fail→pass when the task declares required_tests.
   * Default false (opt-in): the kernel already enforces fail-to-pass for
   * regression evidence, and forcing it would wrongly fail non-bugfix tasks.
   */
  require_test_on_base_pass?: boolean;
  /** Q3: changed files must intersect at least one of these path prefixes. */
  target_paths?: string[];
}

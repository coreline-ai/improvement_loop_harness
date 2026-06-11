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

export type GateType =
  | 'hard'
  | 'scope'
  | 'integrity'
  | 'security'
  | 'task_acceptance'
  | 'regression'
  | 'performance'
  | 'advisory';

export interface EvalGate {
  name: string;
  type: GateType;
  command: string;
  required: boolean;
  timeout_seconds?: number;
  max_regression_percent?: number;
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
  gates: EvalGate[];
}

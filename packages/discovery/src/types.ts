import type {
  EvalConfig,
  EvalGate,
  Limits,
  TaskDefinition
} from '@vibeloop/task-protocol';

export type CandidateSource =
  | 'test_failure'
  | 'typecheck'
  | 'lint'
  | 'security_scan'
  | 'manual';

export interface StructuredLocation {
  filePath: string;
  testName?: string | undefined;
  gateName?: string | undefined;
  errorCode: string;
}

export interface DiscoveryCandidate {
  id?: string | undefined;
  projectId?: string | undefined;
  source: CandidateSource;
  fingerprint: string;
  title: string;
  evidenceRefs: string[];
  /** Sanitized, bounded failure excerpt for the builder. Prompt-injection lines are removed. */
  evidenceSummary?: string | undefined;
  riskAreaHint?: string | null | undefined;
  trustLevel?: 'high' | 'medium' | 'low' | undefined;
  injectionIndicators?: string[] | undefined;
  reproCommand?: string | null | undefined;
  priority: number;
  status:
    | 'proposed'
    | 'approved'
    | 'queued'
    | 'running'
    | 'processed'
    | 'dismissed';
  location: StructuredLocation;
}

export interface DiscoveryCommand {
  source: Exclude<CandidateSource, 'manual'>;
  gate: EvalGate;
}

export interface DiscoverOptions {
  repoPath: string;
  evalConfig: EvalConfig;
  artifactRoot?: string | undefined;
  loopId?: string | undefined;
  commands?: DiscoveryCommand[] | undefined;
  existingFingerprints?: Iterable<string> | undefined;
  maxProposed?: number | undefined;
}

export interface DiscoveryCandidateSummary {
  fingerprint: string;
  title: string;
  source: CandidateSource;
  priority: number;
  location: StructuredLocation;
}

export interface DiscoveryCapReport {
  schema_version: '1.0';
  max_proposed: number;
  raw_count: number;
  deduped_count: number;
  selected_count: number;
  dropped_count: number;
  cap_applied: boolean;
  sort_order: 'priority_desc_title_asc';
  selected: DiscoveryCandidateSummary[];
  dropped: Array<DiscoveryCandidateSummary & { reason: 'max_proposed_cap' }>;
}

export interface DiscoverResult {
  candidates: DiscoveryCandidate[];
  report: DiscoveryCapReport;
}

export interface GenerateTaskOptions {
  evalConfig?: EvalConfig | undefined;
  baseBranch?: string | undefined;
}

export interface GeneratedTask {
  task: TaskDefinition;
  riskArea: string;
  writeScope: TaskDefinition['write_scope'];
  requiredEvidence: string[];
  limits?: Limits | undefined;
}

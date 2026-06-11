import type { EvalConfig, EvalGate, Limits, TaskDefinition } from '@vibeloop/task-protocol';

export type CandidateSource = 'test_failure' | 'typecheck' | 'lint' | 'security_scan' | 'manual';

export interface StructuredLocation {
  filePath: string;
  testName?: string | undefined;
  errorCode: string;
}

export interface DiscoveryCandidate {
  id?: string | undefined;
  projectId?: string | undefined;
  source: CandidateSource;
  fingerprint: string;
  title: string;
  evidenceRefs: string[];
  riskAreaHint?: string | null | undefined;
  priority: number;
  status: 'proposed' | 'approved' | 'queued' | 'running' | 'processed' | 'dismissed';
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

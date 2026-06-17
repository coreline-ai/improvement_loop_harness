export type TerminalRunStatus =
  | 'completed'
  | 'accepted'
  | 'approved'
  | 'pr_created'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'needs_human_review'
  | 'needs_more_tests';

export type ManifestStatus = 'running' | TerminalRunStatus;

export interface CreateRunDirOptions {
  dataDir: string;
  projectId: string;
  loopId: string;
}

export interface RunLayout {
  dataDir: string;
  projectId: string;
  loopId: string;
  root: string;
  manifest: string;
  input: string;
  workspace: string;
  patches: string;
  logs: string;
  gateLogs: string;
  reports: string;
  metrics: string;
  integrity: string;
  path(relativePath: string): string;
}

export interface ArtifactManifestEntry {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface ManifestIntegrity {
  algorithm: 'hmac-sha256';
  key_ref: 'data-dir';
  signature: string;
}

export interface RunManifest {
  schema_version: '1.0';
  loop_id: string;
  task_id?: string;
  project_id: string;
  base_commit?: string;
  created_at: string;
  artifact_root: string;
  status: ManifestStatus;
  finalized_at?: string;
  decision?: string;
  expires_at?: string;
  audit_keep?: boolean;
  artifacts?: ArtifactManifestEntry[];
  manifest_integrity?: ManifestIntegrity;
}

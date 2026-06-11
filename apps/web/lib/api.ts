export interface ProjectRecord {
  id: string;
  name: string;
  repoUrl?: string | null;
  localPath?: string | null;
  defaultBranch: string;
  evalConfigPath: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  status: string;
  riskArea?: string | null;
  writeScope: unknown;
  acceptance?: unknown;
  taskYaml: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface LoopRecord {
  id: string;
  taskId: string;
  iteration: number;
  status: string;
  decision?: string | null;
  decisionReasons?: unknown;
  baseCommit?: string | null;
  candidateCommit?: string | null;
  artifactRoot?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateRecord {
  id: string;
  projectId: string;
  source: string;
  fingerprint: string;
  title: string;
  evidenceRefs?: unknown;
  riskAreaHint?: string | null;
  priority: number;
  status: string;
  dismissReason?: string | null;
  taskId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  loopRunId: string;
  reason: string;
  status: string;
  reviewerId?: string | null;
  decisionReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvalReportRecord {
  id: string;
  loopRunId: string;
  type: string;
  status: string;
  reportJson: EvalReportJson;
  summary?: string | null;
  artifactRef?: string | null;
  createdAt: string;
}

export interface GateRunJson {
  name: string;
  type: string;
  required: boolean;
  command?: string;
  status: string;
  exit_code?: number | null;
  duration_ms?: number | null;
  stdout_ref?: string | null;
  stderr_ref?: string | null;
  summary?: string | null;
}

export interface EvalReportJson {
  decision?: string;
  decision_reasons?: Array<{ code: string; message: string }>;
  gate_runs?: GateRunJson[];
  changed_files?: Array<{ path: string; status: string; added_lines?: number; deleted_lines?: number }>;
  improvement_evidence?: Array<{
    type: string;
    status: string;
    artifact_ref?: string | null;
    supporting_gate?: string | null;
    message?: string;
  }>;
  artifact_refs?: string[];
  summary?: string;
}

export interface LoopEventEnvelope {
  id: string;
  loop_id: string;
  type: string;
  created_at: string;
  payload: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'API_ERROR'
  ) {
    super(message);
  }
}

function apiBaseUrl(): string {
  const value = process.env.VIBELOOP_API_URL;
  if (!value) throw new Error('VIBELOOP_API_URL is required for apps/web');
  return value.replace(/\/+$/, '');
}

export function apiToken(): string {
  const value = process.env.VIBELOOP_API_TOKEN;
  if (!value) throw new Error('VIBELOOP_API_TOKEN is required for apps/web');
  return value;
}

export function apiUrl(path: string): string {
  return `${apiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${apiToken()}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  });
  if (!response.ok) {
    let code = 'API_ERROR';
    let message = `API request failed with ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? message;
    } catch {
      // keep fallback
    }
    throw new ApiError(response.status, message, code);
  }
  return (await response.json()) as T;
}

export async function listProjects(): Promise<ProjectRecord[]> {
  return apiFetch<ProjectRecord[]>('/api/projects');
}

export async function getProject(projectId: string): Promise<ProjectRecord> {
  return apiFetch<ProjectRecord>(`/api/projects/${projectId}`);
}

export async function listTasks(projectId: string): Promise<TaskRecord[]> {
  return apiFetch<TaskRecord[]>(`/api/projects/${projectId}/tasks`);
}

export async function listLoops(taskId: string): Promise<LoopRecord[]> {
  return apiFetch<LoopRecord[]>(`/api/tasks/${taskId}/loops`);
}

export async function getLoop(loopId: string): Promise<LoopRecord> {
  return apiFetch<LoopRecord>(`/api/loops/${loopId}`);
}

export async function listReports(loopId: string): Promise<EvalReportRecord[]> {
  return apiFetch<EvalReportRecord[]>(`/api/loops/${loopId}/reports`);
}

export async function listApprovals(): Promise<ApprovalRecord[]> {
  return apiFetch<ApprovalRecord[]>('/api/approvals');
}

export async function listCandidates(projectId: string): Promise<CandidateRecord[]> {
  return apiFetch<CandidateRecord[]>(`/api/projects/${projectId}/candidates`);
}

export function latestEvalReport(reports: EvalReportRecord[]): EvalReportRecord | undefined {
  return [...reports]
    .filter((report) => report.type === 'eval' || report.type === 'eval-report' || report.reportJson?.decision)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? reports[0];
}


export function artifactHref(loopId: string, artifactRef: string): string {
  return `/api/loops/${encodeURIComponent(loopId)}/artifacts/${artifactRef
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

export function badgeClass(value?: string | null): string {
  return `badge ${value ?? ''}`.trim();
}

export function allPass(report: EvalReportJson | undefined): boolean {
  if (!report) return false;
  const gates = report.gate_runs ?? [];
  const evidence = report.improvement_evidence ?? [];
  const requiredGatesPass = gates.filter((gate) => gate.required).every((gate) => gate.status === 'pass');
  const evidencePresent = evidence.length === 0 || evidence.every((entry) => entry.status === 'present');
  return report.decision === 'accept' && requiredGatesPass && evidencePresent;
}

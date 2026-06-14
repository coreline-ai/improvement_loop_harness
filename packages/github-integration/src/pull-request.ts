export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface DecisionReason {
  code: string;
  message: string;
  ref?: string | null;
}

export interface GateRunSummary {
  name: string;
  status: string;
  required: boolean;
}

export interface AdversaryReviewSummaryInput {
  authority?: string | undefined;
  decision_impact?: string | undefined;
  builder_provider?: string | undefined;
  reviewer_provider?: string | undefined;
  same_model_review?: boolean | undefined;
  require_different_provider?: boolean | undefined;
  accepted_proposal_count?: number | undefined;
  requires_human_review_signal?: boolean | undefined;
  next_step?: string | undefined;
  error?: string | undefined;
  findings?:
    | Array<{
        severity?: string | undefined;
        message?: string | undefined;
      }>
    | undefined;
}

export interface PullRequestBodyOptions {
  adversaryReview?: AdversaryReviewSummaryInput | null | undefined;
}

export interface EvalReportSummaryInput {
  decision?: string | undefined;
  decision_reasons?: DecisionReason[] | undefined;
  gate_runs?: GateRunSummary[] | undefined;
  summary?: string | undefined;
  trust_summary?:
    | {
        deterministic_authority?: string;
        advisory_findings_count?: number;
        provenance_verified?: boolean;
        hidden_acceptance_status?: string;
        verifier_status?: string;
        human_review_reason_code?: string | null;
      }
    | undefined;
  verifier?: { policy?: string; mismatch?: boolean } | undefined;
}

export interface DraftPullRequestInput {
  owner: string;
  repo: string;
  token: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
  apiBaseUrl?: string | undefined;
}

export interface DraftPullRequestResult {
  url: string;
  number: number;
  reused: boolean;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody: string
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export function parseGitHubRepo(value: string): GitHubRepoRef | null {
  const normalized = value.trim().replace(/\.git$/, '');
  const shorthand = normalized.match(/^([^/\s:]+)\/([^/\s:]+)$/);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]! };
  const ssh = normalized.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  try {
    const url = new URL(normalized);
    if (url.hostname !== 'github.com') return null;
    const [owner, repo] = url.pathname.replace(/^\/+/, '').split('/');
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28'
  };
}

async function githubFetch<T>(
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(token),
      ...init.headers
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new GitHubApiError(
      `GitHub API request failed with ${response.status}`,
      response.status,
      text
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function formatAdversaryReview(
  review: AdversaryReviewSummaryInput | null | undefined
): string {
  if (!review) {
    return '- Not configured or not recorded.';
  }
  const findings = review.findings ?? [];
  const findingLines = findings.length
    ? findings
        .slice(0, 5)
        .map(
          (finding) =>
            `  - ${finding.severity ?? 'info'}: ${finding.message ?? 'No message'}`
        )
        .join('\n')
    : '  - none';
  return [
    `- Authority: ${review.authority ?? 'advisory_only'}`,
    `- Decision impact: ${review.decision_impact ?? 'none'}`,
    `- Builder provider: ${review.builder_provider ?? 'unknown'}`,
    `- Reviewer provider: ${review.reviewer_provider ?? 'undeclared'}`,
    `- Same model review / independence not guaranteed: ${review.same_model_review ? 'yes' : 'no'}`,
    `- Require different provider: ${review.require_different_provider ? 'yes' : 'no'}`,
    `- Human review signal: ${review.requires_human_review_signal ? 'yes' : 'no'}`,
    `- Accepted proposal count: ${review.accepted_proposal_count ?? 0}`,
    `- Next step: ${review.next_step ?? 'none'}`,
    review.error ? `- Reviewer error: ${review.error}` : null,
    '- Findings:',
    findingLines
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

export function buildPullRequestBody(
  report: EvalReportSummaryInput,
  options: PullRequestBodyOptions = {}
): string {
  const gates = report.gate_runs ?? [];
  const gateCounts = gates.reduce<Record<string, number>>((counts, gate) => {
    counts[gate.status] = (counts[gate.status] ?? 0) + 1;
    return counts;
  }, {});
  const reasons = report.decision_reasons ?? [];
  const reasonLines = reasons.length
    ? reasons
        .map((reason) => `- \`${reason.code}\` — ${reason.message}`)
        .join('\n')
    : '- No decision reason recorded.';
  const gateLines =
    Object.entries(gateCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `- ${status}: ${count}`)
      .join('\n') || '- No gate runs recorded.';

  const trust = report.trust_summary;
  const trustLines = trust
    ? [
        `- Deterministic authority: ${trust.deterministic_authority ?? 'decision_engine'}`,
        `- Provenance: ${trust.provenance_verified === false ? 'mismatch' : 'verified'}`,
        `- Hidden acceptance: ${trust.hidden_acceptance_status ?? 'not_configured'}`,
        `- Verifier: ${trust.verifier_status ?? 'not_configured'}`,
        `- Advisory findings: ${trust.advisory_findings_count ?? 0}`
      ].join('\n')
    : '- Trust summary not recorded.';

  return [
    '## VibeLoop eval summary',
    '',
    `- Decision: \`${report.decision ?? 'unknown'}\``,
    report.summary ? `- Summary: ${report.summary}` : '- Summary: not recorded',
    '',
    '## Decision reasons',
    '',
    reasonLines,
    '',
    '## Gate status counts',
    '',
    gateLines,
    '',
    '## Trust boundary',
    '',
    trustLines,
    '',
    '## Advisory adversary review',
    '',
    formatAdversaryReview(options.adversaryReview),
    '',
    '<!-- Generated by VibeLoop Harness. Draft PR only; no automatic merge. -->'
  ].join('\n');
}

export async function findExistingDraftPullRequest(
  input: DraftPullRequestInput
): Promise<DraftPullRequestResult | null> {
  const apiBaseUrl = input.apiBaseUrl ?? 'https://api.github.com';
  const url = new URL(`/repos/${input.owner}/${input.repo}/pulls`, apiBaseUrl);
  url.searchParams.set('head', `${input.owner}:${input.headBranch}`);
  url.searchParams.set('state', 'open');
  const pulls = await githubFetch<Array<{ html_url: string; number: number }>>(
    url.toString(),
    input.token,
    {
      method: 'GET'
    }
  );
  const existing = pulls[0];
  return existing
    ? { url: existing.html_url, number: existing.number, reused: true }
    : null;
}

export async function createDraftPullRequest(
  input: DraftPullRequestInput
): Promise<DraftPullRequestResult> {
  const existing = await findExistingDraftPullRequest(input);
  if (existing) return existing;

  const apiBaseUrl = input.apiBaseUrl ?? 'https://api.github.com';
  const created = await githubFetch<{ html_url: string; number: number }>(
    new URL(`/repos/${input.owner}/${input.repo}/pulls`, apiBaseUrl).toString(),
    input.token,
    {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        head: input.headBranch,
        base: input.baseBranch,
        body: input.body,
        draft: true
      })
    }
  );

  return { url: created.html_url, number: created.number, reused: false };
}

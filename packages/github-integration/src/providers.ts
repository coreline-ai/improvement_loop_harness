export type PullRequestProviderName = 'github' | 'gitea';

export interface PullRequestRef {
  url: string;
  number: number;
  baseBranch: string;
  headBranch: string;
  title?: string | undefined;
  body?: string | undefined;
  state?: string | undefined;
}

export interface PullRequestProvider {
  provider: PullRequestProviderName;
  createPullRequest(input: unknown): Promise<PullRequestState>;
  getPullRequest?(ref: PullRequestRef): Promise<PullRequestState>;
}

interface PullRequestStateBase extends PullRequestRef {
  provider: PullRequestProviderName;
  reused: boolean;
  draft_supported: boolean;
  draft_pr: boolean;
  github_draft_pr: boolean;
  github_draft_pr_verified: boolean;
  local_pr_like: boolean;
}

export interface GitHubDraftPullRequestState extends PullRequestStateBase {
  provider: 'github';
  draft_supported: true;
  draft_pr: true;
  github_draft_pr: true;
  github_draft_pr_verified: true;
  local_pr_like: false;
  auto_merge: null;
}

export interface GiteaPrLikePullRequestState extends PullRequestStateBase {
  provider: 'gitea';
  draft_supported: false;
  draft_pr: false;
  github_draft_pr: false;
  github_draft_pr_verified: false;
  local_pr_like: true;
  auto_merge?: null | undefined;
}

export type PullRequestState =
  | GitHubDraftPullRequestState
  | GiteaPrLikePullRequestState;

export interface PullRequestProviderOptionInput {
  gitProvider?: string | undefined;
  githubDraftPr?: boolean | undefined;
  giteaBaseUrl?: string | undefined;
  giteaTokenEnv?: string | undefined;
}

function normalizedProvider(
  value: string | undefined
): PullRequestProviderName | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const provider = value.trim().toLowerCase();
  if (provider === 'github' || provider === 'gitea') return provider;
  throw new Error(
    `--git-provider must be one of github,gitea; received ${value}`
  );
}

export function assertPullRequestProviderOptions(
  input: PullRequestProviderOptionInput
): PullRequestProviderName | undefined {
  const provider = normalizedProvider(input.gitProvider);
  if (input.githubDraftPr === true && provider === 'gitea') {
    throw new Error(
      '--github-draft-pr cannot be combined with --git-provider gitea; Gitea evidence is local_pr_like only'
    );
  }
  if ((input.giteaBaseUrl || input.giteaTokenEnv) && provider !== 'gitea') {
    throw new Error('--gitea-* options require --git-provider gitea');
  }
  return provider;
}

export function githubDraftPullRequestState(input: {
  url: string;
  number: number;
  baseBranch: string;
  headBranch: string;
  reused?: boolean | undefined;
  title?: string | undefined;
  body?: string | undefined;
  state?: string | undefined;
}): GitHubDraftPullRequestState {
  return {
    provider: 'github',
    url: input.url,
    number: input.number,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    title: input.title,
    body: input.body,
    state: input.state ?? 'open',
    reused: input.reused ?? false,
    draft_supported: true,
    draft_pr: true,
    github_draft_pr: true,
    github_draft_pr_verified: true,
    local_pr_like: false,
    auto_merge: null
  };
}

export function giteaPrLikePullRequestState(input: {
  url: string;
  number: number;
  baseBranch: string;
  headBranch: string;
  reused?: boolean | undefined;
  title?: string | undefined;
  body?: string | undefined;
  state?: string | undefined;
}): GiteaPrLikePullRequestState {
  return {
    provider: 'gitea',
    url: input.url,
    number: input.number,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    title: input.title,
    body: input.body,
    state: input.state ?? 'open',
    reused: input.reused ?? false,
    draft_supported: false,
    draft_pr: false,
    github_draft_pr: false,
    github_draft_pr_verified: false,
    local_pr_like: true,
    auto_merge: null
  };
}

export function assertPullRequestStateContract(
  state: PullRequestState
): PullRequestState {
  if (state.provider === 'github') {
    if (
      state.draft_supported !== true ||
      state.draft_pr !== true ||
      state.github_draft_pr !== true ||
      state.github_draft_pr_verified !== true ||
      state.local_pr_like !== false ||
      state.auto_merge !== null
    ) {
      throw new Error('GitHub provider state must be verified draft PR only');
    }
    return state;
  }

  if (
    state.draft_supported !== false ||
    state.draft_pr !== false ||
    state.github_draft_pr !== false ||
    state.github_draft_pr_verified !== false ||
    state.local_pr_like !== true
  ) {
    throw new Error(
      'Gitea provider state must be local_pr_like only and cannot claim GitHub draft PR evidence'
    );
  }
  return state;
}

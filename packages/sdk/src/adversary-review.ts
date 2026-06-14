/**
 * Adversary review lane (advisory only).
 *
 * A separate process/LLM may try to break the selected patch by proposing
 * findings and tests. This lane is deliberately NOT an accept gate: it cannot
 * change decision/qualified/selected_candidate_id. Proposed tests are only
 * statically filtered here; execution/M2 confirmation and M4 rulepack freeze are
 * explicit later steps.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  filterAdversaryProposal,
  type AdversaryProposal,
  type ProposalFilterConfig,
  type ProposalFilterResult
} from '@vibeloop/eval-engine';
import { providerForAgentSpec } from '@vibeloop/agent-adapters';

export const FIXED_ADVERSARY_REVIEW_PROMPT_VERSION = 'adversary-review-v1';

export const FIXED_ADVERSARY_REVIEW_PROMPT = [
  'You are an adversarial advisory reviewer for a VibeLoop candidate patch.',
  'Do not approve the change. Try to break it.',
  'Find defects, edge cases, regressions, or missing tests that the visible verifier may not catch.',
  'You are not an accept gate and must not decide pass/fail or merge readiness.',
  'Return JSON only: findings[] and optional proposals[].',
  'A proposal must be a bounded test file under tests/, test/, __tests__/, or .vibeloop/adversary/.',
  'Do not weaken tests, skip tests, use hidden acceptance details, request secrets, or include tokens.',
  'The harness will statically filter proposals, then M2/M4 may isolate and freeze them for a later loop only.'
].join('\n');

function promptHash(): string {
  return `sha256:${createHash('sha256')
    .update(FIXED_ADVERSARY_REVIEW_PROMPT)
    .digest('hex')}`;
}

export interface AdversaryReviewInput {
  reviewer_context: {
    prompt_version: typeof FIXED_ADVERSARY_REVIEW_PROMPT_VERSION;
    prompt: typeof FIXED_ADVERSARY_REVIEW_PROMPT;
    decision_impact: 'none';
    authority: 'advisory_only';
    forbidden_inputs: string[];
    output_contract: string;
  };
  task: {
    id: string;
    title: string;
    objective: string;
    required_evidence: string[];
    acceptance_required_tests: string[];
    write_scope_allowed: string[];
  };
  selected: {
    candidate_id: string;
    patch_ref: string;
    patch: string;
  };
}

export interface AdversaryFinding {
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  message: string;
  suggested_test_id?: string | undefined;
}

export interface AdversaryReviewOutput {
  findings?: AdversaryFinding[] | undefined;
  proposals?: AdversaryProposal[] | undefined;
  confidence?: number | undefined;
}

export interface ReviewedAdversaryProposal {
  proposal: AdversaryProposal;
  filter: ProposalFilterResult;
  next_step: 'discard' | 'm2_execution_required';
}

export interface AdversaryReviewReport {
  ran: boolean;
  authority: 'advisory_only';
  decision_impact: 'none';
  selected_candidate_id: string;
  builder_provider: string;
  reviewer_provider: string;
  same_model_review: boolean;
  require_different_provider: boolean;
  prompt_version: typeof FIXED_ADVERSARY_REVIEW_PROMPT_VERSION;
  prompt_hash: string;
  findings: AdversaryFinding[];
  proposals: ReviewedAdversaryProposal[];
  accepted_proposal_count: number;
  requires_human_review_signal: boolean;
  next_step:
    | 'none'
    | 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop';
  /**
   * JSON artifact containing only static-filter-accepted proposals for later M2
   * isolated execution. Advisory only; not an accept gate.
   */
  m2_handoff_ref?: string | undefined;
  error?: string | undefined;
}

export type AdversaryReviewer = (
  input: AdversaryReviewInput
) => Promise<AdversaryReviewOutput>;

export interface CommandAdversaryReviewerOptions {
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface AdversaryReviewIndependenceOptions {
  builderAgentSpec: string;
  reviewerProvider?: string | undefined;
  requireDifferentProvider?: boolean | undefined;
}

export interface AdversaryReviewIndependence {
  builder_provider: string;
  reviewer_provider: string;
  same_model_review: boolean;
  require_different_provider: boolean;
}

export function fixedAdversaryReviewContext(): AdversaryReviewInput['reviewer_context'] {
  return {
    prompt_version: FIXED_ADVERSARY_REVIEW_PROMPT_VERSION,
    prompt: FIXED_ADVERSARY_REVIEW_PROMPT,
    decision_impact: 'none',
    authority: 'advisory_only',
    forbidden_inputs: [
      'builder transcript',
      'hidden acceptance tests',
      'hidden sentinels',
      'OAuth tokens',
      'API keys',
      'secrets'
    ],
    output_contract:
      'JSON object with findings[] and optional proposals[{id,targetPath,body,expectation}]'
  };
}

export function fixedAdversaryReviewPromptHash(): string {
  return promptHash();
}

export function resolveAdversaryReviewIndependence(
  options: AdversaryReviewIndependenceOptions
): AdversaryReviewIndependence {
  const builderProvider = providerForAgentSpec(options.builderAgentSpec);
  const reviewerProvider = options.reviewerProvider?.trim() || 'undeclared';
  const requireDifferentProvider = options.requireDifferentProvider === true;

  let sameModelReview: boolean;
  if (builderProvider === 'mock') {
    sameModelReview = false;
  } else if (
    reviewerProvider === 'undeclared' ||
    reviewerProvider === 'unknown'
  ) {
    sameModelReview = true;
  } else if (builderProvider === 'unknown') {
    sameModelReview = true;
  } else {
    sameModelReview = builderProvider === reviewerProvider;
  }

  return {
    builder_provider: builderProvider,
    reviewer_provider: reviewerProvider,
    same_model_review: sameModelReview,
    require_different_provider: requireDifferentProvider
  };
}

export function commandAdversaryReviewer(
  command: string,
  options: CommandAdversaryReviewerOptions = {}
): AdversaryReviewer {
  return (input) =>
    new Promise<AdversaryReviewOutput>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.env ? { env: options.env } : {})
      });
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
        timer.unref();
      }
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              `adversary reviewer exited ${code ?? 'signal'}: ${stderr.slice(0, 300)}`
            )
          );
          return;
        }
        const start = stdout.indexOf('{');
        if (start < 0) {
          reject(new Error('adversary reviewer produced no JSON'));
          return;
        }
        try {
          resolve(JSON.parse(stdout.slice(start)) as AdversaryReviewOutput);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
}

function objectiveTerms(input: AdversaryReviewInput): string[] {
  const text = [
    input.task.id,
    input.task.title,
    input.task.objective,
    input.selected.patch_ref
  ].join(' ');
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((token) => token.length >= 3 && token.length <= 40)
    )
  ].slice(0, 20);
}

export function filterAdversaryReviewOutput(options: {
  input: AdversaryReviewInput;
  output: AdversaryReviewOutput;
  filterConfig?: Partial<ProposalFilterConfig> | undefined;
  independence?: AdversaryReviewIndependence | undefined;
}): AdversaryReviewReport {
  const filterConfig: ProposalFilterConfig = {
    testDirs: ['tests/', 'test/', '__tests__/', '.vibeloop/adversary/'],
    objectiveTerms: objectiveTerms(options.input),
    hiddenMarkers: ['SECRET_HIDDEN', 'HIDDEN_ACCEPTANCE', 'BEGIN_HIDDEN'],
    maxBodyBytes: 8_000,
    ...options.filterConfig
  };
  const findings = options.output.findings ?? [];
  const proposals = (options.output.proposals ?? []).map((proposal) => {
    const filter = filterAdversaryProposal(proposal, filterConfig);
    return {
      proposal,
      filter,
      next_step: filter.accepted
        ? ('m2_execution_required' as const)
        : ('discard' as const)
    };
  });
  const acceptedProposalCount = proposals.filter(
    (proposal) => proposal.filter.accepted
  ).length;
  const independence =
    options.independence ??
    resolveAdversaryReviewIndependence({
      builderAgentSpec: 'unknown'
    });
  const independenceWarning =
    independence.same_model_review ||
    (independence.require_different_provider && independence.same_model_review);
  return {
    ran: true,
    authority: 'advisory_only',
    decision_impact: 'none',
    selected_candidate_id: options.input.selected.candidate_id,
    builder_provider: independence.builder_provider,
    reviewer_provider: independence.reviewer_provider,
    same_model_review: independence.same_model_review,
    require_different_provider: independence.require_different_provider,
    prompt_version: options.input.reviewer_context.prompt_version,
    prompt_hash: fixedAdversaryReviewPromptHash(),
    findings,
    proposals,
    accepted_proposal_count: acceptedProposalCount,
    requires_human_review_signal:
      independenceWarning ||
      acceptedProposalCount > 0 ||
      findings.some((finding) =>
        ['high', 'critical'].includes(finding.severity)
      ),
    next_step:
      acceptedProposalCount > 0
        ? 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop'
        : 'none'
  };
}

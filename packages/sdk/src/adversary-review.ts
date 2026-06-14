/**
 * Adversary review lane (advisory only).
 *
 * A separate process/LLM may try to break the selected patch by proposing
 * findings and tests. This lane is deliberately NOT an accept gate: it cannot
 * change decision/qualified/selected_candidate_id. Proposed tests are only
 * statically filtered here; execution/M2 confirmation and M4 rulepack freeze are
 * explicit later steps.
 */
import { spawn } from 'node:child_process';
import {
  filterAdversaryProposal,
  type AdversaryProposal,
  type ProposalFilterConfig,
  type ProposalFilterResult
} from '@vibeloop/eval-engine';

export interface AdversaryReviewInput {
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
  findings: AdversaryFinding[];
  proposals: ReviewedAdversaryProposal[];
  accepted_proposal_count: number;
  requires_human_review_signal: boolean;
  next_step:
    | 'none'
    | 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop';
  error?: string | undefined;
}

export type AdversaryReviewer = (
  input: AdversaryReviewInput
) => Promise<AdversaryReviewOutput>;

export interface CommandAdversaryReviewerOptions {
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
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
  return {
    ran: true,
    authority: 'advisory_only',
    decision_impact: 'none',
    selected_candidate_id: options.input.selected.candidate_id,
    findings,
    proposals,
    accepted_proposal_count: acceptedProposalCount,
    requires_human_review_signal:
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

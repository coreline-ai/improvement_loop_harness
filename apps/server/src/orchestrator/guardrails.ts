import type { OrchestratorStateRecord } from '../types.js';

export const DEFAULT_DAILY_LOOP_BUDGET = 20;
export const DEFAULT_SAME_CANDIDATE_RETRY_LIMIT = 2;
export const DEFAULT_CONSECUTIVE_FAILURE_LIMIT = 5;
export const DEFAULT_OPEN_DRAFT_PR_LIMIT = 5;
export const DEFAULT_DISCOVERY_INTERVAL_MINUTES = 30;

export interface GuardrailCheckInput {
  state: OrchestratorStateRecord;
  openDraftPrCount: number;
  now?: Date | undefined;
}

export interface GuardrailDecision {
  allowed: boolean;
  reason?: string | undefined;
  eventType?: string | undefined;
}

export function budgetDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function resetDailyBudgetIfNeeded(
  state: OrchestratorStateRecord,
  now = new Date()
): Pick<OrchestratorStateRecord, 'budgetDay' | 'loopsStartedToday' | 'tokenUsedToday'> {
  const today = budgetDay(now);
  if (state.budgetDay === today) {
    return {
      budgetDay: state.budgetDay,
      loopsStartedToday: state.loopsStartedToday,
      tokenUsedToday: state.tokenUsedToday
    };
  }
  return { budgetDay: today, loopsStartedToday: 0, tokenUsedToday: 0 };
}

export function evaluateBeforeLoop(input: GuardrailCheckInput): GuardrailDecision {
  const normalized = resetDailyBudgetIfNeeded(input.state, input.now);
  const loopsStartedToday = normalized.loopsStartedToday;
  const tokenUsedToday = normalized.tokenUsedToday;

  if (input.state.tokenBudgetDaily === null || input.state.tokenBudgetDaily === undefined) {
    return { allowed: false, reason: 'token_budget_required', eventType: 'orchestrator.paused.token_budget_required' };
  }
  if (loopsStartedToday >= input.state.dailyLoopBudget) {
    return { allowed: false, reason: 'daily_loop_budget_exceeded', eventType: 'orchestrator.paused.daily_budget' };
  }
  if (tokenUsedToday >= input.state.tokenBudgetDaily) {
    return { allowed: false, reason: 'token_budget_exceeded', eventType: 'orchestrator.paused.token_budget' };
  }
  if (input.openDraftPrCount >= input.state.openDraftPrLimit) {
    return { allowed: false, reason: 'open_draft_pr_limit_reached', eventType: 'orchestrator.paused.open_draft_pr_limit' };
  }
  if (input.state.consecutiveFailures >= DEFAULT_CONSECUTIVE_FAILURE_LIMIT) {
    return { allowed: false, reason: 'consecutive_failure_limit_reached', eventType: 'orchestrator.paused.consecutive_failures' };
  }
  return { allowed: true };
}

export function isFailureForCircuitBreaker(status: string): boolean {
  return status === 'rejected' || status === 'failed';
}

export function isRetryableCandidateStatus(status: string): boolean {
  return status === 'rejected' || status === 'needs_more_tests' || status === 'failed';
}

export function isPrEligibleLoopStatus(status: string): boolean {
  return status === 'accepted' || status === 'approved';
}

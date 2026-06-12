import { safeGit } from '@vibeloop/workspace-runner';
import { approveCandidate } from '../candidate-service.js';
import { ApiError, requireRecord } from '../errors.js';
import type { LoopRunner, LoopRunnerResult } from '../queue.js';
import {
  createPullRequestForLoop,
  GitHubPullRequestManager,
  type PullRequestManager
} from '../routes/pull-requests.js';
import {
  ACTIVE_LOOP_STATUSES,
  type ImprovementCandidateRecord,
  type LoopRunRecord,
  type OrchestratorMode,
  type OrchestratorStateRecord,
  type ProjectRecord,
  type Store,
  type TaskRecord,
  type UpsertOrchestratorStateInput
} from '../types.js';
import {
  budgetDay,
  DEFAULT_CONSECUTIVE_FAILURE_LIMIT,
  DEFAULT_DAILY_LOOP_BUDGET,
  DEFAULT_DISCOVERY_INTERVAL_MINUTES,
  DEFAULT_OPEN_DRAFT_PR_LIMIT,
  DEFAULT_SAME_CANDIDATE_RETRY_LIMIT,
  evaluateBeforeLoop,
  isFailureForCircuitBreaker,
  isPrEligibleLoopStatus,
  isRetryableCandidateStatus,
  resetDailyBudgetIfNeeded
} from './guardrails.js';

export type SchedulerStartOptions = UpsertOrchestratorStateInput;

export interface FetchLatestBaseInput {
  project: ProjectRecord;
}

export type FetchLatestBase = (input: FetchLatestBaseInput) => Promise<string | null>;

export interface LoopOrchestratorSchedulerOptions {
  runner?: LoopRunner | undefined;
  pullRequestManager?: PullRequestManager | undefined;
  fetchLatestBase?: FetchLatestBase | undefined;
  now?: (() => Date) | undefined;
}

interface ActiveProjectRun {
  controller: AbortController;
  drain: Promise<void>;
}

function defaultStatePatch(now: Date): UpsertOrchestratorStateInput {
  return {
    mode: 'supervised',
    status: 'stopped',
    dailyLoopBudget: DEFAULT_DAILY_LOOP_BUDGET,
    loopsStartedToday: 0,
    budgetDay: budgetDay(now),
    tokenBudgetDaily: null,
    tokenUsedToday: 0,
    openDraftPrLimit: DEFAULT_OPEN_DRAFT_PR_LIMIT,
    discoveryIntervalMinutes: DEFAULT_DISCOVERY_INTERVAL_MINUTES,
    consecutiveFailures: 0,
    currentCandidateId: null,
    currentLoopId: null,
    nextDiscoveryAt: null,
    pausedReason: null,
    lastStartedAt: null,
    stoppedAt: null
  };
}

function candidateHasInjectionIndicators(candidate: ImprovementCandidateRecord): boolean {
  return Array.isArray(candidate.injectionIndicators) && candidate.injectionIndicators.length > 0;
}

function isLowRiskCandidate(candidate: ImprovementCandidateRecord): boolean {
  if (candidateHasInjectionIndicators(candidate)) return false;
  return candidate.riskAreaHint === 'none' || candidate.riskAreaHint === 'low';
}

function isSelectableCandidate(candidate: ImprovementCandidateRecord, mode: OrchestratorMode): boolean {
  if (candidate.status === 'approved' || candidate.status === 'queued') return true;
  return mode === 'auto' && candidate.status === 'proposed' && isLowRiskCandidate(candidate);
}

function loopDecisionFromStatus(status: string): string {
  switch (status) {
    case 'accepted':
    case 'approved':
      return 'accept';
    case 'needs_human_review':
      return 'needs_human_review';
    case 'needs_more_tests':
      return 'needs_more_tests';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return 'reject';
  }
}

function nextDiscoveryAt(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

async function defaultFetchLatestBase(input: FetchLatestBaseInput): Promise<string | null> {
  if (!input.project.localPath) return null;
  await safeGit(input.project.localPath, ['fetch', 'origin', input.project.defaultBranch]).catch(() => undefined);
  const remote = await safeGit(input.project.localPath, ['rev-parse', `origin/${input.project.defaultBranch}`]).catch(
    () => undefined
  );
  if (remote?.stdout.trim()) return remote.stdout.trim();
  const local = await safeGit(input.project.localPath, ['rev-parse', input.project.defaultBranch]).catch(() => undefined);
  return local?.stdout.trim() ?? null;
}

export class LoopOrchestratorScheduler {
  private readonly active = new Map<string, ActiveProjectRun>();

  constructor(
    private readonly store: Store,
    private readonly options: LoopOrchestratorSchedulerOptions = {}
  ) {}

  async ensureState(projectId: string): Promise<OrchestratorStateRecord> {
    const existing = await this.store.getOrchestratorState(projectId);
    if (existing) return existing;
    return this.store.upsertOrchestratorState(projectId, defaultStatePatch(this.now()));
  }

  async recoverAll(): Promise<void> {
    for (const state of await this.store.listOrchestratorStates()) {
      await this.recoverProject(state.projectId);
    }
  }

  async recoverProject(projectId: string): Promise<void> {
    const state = await this.store.getOrchestratorState(projectId);
    const candidates = await this.store.listCandidates(projectId);
    const runningCandidates = candidates.filter((candidate) => candidate.status === 'running');
    let recovered = false;

    for (const candidate of runningCandidates) {
      await this.store.updateCandidate(candidate.id, { status: 'queued' });
      if (candidate.taskId) {
        const loops = await this.store.listLoops(candidate.taskId);
        for (const loop of loops.filter((entry) => ACTIVE_LOOP_STATUSES.has(entry.status))) {
          await this.store.updateLoop(loop.id, {
            status: 'failed',
            decision: 'failed',
            finishedAt: new Date()
          });
          await this.store.addLoopEvent(loop.id, 'loop.failed', { reason: 'orchestrator_recovered_zombie' });
        }
      }
      recovered = true;
    }

    if (state?.currentLoopId) {
      const loop = await this.store.getLoop(state.currentLoopId);
      if (loop && ACTIVE_LOOP_STATUSES.has(loop.status)) {
        await this.store.updateLoop(loop.id, {
          status: 'failed',
          decision: 'failed',
          finishedAt: new Date()
        });
        await this.store.addLoopEvent(loop.id, 'loop.failed', { reason: 'orchestrator_recovered_zombie' });
        recovered = true;
      }
    }

    if (recovered || state?.status === 'running' || state?.status === 'stopping') {
      await this.store.upsertOrchestratorState(projectId, {
        status: 'stopped',
        currentCandidateId: null,
        currentLoopId: null,
        stoppedAt: this.now(),
        pausedReason: recovered ? 'recovered_running_zombie' : state?.pausedReason ?? null
      });
      await this.store.addOrchestratorEvent(projectId, 'orchestrator.recovered', { recovered_zombies: recovered });
    }
  }

  async start(projectId: string, input: SchedulerStartOptions = {}): Promise<OrchestratorStateRecord> {
    requireRecord(await this.store.getProject(projectId), 'PROJECT_NOT_FOUND', 'project not found');
    if (!this.options.runner) {
      throw new ApiError(400, 'LOOP_RUNNER_REQUIRED', 'orchestrator requires a LoopRunner');
    }
    const current = await this.ensureState(projectId);
    const normalized = resetDailyBudgetIfNeeded(current, this.now());
    const tokenBudgetDaily = input.tokenBudgetDaily !== undefined ? input.tokenBudgetDaily : current.tokenBudgetDaily;
    if (tokenBudgetDaily === null || tokenBudgetDaily === undefined || tokenBudgetDaily <= 0) {
      throw new ApiError(400, 'TOKEN_BUDGET_REQUIRED', 'tokenBudgetDaily must be configured before starting');
    }
    const state = await this.store.upsertOrchestratorState(projectId, {
      ...input,
      mode: input.mode ?? current.mode ?? 'supervised',
      status: 'running',
      tokenBudgetDaily,
      budgetDay: normalized.budgetDay,
      loopsStartedToday: normalized.loopsStartedToday,
      tokenUsedToday: normalized.tokenUsedToday,
      pausedReason: null,
      stoppedAt: null,
      lastStartedAt: this.now()
    });
    await this.store.addOrchestratorEvent(projectId, 'orchestrator.started', { mode: state.mode });
    this.kick(projectId);
    return state;
  }

  async stop(projectId: string, reason = 'kill_switch'): Promise<OrchestratorStateRecord> {
    const active = this.active.get(projectId);
    active?.controller.abort();
    const state = await this.ensureState(projectId);
    if (state.currentLoopId) {
      const loop = await this.store.getLoop(state.currentLoopId);
      if (loop && ACTIVE_LOOP_STATUSES.has(loop.status)) {
        await this.store.updateLoop(loop.id, { status: 'cancelled', decision: 'cancelled', finishedAt: this.now() });
        await this.store.addLoopEvent(loop.id, 'loop.cancelled', { reason });
      }
    }
    if (state.currentCandidateId) {
      const candidate = await this.store.getCandidate(state.currentCandidateId);
      if (candidate?.status === 'running') {
        await this.store.updateCandidate(candidate.id, { status: 'queued' });
      }
    }
    const stopped = await this.store.upsertOrchestratorState(projectId, {
      status: 'stopped',
      currentCandidateId: null,
      currentLoopId: null,
      stoppedAt: this.now(),
      pausedReason: null
    });
    await this.store.addOrchestratorEvent(projectId, 'orchestrator.stopped', { reason });
    return stopped;
  }

  private kick(projectId: string): void {
    const existing = this.active.get(projectId);
    if (existing) return;
    const controller = new AbortController();
    const drain = this.drain(projectId, controller)
      .catch(async (error) => {
        await this.pause(projectId, 'orchestrator_error', 'orchestrator.paused.error', {
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        const current = this.active.get(projectId);
        if (current?.controller === controller) {
          this.active.delete(projectId);
        }
      });
    this.active.set(projectId, { controller, drain });
  }

  private async drain(projectId: string, controller: AbortController): Promise<void> {
    while (!controller.signal.aborted) {
      const state = await this.ensureState(projectId);
      if (state.status !== 'running') return;
      const project = requireRecord(await this.store.getProject(projectId), 'PROJECT_NOT_FOUND', 'project not found');
      const normalized = resetDailyBudgetIfNeeded(state, this.now());
      if (
        normalized.budgetDay !== state.budgetDay ||
        normalized.loopsStartedToday !== state.loopsStartedToday ||
        normalized.tokenUsedToday !== state.tokenUsedToday
      ) {
        await this.store.upsertOrchestratorState(projectId, normalized);
      }

      const guardrail = evaluateBeforeLoop({
        state: { ...state, ...normalized },
        openDraftPrCount: await this.store.countOpenDraftPullRequests(projectId),
        now: this.now()
      });
      if (!guardrail.allowed) {
        await this.pause(projectId, guardrail.reason ?? 'guardrail', guardrail.eventType ?? 'orchestrator.paused');
        return;
      }

      const candidate = await this.nextCandidate(projectId, state.mode);
      if (!candidate) {
        await this.store.upsertOrchestratorState(projectId, {
          currentCandidateId: null,
          currentLoopId: null,
          nextDiscoveryAt: nextDiscoveryAt(this.now(), state.discoveryIntervalMinutes)
        });
        await this.store.addOrchestratorEvent(projectId, 'orchestrator.waiting_discovery', {
          interval_minutes: state.discoveryIntervalMinutes
        });
        return;
      }

      await this.processCandidate(project, candidate, controller);
    }
  }

  private async nextCandidate(projectId: string, mode: OrchestratorMode): Promise<ImprovementCandidateRecord | null> {
    const candidates = await this.store.listCandidates(projectId);
    return candidates.find((candidate) => isSelectableCandidate(candidate, mode)) ?? null;
  }

  private async processCandidate(
    project: ProjectRecord,
    candidate: ImprovementCandidateRecord,
    controller: AbortController
  ): Promise<void> {
    const queued = await approveCandidate(this.store, candidate.id, 'queued');
    const task = requireRecord(await this.store.getTask(queued.taskId ?? ''), 'TASK_NOT_FOUND', 'candidate task not found');
    const baseCommit = await (this.options.fetchLatestBase ?? defaultFetchLatestBase)({ project });
    const loop = await this.store.createLoop({
      taskId: task.id,
      iteration: await this.store.nextLoopIteration(task.id),
      status: 'queued',
      baseCommit
    });
    const current = await this.ensureState(project.id);
    const normalized = resetDailyBudgetIfNeeded(current, this.now());
    await this.store.updateCandidate(queued.id, { status: 'running' });
    await this.store.upsertOrchestratorState(project.id, {
      currentCandidateId: queued.id,
      currentLoopId: loop.id,
      loopsStartedToday: normalized.loopsStartedToday + 1,
      budgetDay: normalized.budgetDay,
      tokenUsedToday: normalized.tokenUsedToday,
      nextDiscoveryAt: null
    });
    await this.store.addOrchestratorEvent(project.id, 'candidate.picked', {
      candidate_id: queued.id,
      loop_id: loop.id,
      base_commit: baseCommit
    });
    await this.store.addLoopEvent(loop.id, 'candidate.picked', { candidate_id: queued.id });

    const result = await this.runLoop(loop, task, controller);
    await this.finalizeLoopResult(project.id, queued, loop, result, controller.signal.aborted);
  }

  private async runLoop(
    loop: LoopRunRecord,
    task: TaskRecord,
    controller: AbortController
  ): Promise<LoopRunnerResult> {
    const runner = this.options.runner;
    if (!runner) throw new ApiError(400, 'LOOP_RUNNER_REQUIRED', 'orchestrator requires a LoopRunner');
    await this.store.updateLoop(loop.id, { status: 'workspace_preparing', startedAt: this.now() });
    await this.store.addLoopEvent(loop.id, 'workspace_preparing', {});
    try {
      const result = await runner({ loop, task, signal: controller.signal });
      const status = controller.signal.aborted ? 'cancelled' : result.status;
      const updated = await this.store.updateLoop(loop.id, {
        status,
        decision: result.decision ?? loopDecisionFromStatus(status),
        artifactRoot: result.artifactRoot ?? loop.artifactRoot ?? null,
        finishedAt: this.now()
      });
      await this.store.addLoopEvent(loop.id, status === 'cancelled' ? 'loop.cancelled' : 'loop.completed', {
        status,
        decision: updated?.decision ?? null
      });
      return { ...result, status };
    } catch (error) {
      await this.store.updateLoop(loop.id, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        decision: controller.signal.aborted ? 'cancelled' : 'failed',
        decisionReasons: [
          {
            code: 'RUNNER_FAILED',
            message: error instanceof Error ? error.message : String(error)
          }
        ],
        finishedAt: this.now()
      });
      await this.store.addLoopEvent(loop.id, controller.signal.aborted ? 'loop.cancelled' : 'loop.failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      return { status: controller.signal.aborted ? 'cancelled' : 'failed', decision: controller.signal.aborted ? 'cancelled' : 'failed' };
    }
  }

  private async finalizeLoopResult(
    projectId: string,
    candidate: ImprovementCandidateRecord,
    loop: LoopRunRecord,
    result: LoopRunnerResult,
    stopped: boolean
  ): Promise<void> {
    const current = await this.ensureState(projectId);
    const tokenUsedToday = current.tokenUsedToday + (result.tokenUsageTotal ?? 0);
    const tokenBudgetExceeded =
      current.tokenBudgetDaily !== null && current.tokenBudgetDaily !== undefined && tokenUsedToday >= current.tokenBudgetDaily;
    const consecutiveFailures = isFailureForCircuitBreaker(result.status) ? current.consecutiveFailures + 1 : 0;
    await this.store.upsertOrchestratorState(projectId, {
      tokenUsedToday,
      consecutiveFailures,
      currentCandidateId: null,
      currentLoopId: null
    });

    if (stopped || result.status === 'cancelled') {
      await this.store.updateCandidate(candidate.id, { status: 'queued' });
      return;
    }

    if (isPrEligibleLoopStatus(result.status)) {
      await this.store.updateCandidate(candidate.id, { status: 'processed' });
      await createPullRequestForLoop(this.store, this.options.pullRequestManager ?? new GitHubPullRequestManager(), loop.id).catch(
        async (error) => {
          await this.store.addOrchestratorEvent(projectId, 'pr.create_failed', {
            loop_id: loop.id,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      );
      if (tokenBudgetExceeded) {
        await this.pause(projectId, 'token_budget_exceeded', 'orchestrator.paused.token_budget', {
          token_used_today: tokenUsedToday
        });
      }
      return;
    }

    if (result.status === 'needs_human_review') {
      await this.store.updateCandidate(candidate.id, { status: 'processed' });
      await this.store.createApproval({ loopRunId: loop.id, reason: 'orchestrator.needs_human_review' });
      await this.store.addOrchestratorEvent(projectId, 'approval.required', { loop_id: loop.id, candidate_id: candidate.id });
      if (tokenBudgetExceeded) {
        await this.pause(projectId, 'token_budget_exceeded', 'orchestrator.paused.token_budget', {
          token_used_today: tokenUsedToday
        });
      }
      return;
    }

    if (isRetryableCandidateStatus(result.status)) {
      const retryCount = await this.retryCount(candidate);
      if (retryCount >= DEFAULT_SAME_CANDIDATE_RETRY_LIMIT) {
        await this.store.updateCandidate(candidate.id, {
          status: 'dismissed',
          dismissReason: 'retry_limit'
        });
        await this.store.addLoopEvent(loop.id, 'candidate.dismissed.retry_limit', { candidate_id: candidate.id, retry_count: retryCount });
        await this.store.addOrchestratorEvent(projectId, 'candidate.dismissed.retry_limit', {
          candidate_id: candidate.id,
          retry_count: retryCount
        });
      } else {
        await this.store.updateCandidate(candidate.id, { status: 'queued' });
      }
    } else {
      await this.store.updateCandidate(candidate.id, { status: 'processed' });
    }

    if (consecutiveFailures >= DEFAULT_CONSECUTIVE_FAILURE_LIMIT) {
      await this.pause(projectId, 'consecutive_failure_limit_reached', 'orchestrator.paused.consecutive_failures', {
        consecutive_failures: consecutiveFailures
      });
    } else if (tokenBudgetExceeded) {
      await this.pause(projectId, 'token_budget_exceeded', 'orchestrator.paused.token_budget', {
        token_used_today: tokenUsedToday
      });
    }
  }

  private async retryCount(candidate: ImprovementCandidateRecord): Promise<number> {
    if (!candidate.taskId) return 0;
    const loops = await this.store.listLoops(candidate.taskId);
    return loops.filter((loop) => ['rejected', 'needs_more_tests', 'failed'].includes(loop.status)).length;
  }

  private async pause(
    projectId: string,
    reason: string,
    eventType = 'orchestrator.paused',
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    const previous = await this.ensureState(projectId);
    await this.store.upsertOrchestratorState(projectId, {
      status: 'paused',
      pausedReason: reason,
      currentCandidateId: null,
      currentLoopId: null
    });
    await this.store.addOrchestratorEvent(projectId, eventType, { reason, ...payload });
    if (previous.currentLoopId) {
      await this.store.addLoopEvent(previous.currentLoopId, 'orchestrator.paused', { reason, ...payload });
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

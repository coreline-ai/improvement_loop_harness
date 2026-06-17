import {
  TERMINAL_LOOP_STATUSES,
  type LoopRunRecord,
  type Store,
  type TaskRecord
} from './types.js';

export interface LoopRunnerInput {
  loop: LoopRunRecord;
  task: TaskRecord;
  signal?: AbortSignal | undefined;
}

export interface LoopRunnerResult {
  status: string;
  decision?: string | undefined;
  artifactRoot?: string | undefined;
  tokenUsageTotal?: number | undefined;
  /**
   * Deterministic improvement-quality verdict (M0). Undefined for legacy runners.
   * PR candidacy requires `accepted` (correctness) AND `qualified !== false`.
   */
  qualified?: boolean | undefined;
}

export type LoopRunner = (input: LoopRunnerInput) => Promise<LoopRunnerResult>;

export class InProcessLoopQueue {
  private chain = Promise.resolve();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly runner?: LoopRunner | undefined
  ) {}

  enqueue(loop: LoopRunRecord, task: TaskRecord): void {
    void this.store.addLoopEvent(loop.id, 'loop.queued', {
      status: loop.status
    });
    if (!this.runner) {
      return;
    }

    this.chain = this.chain
      .then(async () => {
        const controller = new AbortController();
        this.controllers.set(loop.id, controller);
        const current = await this.store.getLoop(loop.id);
        if (!current || TERMINAL_LOOP_STATUSES.has(current.status)) {
          this.controllers.delete(loop.id);
          return;
        }
        try {
          await this.store.updateLoop(loop.id, {
            status: 'workspace_preparing',
            startedAt: new Date()
          });
          await this.store.addLoopEvent(loop.id, 'workspace_preparing', {});
          const result = await this.runner!({
            loop,
            task,
            signal: controller.signal
          });
          const latest = await this.store.getLoop(loop.id);
          if (latest && TERMINAL_LOOP_STATUSES.has(latest.status)) {
            await this.store.addLoopEvent(loop.id, 'loop.result_ignored', {
              current_status: latest.status,
              runner_status: result.status,
              decision: result.decision ?? null
            });
            return;
          }
          await this.store.updateLoop(loop.id, {
            status: result.status,
            decision: result.decision ?? null,
            artifactRoot: result.artifactRoot ?? loop.artifactRoot ?? null,
            finishedAt: new Date()
          });
          await this.store.addLoopEvent(loop.id, 'loop.completed', {
            status: result.status,
            decision: result.decision ?? null
          });
        } finally {
          this.controllers.delete(loop.id);
        }
      })
      .catch(async (error) => {
        const latest = await this.store.getLoop(loop.id);
        if (latest && TERMINAL_LOOP_STATUSES.has(latest.status)) {
          await this.store.addLoopEvent(loop.id, 'loop.error_ignored', {
            current_status: latest.status,
            message: error instanceof Error ? error.message : String(error)
          });
          return;
        }
        await this.store.updateLoop(loop.id, {
          status: 'failed',
          decision: 'failed',
          decisionReasons: [
            {
              code: 'RUNNER_FAILED',
              message: error instanceof Error ? error.message : String(error)
            }
          ],
          finishedAt: new Date()
        });
        await this.store.addLoopEvent(loop.id, 'loop.failed', {
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }

  cancel(loopId: string): boolean {
    const controller = this.controllers.get(loopId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

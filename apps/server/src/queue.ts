import type { LoopRunRecord, Store, TaskRecord } from './types.js';

export interface LoopRunnerInput {
  loop: LoopRunRecord;
  task: TaskRecord;
}

export interface LoopRunnerResult {
  status: string;
  decision?: string | undefined;
  artifactRoot?: string | undefined;
}

export type LoopRunner = (input: LoopRunnerInput) => Promise<LoopRunnerResult>;

export class InProcessLoopQueue {
  private chain = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly runner?: LoopRunner | undefined
  ) {}

  enqueue(loop: LoopRunRecord, task: TaskRecord): void {
    void this.store.addLoopEvent(loop.id, 'loop.queued', { status: loop.status });
    if (!this.runner) {
      return;
    }

    this.chain = this.chain
      .then(async () => {
        await this.store.updateLoop(loop.id, {
          status: 'workspace_preparing',
          startedAt: new Date()
        });
        await this.store.addLoopEvent(loop.id, 'workspace_preparing', {});
        const result = await this.runner!({ loop, task });
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
      })
      .catch(async (error) => {
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
}

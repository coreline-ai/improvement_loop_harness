import type { FastifyInstance } from 'fastify';
import { ApiError, requireRecord } from '../errors.js';
import type { Store } from '../types.js';

async function transitionApproval(
  store: Store,
  approvalId: string,
  targetStatus: 'approved' | 'rejected' | 'needs_more_tests',
  body: Record<string, unknown>,
  reviewerId: string | null
): Promise<unknown> {
  const approval = requireRecord(await store.getApproval(approvalId), 'APPROVAL_NOT_FOUND', 'approval not found');
  const loop = requireRecord(await store.getLoop(approval.loopRunId), 'LOOP_NOT_FOUND', 'loop not found');
  if (approval.status !== 'pending' || loop.status !== 'needs_human_review') {
    throw new ApiError(409, 'APPROVAL_NOT_ALLOWED', 'approval is only allowed for pending approvals on needs_human_review loops');
  }

  const now = new Date();
  const updatedApproval = requireRecord(
    await store.updateApproval(approval.id, {
      status: targetStatus === 'needs_more_tests' ? 'requested_more_tests' : targetStatus,
      reviewerId,
      decisionReason: typeof body.decision_reason === 'string' ? body.decision_reason : null,
      requestedChanges: body.requested_changes ?? null,
      approvedAt: targetStatus === 'approved' ? now : null,
      rejectedAt: targetStatus === 'rejected' ? now : null
    }),
    'APPROVAL_NOT_FOUND',
    'approval not found'
  );
  const loopStatus = targetStatus === 'approved' ? 'approved' : targetStatus;
  const updatedLoop = requireRecord(
    await store.updateLoop(loop.id, { status: loopStatus, finishedAt: now }),
    'LOOP_NOT_FOUND',
    'loop not found'
  );
  await store.addLoopEvent(loop.id, 'approval.completed', {
    approval_id: approval.id,
    status: updatedApproval.status,
    loop_status: updatedLoop.status
  });
  return { approval: updatedApproval, loop: updatedLoop };
}

export async function registerApprovalRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.get('/api/approvals', async () => store.listApprovals());

  app.get('/api/approvals/:approvalId', async (request) => {
    const params = request.params as { approvalId: string };
    return requireRecord(await store.getApproval(params.approvalId), 'APPROVAL_NOT_FOUND', 'approval not found');
  });

  app.post('/api/approvals/:approvalId/approve', async (request) => {
    const params = request.params as { approvalId: string };
    return transitionApproval(store, params.approvalId, 'approved', (request.body ?? {}) as Record<string, unknown>, request.reviewerId);
  });

  app.post('/api/approvals/:approvalId/reject', async (request) => {
    const params = request.params as { approvalId: string };
    return transitionApproval(store, params.approvalId, 'rejected', (request.body ?? {}) as Record<string, unknown>, request.reviewerId);
  });

  app.post('/api/approvals/:approvalId/request-more-tests', async (request) => {
    const params = request.params as { approvalId: string };
    return transitionApproval(store, params.approvalId, 'needs_more_tests', (request.body ?? {}) as Record<string, unknown>, request.reviewerId);
  });
}

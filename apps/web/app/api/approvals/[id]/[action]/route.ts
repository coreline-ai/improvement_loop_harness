import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '../../../../../lib/api';

const allowed = new Set(['approve', 'reject', 'request-more-tests']);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  if (!allowed.has(action)) {
    return NextResponse.json({ error: { code: 'ACTION_NOT_ALLOWED' } }, { status: 404 });
  }
  const form = await request.formData();
  await apiFetch(`/api/approvals/${id}/${action}`, {
    method: 'POST',
    body: JSON.stringify({
      reviewer_id: 'mvp-user',
      decision_reason: String(form.get('decision_reason') ?? ''),
      requested_changes: String(form.get('requested_changes') ?? '')
    })
  });
  return NextResponse.redirect(new URL('/approvals?updated=1', request.url), 303);
}

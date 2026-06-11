import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '../../../../../lib/api';

const allowed = new Set(['approve', 'dismiss']);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  if (!allowed.has(action)) {
    return NextResponse.json({ error: { code: 'ACTION_NOT_ALLOWED' } }, { status: 404 });
  }
  const form = await request.formData();
  await apiFetch(`/api/candidates/${id}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ reason: String(form.get('reason') ?? '') })
  });
  return NextResponse.redirect(new URL('/candidates?updated=1', request.url), 303);
}

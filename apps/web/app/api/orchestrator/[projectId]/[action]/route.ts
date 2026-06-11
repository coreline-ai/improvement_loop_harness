import { NextRequest, NextResponse } from 'next/server';
import { apiFetch } from '../../../../../lib/api';

const allowed = new Set(['start', 'stop']);

function numberFromForm(form: FormData, key: string): number | undefined {
  const raw = String(form.get(key) ?? '').trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; action: string }> }
) {
  const { projectId, action } = await params;
  if (!allowed.has(action)) {
    return NextResponse.json({ error: { code: 'ACTION_NOT_ALLOWED' } }, { status: 404 });
  }
  const form = await request.formData();
  const body = action === 'start'
    ? {
        mode: String(form.get('mode') ?? 'supervised'),
        tokenBudgetDaily: numberFromForm(form, 'tokenBudgetDaily'),
        dailyLoopBudget: numberFromForm(form, 'dailyLoopBudget')
      }
    : {};
  await apiFetch(`/api/projects/${projectId}/orchestrator/${action}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return NextResponse.redirect(new URL('/orchestrator?updated=1', request.url), 303);
}

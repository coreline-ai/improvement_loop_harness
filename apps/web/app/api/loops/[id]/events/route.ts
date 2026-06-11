import { NextRequest } from 'next/server';
import { apiToken, apiUrl } from '../../../../../lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lastEventId = request.nextUrl.searchParams.get('lastEventId') ?? request.headers.get('last-event-id') ?? '0';
  const upstream = await fetch(apiUrl(`/api/loops/${id}/events`), {
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${apiToken()}`,
      'last-event-id': lastEventId
    }
  });
  if (!upstream.ok) {
    return new Response(await upstream.text(), { status: upstream.status });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform'
    }
  });
}

import { NextRequest } from 'next/server';
import { apiToken, apiUrl } from '../../../../../../lib/api';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  const artifactPath = path.map((segment) => encodeURIComponent(segment)).join('/');
  const upstream = await fetch(apiUrl(`/api/loops/${encodeURIComponent(id)}/artifacts/${artifactPath}`), {
    cache: 'no-store',
    headers: { authorization: `Bearer ${apiToken()}` }
  });

  if (!upstream.ok) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store'
    }
  });
}

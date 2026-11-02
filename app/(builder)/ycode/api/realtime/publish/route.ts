import { isPlatformAuth } from '@/lib/platform/config';
import { getRealtimeHub, RealtimeError } from '@/lib/realtime/hub';
import { MAX_ACTION_BYTES, REALTIME_TOKEN_HEADER, type RealtimeAction } from '@/lib/realtime/protocol';
import { verifyRealtimeToken } from '@/lib/realtime/token';

export const dynamic = 'force-dynamic';

/**
 * POST /ycode/api/realtime/publish
 *
 * Actions of a realtime connection: join/leave a channel, broadcast, and
 * track/untrack presence. Authorized by the connection token from the
 * stream instead of a session lookup, since cursor moves arrive many times
 * per second; the proxy treats this route as public for the same reason.
 */
export async function POST(request: Request) {
  if (!isPlatformAuth()) {
    return new Response('Not found', { status: 404 });
  }

  const claims = verifyRealtimeToken(request.headers.get(REALTIME_TOKEN_HEADER));
  if (!claims) {
    return Response.json({ error: 'Invalid or expired realtime token' }, { status: 401 });
  }

  const raw = await request.text();
  if (raw.length > MAX_ACTION_BYTES) {
    return Response.json({ error: 'Message too large' }, { status: 413 });
  }

  let action: RealtimeAction;
  try {
    action = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    await getRealtimeHub().handle(claims.connectionId, action);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof RealtimeError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error('[realtime] Action failed:', error);
    return Response.json({ error: 'Realtime action failed' }, { status: 500 });
  }
}

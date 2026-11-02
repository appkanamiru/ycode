import { headers } from 'next/headers';

import { isPlatformAuth } from '@/lib/platform/config';
import { resolveBuilderAccess } from '@/lib/platform/tenants';
import { getRealtimeHub } from '@/lib/realtime/hub';
import type { RealtimeReady } from '@/lib/realtime/protocol';
import { issueRealtimeToken } from '@/lib/realtime/token';
import { getTenantIdFromHeaders } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const HEARTBEAT_MS = 15_000;

/**
 * GET /ycode/api/realtime/stream
 *
 * Server-sent events for collaboration (plain Postgres only): broadcasts and
 * presence of the channels this connection joined. The first event, `ready`,
 * carries the connection id and the token for POST /ycode/api/realtime/publish.
 * The proxy has verified the session and resolved the tenant.
 */
export async function GET(request: Request) {
  if (!isPlatformAuth()) {
    return new Response('Not found', { status: 404 });
  }

  const access = await resolveBuilderAccess(await headers());
  if (!access) {
    return new Response('Not authenticated', { status: 401 });
  }
  const tenantId = await getTenantIdFromHeaders();

  const hub = getRealtimeHub();
  const encoder = new TextEncoder();
  let connectionId: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (connectionId) {
      hub.disconnect(connectionId).catch((error) => console.error('[realtime] Disconnect failed:', error));
      connectionId = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      connectionId = hub.connect(tenantId, access.user.id, (event) => send('message', event));
      const ready: RealtimeReady = {
        connectionId,
        token: issueRealtimeToken({ connectionId, tenantId, userId: access.user.id }),
      };
      write('retry: 3000\n\n');
      send('ready', ready);

      // Keeps idle connections open through proxies and load balancers
      heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);

      request.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
    cancel: cleanup,
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform keeps compression from buffering the stream
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

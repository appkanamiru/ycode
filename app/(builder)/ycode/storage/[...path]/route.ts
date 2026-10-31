import { MAX_UPLOAD_FILE_SIZE } from '@/lib/asset-constants';
import { isPlatformAuth } from '@/lib/platform/config';
import {
  parseObjectKey,
  serveObject,
  verifyUploadToken,
  writeObject,
} from '@/lib/storage/filesystem-storage';

export const dynamic = 'force-dynamic';

/**
 * /ycode/storage/<bucket>/[<tenant>/]<path>
 *
 * Serves files from filesystem storage (plain Postgres) and receives signed
 * uploads (PUT ?token=...). Only available when running on plain Postgres.
 */

type RouteContext = { params: Promise<{ path: string[] }> };

async function resolveSegments(context: RouteContext): Promise<string[] | null> {
  if (!isPlatformAuth()) return null;
  const { path } = await context.params;
  return parseObjectKey(path.map((segment) => decodeURIComponent(segment)).join('/'));
}

async function serve(request: Request, context: RouteContext, includeBody: boolean): Promise<Response> {
  const segments = await resolveSegments(context);
  if (!segments) return new Response('Not found', { status: 404 });
  return serveObject(segments, request.headers.get('range'), includeBody);
}

export function GET(request: Request, context: RouteContext) {
  return serve(request, context, true);
}

export function HEAD(request: Request, context: RouteContext) {
  return serve(request, context, false);
}

/** Signed upload, e.g. a CSV import uploaded straight from the browser */
export async function PUT(request: Request, context: RouteContext) {
  const segments = await resolveSegments(context);
  if (!segments) return new Response('Not found', { status: 404 });

  const token = new URL(request.url).searchParams.get('token');
  if (!verifyUploadToken(segments.join('/'), token)) {
    return Response.json({ error: 'Invalid or expired upload token' }, { status: 403 });
  }

  if (Number(request.headers.get('content-length')) > MAX_UPLOAD_FILE_SIZE) {
    return Response.json({ error: 'File too large' }, { status: 413 });
  }
  const contents = Buffer.from(await request.arrayBuffer());
  if (contents.length > MAX_UPLOAD_FILE_SIZE) {
    return Response.json({ error: 'File too large' }, { status: 413 });
  }

  const result = await writeObject(segments, contents, {
    contentType: request.headers.get('content-type') || 'application/octet-stream',
  });
  if (result.error) {
    return Response.json({ error: result.error.message }, { status: Number(result.error.statusCode) || 500 });
  }

  return Response.json({ Key: segments.join('/') }, { headers: { 'Access-Control-Allow-Origin': '*' } });
}

import { createReadStream, promises as fs } from 'fs';
import { Readable } from 'stream';

import { MAX_UPLOAD_FILE_SIZE } from '@/lib/asset-constants';
import { isPlatformAuth } from '@/lib/platform/config';
import {
  objectFilePath,
  parseObjectKey,
  readObjectMeta,
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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // User uploads (SVG, HTML) are served from the builder origin: never let
  // them run scripts there if opened as a document
  'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  // Fonts and media are loaded by published sites on other domains
  'Access-Control-Allow-Origin': '*',
};

async function resolveSegments(context: RouteContext): Promise<string[] | null> {
  if (!isPlatformAuth()) return null;
  const { path } = await context.params;
  return parseObjectKey(path.map((segment) => decodeURIComponent(segment)).join('/'));
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;

  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

async function serve(request: Request, context: RouteContext, includeBody: boolean): Promise<Response> {
  const segments = await resolveSegments(context);
  if (!segments) return new Response('Not found', { status: 404 });

  const filePath = objectFilePath(segments);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return new Response('Not found', { status: 404 });

  const meta = await readObjectMeta(segments);
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    'Content-Type': meta.contentType,
    'Cache-Control': `public, max-age=${Number(meta.cacheControl) || 3600}`,
    'Accept-Ranges': 'bytes',
  };

  const rangeHeader = request.headers.get('range');
  const range = parseRange(rangeHeader, stat.size);
  if (rangeHeader && !range) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
  }

  const { start, end } = range ?? { start: 0, end: stat.size - 1 };
  headers['Content-Length'] = String(stat.size === 0 ? 0 : end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;

  const body = includeBody && stat.size > 0
    ? Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
    : null;
  return new Response(body, { status: range ? 206 : 200, headers });
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

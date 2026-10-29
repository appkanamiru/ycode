/**
 * Filesystem Storage
 *
 * The subset of the Supabase Storage API the app uses (upload, download,
 * remove, getPublicUrl, createSignedUploadUrl), backed by a local directory.
 * Used on plain Postgres. Files are served, and signed uploads received, by
 * the /ycode/storage/[...path] route.
 *
 * Layout under STORAGE_DIR (default ./data/uploads):
 *   objects/<bucket>/[<tenant id>/]<path>       file contents
 *   meta/<bucket>/[<tenant id>/]<path>.json     content type
 * In multi-tenant mode every key starts with the tenant id, so a tenant can
 * only reach its own files.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const SIGNED_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const SAFE_SEGMENT = /^[^/\\\0]+$/;

export interface StorageError {
  message: string;
  statusCode: string;
}

type Result<T> = { data: T; error: null } | { data: null; error: StorageError };

interface ObjectMeta {
  contentType: string;
  cacheControl?: string;
}

function failure(message: string, statusCode: string): { data: null; error: StorageError } {
  return { data: null, error: { message, statusCode } };
}

export function getStorageRoot(): string {
  return path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), 'data', 'uploads'));
}

function getPublicBaseUrl(): string {
  const base = process.env.STORAGE_PUBLIC_URL || process.env.BETTER_AUTH_URL;
  if (!base) {
    throw new Error('STORAGE_PUBLIC_URL (or BETTER_AUTH_URL) is required for filesystem storage');
  }
  return base.replace(/\/+$/, '');
}

function getSigningSecret(): string {
  const secret = process.env.STORAGE_SIGNING_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error('STORAGE_SIGNING_SECRET (or BETTER_AUTH_SECRET) is required for signed uploads');
  }
  return secret;
}

/**
 * Validate an object key (`bucket/[tenant/]path`) and split it into segments.
 * Rejects traversal (`..`), empty segments and absolute paths.
 */
export function parseObjectKey(key: string): string[] | null {
  const segments = key.split('/');
  if (segments.length < 2) return null;
  const valid = segments.every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..');
  return valid ? segments : null;
}

function resolveUnder(base: string, segments: string[], suffix = ''): string {
  const resolved = path.resolve(base, ...segments) + suffix;
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error('Invalid storage path');
  }
  return resolved;
}

export function objectFilePath(segments: string[]): string {
  return resolveUnder(path.join(getStorageRoot(), 'objects'), segments);
}

function metaFilePath(segments: string[]): string {
  return resolveUnder(path.join(getStorageRoot(), 'meta'), segments, '.json');
}

export async function readObjectMeta(segments: string[]): Promise<ObjectMeta> {
  try {
    return JSON.parse(await fs.readFile(metaFilePath(segments), 'utf8'));
  } catch {
    return { contentType: 'application/octet-stream' };
  }
}

/** Write atomically: readers never see a half-written file. */
async function writeFileAtomic(target: string, contents: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, target);
}

export async function writeObject(
  segments: string[],
  contents: Buffer,
  meta: ObjectMeta,
  options: { upsert?: boolean } = {},
): Promise<Result<null>> {
  const target = objectFilePath(segments);
  if (!options.upsert) {
    const exists = await fs.access(target).then(() => true, () => false);
    if (exists) return failure('The resource already exists', '409');
  }

  await writeFileAtomic(target, contents);
  await writeFileAtomic(metaFilePath(segments), JSON.stringify(meta));
  return { data: null, error: null };
}

function signKey(key: string, expires: number): string {
  return createHmac('sha256', getSigningSecret()).update(`${key}:${expires}`).digest('base64url');
}

/** Verify a signed upload token (`<expires>.<signature>`) for an object key. */
export function verifyUploadToken(key: string, token: string | null): boolean {
  const [expiresText, signature] = (token ?? '').split('.');
  const expires = Number(expiresText);
  if (!signature || !Number.isFinite(expires) || expires < Date.now()) return false;

  const expected = Buffer.from(signKey(key, expires));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function toBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new Error('Unsupported upload body');
}

class FilesystemBucket {
  constructor(private readonly bucket: string, private readonly tenantId: string | null) {}

  private key(objectPath: string): string {
    const prefix = this.tenantId ? `${this.bucket}/${this.tenantId}` : this.bucket;
    return `${prefix}/${objectPath.replace(/^\/+/, '')}`;
  }

  private segments(objectPath: string): string[] {
    const segments = parseObjectKey(this.key(objectPath));
    if (!segments) throw new Error(`Invalid storage path: ${objectPath}`);
    return segments;
  }

  async upload(
    objectPath: string,
    body: unknown,
    options: { contentType?: string; upsert?: boolean; cacheControl?: string } = {},
  ): Promise<Result<{ id: string; path: string; fullPath: string }>> {
    try {
      const contents = await toBuffer(body);
      const contentType = options.contentType || (body instanceof Blob && body.type) || 'application/octet-stream';
      const result = await writeObject(this.segments(objectPath), contents, {
        contentType,
        cacheControl: options.cacheControl,
      }, { upsert: options.upsert });
      if (result.error) return result;

      return { data: { id: randomUUID(), path: objectPath, fullPath: `${this.bucket}/${objectPath}` }, error: null };
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'Upload failed', '500');
    }
  }

  async download(objectPath: string): Promise<Result<Blob>> {
    try {
      const segments = this.segments(objectPath);
      const [contents, meta] = await Promise.all([fs.readFile(objectFilePath(segments)), readObjectMeta(segments)]);
      return { data: new Blob([new Uint8Array(contents)], { type: meta.contentType }), error: null };
    } catch (error) {
      const notFound = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return failure(notFound ? 'Object not found' : 'Download failed', notFound ? '404' : '500');
    }
  }

  async remove(objectPaths: string[]): Promise<Result<Array<{ name: string }>>> {
    try {
      const removed: Array<{ name: string }> = [];
      for (const objectPath of objectPaths) {
        const segments = this.segments(objectPath);
        const existed = await fs.rm(objectFilePath(segments)).then(() => true, () => false);
        await fs.rm(metaFilePath(segments), { force: true });
        if (existed) removed.push({ name: objectPath });
      }
      return { data: removed, error: null };
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'Remove failed', '500');
    }
  }

  getPublicUrl(objectPath: string): { data: { publicUrl: string } } {
    const encoded = this.segments(objectPath).map(encodeURIComponent).join('/');
    return { data: { publicUrl: `${getPublicBaseUrl()}/ycode/storage/${encoded}` } };
  }

  async createSignedUploadUrl(objectPath: string): Promise<Result<{ signedUrl: string; token: string; path: string }>> {
    try {
      const key = this.key(objectPath);
      this.segments(objectPath);
      const expires = Date.now() + SIGNED_UPLOAD_TTL_MS;
      const token = `${expires}.${signKey(key, expires)}`;
      const { publicUrl } = this.getPublicUrl(objectPath).data;
      return { data: { signedUrl: `${publicUrl}?token=${encodeURIComponent(token)}`, token, path: objectPath }, error: null };
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'Failed to sign upload', '500');
    }
  }
}

export interface FilesystemStorage {
  from(bucket: string): FilesystemBucket;
}

/** Storage bound to a tenant (null on single-tenant installs). */
export function createFilesystemStorage(tenantId: string | null): FilesystemStorage {
  return {
    from(bucket: string) {
      if (!SAFE_SEGMENT.test(bucket) || bucket === '.' || bucket === '..') {
        throw new Error(`Invalid bucket: ${bucket}`);
      }
      return new FilesystemBucket(bucket, tenantId);
    },
  };
}

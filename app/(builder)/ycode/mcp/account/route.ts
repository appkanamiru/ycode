import { NextRequest } from 'next/server';
import {
  addCorsHeaders,
  buildWwwAuthenticateHeader,
  handleMcpDelete,
  handleMcpGet,
  handleMcpPost,
} from '@/lib/mcp/handler';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getBaseUrl } from '@/lib/oauth/metadata';
import { ACCOUNT_MCP_PATH, validateAccountToken } from '@/lib/platform/mcp-account';
import { ACCOUNT_TOOLS, getAccountMcpOptions, resolveAccountCallSite } from '@/lib/platform/mcp-account-server';
import { runInTenantContext } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Account-wide MCP endpoint (multi-tenant): one connector for all of the
 * user's sites. OAuth Bearer tokens from an account consent; each call is
 * run scoped to the site it names (or the session's selected site).
 */

/** Served on the editor's host only: a site's own address is for that site */
function isEditorHost(request: NextRequest): boolean {
  const editor = process.env.BETTER_AUTH_URL;
  return Boolean(editor) && request.headers.get('host')?.toLowerCase() === new URL(editor!).host.toLowerCase();
}

async function authorize(request: NextRequest): Promise<string | Response> {
  if (!isMultiTenant() || !isEditorHost(request)) return addCorsHeaders(new Response('Not found', { status: 404 }));

  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const userId = token ? await validateAccountToken(token) : null;
  if (userId) return userId;

  return addCorsHeaders(new Response(JSON.stringify({ error: token ? 'Invalid or expired access token' : 'Authorization required' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': buildWwwAuthenticateHeader(getBaseUrl(request), ACCOUNT_MCP_PATH),
    },
  }));
}

function toolError(id: unknown, text: string): Response {
  return addCorsHeaders(new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: id ?? null,
    result: { content: [{ type: 'text', text }], isError: true },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

export async function POST(request: NextRequest) {
  const userId = await authorize(request);
  if (userId instanceof Response) return userId;

  const text = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const messages = (Array.isArray(body) ? body : [body]) as Array<{ id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null>;
  const sessionId = request.headers.get('mcp-session-id');

  // The site this request works on; site tools need one
  let tenantId: string | null = null;
  const call = messages.find((message) => message?.method === 'tools/call');
  const siteArgument = call && !ACCOUNT_TOOLS.has(call.params?.name ?? '') ? call.params?.arguments?.site : undefined;
  const resolved = await resolveAccountCallSite(userId, sessionId, siteArgument);
  if (resolved && 'error' in resolved) {
    if (call) return toolError(call.id, resolved.error);
  } else if (resolved) {
    tenantId = resolved.site.id;
  }
  if (call && !ACCOUNT_TOOLS.has(call.params?.name ?? '') && !tenantId) {
    return toolError(call.id, 'No site selected. Call list_sites and select_site, or pass `site` (its slug).');
  }

  const forwarded = new Request(request.url, { method: 'POST', headers: request.headers, body: text });
  return runInTenantContext(tenantId, () => handleMcpPost(forwarded, getAccountMcpOptions(userId), `account:${userId}`));
}

export async function GET(request: NextRequest) {
  const userId = await authorize(request);
  if (userId instanceof Response) return userId;
  return handleMcpGet(request, `account:${userId}`);
}

export async function DELETE(request: NextRequest) {
  const userId = await authorize(request);
  if (userId instanceof Response) return userId;
  return handleMcpDelete(request, `account:${userId}`);
}

export async function OPTIONS() {
  return addCorsHeaders(new Response(null, { status: 204 }));
}

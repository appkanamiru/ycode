/**
 * Account-wide MCP Requests
 *
 * The editor's `/ycode/mcp` (multi-tenant) with an account token: one
 * connection for all of the user's sites. Each call runs scoped to the site
 * it names, or the session's selected site.
 */

import {
  addCorsHeaders,
  buildWwwAuthenticateHeader,
  handleMcpDelete,
  handleMcpGet,
  handleMcpPost,
} from '@/lib/mcp/handler';
import { isMultiTenant } from '@/lib/database/tenancy';
import { getBaseUrl } from '@/lib/oauth/metadata';
import { isAccountAccessToken, validateAccountToken } from './mcp-account';
import { ACCOUNT_TOOLS, getAccountMcpOptions, resolveAccountCallSite } from './mcp-account-server';
import { runInTenantContext } from '@/lib/supabase-server';

function bearerToken(request: Request): string | null {
  return request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
}

/** Served on the editor's host only: a site's own address is for that site */
function isEditorHost(request: Request): boolean {
  const editor = process.env.BETTER_AUTH_URL;
  return Boolean(editor) && request.headers.get('host')?.toLowerCase() === new URL(editor!).host.toLowerCase();
}

/** An account connection's request: an account token on the editor's endpoint */
export function isAccountMcpRequest(request: Request): boolean {
  return isMultiTenant() && isEditorHost(request) && isAccountAccessToken(bearerToken(request));
}

async function authorize(request: Request): Promise<string | Response> {
  const token = bearerToken(request);
  const userId = token ? await validateAccountToken(token) : null;
  if (userId) return userId;

  return addCorsHeaders(new Response(JSON.stringify({ error: token ? 'Invalid or expired access token' : 'Authorization required' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': buildWwwAuthenticateHeader(getBaseUrl(request)),
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

async function handlePost(request: Request): Promise<Response> {
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

export async function handleAccountMcp(request: Request): Promise<Response> {
  if (request.method === 'POST') return handlePost(request);

  const userId = await authorize(request);
  if (userId instanceof Response) return userId;
  return request.method === 'DELETE'
    ? handleMcpDelete(request, `account:${userId}`)
    : handleMcpGet(request, `account:${userId}`);
}

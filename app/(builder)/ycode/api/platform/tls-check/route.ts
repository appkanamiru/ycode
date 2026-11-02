import { isMultiTenant } from '@/lib/database/tenancy';
import { isPlatformAuth } from '@/lib/platform/config';
import { normalizeHostname, resolveTenantByHost } from '@/lib/platform/tenants';

export const dynamic = 'force-dynamic';

/**
 * GET /ycode/api/platform/tls-check?domain=<hostname>
 *
 * Asked by the TLS terminator (Caddy `on_demand_tls { ask ... }`) before it
 * requests a certificate: 200 only for the builder host, existing site
 * subdomains and verified custom domains, so nobody can make the server
 * request certificates for arbitrary names pointed at it.
 */
export async function GET(request: Request) {
  if (!isPlatformAuth() || !isMultiTenant()) {
    return new Response('Not found', { status: 404 });
  }

  const domain = normalizeHostname(new URL(request.url).searchParams.get('domain'));
  if (!domain) return new Response('domain is required', { status: 400 });

  const builderUrl = process.env.BETTER_AUTH_URL;
  const isBuilder = builderUrl ? domain === normalizeHostname(new URL(builderUrl).host) : false;
  const allowed = isBuilder || Boolean(await resolveTenantByHost(domain));

  return new Response(allowed ? 'ok' : 'unknown domain', { status: allowed ? 200 : 404 });
}

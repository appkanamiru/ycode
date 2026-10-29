import { getDbClient } from '@/lib/database/pg-client';
import { isMultiTenant } from '@/lib/database/tenancy';
import { randomBytes } from 'crypto';

/**
 * MCP OAuth Client Repository
 *
 * Stores RFC 7591 Dynamic Client Registration entries. The `client_id` itself
 * is not a secret (PKCE is the actual security mechanism) but we persist the
 * client name so the consent screen can display "Allow [Client Name]…" and
 * the registered redirect URIs so we can validate them at /authorize time.
 */

export interface McpOAuthClient {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

export interface RegisterClientData {
  client_name: string;
  redirect_uris: string[];
}

function generateClientId(): string {
  return 'mcp_client_' + randomBytes(24).toString('hex');
}

export async function registerClient(data: RegisterClientData): Promise<McpOAuthClient> {
  const client = await getDbClient();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const clientId = generateClientId();

  const { data: row, error } = await client
    .from('mcp_oauth_clients')
    .insert({
      client_id: clientId,
      client_name: data.client_name,
      redirect_uris: data.redirect_uris,
      created_at: new Date().toISOString(),
    })
    .select('id, client_id, client_name, redirect_uris, created_at')
    .single();

  if (error) {
    throw new Error(`Failed to register OAuth client: ${error.message}`);
  }

  return row;
}

/**
 * Remove DCR registrations that never completed (or no longer have) an
 * authorisation. Every connect attempt registers a new client, so without this
 * the table grows unbounded. A client is kept while any token or pending code
 * references it, and is never removed within 24h of registration so an
 * in-flight consent flow can't lose its client.
 *
 * Best-effort; callers should not await failures.
 */
export async function cleanupOrphanClients(): Promise<void> {
  // Clients are shared by all tenants while tokens are per tenant, so a
  // tenant-scoped run would see other tenants' clients as orphaned
  if (isMultiTenant()) {
    return;
  }

  const client = await getDbClient();

  if (!client) {
    return;
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: stale, error } = await client
    .from('mcp_oauth_clients')
    .select('client_id')
    .lt('created_at', cutoff);

  if (error || !stale || stale.length === 0) {
    return;
  }

  const staleIds = stale.map((row) => row.client_id);

  const [tokenResult, codeResult] = await Promise.all([
    client.from('mcp_tokens').select('oauth_client_id').in('oauth_client_id', staleIds),
    client.from('mcp_oauth_codes').select('client_id').in('client_id', staleIds),
  ]);

  // Without the references every stale client would look orphaned
  if (tokenResult.error || codeResult.error) {
    return;
  }
  const { data: tokenRefs } = tokenResult;
  const { data: codeRefs } = codeResult;

  const referenced = new Set<string>();
  for (const row of tokenRefs ?? []) {
    if (row.oauth_client_id) referenced.add(row.oauth_client_id);
  }
  for (const row of codeRefs ?? []) {
    referenced.add(row.client_id);
  }

  const orphanIds = staleIds.filter((id) => !referenced.has(id));
  if (orphanIds.length === 0) {
    return;
  }

  await client
    .from('mcp_oauth_clients')
    .delete()
    .in('client_id', orphanIds);
}

export async function getClient(clientId: string): Promise<McpOAuthClient | null> {
  const client = await getDbClient();

  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { data, error } = await client
    .from('mcp_oauth_clients')
    .select('id, client_id, client_name, redirect_uris, created_at')
    .eq('client_id', clientId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to fetch OAuth client: ${error.message}`);
  }

  return data;
}

import type { NextRequest } from 'next/server';
import { getAuthorizationServerUrl, getBaseUrl, jsonMetadataResponse, optionsResponse } from '@/lib/oauth/metadata';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * RFC 9728 — Protected Resource Metadata for the account-wide MCP endpoint
 * (`/ycode/mcp/account`, multi-tenant).
 */
export async function GET(request: NextRequest) {
  return jsonMetadataResponse({
    resource: `${getBaseUrl(request)}/ycode/mcp/account`,
    authorization_servers: [getAuthorizationServerUrl(request)],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/ycode/ycode',
  });
}

export async function OPTIONS() {
  return optionsResponse();
}

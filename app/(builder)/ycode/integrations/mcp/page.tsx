'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import McpEndpointCard from './components/mcp-endpoint-card';
import McpClientInstructions from './components/mcp-client-instructions';
import McpConnectionsList from './components/mcp-connections-list';
import McpLegacyTokens from './components/mcp-legacy-tokens';
import { isOAuthToken, type McpToken } from './components/types';
import { fetchPlatformSites } from '@/lib/platform/browser-sites';

export default function McpPage() {
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [tokenToDelete, setTokenToDelete] = useState<McpToken | null>(null);
  const [mcpUrl, setMcpUrl] = useState('');
  const [isLocalhost, setIsLocalhost] = useState(false);

  useEffect(() => {
    const { origin, hostname, protocol } = window.location;
    // Deployments behind a reverse proxy or served from several hostnames can
    // pin the advertised endpoint; otherwise it is this site's own /ycode/mcp.
    const configured = process.env.NEXT_PUBLIC_MCP_SERVER_URL?.trim();
    setMcpUrl(configured || `${origin}/ycode/mcp`);
    setIsLocalhost(!configured && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')));

    // Multi-tenant: each site has its own endpoint on its subdomain, so a
    // client can connect to several sites (one connector per URL)
    if (configured) return;
    fetchPlatformSites().then((platform) => {
      const site = platform?.sites.find((candidate) => candidate.active);
      if (site && platform?.sitesDomain) {
        setMcpUrl(`${protocol}//${site.slug}.${platform.sitesDomain}/ycode/mcp`);
      }
    }).catch(() => {});
  }, []);

  const fetchTokens = useCallback(async () => {
    try {
      const response = await fetch('/ycode/api/mcp-tokens');
      const result = await response.json();
      if (result.data) {
        setTokens(result.data);
      }
    } catch (error) {
      console.error('Failed to fetch MCP tokens:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const { connections, urlTokens } = useMemo(() => ({
    connections: tokens.filter(isOAuthToken),
    urlTokens: tokens.filter((token) => !isOAuthToken(token)),
  }), [tokens]);

  const handleGenerateToken = async (name: string): Promise<McpToken | null> => {
    try {
      const response = await fetch('/ycode/api/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      const result = await response.json();
      if (result.data) {
        fetchTokens();
        return result.data as McpToken;
      }
      return null;
    } catch (error) {
      console.error('Failed to generate MCP token:', error);
      return null;
    }
  };

  const handleDeleteToken = async () => {
    if (!tokenToDelete) return;

    try {
      await fetch(`/ycode/api/mcp-tokens/${tokenToDelete.id}`, {
        method: 'DELETE',
      });
      setTokens((prev) => prev.filter((t) => t.id !== tokenToDelete.id));
    } catch (error) {
      console.error('Failed to delete MCP token:', error);
    } finally {
      setTokenToDelete(null);
    }
  };

  const deleteIsConnection = tokenToDelete ? isOAuthToken(tokenToDelete) : false;

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto flex flex-col gap-8">

        <div className="flex flex-col gap-3 pt-8">
          <span className="text-base font-medium">MCP</span>
          <p className="text-sm text-muted-foreground">
            Connect AI assistants like Claude, Cursor, or ChatGPT to this Ycode project. They can
            read and edit pages, collections, assets, and more on your behalf.
          </p>
        </div>

        {mcpUrl && <McpEndpointCard url={mcpUrl} />}

        <div className="flex flex-col gap-3">
          <span className="text-base font-medium">Connections</span>
          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Spinner />
            </div>
          ) : (
            <McpConnectionsList
              connections={connections}
              onRevoke={setTokenToDelete}
            />
          )}
        </div>

        {mcpUrl && (
          <McpClientInstructions
            url={mcpUrl}
            isLocalhost={isLocalhost}
          />
        )}

        {!isLoading && (
          <McpLegacyTokens
            tokens={urlTokens}
            onGenerate={handleGenerateToken}
            onDelete={setTokenToDelete}
          />
        )}

        <ConfirmDialog
          open={tokenToDelete !== null}
          onOpenChange={(open) => {
            if (!open) setTokenToDelete(null);
          }}
          title={deleteIsConnection ? 'Revoke connection' : 'Delete URL token'}
          description={deleteIsConnection
            ? `Revoke access for "${tokenToDelete?.name}"? The client will need to reconnect and approve access again.`
            : `Delete "${tokenToDelete?.name}"? AI tools using this URL will no longer be able to connect.`}
          confirmLabel={deleteIsConnection ? 'Revoke' : 'Delete'}
          onConfirm={handleDeleteToken}
          confirmVariant="destructive"
        />
      </div>
    </div>
  );
}

'use client';

import { Button } from '@/components/ui/button';
import { useCopyToClipboard } from './use-copy-to-clipboard';

interface McpEndpointCardProps {
  url: string;
  title?: string;
  description?: string;
}

/**
 * An OAuth MCP endpoint (this site's, or the account's). Clients discover the
 * OAuth flow from the URL alone; the user signs in and approves when prompted.
 */
export default function McpEndpointCard({ url, title = 'MCP server URL', description }: McpEndpointCardProps) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="flex flex-col gap-3 bg-secondary/20 p-5 rounded-lg">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{title}</span>
        <p className="text-xs text-muted-foreground">
          {description ?? 'Paste this URL into your AI tool. You\'ll be asked to sign in to Ycode and approve access the first time it connects — no keys to copy.'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-secondary px-3 py-2.5 rounded-lg font-mono break-all select-all">
          {url}
        </code>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => copy(url)}
          aria-label="Copy MCP server URL"
        >
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

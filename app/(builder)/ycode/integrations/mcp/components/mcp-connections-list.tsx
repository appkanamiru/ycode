'use client';

import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { isConnectionExpired, type McpToken } from './types';

interface McpConnectionsListProps {
  connections: McpToken[];
  onRevoke: (token: McpToken) => void;
}

function statusLabel(token: McpToken): string {
  return isConnectionExpired(token) ? 'Expired' : 'Connected';
}

function lastUsedLabel(token: McpToken): string {
  if (!token.last_used_at) return 'never used';
  return `last used ${formatRelativeTime(token.last_used_at, false)}`;
}

/**
 * OAuth connections approved through the consent screen. One row per client
 * authorisation; revoking deletes the token so the client must reconnect.
 */
export default function McpConnectionsList({ connections, onRevoke }: McpConnectionsListProps) {
  if (connections.length === 0) {
    return (
      <div className="py-10 text-center text-muted-foreground text-sm border border-dashed rounded-lg">
        No connections yet. Connect an AI tool using a URL above and it will appear here.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {connections.map((token) => {
        const expired = isConnectionExpired(token);
        return (
          <div
            key={token.id}
            className="flex items-center gap-4 p-4 bg-secondary/20 rounded-lg"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1">
                <Label className="font-medium truncate">{token.name}</Label>
                <span className={`text-xs px-1.5 py-0.5 rounded ${expired ? 'text-muted-foreground bg-secondary' : 'text-emerald-500 bg-emerald-500/10'}`}>
                  {statusLabel(token)}
                </span>
                {token.scope && (
                  <span className="text-xs px-1.5 py-0.5 rounded text-muted-foreground bg-secondary">
                    {token.scope === 'account' ? 'All sites' : 'This site'}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Connected {formatDate(token.created_at, 'MMM D, YYYY')} · {lastUsedLabel(token)}
              </div>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="xs"
                  aria-label={`Actions for ${token.name}`}
                >
                  <Icon name="more" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => onRevoke(token)}
                >
                  Revoke
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
}

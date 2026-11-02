/**
 * MCP Server for Account-wide Connections
 *
 * The same tools as a site's MCP server, plus list_sites / select_site, and a
 * `site` argument on every tool. The route resolves each call's site (its
 * `site` argument, else the session's selected one) and runs it scoped to
 * that site, after checking the user is a member.
 */

import { z } from 'zod';

import type { CreateMcpServerOptions } from '@/lib/mcp/server';
import { listSites, type SiteSummary } from './sites';

/** Tools that work across sites, without one selected */
export const ACCOUNT_TOOLS = new Set(['list_sites', 'select_site']);

const globalForAccount = globalThis as unknown as {
  __mcpAccountSessionSites?: Map<string, string>;
};
/** The site each account session selected with select_site */
const sessionSites = globalForAccount.__mcpAccountSessionSites ??= new Map();

/** One of the user's sites, by slug, id or one of its domains */
async function findUserSite(userId: string, site: string): Promise<SiteSummary | null> {
  const wanted = site.trim().toLowerCase();
  const sites = await listSites(userId, null);
  return sites.find((candidate) => candidate.slug === wanted || candidate.id === wanted || candidate.domains.includes(wanted)
    || (candidate.url !== null && new URL(candidate.url).host === wanted)) ?? null;
}

export type AccountCallSite =
  | { site: SiteSummary }
  | { error: string };

/**
 * The site a request works on: the `site` it names, else the site its
 * session selected. Null when it names none and none is selected.
 */
export async function resolveAccountCallSite(
  userId: string,
  sessionId: string | null,
  site: unknown,
): Promise<AccountCallSite | null> {
  if (typeof site === 'string' && site.trim()) {
    const found = await findUserSite(userId, site);
    return found ? { site: found } : { error: `"${site}" is not one of your sites. Call list_sites to see them.` };
  }

  const selected = sessionId ? sessionSites.get(sessionId) : undefined;
  if (!selected) return null;
  const found = await findUserSite(userId, selected);
  // Removed from the site since selecting it
  return found ? { site: found } : { error: 'You no longer have access to the selected site. Call list_sites and select_site.' };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

export function getAccountMcpOptions(userId: string): CreateMcpServerOptions {
  return {
    sharedToolParams: {
      site: z.string().optional()
        .describe('Slug of the site this call works on (see list_sites). Defaults to the site chosen with select_site.'),
    },
    extraTools: (server) => {
      server.registerTool('list_sites', {
        title: 'List sites',
        description: 'List the sites this connection can work on, with their slug, name, your role, address (where the site is served) and verified domains. The selected site is marked.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      }, async (_args, extra) => {
        const selected = extra.sessionId ? sessionSites.get(extra.sessionId) : undefined;
        const sites = await listSites(userId, selected ?? null);
        return textResult(JSON.stringify(sites.map((site) => ({
          slug: site.slug, name: site.name, role: site.role, url: site.url, domains: site.domains, selected: site.active,
        }))));
      });

      server.registerTool('select_site', {
        title: 'Select site',
        description: 'Choose the site the following tool calls work on (by slug, see list_sites). A `site` argument on a single call overrides it.',
        inputSchema: { site: z.string().describe('Slug of one of your sites') },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      }, async ({ site }, extra) => {
        const found = await findUserSite(userId, site);
        if (!found) return textResult(`"${site}" is not one of your sites. Call list_sites to see them.`, true);
        if (!extra.sessionId) return textResult('This client keeps no session. Pass `site` on every call instead.', true);
        sessionSites.set(extra.sessionId, found.id);
        return textResult(`Selected ${JSON.stringify(found.name)} (${found.url ?? found.slug}). Tool calls now work on this site.`);
      });
    },
    extraInstructions: `## Connected sites

This connection works on all sites of the account that approved it. Before changing anything, call
list_sites and select_site with the site you were asked to work on, or pass \`site\` (its slug) on each
call. Every tool reads and changes only the site it is called for.`,
  };
}

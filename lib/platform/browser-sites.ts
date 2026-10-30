/**
 * Browser side of the multi-tenant site list (/ycode/api/platform/sites).
 */

export interface PlatformSite {
  id: string;
  name: string;
  slug: string;
  role: string;
  url: string | null;
  domains: string[];
  active: boolean;
}

export interface PlatformSites {
  sites: PlatformSite[];
  owned: number;
  limit: number;
  canCreate: boolean;
  sitesDomain: string | null;
}

/** null when the server is not multi-tenant (or the user is signed out) */
export async function fetchPlatformSites(): Promise<PlatformSites | null> {
  const response = await fetch('/ycode/api/platform/sites', { cache: 'no-store' });
  if (!response.ok) return null;
  return (await response.json()).data;
}

/** Returns an error message, or null on success */
export async function createPlatformSite(name: string, slug: string): Promise<string | null> {
  const response = await fetch('/ycode/api/platform/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slug }),
  });
  if (response.ok) return null;
  return (await response.json().catch(() => null))?.error || 'Failed to create the site';
}

export async function activatePlatformSite(slug: string): Promise<boolean> {
  const response = await fetch('/ycode/api/platform/sites/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  return response.ok;
}

/** Switch to a site and reload the editor: everything loaded belongs to the previous site */
export async function openPlatformSite(slug: string): Promise<boolean> {
  if (!(await activatePlatformSite(slug))) return false;
  window.location.assign('/ycode');
  return true;
}

/** Suggest a subdomain from a site name: "Petr Novák" -> "petr-novak" */
export function slugifySiteName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export interface PlatformDnsRecord {
  type: 'TXT' | 'CNAME' | 'A';
  name: string;
  value: string;
  purpose: 'verification' | 'routing';
}

export interface PlatformDomain {
  id: string;
  hostname: string;
  verified: boolean;
  /** The site's other hostnames redirect here */
  primary: boolean;
  records: PlatformDnsRecord[];
}

export interface PlatformDomainCheck {
  domain: PlatformDomain;
  ownershipVerified: boolean;
  routed: boolean;
}

type Result<T> = { data: T; error: null } | { data: null; error: string };

async function domainRequest<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  const response = await fetch(`/ycode/api/platform/sites/${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (response.status === 204) return { data: null as T, error: null };
  const json = await response.json().catch(() => null);
  return response.ok ? { data: json.data, error: null } : { data: null, error: json?.error || 'Request failed' };
}

export function fetchSiteDomains(siteId: string) {
  return domainRequest<PlatformDomain[]>(`${siteId}/domains`);
}

export function addSiteDomain(siteId: string, hostname: string) {
  return domainRequest<PlatformDomain>(`${siteId}/domains`, { method: 'POST', body: JSON.stringify({ hostname }) });
}

export function verifySiteDomain(siteId: string, domainId: string) {
  return domainRequest<PlatformDomainCheck>(`${siteId}/domains/${domainId}/verify`, { method: 'POST' });
}

export function setPrimarySiteDomain(siteId: string, domainId: string, primary: boolean) {
  return domainRequest<PlatformDomain>(`${siteId}/domains/${domainId}`, { method: 'PATCH', body: JSON.stringify({ primary }) });
}

export function removeSiteDomain(siteId: string, domainId: string) {
  return domainRequest<null>(`${siteId}/domains/${domainId}`, { method: 'DELETE' });
}

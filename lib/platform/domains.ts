/**
 * Custom Domains
 *
 * A site can be served on its own domains besides its free subdomain.
 * Ownership is proven with a TXT record (`_ycode-verification.<domain>`);
 * pointing DNS at the platform is not enough, since anyone could claim a
 * domain whose old DNS records still point here. Several sites may have a
 * pending claim on a hostname; the first to verify it gets it.
 *
 * A site can make one of its domains primary: its other hostnames (the free
 * subdomain, other domains) then redirect there.
 *
 * Env: PLATFORM_DOMAIN_IPV4 (A record target for apex domains),
 * PLATFORM_DNS_SERVERS (comma-separated resolvers, default: system).
 */

import { randomBytes } from 'crypto';
import { promises as dns } from 'dns';
import { domainToASCII } from 'url';

import { PLATFORM_SCHEMA, getSitesDomain } from './config';
import { getPlatformPool } from './db';
import { syncSiteAnalyticsLater } from './analytics';
import { forgetHostname, forgetPrimaryHost, forgetSiteBadge, normalizeHostname } from './tenants';

export const VERIFICATION_PREFIX = '_ycode-verification';
const VERIFICATION_VALUE_PREFIX = 'ycode-verification=';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface DnsLookup {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
}

export function getDnsResolver(): DnsLookup {
  const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
  const servers = process.env.PLATFORM_DNS_SERVERS?.split(',').map((server) => server.trim()).filter(Boolean);
  if (servers?.length) resolver.setServers(servers);
  return resolver;
}

export class DomainError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Accepts `www.example.com`, `https://Example.com/`, unicode names; returns the ASCII hostname */
export function normalizeCustomHostname(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new DomainError('Enter a domain, e.g. www.example.com');

  const value = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (value.includes(':')) throw new DomainError('Enter the domain without a port');

  const hostname = domainToASCII(value);
  const labels = hostname.split('.');
  if (!hostname || hostname.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new DomainError('This is not a valid domain');
  }
  if (/^\d+$/.test(labels.at(-1)!)) throw new DomainError('Use a domain name, not an IP address');

  const sitesDomain = getSitesDomain();
  if (sitesDomain && (hostname === sitesDomain || hostname.endsWith(`.${sitesDomain}`))) {
    throw new DomainError(`Addresses on ${sitesDomain} are assigned to sites automatically`);
  }
  const builderUrl = process.env.BETTER_AUTH_URL;
  if (builderUrl && hostname === normalizeHostname(new URL(builderUrl).host)) {
    throw new DomainError('This domain is reserved');
  }

  return hostname;
}

/** `example.cz` (no CNAME allowed at the apex) vs `www.example.cz` */
function isApexDomain(hostname: string): boolean {
  return hostname.split('.').length === 2;
}

export interface DnsRecord {
  type: 'TXT' | 'CNAME' | 'A';
  name: string;
  value: string;
  purpose: 'verification' | 'routing';
}

export interface DomainStatus {
  id: string;
  hostname: string;
  verified: boolean;
  verifiedAt: string | null;
  /** The site's other hostnames redirect here */
  primary: boolean;
  /** DNS records the customer should create */
  records: DnsRecord[];
}

interface DomainRow {
  id: string;
  hostname: string;
  verification_token: string;
  verified_at: Date | null;
  is_primary: boolean;
}

function toStatus(row: DomainRow, siteSlug: string): DomainStatus {
  const records: DnsRecord[] = [{
    type: 'TXT',
    name: `${VERIFICATION_PREFIX}.${row.hostname}`,
    value: `${VERIFICATION_VALUE_PREFIX}${row.verification_token}`,
    purpose: 'verification',
  }];

  const sitesDomain = getSitesDomain();
  if (!isApexDomain(row.hostname) && sitesDomain) {
    records.push({ type: 'CNAME', name: row.hostname, value: `${siteSlug}.${sitesDomain}`, purpose: 'routing' });
  } else if (process.env.PLATFORM_DOMAIN_IPV4) {
    records.push({ type: 'A', name: row.hostname, value: process.env.PLATFORM_DOMAIN_IPV4, purpose: 'routing' });
  }

  return {
    id: row.id,
    hostname: row.hostname,
    verified: Boolean(row.verified_at),
    verifiedAt: row.verified_at?.toISOString() ?? null,
    primary: row.is_primary,
    records,
  };
}

export async function listDomains(siteId: string, siteSlug: string): Promise<DomainStatus[]> {
  const { rows } = await getPlatformPool().query<DomainRow>(
    `select id, hostname, verification_token, verified_at, is_primary from ${PLATFORM_SCHEMA}.domains
     where tenant_id = $1 order by created_at`,
    [siteId],
  );
  return rows.map((row) => toStatus(row, siteSlug));
}

export async function addDomain(siteId: string, siteSlug: string, input: unknown): Promise<DomainStatus> {
  const hostname = normalizeCustomHostname(input);
  const pool = getPlatformPool();

  const { rows: taken } = await pool.query(
    `select tenant_id from ${PLATFORM_SCHEMA}.domains where hostname = $1 and verified_at is not null`,
    [hostname],
  );
  if (taken[0]) {
    throw new DomainError(taken[0].tenant_id === siteId ? 'This domain is already added' : 'This domain is used by another site', 409);
  }

  const { rows } = await pool.query<DomainRow>(
    `insert into ${PLATFORM_SCHEMA}.domains (tenant_id, hostname, verification_token) values ($1, $2, $3)
     on conflict (tenant_id, hostname) do nothing
     returning id, hostname, verification_token, verified_at, is_primary`,
    [siteId, hostname, randomBytes(16).toString('hex')],
  );
  if (!rows[0]) throw new DomainError('This domain is already added', 409);
  return toStatus(rows[0], siteSlug);
}

export async function removeDomain(siteId: string, domainId: string): Promise<void> {
  const { rows } = await getPlatformPool().query(
    `delete from ${PLATFORM_SCHEMA}.domains where id = $1 and tenant_id = $2 returning hostname`,
    [domainId, siteId],
  );
  if (!rows[0]) throw new DomainError('Domain not found', 404);
  forgetHostname(rows[0].hostname);
  forgetPrimaryHost(siteId);
  forgetSiteBadge(siteId);
  syncSiteAnalyticsLater(siteId);
}

/**
 * Make a domain the site's primary one, or stop redirecting to it. Only a
 * verified domain whose DNS already points here can become primary: the
 * site's other hostnames start redirecting to it right away.
 */
export async function setPrimaryDomain(
  siteId: string,
  siteSlug: string,
  domainId: string,
  primary: boolean,
  lookup: DnsLookup = getDnsResolver(),
): Promise<DomainStatus> {
  const pool = getPlatformPool();
  const { rows } = await pool.query<DomainRow>(
    `select id, hostname, verification_token, verified_at, is_primary from ${PLATFORM_SCHEMA}.domains where id = $1 and tenant_id = $2`,
    [domainId, siteId],
  );
  if (!rows[0]) throw new DomainError('Domain not found', 404);

  if (primary) {
    const status = toStatus(rows[0], siteSlug);
    if (!status.verified) throw new DomainError('Verify the domain before making it primary');
    if (!await isRoutedHere(lookup, status)) {
      throw new DomainError('The domain does not point to this site yet. Create the DNS record first');
    }
  }

  const client = await pool.connect();
  let updated: DomainRow;
  try {
    await client.query('begin');
    if (primary) {
      await client.query(`update ${PLATFORM_SCHEMA}.domains set is_primary = false where tenant_id = $1 and id <> $2`, [siteId, domainId]);
    }
    const result = await client.query<DomainRow>(
      `update ${PLATFORM_SCHEMA}.domains set is_primary = $2 where id = $1
       returning id, hostname, verification_token, verified_at, is_primary`,
      [domainId, primary],
    );
    await client.query('commit');
    updated = result.rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  forgetPrimaryHost(siteId);
  syncSiteAnalyticsLater(siteId);
  return toStatus(updated, siteSlug);
}

async function lookupTxt(lookup: DnsLookup, name: string): Promise<string[]> {
  try {
    // A TXT record can be split into several strings
    return (await lookup.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
}

/** Whether the domain already resolves to the platform (informational) */
async function isRoutedHere(lookup: DnsLookup, status: DomainStatus): Promise<boolean> {
  const routing = status.records.find((record) => record.purpose === 'routing');
  if (!routing) return false;

  try {
    if (routing.type === 'A') {
      return (await lookup.resolve4(status.hostname)).includes(routing.value);
    }
    const cnames = await lookup.resolveCname(status.hostname).catch(() => [] as string[]);
    if (cnames.some((cname) => normalizeHostname(cname) === routing.value)) return true;
    // Flattened CNAME / ALIAS: compare addresses instead
    const [own, target] = await Promise.all([lookup.resolve4(status.hostname), lookup.resolve4(routing.value)]);
    return own.some((address) => target.includes(address));
  } catch {
    return false;
  }
}

export interface VerificationResult {
  domain: DomainStatus;
  /** The TXT record was found */
  ownershipVerified: boolean;
  /** DNS already points to the platform */
  routed: boolean;
}

export async function verifyDomain(
  siteId: string,
  siteSlug: string,
  domainId: string,
  lookup: DnsLookup = getDnsResolver(),
): Promise<VerificationResult> {
  const pool = getPlatformPool();
  const { rows } = await pool.query<DomainRow>(
    `select id, hostname, verification_token, verified_at, is_primary from ${PLATFORM_SCHEMA}.domains where id = $1 and tenant_id = $2`,
    [domainId, siteId],
  );
  if (!rows[0]) throw new DomainError('Domain not found', 404);
  let row = rows[0];

  const ownershipVerified = row.verified_at !== null
    || (await lookupTxt(lookup, `${VERIFICATION_PREFIX}.${row.hostname}`)).includes(`${VERIFICATION_VALUE_PREFIX}${row.verification_token}`);

  if (ownershipVerified && !row.verified_at) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const { rows: updated } = await client.query<DomainRow>(
        `update ${PLATFORM_SCHEMA}.domains set verified_at = now() where id = $1
         returning id, hostname, verification_token, verified_at, is_primary`,
        [row.id],
      );
      // Pending claims of other sites on this hostname are void now
      await client.query(
        `delete from ${PLATFORM_SCHEMA}.domains where hostname = $1 and id <> $2 and verified_at is null`,
        [row.hostname, row.id],
      );
      await client.query('commit');
      row = updated[0];
    } catch (error) {
      await client.query('rollback');
      // Another site verified it first (unique index on verified hostnames)
      if ((error as { code?: string }).code === '23505') {
        throw new DomainError('This domain is used by another site', 409);
      }
      throw error;
    } finally {
      client.release();
    }
    forgetHostname(row.hostname);
    forgetSiteBadge(siteId);
  }

  const domain = toStatus(row, siteSlug);
  return { domain, ownershipVerified, routed: await isRoutedHere(lookup, domain) };
}

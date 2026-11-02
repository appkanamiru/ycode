'use client';

/**
 * Custom domains of a site: add, see the DNS records to create, verify,
 * make one primary, remove. Shown on /ycode/sites to site owners and admins.
 */

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  addSiteDomain,
  fetchSiteDomains,
  removeSiteDomain,
  setPrimarySiteDomain,
  verifySiteDomain,
  type PlatformDomain,
} from '@/lib/platform/browser-sites';

function verificationMessage(ownershipVerified: boolean, routed: boolean): string {
  if (!ownershipVerified) return 'The TXT record was not found yet. DNS changes can take a while to propagate.';
  if (!routed) return 'Verified. Point the domain to the site with the record below to start serving it.';
  return 'Verified and live.';
}

export default function SiteDomains({ siteId }: { siteId: string }) {
  const [domains, setDomains] = useState<PlatformDomain[] | null>(null);
  const [hostname, setHostname] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const result = await fetchSiteDomains(siteId);
    setDomains(result.data ?? []);
    if (result.error) setError(result.error);
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending('add');
    setError(null);
    const result = await addSiteDomain(siteId, hostname);
    setPending(null);
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    setHostname('');
    await load();
  };

  const verify = async (domain: PlatformDomain) => {
    setPending(domain.id);
    setError(null);
    const result = await verifySiteDomain(siteId, domain.id);
    setPending(null);
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    setMessages((current) => ({
      ...current,
      [domain.id]: verificationMessage(result.data.ownershipVerified, result.data.routed),
    }));
    await load();
  };

  const togglePrimary = async (domain: PlatformDomain) => {
    setPending(domain.id);
    setError(null);
    const result = await setPrimarySiteDomain(siteId, domain.id, !domain.primary);
    setPending(null);
    if (result.error) setError(result.error);
    await load();
  };

  const remove = async (domain: PlatformDomain) => {
    if (!window.confirm(`Remove ${domain.hostname} from this site?`)) return;
    setPending(domain.id);
    const result = await removeSiteDomain(siteId, domain.id);
    setPending(null);
    if (result.error) setError(result.error);
    await load();
  };

  if (!domains) {
    return <div className="py-2"><Spinner /></div>;
  }

  return (
    <div className="flex flex-col gap-4 pt-2">
      {error && <p className="text-xs text-red-400">{error}</p>}

      {domains.map((domain) => (
        <div key={domain.id} className="flex flex-col gap-2 rounded-md border border-white/10 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm truncate">
              {domain.hostname}
              <span className={`ml-2 text-[10px] ${domain.verified ? 'text-green-400' : 'text-amber-400'}`}>
                {domain.verified ? 'verified' : 'pending verification'}
              </span>
              {domain.primary && <span className="ml-2 text-[10px] text-sky-400">primary</span>}
            </div>
            <div className="flex gap-2 shrink-0">
              {domain.verified && (
                <Button
                  size="sm" variant="secondary"
                  onClick={() => togglePrimary(domain)} disabled={pending !== null}
                  title={domain.primary ? undefined : 'Redirect the site\'s other addresses here'}
                >
                  {domain.primary ? 'Unset primary' : 'Make primary'}
                </Button>
              )}
              <Button
                size="sm" variant="secondary"
                onClick={() => verify(domain)} disabled={pending !== null}
              >
                {pending === domain.id ? <Spinner /> : domain.verified ? 'Check DNS' : 'Verify'}
              </Button>
              <Button
                size="sm" variant="ghost"
                onClick={() => remove(domain)} disabled={pending !== null}
              >
                Remove
              </Button>
            </div>
          </div>

          {messages[domain.id] && <p className="text-xs text-white/60">{messages[domain.id]}</p>}
          {domain.primary && (
            <p className="text-xs text-white/60">The site&apos;s other addresses redirect here.</p>
          )}

          <table className="w-full text-[11px] text-white/60">
            <thead>
              <tr className="text-left text-white/40">
                <th className="font-normal pr-2">Type</th>
                <th className="font-normal pr-2">Name</th>
                <th className="font-normal">Value</th>
              </tr>
            </thead>
            <tbody>
              {domain.records
                .filter((record) => !(domain.verified && record.purpose === 'verification'))
                .map((record) => (
                  <tr key={`${record.type}-${record.name}`} className="align-top">
                    <td className="pr-2 py-1">{record.type}</td>
                    <td className="pr-2 py-1 break-all">{record.name}</td>
                    <td className="py-1 break-all">
                      <button
                        type="button" className="text-left hover:text-white"
                        title="Copy" onClick={() => navigator.clipboard?.writeText(record.value)}
                      >
                        {record.value}
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}

      <form onSubmit={add} className="flex gap-2">
        <Input
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="www.example.com"
          disabled={pending !== null}
          required
        />
        <Button
          type="submit" size="sm"
          disabled={pending !== null || !hostname.trim()}
        >
          {pending === 'add' ? <Spinner /> : 'Add domain'}
        </Button>
      </form>
    </div>
  );
}

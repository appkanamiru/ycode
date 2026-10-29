'use client';

/**
 * /ycode/sites (multi-tenant platform)
 *
 * The signed-in user's sites: open one in the editor, or create a new one on
 * a free subdomain, within the account's site limit.
 */

import { useCallback, useEffect, useState } from 'react';

import BuilderLoading from '@/components/BuilderLoading';
import PlatformSignIn from '@/components/platform/PlatformSignIn';
import SiteDomains from '@/components/platform/SiteDomains';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  createPlatformSite,
  fetchPlatformSites,
  openPlatformSite,
  slugifySiteName,
  type PlatformSites,
} from '@/lib/platform/browser-sites';
import { useAuthStore } from '@/stores/useAuthStore';

export default function SitesPage() {
  const user = useAuthStore((state) => state.user);
  const initialized = useAuthStore((state) => state.initialized);
  const signOut = useAuthStore((state) => state.signOut);

  const [data, setData] = useState<PlatformSites | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setData(await fetchPlatformSites());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (!initialized) return <BuilderLoading message="Checking authentication..." />;
  if (!user) return <PlatformSignIn />;
  if (loading) return <BuilderLoading message="Loading sites..." />;

  const open = async (siteSlug: string) => {
    setPending(siteSlug);
    setError(null);
    if (!(await openPlatformSite(siteSlug))) {
      setPending(null);
      setError('Could not open the site');
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending('create');
    setError(null);
    const problem = await createPlatformSite(name.trim(), slug);
    if (problem) {
      setPending(null);
      setError(problem);
      return;
    }
    // The new site is active: go straight to the editor
    window.location.assign('/ycode');
  };

  const sites = data?.sites ?? [];

  return (
    <div className="min-h-screen bg-neutral-950 text-white py-16 px-4">
      <div className="mx-auto w-full max-w-xl flex flex-col gap-10">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-medium">Your sites</h1>
          <div className="flex items-center gap-3 text-xs text-white/50">
            <span>{user.email}</span>
            <button
              type="button" className="hover:text-white/80"
              onClick={() => signOut()}
            >Sign out</button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        )}

        {sites.length > 0 && (
          <ul className="flex flex-col divide-y divide-white/10 rounded-lg border border-white/10">
            {sites.map((site) => (
              <li key={site.id} className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {site.name}
                    {site.active && <span className="ml-2 text-[10px] text-white/50">current</span>}
                  </div>
                  {site.url && (
                    <a
                      href={site.url} target="_blank"
                      rel="noreferrer" className="text-xs text-white/50 hover:text-white/80 truncate block"
                    >
                      {new URL(site.url).host}
                    </a>
                  )}
                  {site.domains.map((domain) => (
                    <div key={domain} className="text-xs text-white/50 truncate">{domain}</div>
                  ))}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[10px] text-white/50 capitalize">{site.role}</span>
                  <Button
                    size="sm" onClick={() => open(site.slug)}
                    disabled={pending !== null}
                  >
                    {pending === site.slug ? <Spinner /> : 'Open editor'}
                  </Button>
                </div>
                </div>
                {(site.role === 'owner' || site.role === 'admin') && (
                  <details>
                    <summary className="cursor-pointer text-xs text-white/50 hover:text-white/80">Domains</summary>
                    <SiteDomains siteId={site.id} />
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}

        {data?.canCreate ? (
          <form onSubmit={create} className="flex flex-col gap-6">
            <h2 className="text-sm font-medium">{sites.length ? 'Create another site' : 'Create your site'}</h2>
            <Field>
              <Label htmlFor="site-name">Name</Label>
              <Input
                id="site-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugEdited) setSlug(slugifySiteName(e.target.value));
                }}
                placeholder="Petr Novák"
                disabled={pending !== null}
                required
              />
            </Field>
            <Field>
              <Label htmlFor="site-slug">Address</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="site-slug"
                  value={slug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                  }}
                  placeholder="petr-novak"
                  disabled={pending !== null}
                  required
                />
                {data.sitesDomain && <span className="text-xs text-white/50 whitespace-nowrap">.{data.sitesDomain}</span>}
              </div>
            </Field>
            <Button
              type="submit" size="sm"
              disabled={pending !== null || !name.trim() || !slug}
            >
              {pending === 'create' ? <Spinner /> : 'Create site'}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-white/50">
            Your account can own {data?.limit ?? 1} {data?.limit === 1 ? 'site' : 'sites'}, and you&apos;ve reached the limit.
          </p>
        )}
      </div>
    </div>
  );
}

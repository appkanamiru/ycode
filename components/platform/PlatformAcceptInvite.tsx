'use client';

/**
 * Accept an invitation to a site (multi-tenant platform). The invitee signs
 * in with the invited email address, then joins the site and opens it.
 */

import { useState } from 'react';

import BuilderLoading from '@/components/BuilderLoading';
import PlatformSignIn from '@/components/platform/PlatformSignIn';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAuthStore } from '@/stores/useAuthStore';

export default function PlatformAcceptInvite({ invitationId }: { invitationId: string }) {
  const user = useAuthStore((state) => state.user);
  const initialized = useAuthStore((state) => state.initialized);
  const signOut = useAuthStore((state) => state.signOut);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!initialized) return <BuilderLoading message="Checking authentication..." />;
  if (!user) return <PlatformSignIn hint="Sign in with the email address the invitation was sent to." />;

  const accept = async () => {
    setPending(true);
    setError(null);
    const response = await fetch('/ycode/api/platform/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitationId }),
    });
    if (response.ok) {
      window.location.assign('/ycode');
      return;
    }
    const result = await response.json().catch(() => null);
    setError(result?.error || 'Could not accept the invitation');
    setPending(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-950 text-white py-10">
      <div className="w-full max-w-sm flex flex-col gap-6">
        <h1 className="text-lg font-medium">You&apos;ve been invited to a site</h1>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        )}

        <Button
          size="sm" onClick={accept}
          disabled={pending}
        >
          {pending ? <Spinner /> : 'Accept invitation'}
        </Button>

        <p className="text-xs text-white/50">
          Signed in as {user.email}.{' '}
          <button
            type="button" className="text-white/80 hover:text-white"
            onClick={() => signOut()}
          >
            Use another account
          </button>
        </p>
      </div>
    </div>
  );
}

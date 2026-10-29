'use client';

/**
 * Passwordless sign in (multi-tenant platform): email -> emailed code.
 * The first sign in with a new email creates the account.
 */

import { useState } from 'react';

import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { platformSendSignInCode, platformSignInWithCode } from '@/lib/platform/browser-auth';
import { useAuthStore } from '@/stores/useAuthStore';

export default function PlatformSignIn({ hint }: { hint?: string }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setPending(true);
    setError(null);
    const problem = await platformSendSignInCode(email.trim());
    setPending(false);
    if (problem) {
      setError(problem);
      return;
    }
    setCodeSent(true);
  };

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const problem = await platformSignInWithCode(email.trim(), code.trim());
    if (problem) {
      setPending(false);
      setError(problem);
      return;
    }
    await useAuthStore.getState().checkSession();
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-950 py-10">
      <div className="w-full max-w-sm animate-in fade-in slide-in-from-bottom-1 duration-700" style={{ animationFillMode: 'both' }}>
        {hint && <p className="mb-6 text-sm text-white/70">{hint}</p>}
        <form onSubmit={codeSent ? signIn : sendCode} className="flex flex-col gap-6">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          )}

          <Field>
            <Label htmlFor="email">Email</Label>
            <Input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={pending || codeSent}
              required
            />
          </Field>

          {codeSent && (
            <Field>
              <Label htmlFor="code">Code from your email</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                disabled={pending}
                required
              />
            </Field>
          )}

          <Button
            type="submit" size="sm"
            disabled={pending}
          >
            {pending ? <Spinner /> : codeSent ? 'Sign in' : 'Email me a sign-in code'}
          </Button>
        </form>

        {codeSent && (
          <div className="mt-4 flex justify-center gap-4 text-xs text-white/50">
            <button
              type="button" className="hover:text-white/80"
              onClick={() => sendCode()} disabled={pending}
            >
              Send a new code
            </button>
            <button
              type="button" className="hover:text-white/80"
              onClick={() => { setCodeSent(false); setCode(''); setError(null); }}
              disabled={pending}
            >
              Use another email
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

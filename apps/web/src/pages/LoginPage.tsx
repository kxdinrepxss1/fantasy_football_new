import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

type Mode = 'login' | 'register' | 'magic';

export default function LoginPage() {
  const { signIn } = useSession();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);

    try {
      if (mode === 'magic') {
        const result = await api.post<{ message: string }>('/api/auth/magic-link', { email });
        setNotice(result.message);
      } else {
        const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
        const result = await api.post<{ token: string }>(path, {
          email,
          password,
          ...(mode === 'register' ? { displayName } : {}),
        });
        await signIn(result.token);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-5">
      <h1 className="mb-1 text-2xl font-bold">Fantasy League</h1>
      <p className="mb-6 text-sm text-slate-400">
        {mode === 'register' ? 'Create your account.' : 'Sign in to your leagues.'}
      </p>

      <form onSubmit={submit} className="space-y-3">
        <input
          className="field"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        {mode === 'register' && (
          <input
            className="field"
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        )}

        {mode !== 'magic' && (
          <input
            className="field"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        )}

        {error && <p className="text-sm text-red-300">{error}</p>}
        {notice && <p className="text-sm text-accent">{notice}</p>}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy
            ? 'Working…'
            : mode === 'login'
              ? 'Sign in'
              : mode === 'register'
                ? 'Create account'
                : 'Email me a link'}
        </button>
      </form>

      <div className="mt-6 space-y-2 text-center text-sm text-slate-400">
        {mode !== 'login' && (
          <button className="underline" onClick={() => setMode('login')}>
            Sign in with a password
          </button>
        )}
        {mode !== 'register' && (
          <button className="block w-full underline" onClick={() => setMode('register')}>
            Create an account
          </button>
        )}
        {mode !== 'magic' && (
          <button className="block w-full underline" onClick={() => setMode('magic')}>
            Email me a sign-in link instead
          </button>
        )}
      </div>
    </div>
  );
}

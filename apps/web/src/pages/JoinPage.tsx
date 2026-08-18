import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, getToken } from '../lib/api';
import { useSession } from '../lib/session';
import { Spinner } from '../components/ui';

/**
 * Invite landing page.
 *
 * An invite link can be opened by somebody who is not signed in yet, so the
 * token is held until they have an account and then redeemed automatically.
 */
export default function JoinPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const { user, refresh } = useSession();

  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token) sessionStorage.setItem('ff.invite', token);
  }, [token]);

  if (!user) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-5 text-center">
        <h1 className="mb-2 text-xl font-bold">You have been invited</h1>
        <p className="mb-6 text-sm text-slate-400">
          Sign in or create an account and you will join the league straight away.
        </p>
        <button className="btn-primary" onClick={() => navigate('/')}>
          Continue
        </button>
      </div>
    );
  }

  const inviteToken = token ?? sessionStorage.getItem('ff.invite');

  if (!inviteToken) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-5 text-center">
        <p className="text-sm text-slate-400">That invite link is missing its token.</p>
        <button className="btn-ghost mt-4" onClick={() => navigate('/')}>
          Back to your leagues
        </button>
      </div>
    );
  }

  async function join() {
    if (!getToken()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ leagueId: string; teamId: string }>('/api/leagues/join', {
        token: inviteToken,
        ...(teamName ? { teamName } : {}),
      });
      sessionStorage.removeItem('ff.invite');
      await refresh();
      navigate(`/leagues/${result.leagueId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join that league');
    } finally {
      setBusy(false);
    }
  }

  if (busy) return <Spinner label="Joining the league" />;

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-5">
      <h1 className="mb-2 text-xl font-bold">Join the league</h1>
      <p className="mb-5 text-sm text-slate-400">Pick a name for your team.</p>

      <input
        className="field mb-3"
        placeholder="Team name (optional)"
        value={teamName}
        onChange={(e) => setTeamName(e.target.value)}
        maxLength={60}
      />

      {error && <p className="mb-3 text-sm text-red-300">{error}</p>}

      <button className="btn-primary" onClick={join}>
        Claim my team
      </button>
    </div>
  );
}

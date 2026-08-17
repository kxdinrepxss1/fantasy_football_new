import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { EmptyNote, SectionTitle } from '../components/ui';

const PRESETS = [
  { id: 'standard', label: 'Standard', hint: 'No points per reception' },
  { id: 'half_ppr', label: 'Half PPR', hint: '0.5 per reception' },
  { id: 'ppr', label: 'Full PPR', hint: '1 per reception' },
  { id: 'superflex', label: 'Superflex', hint: 'Second QB slot — QBs matter a lot more' },
] as const;

export default function LeaguesPage() {
  const { user, leagues, signOut, refresh } = useSession();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [teamCount, setTeamCount] = useState(12);
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('half_ppr');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/leagues', { name, teamCount, preset });
      await refresh();
      setCreating(false);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the league');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Your leagues</h1>
          <p className="text-sm text-slate-400">{user?.email}</p>
        </div>
        <button className="btn-ghost" onClick={signOut}>
          Sign out
        </button>
      </div>

      {leagues.length === 0 && !creating && (
        <EmptyNote>No leagues yet. Create one, or follow an invite link from your commissioner.</EmptyNote>
      )}

      <ul className="space-y-3">
        {leagues.map((league) => (
          <li key={league.id}>
            <Link to={`/leagues/${league.id}`} className="card block hover:border-ink-500">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">{league.name}</span>
                <span className="pill bg-ink-700 text-slate-300">{league.role}</span>
              </div>
              {!league.team_id && (
                <p className="mt-1 text-xs text-amber-300">
                  You run this league but do not own a team in it.
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-6">
        {!creating ? (
          <button className="btn-primary w-full" onClick={() => setCreating(true)}>
            Create a league
          </button>
        ) : (
          <form onSubmit={create} className="card space-y-4">
            <SectionTitle>New league</SectionTitle>

            <input
              className="field"
              placeholder="League name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />

            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">Teams: {teamCount}</span>
              <input
                type="range"
                min={4}
                max={16}
                value={teamCount}
                onChange={(e) => setTeamCount(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </label>

            <fieldset>
              <legend className="mb-2 text-xs text-slate-400">Scoring</legend>
              <div className="grid gap-2">
                {PRESETS.map((option) => (
                  <label
                    key={option.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                      preset === option.id ? 'border-accent-dim bg-accent/5' : 'border-ink-600'
                    }`}
                  >
                    <input
                      type="radio"
                      name="preset"
                      className="mt-1 accent-emerald-500"
                      checked={preset === option.id}
                      onChange={() => setPreset(option.id)}
                    />
                    <span>
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="block text-xs text-slate-400">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <p className="text-xs text-slate-500">
              Every individual stat value can be changed afterwards in league settings.
            </p>

            {error && <p className="text-sm text-red-300">{error}</p>}

            <div className="flex gap-2">
              <button type="submit" className="btn-primary flex-1" disabled={busy}>
                {busy ? 'Creating…' : 'Create'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

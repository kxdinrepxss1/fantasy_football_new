import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Position } from '../lib/api';
import { useAsync } from '../lib/session';
import { EmptyNote, ErrorNote, PositionBadge, SectionTitle, Spinner } from '../components/ui';

interface DraftResponse {
  draft: {
    id: string;
    type: 'snake' | 'auction';
    status: 'scheduled' | 'in_progress' | 'paused' | 'complete';
    rounds: number;
    pick_timer_secs: number;
    current_pick: number;
    secondsRemaining: number | null;
  };
  picks: Array<{
    id: string;
    pick_number: number;
    round: number;
    team_id: string;
    team_name: string;
    player_name: string | null;
    position: Position | null;
    picked_at: string | null;
  }>;
  onTheClock: { team_name: string; pick_number: number; round: number } | null;
}

interface Suggestion {
  playerId: string;
  name: string;
  position: Position;
  positionalRank: number;
  perGame: number;
  value: number;
}

export default function DraftPage() {
  const { leagueId } = useParams();
  const draft = useAsync(() => api.get<DraftResponse>(`/api/draft/league/${leagueId}`), [leagueId]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const suggestions = useAsync(
    () =>
      draft.data
        ? api.get<{ suggestions: Suggestion[] }>(`/api/draft/league/${leagueId}/suggestions`)
        : Promise.resolve(null),
    [leagueId, draft.data?.draft.current_pick],
  );

  // The clock is authoritative on the server; this just ticks the display down
  // between refreshes so it does not sit frozen.
  useEffect(() => {
    setRemaining(draft.data?.draft.secondsRemaining ?? null);
  }, [draft.data]);

  useEffect(() => {
    if (remaining === null || remaining <= 0) return;
    const timer = setInterval(() => setRemaining((r) => (r === null ? null : Math.max(0, r - 1))), 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  async function pick(playerId: string) {
    setBusy(true);
    try {
      await api.post(`/api/draft/league/${leagueId}/pick`, { playerId });
      draft.reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not make that pick');
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    try {
      await api.post(`/api/draft/league/${leagueId}/start`);
      draft.reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not start the draft');
    } finally {
      setBusy(false);
    }
  }

  if (draft.loading) return <Spinner label="Loading draft" />;
  if (draft.error) {
    return (
      <div className="space-y-4">
        <ErrorNote message={draft.error} onRetry={draft.reload} />
        <CreateDraft leagueId={leagueId!} onCreated={draft.reload} />
      </div>
    );
  }
  if (!draft.data) return null;

  const { draft: info, picks, onTheClock } = draft.data;
  const made = picks.filter((p) => p.player_name);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">Draft room</h1>
          <p className="text-sm text-slate-400">
            {info.type} · {info.rounds} rounds · {info.status.replace('_', ' ')}
          </p>
        </div>
        {info.status === 'scheduled' && (
          <button className="btn-primary" onClick={start} disabled={busy}>
            Start
          </button>
        )}
      </div>

      {onTheClock && info.status === 'in_progress' && (
        <div className="card border-accent-dim/50 bg-accent/5">
          <p className="text-xs uppercase tracking-wide text-slate-400">On the clock</p>
          <p className="mt-1 text-lg font-bold">{onTheClock.team_name}</p>
          <p className="text-xs text-slate-400">
            Round {onTheClock.round} · pick {onTheClock.pick_number}
          </p>
          {remaining !== null && (
            <p
              className={`mt-2 text-3xl font-bold tabular-nums ${
                remaining <= 10 ? 'text-red-400' : 'text-accent'
              }`}
            >
              {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
            </p>
          )}
          {remaining === 0 && (
            <p className="mt-1 text-xs text-amber-300">
              Clock expired — anyone can make this pick to keep things moving.
            </p>
          )}
        </div>
      )}

      {info.status === 'in_progress' && (
        <section>
          <SectionTitle>Best available</SectionTitle>
          {suggestions.loading ? (
            <Spinner label="Ranking" />
          ) : (
            <ul className="space-y-1.5">
              {(suggestions.data?.suggestions ?? []).slice(0, 15).map((player) => (
                <li key={player.playerId}>
                  <button
                    className="flex w-full items-center gap-2 rounded-lg border border-ink-700 bg-ink-800/50 px-3 py-2 text-left hover:border-ink-500"
                    onClick={() => pick(player.playerId)}
                    disabled={busy}
                  >
                    <PositionBadge position={player.position} rank={player.positionalRank} />
                    <span className="min-w-0 flex-1 truncate text-sm">{player.name}</span>
                    <span className="text-xs tabular-nums text-slate-400">
                      {player.perGame.toFixed(1)} pts/gm
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {player.value.toFixed(0)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <SectionTitle>Board</SectionTitle>
        {made.length === 0 ? (
          <EmptyNote>No picks yet.</EmptyNote>
        ) : (
          <ul className="space-y-1">
            {[...made].reverse().map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-800/50 px-3 py-1.5 text-sm"
              >
                <span className="w-12 shrink-0 text-[11px] text-slate-500">
                  {p.round}.{String(((p.pick_number - 1) % 100) + 1).padStart(2, '0')}
                </span>
                {p.position && <PositionBadge position={p.position} />}
                <span className="min-w-0 flex-1 truncate">{p.player_name}</span>
                <span className="shrink-0 truncate text-xs text-slate-400">{p.team_name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CreateDraft({ leagueId, onCreated }: { leagueId: string; onCreated: () => void }) {
  const [type, setType] = useState<'snake' | 'auction'>('snake');
  const [timer, setTimer] = useState(90);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await api.post(`/api/draft/league/${leagueId}`, { type, pickTimerSeconds: timer });
      onCreated();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not create the draft');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4">
      <SectionTitle>Set up a draft</SectionTitle>

      <div className="flex gap-2">
        {(['snake', 'auction'] as const).map((option) => (
          <button
            key={option}
            onClick={() => setType(option)}
            className={`btn flex-1 ${
              type === option ? 'bg-accent-dim text-ink-900' : 'border border-ink-600 text-slate-300'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="mb-1 block text-xs text-slate-400">Pick timer: {timer}s</span>
        <input
          type="range"
          min={10}
          max={300}
          step={10}
          value={timer}
          onChange={(e) => setTimer(Number(e.target.value))}
          className="w-full accent-emerald-500"
        />
      </label>

      <button className="btn-primary w-full" onClick={create} disabled={busy}>
        {busy ? 'Creating…' : 'Create draft'}
      </button>
    </div>
  );
}

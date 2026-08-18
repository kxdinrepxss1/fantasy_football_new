import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type RosterPlayer, type TeamResponse } from '../lib/api';
import { useAsync } from '../lib/session';
import {
  ErrorNote,
  InjuryBadge,
  NeedBadge,
  PositionBadge,
  SectionTitle,
  Spinner,
} from '../components/ui';

const BENCH_SLOTS = new Set(['BENCH', 'IR']);

export default function RosterPage() {
  const { teamId } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => api.get<TeamResponse>(`/api/teams/${teamId}`),
    [teamId],
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { starters, bench } = useMemo(() => {
    const players = data?.players ?? [];
    return {
      starters: players.filter((p) => !BENCH_SLOTS.has(p.slot)),
      bench: players.filter((p) => BENCH_SLOTS.has(p.slot)),
    };
  }, [data]);

  /** Apply the optimizer's answer directly — the most-used button on this page. */
  async function applyOptimal() {
    if (!data) return;
    setSaving(true);
    try {
      const assignments = data.lineup.optimal.assignments
        .filter((a) => a.playerId)
        .map((a) => ({ playerId: a.playerId as string, slot: a.slot }));

      const startingIds = new Set(assignments.map((a) => a.playerId));
      for (const player of data.players) {
        if (!startingIds.has(player.id)) {
          assignments.push({ playerId: player.id, slot: player.slot === 'IR' ? 'IR' : 'BENCH' });
        }
      }

      await api.put(`/api/teams/${teamId}/lineup`, { assignments });
      reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not update the lineup');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner label="Loading roster" />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  const leftOnBench = data.lineup.pointsLeftOnBench;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">{data.team.name}</h1>
        <p className="text-sm text-slate-400">
          Projected {data.lineup.currentProjected.toFixed(1)} pts/gm · FAAB ${data.team.faab_remaining}
        </p>
      </div>

      {leftOnBench > 0.05 && (
        <div className="card border-amber-500/40 bg-amber-500/10">
          <p className="text-sm text-amber-200">
            You are leaving <strong>{leftOnBench.toFixed(1)} pts/gm</strong> on your bench.
          </p>
          <button className="btn-primary mt-3" onClick={applyOptimal} disabled={saving}>
            {saving ? 'Setting…' : 'Set optimal lineup'}
          </button>
        </div>
      )}

      <section>
        <SectionTitle>Roster needs</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {data.needs.map((need) => (
            <span key={need.position} className="flex items-center gap-1.5 rounded-lg bg-ink-800 px-2 py-1">
              <span className="text-xs font-semibold">{need.position}</span>
              <span className="text-[11px] text-slate-400">
                {need.depth}/{need.required}
              </span>
              <NeedBadge severity={need.severity} />
            </span>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Starters</SectionTitle>
        <ul className="space-y-1.5">
          {starters.map((player) => (
            <PlayerCard
              key={player.id}
              player={player}
              expanded={expanded === player.id}
              onToggle={() => setExpanded(expanded === player.id ? null : player.id)}
            />
          ))}
        </ul>
      </section>

      <section>
        <SectionTitle>Bench</SectionTitle>
        <ul className="space-y-1.5">
          {bench.map((player) => (
            <PlayerCard
              key={player.id}
              player={player}
              expanded={expanded === player.id}
              onToggle={() => setExpanded(expanded === player.id ? null : player.id)}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function PlayerCard({
  player,
  expanded,
  onToggle,
}: {
  player: RosterPlayer;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="rounded-lg border border-ink-700 bg-ink-800/50">
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <span className="w-12 shrink-0 text-[11px] font-semibold uppercase text-slate-500">
          {player.slot}
        </span>
        <PositionBadge position={player.position} rank={player.positionalRank} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm">{player.name}</span>
            <InjuryBadge status={player.injuryStatus} />
          </span>
          <span className="block text-[11px] text-slate-400">
            {player.nflTeam ?? '—'}
            {player.byeWeek ? ` · bye ${player.byeWeek}` : ''}
            {player.age ? ` · ${player.age}yo` : ''}
          </span>
        </span>
        <span className="text-right">
          <span className="block text-sm font-semibold tabular-nums">
            {player.projectedPerGame.toFixed(1)}
          </span>
          <span className="block text-[11px] text-slate-500">pts/gm</span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-ink-700 px-3 py-2.5">
          <p className="mb-1.5 text-xs text-slate-400">
            Value {player.value.toFixed(0)} · {player.score.toFixed(0)}/100 in this league
          </p>
          <ul className="space-y-1 text-xs text-slate-300">
            {player.reasons.map((reason, i) => (
              <li key={i}>— {reason}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

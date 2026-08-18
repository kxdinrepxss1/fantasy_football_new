import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/session';
import { EmptyNote, ErrorNote, PositionBadge, Spinner } from '../components/ui';

interface ScoredPlayer {
  playerId: string;
  name: string;
  position: 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST';
  slot: string;
  points: number;
  starting: boolean;
  hasStats: boolean;
}

interface ScoredTeam {
  teamId: string;
  teamName: string;
  total: number;
  benchTotal: number;
  players: ScoredPlayer[];
}

interface ScoreboardResponse {
  week: number;
  currentWeek: number;
  matchups: Array<{
    id: string;
    week: number;
    final: boolean;
    home: ScoredTeam | null;
    away: ScoredTeam | null;
  }>;
}

export default function ScoreboardPage() {
  const { leagueId } = useParams();
  const [week, setWeek] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const { data, error, loading, reload } = useAsync(
    () =>
      api.get<ScoreboardResponse>(
        `/api/matchups/league/${leagueId}${week ? `?week=${week}` : ''}`,
      ),
    [leagueId, week],
  );

  if (loading) return <Spinner label="Loading scores" />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  const shown = week ?? data.week;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold">Week {shown}</h1>
        <div className="flex gap-2">
          <button
            className="btn-ghost px-3"
            onClick={() => setWeek(Math.max(1, shown - 1))}
            disabled={shown <= 1}
          >
            ←
          </button>
          <button
            className="btn-ghost px-3"
            onClick={() => setWeek(Math.min(18, shown + 1))}
            disabled={shown >= 18}
          >
            →
          </button>
        </div>
      </div>

      {data.matchups.length === 0 ? (
        <EmptyNote>No matchups scheduled for this week yet.</EmptyNote>
      ) : (
        <ul className="space-y-3">
          {data.matchups.map((matchup) => {
            const isOpen = open === matchup.id;
            const homeWon = (matchup.home?.total ?? 0) > (matchup.away?.total ?? 0);

            return (
              <li key={matchup.id} className="card p-0">
                <button
                  className="w-full px-4 py-3 text-left"
                  onClick={() => setOpen(isOpen ? null : matchup.id)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className={`truncate text-sm ${homeWon ? 'font-semibold' : ''}`}>
                      {matchup.home?.teamName ?? 'TBD'}
                    </span>
                    <span className="shrink-0 text-sm font-bold tabular-nums">
                      {(matchup.home?.total ?? 0).toFixed(1)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <span className={`truncate text-sm ${!homeWon ? 'font-semibold' : ''}`}>
                      {matchup.away?.teamName ?? 'TBD'}
                    </span>
                    <span className="shrink-0 text-sm font-bold tabular-nums">
                      {(matchup.away?.total ?? 0).toFixed(1)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-500">
                    {matchup.final ? 'Final' : 'In progress'} · tap for the box score
                  </p>
                </button>

                {isOpen && (
                  <div className="grid gap-4 border-t border-ink-700 p-4 sm:grid-cols-2">
                    <BoxScore team={matchup.home} />
                    <BoxScore team={matchup.away} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BoxScore({ team }: { team: ScoredTeam | null }) {
  if (!team) return null;
  const starters = team.players.filter((p) => p.starting);

  return (
    <div>
      <p className="mb-2 truncate text-xs font-semibold uppercase tracking-wide text-slate-400">
        {team.teamName}
      </p>
      <ul className="space-y-1">
        {starters.map((player) => (
          <li key={player.playerId} className="flex items-center gap-2 text-sm">
            <span className="w-10 shrink-0 text-[10px] uppercase text-slate-500">{player.slot}</span>
            <PositionBadge position={player.position} />
            <span className="min-w-0 flex-1 truncate">{player.name}</span>
            <span
              className={`shrink-0 tabular-nums ${player.hasStats ? '' : 'text-slate-500'}`}
            >
              {player.hasStats ? player.points.toFixed(1) : '—'}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-slate-500">Bench {team.benchTotal.toFixed(1)}</p>
    </div>
  );
}

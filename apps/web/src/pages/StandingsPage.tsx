import { useParams } from 'react-router-dom';
import { api, type PowerRankingRow, type StandingRow } from '../lib/api';
import { useAsync } from '../lib/session';
import { ErrorNote, SectionTitle, Spinner } from '../components/ui';

interface BracketMatchup {
  round: number;
  slot: number;
  highSeed: number | null;
  lowSeed: number | null;
  bye: boolean;
}

interface StandingsResponse {
  standings: StandingRow[];
  powerRankings: PowerRankingRow[];
  bracket: BracketMatchup[];
  playoffSchedule: Array<{ round: number; weeks: number[] }>;
}

export default function StandingsPage() {
  const { leagueId } = useParams();
  const { data, error, loading, reload } = useAsync(
    () => api.get<StandingsResponse>(`/api/leagues/${leagueId}/standings`),
    [leagueId],
  );

  if (loading) return <Spinner label="Loading standings" />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  const playoffTeams = data.bracket.length
    ? Math.max(...data.bracket.flatMap((b) => [b.highSeed ?? 0, b.lowSeed ?? 0]))
    : 0;

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>Standings</SectionTitle>
        <div className="scroll-x">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="py-1.5 pr-2">#</th>
                <th className="py-1.5 pr-2">Team</th>
                <th className="py-1.5 pr-2 text-right">W-L</th>
                <th className="py-1.5 pr-2 text-right">PF</th>
                <th className="py-1.5 pr-2 text-right">PA</th>
                <th className="py-1.5 text-right">Strk</th>
              </tr>
            </thead>
            <tbody>
              {data.standings.map((row) => (
                <tr
                  key={row.teamId}
                  className={`border-t border-ink-700 ${
                    // A line under the last playoff spot is the thing everyone
                    // actually looks for in a standings table.
                    row.seed === playoffTeams ? 'border-b-2 border-b-accent-dim' : ''
                  }`}
                >
                  <td className="py-2 pr-2 text-slate-500">{row.seed}</td>
                  <td className="py-2 pr-2">
                    <span className="block max-w-[10rem] truncate">{row.teamName}</span>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {row.wins}-{row.losses}
                    {row.ties ? `-${row.ties}` : ''}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{row.pointsFor.toFixed(0)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-slate-400">
                    {row.pointsAgainst.toFixed(0)}
                  </td>
                  <td className="py-2 text-right text-slate-400">{row.streak}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {playoffTeams > 0 && (
          <p className="mt-2 text-[11px] text-slate-500">
            Line marks the last playoff spot ({playoffTeams} make it).
          </p>
        )}
      </section>

      <section>
        <SectionTitle>Power rankings</SectionTitle>
        <ul className="space-y-2">
          {data.powerRankings.map((row) => (
            <li key={row.teamId} className="card">
              <div className="flex items-center gap-2">
                <span className="w-5 text-sm font-bold text-slate-500">{row.rank}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{row.teamName}</span>
                <span className="text-xs text-slate-400">{row.record}</span>
                <span className="pill bg-ink-700 text-slate-300">{row.power.toFixed(0)}</span>
              </div>
              <p className="mt-1.5 text-xs text-slate-400">{row.blurb}</p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <SectionTitle>Playoff bracket</SectionTitle>
        <ul className="space-y-1.5">
          {data.bracket
            .filter((b) => b.round === 1)
            .map((b) => (
              <li
                key={`${b.round}-${b.slot}`}
                className="rounded-lg border border-ink-700 bg-ink-800/50 px-3 py-2 text-sm"
              >
                {b.bye ? (
                  <span>
                    Seed {b.highSeed} — <span className="text-accent">first-round bye</span>
                  </span>
                ) : (
                  <span>
                    Seed {b.highSeed} vs seed {b.lowSeed}
                  </span>
                )}
              </li>
            ))}
        </ul>
        <p className="mt-2 text-[11px] text-slate-500">
          {data.playoffSchedule
            .map((r) => `Round ${r.round}: week ${r.weeks.join(' & ')}`)
            .join(' · ')}
        </p>
      </section>
    </div>
  );
}

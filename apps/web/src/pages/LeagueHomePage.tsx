import { Link, useParams } from 'react-router-dom';
import { api, type PowerRankingRow, type StandingRow } from '../lib/api';
import { useAsync, useSession } from '../lib/session';
import { ErrorNote, SectionTitle, Spinner } from '../components/ui';

interface LeagueResponse {
  league: { id: string; name: string; season: number; current_week: number; status: string };
  myTeamId: string | null;
  isCommissioner: boolean;
  teams: Array<{ id: string; name: string; owner: { display_name: string } | null }>;
}

interface RecapResponse {
  week: number;
  played: boolean;
  message?: string;
  standings?: StandingRow[];
  powerRankings?: PowerRankingRow[];
  highlights?: {
    highScore: { team: string; points: number };
    lowScore: { team: string; points: number };
    blowout: { winner: string; loser: string; margin: number };
    closest: { teams: string[]; margin: number };
    unluckiest: { team: string; points: number; lostTo: string; opponentPoints: number } | null;
  };
}

const LINKS = [
  { to: 'standings', label: 'Standings & playoffs', icon: '🏆' },
  { to: 'values', label: 'Player values', icon: '📈' },
  { to: 'draft', label: 'Draft room', icon: '🎯' },
  { to: 'news', label: 'News & injuries', icon: '📰' },
  { to: 'settings', label: 'League settings', icon: '⚙️' },
];

export default function LeagueHomePage() {
  const { leagueId } = useParams();
  const { leagues } = useSession();
  const myTeamId = leagues.find((l) => l.id === leagueId)?.team_id ?? null;

  const league = useAsync(() => api.get<LeagueResponse>(`/api/leagues/${leagueId}`), [leagueId]);
  const recap = useAsync(
    () => api.get<RecapResponse>(`/api/matchups/league/${leagueId}/recap`),
    [leagueId],
  );

  if (league.loading) return <Spinner label="Loading league" />;
  if (league.error) return <ErrorNote message={league.error} onRetry={league.reload} />;
  if (!league.data) return null;

  const { league: info, teams } = league.data;
  const highlights = recap.data?.played ? recap.data.highlights : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">{info.name}</h1>
        <p className="text-sm text-slate-400">
          {info.season} · week {info.current_week} · {teams.length} teams · {info.status.replace('_', ' ')}
        </p>
      </div>

      {myTeamId && (
        <Link
          to={`/leagues/${leagueId}/teams/${myTeamId}`}
          className="card block border-accent-dim/40 hover:border-accent-dim"
        >
          <p className="text-xs uppercase tracking-wide text-slate-400">Your team</p>
          <p className="mt-1 font-semibold">
            {teams.find((t) => t.id === myTeamId)?.name ?? 'My team'}
          </p>
          <p className="mt-1 text-xs text-slate-400">Set your lineup and check roster needs →</p>
        </Link>
      )}

      {highlights && (
        <section>
          <SectionTitle>Week {recap.data?.week} recap</SectionTitle>
          <div className="card space-y-2 text-sm">
            <p>
              <span className="text-slate-400">Top score:</span>{' '}
              <strong>{highlights.highScore.team}</strong> with{' '}
              {highlights.highScore.points.toFixed(1)}
            </p>
            <p>
              <span className="text-slate-400">Biggest blowout:</span>{' '}
              <strong>{highlights.blowout.winner}</strong> over {highlights.blowout.loser} by{' '}
              {highlights.blowout.margin.toFixed(1)}
            </p>
            <p>
              <span className="text-slate-400">Closest game:</span>{' '}
              {highlights.closest.teams.join(' vs ')} by {highlights.closest.margin.toFixed(1)}
            </p>
            {highlights.unluckiest && (
              <p>
                <span className="text-slate-400">Unluckiest:</span>{' '}
                <strong>{highlights.unluckiest.team}</strong> scored{' '}
                {highlights.unluckiest.points.toFixed(1)} and still lost to{' '}
                {highlights.unluckiest.lostTo}
              </p>
            )}
            <p>
              <span className="text-slate-400">Quietest week:</span> {highlights.lowScore.team} with{' '}
              {highlights.lowScore.points.toFixed(1)}
            </p>
          </div>
        </section>
      )}

      {recap.data && !recap.data.played && (
        <p className="text-sm text-slate-400">{recap.data.message}</p>
      )}

      <section>
        <SectionTitle>League</SectionTitle>
        <ul className="space-y-2">
          {LINKS.map((link) => (
            <li key={link.to}>
              <Link
                to={`/leagues/${leagueId}/${link.to}`}
                className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-800/50 px-4 py-3 hover:border-ink-500"
              >
                <span aria-hidden>{link.icon}</span>
                <span className="flex-1 text-sm">{link.label}</span>
                <span aria-hidden className="text-slate-500">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <SectionTitle>Teams</SectionTitle>
        <ul className="space-y-1.5">
          {teams.map((team) => (
            <li key={team.id}>
              <Link
                to={`/leagues/${leagueId}/teams/${team.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-ink-700 bg-ink-800/50 px-3 py-2 hover:border-ink-500"
              >
                <span className="truncate text-sm">{team.name}</span>
                <span className="shrink-0 text-xs text-slate-400">
                  {team.owner?.display_name ?? 'unclaimed'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Position, type WaiverRecommendation } from '../lib/api';
import { useAsync, useSession } from '../lib/session';
import { EmptyNote, ErrorNote, PositionBadge, SectionTitle, Spinner, Tabs } from '../components/ui';

interface WaiverResponse {
  recommendations: WaiverRecommendation[];
  trending: Array<{ playerId: string; name: string; position: Position; delta: number }>;
  suggestedDrop: { playerId: string; name: string; position: string; reason: string } | null;
}

const FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;

export default function WaiversPage() {
  const { leagueId } = useParams();
  const { leagues } = useSession();
  const teamId = leagues.find((l) => l.id === leagueId)?.team_id ?? null;
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');

  const { data, error, loading, reload } = useAsync(
    () =>
      teamId
        ? api.get<WaiverResponse>(
            `/api/waivers/team/${teamId}?limit=20${filter === 'ALL' ? '' : `&position=${filter}`}`,
          )
        : Promise.resolve(null),
    [teamId, filter],
  );

  if (!teamId) return <EmptyNote>You do not own a team in this league.</EmptyNote>;
  if (loading) return <Spinner label="Ranking the wire" />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Waiver wire</h1>
        <p className="text-sm text-slate-400">
          Ranked by what each add is worth to your roster, not by raw player quality.
        </p>
      </div>

      <Tabs options={FILTERS} value={filter} onChange={setFilter} />

      {data.suggestedDrop && (
        <div className="card border-ink-600">
          <p className="text-xs uppercase tracking-wide text-slate-400">Safest drop</p>
          <p className="mt-1 text-sm font-semibold">
            {data.suggestedDrop.name}{' '}
            <span className="text-slate-400">({data.suggestedDrop.position})</span>
          </p>
          <p className="mt-1 text-xs text-slate-400">{data.suggestedDrop.reason}</p>
        </div>
      )}

      <section>
        <SectionTitle>Recommended adds</SectionTitle>
        {data.recommendations.length === 0 ? (
          <EmptyNote>Nothing available at this position.</EmptyNote>
        ) : (
          <ul className="space-y-2">
            {data.recommendations.map((rec, i) => (
              <RecommendationCard key={rec.playerId} rec={rec} index={i} teamId={teamId} onDone={reload} />
            ))}
          </ul>
        )}
      </section>

      {data.trending.length > 0 && (
        <section>
          <SectionTitle>Trending across fantasy</SectionTitle>
          <ul className="space-y-1.5">
            {data.trending.map((player) => (
              <li
                key={player.playerId}
                className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-800/50 px-3 py-2"
              >
                <PositionBadge position={player.position} />
                <span className="flex-1 truncate text-sm">{player.name}</span>
                <span className="pill bg-accent/15 text-accent">+{player.delta.toFixed(0)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RecommendationCard({
  rec,
  index,
  teamId,
  onDone,
}: {
  rec: WaiverRecommendation;
  index: number;
  teamId: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function claim() {
    setBusy(true);
    try {
      await api.post(`/api/teams/${teamId}/transactions`, {
        addPlayerId: rec.playerId,
        dropPlayerId: rec.dropCandidate?.playerId,
      });
      onDone();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not add that player');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card">
      <div className="flex items-start gap-2">
        <span className="w-5 shrink-0 pt-0.5 text-xs font-bold text-slate-500">{index + 1}</span>
        <PositionBadge position={rec.position} rank={rec.positionalRank} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{rec.name}</span>
            {rec.trending && <span className="pill bg-accent/15 text-accent">trending</span>}
            {rec.opportunity && <span className="pill bg-amber-500/20 text-amber-300">opportunity</span>}
          </div>
          <p className="text-[11px] text-slate-400">
            {rec.perGame.toFixed(1)} pts/gm
            {rec.lineupGain > 0 && ` · +${rec.lineupGain.toFixed(1)} to your lineup`}
          </p>
        </div>
      </div>

      <ul className="mt-2 space-y-1 text-xs text-slate-300">
        {rec.reasons.map((reason, i) => (
          <li key={i}>— {reason}</li>
        ))}
      </ul>

      {rec.dropCandidate && (
        <p className="mt-2 text-[11px] text-slate-400">
          Would drop <strong className="text-slate-300">{rec.dropCandidate.name}</strong>
        </p>
      )}

      <button className="btn-ghost mt-3 w-full" onClick={claim} disabled={busy}>
        {busy ? 'Adding…' : rec.dropCandidate ? 'Add and drop' : 'Add'}
      </button>
    </li>
  );
}

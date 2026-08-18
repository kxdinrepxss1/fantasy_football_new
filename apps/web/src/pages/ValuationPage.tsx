import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Position } from '../lib/api';
import { useAsync } from '../lib/session';
import { EmptyNote, ErrorNote, PositionBadge, SectionTitle, Spinner, Tabs } from '../components/ui';

interface ValuedPlayer {
  playerId: string;
  name: string;
  position: Position;
  perGame: number;
  positionalRank: number;
  vorpPerGame: number;
  value: number;
  score: number;
  ageMultiplier: number;
  scarcityMultiplier: number;
  reasons: string[];
  ownedBy: string | null;
}

interface VerificationIssue {
  check: string;
  severity: 'error' | 'warning';
  message: string;
}

interface VerificationReport {
  ok: boolean;
  checkedAt: string;
  poolSize: number;
  errors: VerificationIssue[];
  warnings: VerificationIssue[];
  positionSummary: Array<{
    position: Position;
    count: number;
    starterDemand: number;
    replacementPerGame: number;
    topValue: number;
    medianValue: number;
  }>;
}

interface DriftEntry {
  playerId: string;
  name: string;
  position: Position;
  previousValue: number;
  currentValue: number;
  changePct: number;
  rankChange: number;
}

interface RunRow {
  id: string;
  week: number;
  ok: boolean;
  player_count: number;
  created_at: string;
  drift: {
    significant: DriftEntry[];
    suspicious: DriftEntry[];
    medianAbsChangePct: number;
    added: Array<{ name: string }>;
    removed: Array<{ name: string }>;
  } | null;
}

const FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;

/**
 * Player values, plus the health of the valuation itself.
 *
 * The second half of this page is the answer to "can I trust these numbers?" —
 * the invariant checks that run after every data refresh, and what moved since
 * the last one.
 */
export default function ValuationPage() {
  const { leagueId } = useParams();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [snapshotting, setSnapshotting] = useState(false);

  const values = useAsync(
    () =>
      api.get<{ values: ValuedPlayer[]; total: number }>(
        `/api/valuation/league/${leagueId}?limit=60${filter === 'ALL' ? '' : `&position=${filter}`}`,
      ),
    [leagueId, filter],
  );

  const verify = useAsync(
    () => api.get<{ report: VerificationReport }>(`/api/valuation/league/${leagueId}/verify`),
    [leagueId],
  );

  const runs = useAsync(
    () => api.get<{ runs: RunRow[] }>(`/api/valuation/league/${leagueId}/runs`),
    [leagueId],
  );

  async function snapshot() {
    setSnapshotting(true);
    try {
      await api.post(`/api/valuation/league/${leagueId}/snapshot`);
      runs.reload();
      verify.reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not take a snapshot');
    } finally {
      setSnapshotting(false);
    }
  }

  const report = verify.data?.report;
  const latestDrift = runs.data?.runs.find((r) => r.drift)?.drift ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold">Player values</h1>
        <p className="text-sm text-slate-400">
          Computed for this league's scoring and roster settings, not a generic ranking.
        </p>
      </div>

      <Tabs options={FILTERS} value={filter} onChange={setFilter} />

      {values.loading ? (
        <Spinner label="Valuing players" />
      ) : values.error ? (
        <ErrorNote message={values.error} onRetry={values.reload} />
      ) : (
        <ul className="space-y-1.5">
          {(values.data?.values ?? []).map((player, i) => (
            <li
              key={player.playerId}
              className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-800/50 px-3 py-2"
            >
              <span className="w-5 shrink-0 text-xs text-slate-500">{i + 1}</span>
              <PositionBadge position={player.position} rank={player.positionalRank} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{player.name}</span>
                <span className="block text-[11px] text-slate-400">
                  {player.perGame.toFixed(1)} pts/gm · {player.vorpPerGame >= 0 ? '+' : ''}
                  {player.vorpPerGame.toFixed(1)} over replacement
                  {player.ownedBy ? '' : ' · free agent'}
                </span>
              </span>
              <span className="text-right">
                <span className="block text-sm font-semibold tabular-nums">
                  {player.value.toFixed(0)}
                </span>
                <span className="block text-[11px] text-slate-500">
                  {player.score.toFixed(0)}/100
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <section>
        <SectionTitle
          action={
            <button className="btn-ghost h-8 min-h-0 px-3 text-xs" onClick={snapshot} disabled={snapshotting}>
              {snapshotting ? 'Saving…' : 'Take snapshot'}
            </button>
          }
        >
          Valuation health
        </SectionTitle>

        {verify.loading ? (
          <Spinner label="Checking" />
        ) : report ? (
          <div className={`card ${report.ok ? 'border-accent-dim/40' : 'border-red-500/50'}`}>
            <p className="text-sm font-semibold">
              {report.ok ? '✅ All checks passed' : '❌ Checks failed'}
              <span className="ml-2 font-normal text-slate-400">
                {report.poolSize} players valued
              </span>
            </p>

            {report.errors.map((issue, i) => (
              <p key={i} className="mt-2 text-xs text-red-300">
                <strong>{issue.check}:</strong> {issue.message}
              </p>
            ))}
            {report.warnings.map((issue, i) => (
              <p key={i} className="mt-2 text-xs text-amber-300">
                <strong>{issue.check}:</strong> {issue.message}
              </p>
            ))}

            <div className="scroll-x mt-3">
              <table className="w-full min-w-[380px] text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500">
                    <th className="py-1 pr-2">Pos</th>
                    <th className="py-1 pr-2 text-right">Pool</th>
                    <th className="py-1 pr-2 text-right">Starters</th>
                    <th className="py-1 pr-2 text-right">Replacement</th>
                    <th className="py-1 text-right">Top value</th>
                  </tr>
                </thead>
                <tbody>
                  {report.positionSummary.map((row) => (
                    <tr key={row.position} className="border-t border-ink-700">
                      <td className="py-1.5 pr-2 font-semibold">{row.position}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{row.count}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{row.starterDemand}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {row.replacementPerGame.toFixed(1)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{row.topValue.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-2 text-[11px] text-slate-500">
              Checked {new Date(report.checkedAt).toLocaleString()}
            </p>
          </div>
        ) : (
          verify.error && <ErrorNote message={verify.error} onRetry={verify.reload} />
        )}
      </section>

      <section>
        <SectionTitle>What moved since the last refresh</SectionTitle>
        {!latestDrift ? (
          <EmptyNote>
            Take a snapshot to start tracking movement. Each one is compared against the previous.
          </EmptyNote>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              Median move {latestDrift.medianAbsChangePct.toFixed(1)}% · {latestDrift.added.length}{' '}
              added · {latestDrift.removed.length} removed
            </p>

            {latestDrift.suspicious.length > 0 && (
              <div className="card border-red-500/40 bg-red-500/5">
                <p className="mb-2 text-xs font-semibold text-red-300">
                  Worth investigating — moves this large usually mean a data problem
                </p>
                <ul className="space-y-1 text-xs">
                  {latestDrift.suspicious.map((entry) => (
                    <li key={entry.playerId} className="flex justify-between gap-2">
                      <span className="truncate">{entry.name}</span>
                      <span className="tabular-nums text-red-300">
                        {entry.changePct > 0 ? '+' : ''}
                        {entry.changePct.toFixed(0)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {latestDrift.significant.length > 0 && (
              <div className="card">
                <p className="mb-2 text-xs font-semibold text-slate-300">Biggest movers</p>
                <ul className="space-y-1 text-xs">
                  {latestDrift.significant.slice(0, 12).map((entry) => (
                    <li key={entry.playerId} className="flex justify-between gap-2">
                      <span className="truncate">
                        {entry.name}{' '}
                        <span className="text-slate-500">
                          {entry.position}
                          {entry.rankChange !== 0 &&
                            ` ${entry.rankChange > 0 ? '↑' : '↓'}${Math.abs(entry.rankChange)}`}
                        </span>
                      </span>
                      <span
                        className={`tabular-nums ${entry.changePct > 0 ? 'text-accent' : 'text-red-300'}`}
                      >
                        {entry.changePct > 0 ? '+' : ''}
                        {entry.changePct.toFixed(0)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

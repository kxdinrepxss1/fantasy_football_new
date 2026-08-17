import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  api,
  type RosterPlayer,
  type TeamResponse,
  type TradeEvaluation,
  type TradeSideResult,
} from '../lib/api';
import { useAsync, useSession } from '../lib/session';
import { ErrorNote, PositionBadge, SectionTitle, Spinner, formatSigned } from '../components/ui';

interface LeagueResponse {
  league: { id: string; name: string };
  myTeamId: string | null;
  teams: Array<{ id: string; name: string }>;
}

/**
 * The trade calculator.
 *
 * Both rosters are shown side by side; tapping a player moves him into the
 * deal. The evaluation re-runs on every change, so the verdict updates as the
 * package is built rather than only when it is submitted.
 */
export default function TradePage() {
  const { leagueId } = useParams();
  const { leagues } = useSession();
  const myTeamId = leagues.find((l) => l.id === leagueId)?.team_id ?? null;

  const league = useAsync(() => api.get<LeagueResponse>(`/api/leagues/${leagueId}`), [leagueId]);

  const [teamAId, setTeamAId] = useState<string | null>(null);
  const [teamBId, setTeamBId] = useState<string | null>(null);
  const [aSends, setASends] = useState<string[]>([]);
  const [bSends, setBSends] = useState<string[]>([]);

  // Default to "my team versus the next one along", which is the most common
  // starting point for talking yourself into a deal.
  useEffect(() => {
    if (!league.data) return;
    const teams = league.data.teams;
    const mine = myTeamId ?? teams[0]?.id ?? null;
    setTeamAId((prev) => prev ?? mine);
    setTeamBId((prev) => prev ?? teams.find((t) => t.id !== mine)?.id ?? null);
  }, [league.data, myTeamId]);

  const rosterA = useAsync(
    () => (teamAId ? api.get<TeamResponse>(`/api/teams/${teamAId}`) : Promise.resolve(null)),
    [teamAId],
  );
  const rosterB = useAsync(
    () => (teamBId ? api.get<TeamResponse>(`/api/teams/${teamBId}`) : Promise.resolve(null)),
    [teamBId],
  );

  const [evaluation, setEvaluation] = useState<TradeEvaluation | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  useEffect(() => {
    if (!teamAId || !teamBId || (aSends.length === 0 && bSends.length === 0)) {
      setEvaluation(null);
      setEvalError(null);
      return;
    }

    let cancelled = false;
    setEvaluating(true);

    api
      .post<{ evaluation: TradeEvaluation }>('/api/trades/evaluate', {
        leagueId,
        teamAId,
        teamBId,
        teamASends: aSends,
        teamBSends: bSends,
      })
      .then((result) => {
        if (!cancelled) {
          setEvaluation(result.evaluation);
          setEvalError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setEvalError(err instanceof Error ? err.message : 'Could not evaluate');
      })
      .finally(() => {
        if (!cancelled) setEvaluating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [leagueId, teamAId, teamBId, aSends, bSends]);

  function toggle(side: 'a' | 'b', playerId: string) {
    const [list, set] = side === 'a' ? [aSends, setASends] : [bSends, setBSends];
    set(list.includes(playerId) ? list.filter((id) => id !== playerId) : [...list, playerId]);
  }

  if (league.loading) return <Spinner label="Loading league" />;
  if (league.error) return <ErrorNote message={league.error} onRetry={league.reload} />;

  const teams = league.data?.teams ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Trade calculator</h1>
        <p className="text-sm text-slate-400">
          Tap players to build a deal. Values account for age, positional scarcity in this league,
          and what each roster actually needs.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <TeamPicker
          label="Team A"
          teams={teams}
          value={teamAId}
          exclude={teamBId}
          onChange={(id) => {
            setTeamAId(id);
            setASends([]);
          }}
        />
        <TeamPicker
          label="Team B"
          teams={teams}
          value={teamBId}
          exclude={teamAId}
          onChange={(id) => {
            setTeamBId(id);
            setBSends([]);
          }}
        />
      </div>

      {evalError && <ErrorNote message={evalError} />}

      {evaluation && <Verdict evaluation={evaluation} pending={evaluating} />}

      {!evaluation && !evaluating && (
        <p className="rounded-lg border border-dashed border-ink-600 p-4 text-center text-sm text-slate-400">
          Pick at least one player to see a verdict.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <RosterColumn
          title={rosterA.data?.team.name ?? 'Team A'}
          roster={rosterA.data}
          loading={rosterA.loading}
          selected={aSends}
          onToggle={(id) => toggle('a', id)}
        />
        <RosterColumn
          title={rosterB.data?.team.name ?? 'Team B'}
          roster={rosterB.data}
          loading={rosterB.loading}
          selected={bSends}
          onToggle={(id) => toggle('b', id)}
        />
      </div>
    </div>
  );
}

function TeamPicker({
  label,
  teams,
  value,
  exclude,
  onChange,
}: {
  label: string;
  teams: Array<{ id: string; name: string }>;
  value: string | null;
  exclude: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-slate-400">{label}</span>
      <select className="field" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {teams
          .filter((team) => team.id !== exclude)
          .map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
      </select>
    </label>
  );
}

const VERDICT_STYLES: Record<string, string> = {
  even: 'border-accent-dim bg-accent/10',
  slight: 'border-amber-500/50 bg-amber-500/10',
  clear: 'border-orange-500/50 bg-orange-500/10',
  lopsided: 'border-red-500/50 bg-red-500/10',
};

function Verdict({ evaluation, pending }: { evaluation: TradeEvaluation; pending: boolean }) {
  const headline =
    evaluation.verdict === 'fair'
      ? 'Fair deal'
      : `Favors ${evaluation.verdict === 'favors_a' ? evaluation.a.teamName : evaluation.b.teamName}`;

  return (
    <div
      className={`card ${VERDICT_STYLES[evaluation.magnitudeLabel] ?? ''} ${
        pending ? 'opacity-60' : ''
      }`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-base font-bold">{headline}</span>
        <span className="pill bg-ink-900/60 text-slate-200">
          {evaluation.magnitudeLabel} · {evaluation.magnitudePct.toFixed(1)}%
        </span>
      </div>

      {evaluation.winWin && (
        <p className="mb-3 rounded-lg bg-accent/15 px-3 py-2 text-xs text-accent">
          Both rosters improve once needs are counted — worth doing even if one side wins on paper.
        </p>
      )}

      <div className="mb-3 grid grid-cols-2 gap-3">
        <SideSummary side={evaluation.a} />
        <SideSummary side={evaluation.b} />
      </div>

      <ul className="space-y-1.5 text-sm text-slate-300">
        {evaluation.explanation.map((line, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="text-slate-500">
              •
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SideSummary({ side }: { side: TradeSideResult }) {
  return (
    <div className="rounded-lg bg-ink-900/50 p-3">
      <p className="truncate text-xs font-semibold text-slate-300">{side.teamName}</p>
      <p className="mt-1 text-lg font-bold tabular-nums">
        <span className={side.netRaw >= 0 ? 'text-accent' : 'text-red-300'}>
          {formatSigned(side.netRaw, 0)}
        </span>
      </p>
      <p className="text-[11px] text-slate-400">value</p>
      <p className="mt-1 text-[11px] text-slate-400">
        lineup {formatSigned(side.startingLineupSwing)} pts/gm
      </p>
    </div>
  );
}

function RosterColumn({
  title,
  roster,
  loading,
  selected,
  onToggle,
}: {
  title: string;
  roster: TeamResponse | null;
  loading: boolean;
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const players = useMemo(
    () => [...(roster?.players ?? [])].sort((a, b) => b.value - a.value),
    [roster],
  );

  if (loading) return <Spinner label="Loading roster" />;

  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <ul className="space-y-1.5">
        {players.map((player) => (
          <PlayerRow
            key={player.id}
            player={player}
            selected={selected.includes(player.id)}
            onToggle={() => onToggle(player.id)}
          />
        ))}
      </ul>
    </section>
  );
}

function PlayerRow({
  player,
  selected,
  onToggle,
}: {
  player: RosterPlayer;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        onClick={onToggle}
        aria-pressed={selected}
        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left ${
          selected ? 'border-accent-dim bg-accent/10' : 'border-ink-700 bg-ink-800/50'
        }`}
      >
        <PositionBadge position={player.position} rank={player.positionalRank} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{player.name}</span>
          <span className="block text-[11px] text-slate-400">
            {player.projectedPerGame.toFixed(1)} pts/gm
            {player.age ? ` · ${player.age}yo` : ''}
          </span>
        </span>
        <span className="text-sm font-semibold tabular-nums text-slate-300">
          {player.value.toFixed(0)}
        </span>
      </button>
    </li>
  );
}

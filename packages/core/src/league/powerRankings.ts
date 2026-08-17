import type { MatchupResult, StandingRow } from './standings.js';

export interface PowerRankingRow {
  teamId: string;
  teamName: string;
  rank: number;
  previousRank: number | null;
  /** Composite 0-100 strength score. */
  power: number;
  record: string;
  pointsPerGame: number;
  /** Average margin, positive means winning comfortably. */
  avgMargin: number;
  /** Points scored over the last three weeks, per game. */
  recentForm: number;
  /** How much better/worse than a coin flip their record is vs their scoring. */
  luck: number;
  blurb: string;
}

/**
 * Power rankings that weigh scoring over record.
 *
 * Fantasy records are noisy — a team can score the second-most points in the
 * league and sit at 3-6 purely on schedule. The composite leans on points per
 * game and recent form, uses record as a smaller input, and reports a luck
 * figure so the recap can call out who is better than their record.
 */
export function computePowerRankings(
  standings: StandingRow[],
  matchups: MatchupResult[],
  previous?: Array<{ teamId: string; rank: number }>,
): PowerRankingRow[] {
  const played = matchups.filter((m) => m.final);
  const maxWeek = played.reduce((m, x) => Math.max(m, x.week), 0);
  const prevRank = new Map((previous ?? []).map((p) => [p.teamId, p.rank]));

  const rows = standings.map((team) => {
    const games = team.wins + team.losses + team.ties;
    const ppg = games ? team.pointsFor / games : 0;
    const avgMargin = games ? (team.pointsFor - team.pointsAgainst) / games : 0;

    const recent = played.filter(
      (m) =>
        m.week > maxWeek - 3 && (m.homeTeamId === team.teamId || m.awayTeamId === team.teamId),
    );
    const recentPoints = recent.map((m) =>
      m.homeTeamId === team.teamId ? m.homeScore : m.awayScore,
    );
    const recentForm = recentPoints.length
      ? recentPoints.reduce((s, n) => s + n, 0) / recentPoints.length
      : ppg;

    // Expected win rate if this team's weekly score played every other team's.
    const allScores = played.flatMap((m) => [m.homeScore, m.awayScore]);
    const teamScores = played
      .filter((m) => m.homeTeamId === team.teamId || m.awayTeamId === team.teamId)
      .map((m) => (m.homeTeamId === team.teamId ? m.homeScore : m.awayScore));
    const expectedWinPct = teamScores.length
      ? teamScores.reduce(
          (acc, score) => acc + allScores.filter((s) => s < score).length / Math.max(allScores.length - 1, 1),
          0,
        ) / teamScores.length
      : 0;

    return { team, ppg, avgMargin, recentForm, expectedWinPct, games };
  });

  const maxPpg = Math.max(...rows.map((r) => r.ppg), 1);
  const maxRecent = Math.max(...rows.map((r) => r.recentForm), 1);

  const scored = rows.map((r) => {
    const power =
      (r.ppg / maxPpg) * 55 + (r.recentForm / maxRecent) * 25 + r.team.winPct * 20;
    return { ...r, power };
  });

  scored.sort((a, b) => b.power - a.power);

  return scored.map((r, i): PowerRankingRow => {
    const luck = r.games ? r.team.winPct - r.expectedWinPct : 0;
    const prev = prevRank.get(r.team.teamId) ?? null;
    return {
      teamId: r.team.teamId,
      teamName: r.team.teamName,
      rank: i + 1,
      previousRank: prev,
      power: round1(r.power),
      record: `${r.team.wins}-${r.team.losses}${r.team.ties ? `-${r.team.ties}` : ''}`,
      pointsPerGame: round1(r.ppg),
      avgMargin: round1(r.avgMargin),
      recentForm: round1(r.recentForm),
      luck: round2(luck),
      blurb: blurbFor(r.team, luck, prev, i + 1, round1(r.recentForm), round1(r.ppg)),
    };
  });
}

function blurbFor(
  team: StandingRow,
  luck: number,
  previousRank: number | null,
  rank: number,
  recentForm: number,
  ppg: number,
): string {
  const bits: string[] = [];

  if (previousRank !== null && previousRank !== rank) {
    const move = previousRank - rank;
    bits.push(`${move > 0 ? 'Up' : 'Down'} ${Math.abs(move)} spot${Math.abs(move) === 1 ? '' : 's'}`);
  }

  if (luck < -0.15) {
    bits.push(`better than their ${team.wins}-${team.losses} record — they have run into the league's high scores`);
  } else if (luck > 0.15) {
    bits.push(`${team.wins}-${team.losses} flatters them a little; the schedule has been kind`);
  }

  if (recentForm > ppg * 1.1) bits.push('trending up over the last three weeks');
  else if (recentForm < ppg * 0.9) bits.push('cooling off lately');

  if (bits.length === 0) bits.push(`${round1(ppg)} pts/gm, right about where their record says`);
  return `${bits.join('; ')}.`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

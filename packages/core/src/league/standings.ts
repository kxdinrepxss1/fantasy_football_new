import type { PlayoffSettings } from '../types.js';

export interface MatchupResult {
  week: number;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  /** False for a matchup that has not been played yet. */
  final: boolean;
}

export interface StandingRow {
  teamId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Win percentage, ties counting as half a win. */
  winPct: number;
  streak: string;
  seed: number;
}

export function computeStandings(
  teams: Array<{ id: string; name: string }>,
  matchups: MatchupResult[],
  playoffs: PlayoffSettings,
): StandingRow[] {
  const rows = new Map<string, StandingRow>(
    teams.map((t) => [
      t.id,
      {
        teamId: t.id,
        teamName: t.name,
        wins: 0,
        losses: 0,
        ties: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        winPct: 0,
        streak: '',
        seed: 0,
      },
    ]),
  );

  const h2h = new Map<string, { wins: number; losses: number }>();
  const results = new Map<string, Array<'W' | 'L' | 'T'>>();

  const played = matchups.filter((m) => m.final).sort((a, b) => a.week - b.week);

  for (const m of played) {
    const home = rows.get(m.homeTeamId);
    const away = rows.get(m.awayTeamId);
    if (!home || !away) continue;

    home.pointsFor += m.homeScore;
    home.pointsAgainst += m.awayScore;
    away.pointsFor += m.awayScore;
    away.pointsAgainst += m.homeScore;

    const key = (a: string, b: string) => `${a}|${b}`;
    if (m.homeScore > m.awayScore) {
      home.wins++;
      away.losses++;
      bump(h2h, key(m.homeTeamId, m.awayTeamId), 'wins');
      bump(h2h, key(m.awayTeamId, m.homeTeamId), 'losses');
      push(results, m.homeTeamId, 'W');
      push(results, m.awayTeamId, 'L');
    } else if (m.awayScore > m.homeScore) {
      away.wins++;
      home.losses++;
      bump(h2h, key(m.awayTeamId, m.homeTeamId), 'wins');
      bump(h2h, key(m.homeTeamId, m.awayTeamId), 'losses');
      push(results, m.awayTeamId, 'W');
      push(results, m.homeTeamId, 'L');
    } else {
      home.ties++;
      away.ties++;
      push(results, m.homeTeamId, 'T');
      push(results, m.awayTeamId, 'T');
    }
  }

  for (const row of rows.values()) {
    const games = row.wins + row.losses + row.ties;
    row.winPct = games === 0 ? 0 : (row.wins + row.ties * 0.5) / games;
    row.pointsFor = round2(row.pointsFor);
    row.pointsAgainst = round2(row.pointsAgainst);
    row.streak = formatStreak(results.get(row.teamId) ?? []);
  }

  const sorted = [...rows.values()].sort((a, b) => {
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    for (const tb of playoffs.tiebreakers) {
      if (tb === 'H2H') {
        const ab = h2h.get(`${a.teamId}|${b.teamId}`);
        if (ab && ab.wins !== ab.losses) return ab.wins > ab.losses ? -1 : 1;
      } else if (tb === 'POINTS_FOR' && b.pointsFor !== a.pointsFor) {
        return b.pointsFor - a.pointsFor;
      } else if (tb === 'POINTS_AGAINST' && a.pointsAgainst !== b.pointsAgainst) {
        // Fewer points allowed is better.
        return a.pointsAgainst - b.pointsAgainst;
      }
    }
    return a.teamName.localeCompare(b.teamName);
  });

  sorted.forEach((row, i) => (row.seed = i + 1));
  return sorted;
}

export interface BracketMatchup {
  round: number;
  slot: number;
  highSeed: number | null;
  lowSeed: number | null;
  highTeamId: string | null;
  lowTeamId: string | null;
  /** True when this pairing exists only because one side has a first-round bye. */
  bye: boolean;
}

/**
 * Build the playoff bracket from final seeding.
 *
 * Handles non-power-of-two fields the way real leagues do: the top seeds get
 * first-round byes, and the remaining teams are paired highest against lowest.
 */
export function buildPlayoffBracket(
  standings: StandingRow[],
  playoffs: PlayoffSettings,
): BracketMatchup[] {
  const field = standings.slice(0, playoffs.teams);
  if (field.length < 2) return [];

  const bracketSize = nextPowerOfTwo(field.length);
  const byes = bracketSize - field.length;
  const out: BracketMatchup[] = [];

  // Round 1: seeds with byes sit out, the rest pair high vs low.
  const playingSeeds = field.slice(byes);
  let slot = 0;
  for (let i = 0; i < playingSeeds.length / 2; i++) {
    const high = playingSeeds[i]!;
    const low = playingSeeds[playingSeeds.length - 1 - i]!;
    out.push({
      round: 1,
      slot: slot++,
      highSeed: high.seed,
      lowSeed: low.seed,
      highTeamId: high.teamId,
      lowTeamId: low.teamId,
      bye: false,
    });
  }

  for (let i = 0; i < byes; i++) {
    const team = field[i]!;
    out.push({
      round: 1,
      slot: slot++,
      highSeed: team.seed,
      lowSeed: null,
      highTeamId: team.teamId,
      lowTeamId: null,
      bye: true,
    });
  }

  // Later rounds are placeholders until results come in.
  let teamsLeft = bracketSize / 2;
  let round = 2;
  while (teamsLeft >= 2) {
    for (let i = 0; i < teamsLeft / 2; i++) {
      out.push({
        round,
        slot: i,
        highSeed: null,
        lowSeed: null,
        highTeamId: null,
        lowTeamId: null,
        bye: false,
      });
    }
    teamsLeft /= 2;
    round++;
  }

  return out;
}

/** Which weeks each playoff round occupies, honouring multi-week rounds. */
export function playoffSchedule(playoffs: PlayoffSettings): Array<{ round: number; weeks: number[] }> {
  const rounds = Math.ceil(Math.log2(nextPowerOfTwo(playoffs.teams)));
  const out: Array<{ round: number; weeks: number[] }> = [];
  let week = playoffs.startWeek;
  for (let r = 1; r <= rounds; r++) {
    const weeks: number[] = [];
    for (let w = 0; w < playoffs.weeksPerRound; w++) weeks.push(week++);
    out.push({ round: r, weeks });
  }
  return out;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function bump(map: Map<string, { wins: number; losses: number }>, key: string, field: 'wins' | 'losses') {
  const cur = map.get(key) ?? { wins: 0, losses: 0 };
  cur[field]++;
  map.set(key, cur);
}

function push(map: Map<string, Array<'W' | 'L' | 'T'>>, key: string, v: 'W' | 'L' | 'T') {
  const list = map.get(key) ?? [];
  list.push(v);
  map.set(key, list);
}

function formatStreak(results: Array<'W' | 'L' | 'T'>): string {
  if (results.length === 0) return '—';
  const last = results[results.length - 1]!;
  let n = 0;
  for (let i = results.length - 1; i >= 0 && results[i] === last; i--) n++;
  return `${last}${n}`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

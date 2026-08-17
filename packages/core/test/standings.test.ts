import { describe, expect, it } from 'vitest';
import { computePowerRankings } from '../src/league/powerRankings.js';
import {
  buildPlayoffBracket,
  computeStandings,
  playoffSchedule,
  type MatchupResult,
} from '../src/league/standings.js';
import { defaultLeagueSettings } from '../src/scoring/presets.js';

const teams = [
  { id: 't1', name: 'Alpha' },
  { id: 't2', name: 'Bravo' },
  { id: 't3', name: 'Charlie' },
  { id: 't4', name: 'Delta' },
];

const m = (
  week: number,
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number,
): MatchupResult => ({ week, homeTeamId, awayTeamId, homeScore, awayScore, final: true });

const playoffs = defaultLeagueSettings().playoffs;

describe('standings', () => {
  const matchups = [
    m(1, 't1', 't2', 120, 100),
    m(1, 't3', 't4', 110, 90),
    m(2, 't1', 't3', 130, 125),
    m(2, 't2', 't4', 95, 105),
    m(3, 't1', 't4', 140, 80),
    m(3, 't2', 't3', 88, 99),
  ];

  it('computes records, points and seeds', () => {
    const table = computeStandings(teams, matchups, playoffs);
    expect(table[0]!.teamId).toBe('t1');
    expect(table[0]!.wins).toBe(3);
    expect(table[0]!.losses).toBe(0);
    expect(table[0]!.seed).toBe(1);
    expect(table[0]!.pointsFor).toBe(390);
    expect(table[0]!.pointsAgainst).toBe(305);
  });

  it('tracks streaks', () => {
    const table = computeStandings(teams, matchups, playoffs);
    expect(table.find((r) => r.teamId === 't1')!.streak).toBe('W3');
    expect(table.find((r) => r.teamId === 't2')!.streak).toBe('L3');
  });

  it('ignores matchups that have not been played', () => {
    const withFuture = [...matchups, { ...m(4, 't1', 't2', 0, 0), final: false }];
    const table = computeStandings(teams, withFuture, playoffs);
    expect(table[0]!.wins + table[0]!.losses + table[0]!.ties).toBe(3);
  });

  it('counts ties as half a win', () => {
    const table = computeStandings(
      [teams[0]!, teams[1]!],
      [m(1, 't1', 't2', 100, 100)],
      playoffs,
    );
    expect(table[0]!.ties).toBe(1);
    expect(table[0]!.winPct).toBe(0.5);
  });

  it('breaks ties on head-to-head before points for', () => {
    // Both 1-1, but t2 beat t1 head to head while t1 scored more overall.
    const tied = [m(1, 't1', 't2', 90, 100), m(2, 't1', 't3', 200, 10), m(2, 't2', 't3', 80, 70)];
    const table = computeStandings(teams.slice(0, 3), tied, {
      ...playoffs,
      tiebreakers: ['H2H', 'POINTS_FOR'],
    });
    const t1 = table.findIndex((r) => r.teamId === 't1');
    const t2 = table.findIndex((r) => r.teamId === 't2');
    expect(t2).toBeLessThan(t1);
  });

  it('falls back to points for when head-to-head is not decisive', () => {
    const tied = [m(1, 't1', 't3', 200, 10), m(2, 't2', 't3', 80, 70)];
    const table = computeStandings(teams.slice(0, 3), tied, {
      ...playoffs,
      tiebreakers: ['H2H', 'POINTS_FOR'],
    });
    expect(table[0]!.teamId).toBe('t1');
  });
});

describe('playoff bracket', () => {
  const six = Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, name: `Seed ${i + 1}` }));
  const results: MatchupResult[] = six.flatMap((t, i) =>
    i % 2 === 0 && six[i + 1]
      ? [m(1, t.id, six[i + 1]!.id, 200 - i * 10, 100 - i * 10)]
      : [],
  );

  it('gives the top seeds first-round byes in a six-team field', () => {
    const standings = computeStandings(six, results, playoffs);
    const bracket = buildPlayoffBracket(standings, { ...playoffs, teams: 6 });
    const round1 = bracket.filter((b) => b.round === 1);
    const byes = round1.filter((b) => b.bye);
    expect(byes).toHaveLength(2);
    expect(byes.map((b) => b.highSeed).sort()).toEqual([1, 2]);
  });

  it('pairs the remaining seeds highest against lowest', () => {
    const standings = computeStandings(six, results, playoffs);
    const bracket = buildPlayoffBracket(standings, { ...playoffs, teams: 6 });
    const games = bracket.filter((b) => b.round === 1 && !b.bye);
    expect(games).toHaveLength(2);
    expect(games[0]!.highSeed).toBe(3);
    expect(games[0]!.lowSeed).toBe(6);
    expect(games[1]!.highSeed).toBe(4);
    expect(games[1]!.lowSeed).toBe(5);
  });

  it('creates placeholder rounds through to the final', () => {
    const standings = computeStandings(six, results, playoffs);
    const bracket = buildPlayoffBracket(standings, { ...playoffs, teams: 4 });
    const rounds = new Set(bracket.map((b) => b.round));
    expect(rounds).toEqual(new Set([1, 2]));
    expect(bracket.filter((b) => b.round === 2)).toHaveLength(1);
  });

  it('lays out two-week championship rounds', () => {
    const schedule = playoffSchedule({ ...playoffs, teams: 4, startWeek: 15, weeksPerRound: 2 });
    expect(schedule).toEqual([
      { round: 1, weeks: [15, 16] },
      { round: 2, weeks: [17, 18] },
    ]);
  });
});

describe('power rankings', () => {
  it('rates a high scorer with a bad record above their standing', () => {
    const matchups = [
      // t4 scores a lot every week but keeps running into the top score.
      m(1, 't4', 't1', 140, 150),
      m(2, 't4', 't2', 138, 141),
      m(3, 't4', 't3', 135, 136),
      m(1, 't2', 't3', 80, 70),
      m(2, 't1', 't3', 85, 60),
      m(3, 't1', 't2', 90, 75),
    ];
    const standings = computeStandings(teams, matchups, playoffs);
    const power = computePowerRankings(standings, matchups);

    const t4Standing = standings.findIndex((s) => s.teamId === 't4');
    const t4Power = power.findIndex((p) => p.teamId === 't4');
    expect(t4Power).toBeLessThan(t4Standing);

    const t4 = power.find((p) => p.teamId === 't4')!;
    expect(t4.luck).toBeLessThan(0);
    expect(t4.blurb).toMatch(/better than their/i);
  });

  it('reports movement against the previous week', () => {
    const matchups = [m(1, 't1', 't2', 120, 100), m(1, 't3', 't4', 110, 90)];
    const standings = computeStandings(teams, matchups, playoffs);
    const power = computePowerRankings(standings, matchups, [
      { teamId: 't1', rank: 4 },
      { teamId: 't2', rank: 1 },
    ]);
    const t1 = power.find((p) => p.teamId === 't1')!;
    expect(t1.previousRank).toBe(4);
    expect(t1.blurb).toMatch(/^Up \d+ spot/);
  });

  it('handles a league with no games played', () => {
    const standings = computeStandings(teams, [], playoffs);
    const power = computePowerRankings(standings, []);
    expect(power).toHaveLength(4);
    expect(power.every((p) => Number.isFinite(p.power))).toBe(true);
  });
});

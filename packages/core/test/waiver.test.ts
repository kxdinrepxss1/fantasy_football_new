import { describe, expect, it } from 'vitest';
import { defaultLeagueSettings } from '../src/scoring/presets.js';
import {
  analyzeRosterNeeds,
  recommendWaivers,
  suggestDrop,
  trendingAdds,
} from '../src/waiver/recommend.js';
import { buildValuationContext } from '../src/valuation/value.js';
import { buildPool, input } from './fixtures.js';

const settings = defaultLeagueSettings('ppr', 12);
const pool = buildPool(12);
const ctx = buildValuationContext(pool, settings);

describe('roster needs', () => {
  it('marks a position with no bodies as critical', () => {
    const roster = [input('QB', 18, { id: 'qb' }), input('RB', 14, { id: 'rb' })];
    const needs = analyzeRosterNeeds(roster, settings);
    expect(needs.find((n) => n.position === 'WR')!.severity).toBe('critical');
  });

  it('marks a stacked position as surplus', () => {
    const roster = [
      input('RB', 16, { id: 'rb1' }),
      input('RB', 15, { id: 'rb2' }),
      input('RB', 14, { id: 'rb3' }),
      input('RB', 13, { id: 'rb4' }),
      input('RB', 12, { id: 'rb5' }),
    ];
    expect(analyzeRosterNeeds(roster, settings).find((n) => n.position === 'RB')!.severity).toBe(
      'surplus',
    );
  });

  it('does not count injured players toward depth', () => {
    const roster = [
      input('TE', 10, { id: 'te1', injuryStatus: 'IR' }),
      input('TE', 9, { id: 'te2', injuryStatus: 'OUT' }),
    ];
    expect(analyzeRosterNeeds(roster, settings).find((n) => n.position === 'TE')!.depth).toBe(0);
  });
});

describe('waiver recommendations', () => {
  const thinAtWr = [
    input('QB', 18, { id: 'my-qb' }),
    input('RB', 16, { id: 'my-rb1' }),
    input('RB', 14, { id: 'my-rb2' }),
    input('RB', 13, { id: 'my-rb3' }),
    input('WR', 12, { id: 'my-wr1' }),
    input('TE', 9, { id: 'my-te' }),
    input('K', 8, { id: 'my-k' }),
    input('DST', 8, { id: 'my-dst' }),
  ];

  it('ranks a player who fills a hole above a better player who does not', () => {
    const available = [
      input('WR', 11, { id: 'free-wr', name: 'Free WR' }),
      input('RB', 12, { id: 'free-rb', name: 'Free RB' }),
    ];
    const recs = recommendWaivers({ roster: thinAtWr, available, settings, ctx });
    expect(recs[0]!.playerId).toBe('free-wr');
    expect(recs[0]!.lineupGain).toBeGreaterThan(0);
  });

  it('surfaces an injury-driven opportunity from the same NFL backfield', () => {
    const available = [
      input('RB', 7, { id: 'backup', name: 'Backup Back', nflTeam: 'KC' }),
      input('RB', 7.5, { id: 'other', name: 'Other Back', nflTeam: 'SF' }),
    ];
    const leagueRostered = [
      input('RB', 17, { id: 'starter', name: 'Hurt Starter', nflTeam: 'KC', injuryStatus: 'OUT' }),
    ];
    const recs = recommendWaivers({
      roster: thinAtWr,
      available,
      leagueRostered,
      settings,
      ctx,
    });
    const backup = recs.find((r) => r.playerId === 'backup')!;
    expect(backup.opportunity).toContain('Hurt Starter');
    expect(backup.reasons.join(' ')).toMatch(/workload should shift/);
  });

  it('flags trending adds and reports the rostership move', () => {
    const available = [
      input('WR', 9, { id: 'hot', name: 'Hot Pickup', rosteredPct: 22, rosteredPctDelta: 18 }),
      input('WR', 9, { id: 'cold', name: 'Cold Pickup', rosteredPct: 5, rosteredPctDelta: 0 }),
    ];
    const recs = recommendWaivers({ roster: thinAtWr, available, settings, ctx });
    expect(recs.find((r) => r.playerId === 'hot')!.trending).toBe(true);
    expect(recs.find((r) => r.playerId === 'cold')!.trending).toBe(false);

    const trending = trendingAdds(available);
    expect(trending[0]!.playerId).toBe('hot');
    expect(trending[0]!.delta).toBe(18);
  });

  it('boosts only as many players as it takes to fill the hole', () => {
    // One defense, on bye in week 5 — the roster needs exactly one more, not five.
    const roster = [
      input('QB', 18, { id: 'qb' }),
      input('RB', 15, { id: 'rb1' }),
      input('RB', 14, { id: 'rb2' }),
      input('WR', 14, { id: 'wr1' }),
      input('WR', 13, { id: 'wr2' }),
      input('WR', 12, { id: 'wr3' }),
      input('TE', 9, { id: 'te1' }),
      input('DST', 8, { id: 'dst1', byeWeek: 5 }),
    ];
    const available = [
      input('DST', 7.5, { id: 'dst-a', name: 'Best DST', byeWeek: 11 }),
      input('DST', 7.4, { id: 'dst-b', name: 'Second DST', byeWeek: 11 }),
      input('DST', 7.3, { id: 'dst-c', name: 'Third DST', byeWeek: 11 }),
    ];
    const recs = recommendWaivers({
      roster,
      available,
      settings,
      ctx,
      currentWeek: 4,
      lookaheadWeeks: 4,
    });

    // Only the best one is credited with solving the week 5 problem.
    expect(recs.find((r) => r.playerId === 'dst-a')!.coversByeWeeks).toContain(5);
    expect(recs.find((r) => r.playerId === 'dst-b')!.coversByeWeeks).toEqual([]);
    expect(recs.find((r) => r.playerId === 'dst-c')!.coversByeWeeks).toEqual([]);
  });

  it('boosts several players when the roster is short by more than one', () => {
    // No receivers at all in a league that starts three of them.
    const roster = [
      input('QB', 18, { id: 'qb' }),
      input('RB', 15, { id: 'rb1' }),
      input('TE', 9, { id: 'te1' }),
    ];
    const available = [
      input('WR', 11, { id: 'wr-a', name: 'WR A' }),
      input('WR', 10, { id: 'wr-b', name: 'WR B' }),
      input('WR', 9, { id: 'wr-c', name: 'WR C' }),
      input('WR', 8, { id: 'wr-d', name: 'WR D' }),
    ];
    const recs = recommendWaivers({ roster, available, settings, ctx, currentWeek: 1 });

    // Three starting receiver slots are empty, so three adds genuinely help.
    const boosted = recs.filter((r) => r.coversByeWeeks.length > 0).length;
    expect(boosted).toBeGreaterThanOrEqual(3);
    expect(recs[0]!.playerId).toBe('wr-a');
  });

  it('prefers a player who covers an uncovered bye week', () => {
    // Only one TE, and he is on bye in week 5 — the roster cannot field a TE.
    const roster = [
      input('QB', 18, { id: 'qb' }),
      input('RB', 15, { id: 'rb1' }),
      input('RB', 14, { id: 'rb2' }),
      input('WR', 14, { id: 'wr1' }),
      input('WR', 13, { id: 'wr2' }),
      input('WR', 12, { id: 'wr3' }),
      input('TE', 9, { id: 'te1', byeWeek: 5 }),
    ];
    const available = [
      input('TE', 6, { id: 'te-cover', name: 'Bye Cover TE', byeWeek: 11 }),
      input('TE', 6, { id: 'te-clash', name: 'Same Bye TE', byeWeek: 5 }),
    ];
    const recs = recommendWaivers({
      roster,
      available,
      settings,
      ctx,
      currentWeek: 4,
      lookaheadWeeks: 4,
    });
    const cover = recs.find((r) => r.playerId === 'te-cover')!;
    const clash = recs.find((r) => r.playerId === 'te-clash')!;
    expect(cover.coversByeWeeks).toContain(5);
    expect(clash.coversByeWeeks).not.toContain(5);
    expect(cover.fitScore).toBeGreaterThan(clash.fitScore);
  });
});

describe('drop suggestions', () => {
  // The ppr preset starts 10: QB, 2 RB, 3 WR, TE, FLEX, K, DST. A roster needs
  // more than 10 players before anyone is genuinely benched.
  const startingTen = [
    input('QB', 20, { id: 'qb' }),
    input('RB', 18, { id: 'rb1' }),
    input('RB', 16, { id: 'rb2' }),
    input('RB', 14, { id: 'rb3-flex' }),
    input('WR', 15, { id: 'wr1' }),
    input('WR', 14, { id: 'wr2' }),
    input('WR', 13, { id: 'wr3' }),
    input('TE', 10, { id: 'te' }),
    input('K', 8, { id: 'k' }),
    input('DST', 8, { id: 'dst' }),
  ];

  it('never suggests dropping a starter', () => {
    const roster = [...startingTen, input('RB', 3, { id: 'scrub' })];
    const drop = suggestDrop(roster, settings, ctx)!;
    expect(drop.playerId).toBe('scrub');
    expect(drop.lineupCost).toBe(0);
  });

  it('falls back to the cheapest starter when there is no bench at all', () => {
    const drop = suggestDrop(startingTen, settings, ctx)!;
    // Every player starts, so a drop has to cost something — say so plainly.
    expect(drop.reason).toMatch(/no bench/i);
    expect(startingTen.some((r) => r.player.id === drop.playerId)).toBe(true);
  });

  it('prefers cutting an injured bench player', () => {
    const roster = [
      ...startingTen,
      input('WR', 9, { id: 'healthy-bench' }),
      input('WR', 9.2, { id: 'hurt-bench', injuryStatus: 'IR' }),
    ];
    const drop = suggestDrop(roster, settings, ctx)!;
    expect(drop.playerId).toBe('hurt-bench');
    expect(drop.reason).toMatch(/ir/i);
  });

  it('honours protected players', () => {
    const roster = [
      ...startingTen,
      input('RB', 3, { id: 'scrub' }),
      input('RB', 4, { id: 'next-scrub' }),
    ];
    const drop = suggestDrop(roster, settings, ctx, ['scrub'])!;
    expect(drop.playerId).toBe('next-scrub');
  });

  it('returns null when every player is protected', () => {
    const roster = [input('QB', 20, { id: 'qb' }), input('RB', 10, { id: 'rb' })];
    expect(suggestDrop(roster, settings, ctx, ['qb', 'rb'])).toBeNull();
  });

  it('returns null for an empty roster', () => {
    expect(suggestDrop([], settings, ctx)).toBeNull();
  });
});

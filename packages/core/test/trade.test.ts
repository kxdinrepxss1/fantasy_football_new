import { describe, expect, it } from 'vitest';
import { defaultLeagueSettings } from '../src/scoring/presets.js';
import { evaluateTrade, type TradeTeam } from '../src/trade/calculator.js';
import { buildValuationContext } from '../src/valuation/value.js';
import { buildPool, input } from './fixtures.js';

const settings = defaultLeagueSettings('ppr', 12);
const pool = buildPool(12);
const ctx = buildValuationContext(pool, settings);

function team(id: string, name: string, roster: ReturnType<typeof input>[]): TradeTeam {
  return { id, name, roster };
}

describe('trade calculator', () => {
  it('calls a swap of near-identical players fair', () => {
    const a = team('a', 'Team A', [
      input('RB', 15, { id: 'a-rb', name: 'A RB', age: 26 }),
      input('WR', 12, { id: 'a-wr', name: 'A WR' }),
      input('QB', 18, { id: 'a-qb', name: 'A QB' }),
      input('TE', 8, { id: 'a-te', name: 'A TE' }),
    ]);
    const b = team('b', 'Team B', [
      input('RB', 15.1, { id: 'b-rb', name: 'B RB', age: 26 }),
      input('WR', 12, { id: 'b-wr', name: 'B WR' }),
      input('QB', 18, { id: 'b-qb', name: 'B QB' }),
      input('TE', 8, { id: 'b-te', name: 'B TE' }),
    ]);

    const result = evaluateTrade(
      { a: { team: a, sending: ['a-rb'] }, b: { team: b, sending: ['b-rb'] } },
      settings,
      ctx,
    );
    expect(result.verdict).toBe('fair');
    expect(result.magnitudePct).toBeLessThan(8);
  });

  it('does not treat equal production at different ages as an equal trade', () => {
    const dynasty = { ...settings, dynastyWeight: 1 };
    const dynastyCtx = buildValuationContext(pool, dynasty);

    const a = team('a', 'Team A', [
      input('RB', 16, { id: 'young-rb', name: 'Young RB', age: 23 }),
      input('WR', 12, { id: 'a-wr' }),
      input('QB', 18, { id: 'a-qb' }),
    ]);
    const b = team('b', 'Team B', [
      input('RB', 16, { id: 'old-rb', name: 'Old RB', age: 31 }),
      input('WR', 12, { id: 'b-wr' }),
      input('QB', 18, { id: 'b-qb' }),
    ]);

    const result = evaluateTrade(
      { a: { team: a, sending: ['young-rb'] }, b: { team: b, sending: ['old-rb'] } },
      dynasty,
      dynastyCtx,
    );
    // Team A ships the young back and gets the old one — that should not be fair.
    expect(result.verdict).toBe('favors_b');
    expect(result.magnitudePct).toBeGreaterThan(15);
  });

  it('discounts a player joining a team that is already deep at his position', () => {
    // Five running backs for two RB slots plus a flex — a sixth is nearly useless.
    const rbRich = team('rich', 'RB Rich', [
      input('RB', 18, { id: 'r-rb1' }),
      input('RB', 17, { id: 'r-rb2' }),
      input('RB', 16, { id: 'r-rb3' }),
      input('RB', 15, { id: 'r-rb4' }),
      input('RB', 14, { id: 'r-rb5' }),
      input('WR', 13, { id: 'r-wr1' }),
      input('WR', 12, { id: 'r-wr2' }),
      input('WR', 11, { id: 'r-wr3' }),
      input('QB', 18, { id: 'r-qb' }),
      input('TE', 9, { id: 'r-te' }),
      input('K', 8, { id: 'r-k' }),
      input('DST', 8, { id: 'r-dst' }),
    ]);
    // One running back for the same three spots — desperate for exactly this player.
    const rbPoor = team('poor', 'RB Poor', [
      input('RB', 13.5, { id: 'p-rb1', name: 'Poor RB1' }),
      input('WR', 16, { id: 'p-wr1' }),
      input('WR', 15, { id: 'p-wr2' }),
      input('WR', 14, { id: 'p-wr3' }),
      input('WR', 13, { id: 'p-wr4' }),
      input('WR', 12, { id: 'p-wr5' }),
      input('QB', 18, { id: 'p-qb' }),
      input('TE', 9, { id: 'p-te' }),
      input('K', 8, { id: 'p-k' }),
      input('DST', 8, { id: 'p-dst' }),
    ]);

    // Both sides trade a comparable running back, but only one of them needs him.
    const toRich = evaluateTrade(
      { a: { team: rbRich, sending: ['r-wr3'] }, b: { team: rbPoor, sending: ['p-rb1'] } },
      settings,
      ctx,
    );
    const richReceivingRb = toRich.a.incoming.find((i) => i.playerId === 'p-rb1')!;

    // Market value is unchanged, but the sixth back barely moves this lineup.
    expect(richReceivingRb.contextValue).toBeLessThan(richReceivingRb.rawValue);
    expect(richReceivingRb.lineupSwingPerGame).toBeLessThan(1);
    expect(richReceivingRb.reasons.join(' ')).toMatch(/already covered here/i);
  });

  it('recognises a needs-based trade that helps both teams', () => {
    // Four backs but only three receivers for three WR slots — the fourth back
    // is stuck on the bench while a starting slot goes to a 6-point receiver.
    const rbRich = team('rich', 'RB Rich', [
      input('RB', 18, { id: 'rr-rb1' }),
      input('RB', 17, { id: 'rr-rb2' }),
      input('RB', 16, { id: 'rr-rb3' }),
      input('RB', 15, { id: 'rr-rb4' }),
      input('WR', 8, { id: 'rr-wr1' }),
      input('WR', 7, { id: 'rr-wr2' }),
      input('WR', 6, { id: 'rr-wr3' }),
      input('QB', 18, { id: 'rr-qb' }),
      input('TE', 9, { id: 'rr-te' }),
      input('K', 8, { id: 'rr-k' }),
      input('DST', 8, { id: 'rr-dst' }),
    ]);
    // Five receivers: three start, a fourth takes the flex, and the fifth is
    // buried — the mirror image of the RB-rich roster.
    const wrRich = team('wrrich', 'WR Rich', [
      input('WR', 18, { id: 'wr-wr1' }),
      input('WR', 17, { id: 'wr-wr2' }),
      input('WR', 16, { id: 'wr-wr3' }),
      input('WR', 15, { id: 'wr-wr4' }),
      input('WR', 14, { id: 'wr-wr5' }),
      input('RB', 8, { id: 'wr-rb1' }),
      input('RB', 7, { id: 'wr-rb2' }),
      input('RB', 6, { id: 'wr-rb3' }),
      input('QB', 18, { id: 'wr-qb' }),
      input('TE', 9, { id: 'wr-te' }),
      input('K', 8, { id: 'wr-k' }),
      input('DST', 8, { id: 'wr-dst' }),
    ]);

    // Each ships a player who never cracks their own lineup — rr-rb4 sits behind
    // the flex back, wr-wr5 behind the flex receiver — for one who starts at once.
    const result = evaluateTrade(
      { a: { team: rbRich, sending: ['rr-rb4'] }, b: { team: wrRich, sending: ['wr-wr5'] } },
      settings,
      ctx,
    );

    expect(result.a.startingLineupSwing).toBeGreaterThan(0);
    expect(result.b.startingLineupSwing).toBeGreaterThan(0);
    expect(result.winWin).toBe(true);
    expect(result.explanation.join(' ')).toMatch(/both rosters come out ahead/i);
  });

  it('flags a genuinely lopsided offer with a magnitude', () => {
    const a = team('a', 'Team A', [
      input('RB', 19, { id: 'stud', name: 'Stud RB' }),
      input('WR', 12, { id: 'a-wr' }),
      input('QB', 18, { id: 'a-qb' }),
    ]);
    const b = team('b', 'Team B', [
      input('RB', 4, { id: 'scrub', name: 'Scrub RB' }),
      input('WR', 12, { id: 'b-wr' }),
      input('QB', 18, { id: 'b-qb' }),
    ]);

    const result = evaluateTrade(
      { a: { team: a, sending: ['stud'] }, b: { team: b, sending: ['scrub'] } },
      settings,
      ctx,
    );
    expect(result.verdict).toBe('favors_b');
    expect(result.magnitudeLabel).toBe('lopsided');
    expect(result.explanation[0]).toMatch(/lopsided/i);
  });

  it('handles multi-player packages on both sides', () => {
    const a = team('a', 'Team A', [
      input('RB', 17, { id: 'a1', name: 'A One' }),
      input('WR', 14, { id: 'a2', name: 'A Two' }),
      input('WR', 11, { id: 'a3' }),
      input('QB', 18, { id: 'a-qb' }),
      input('TE', 9, { id: 'a-te' }),
    ]);
    const b = team('b', 'Team B', [
      input('RB', 19, { id: 'b1', name: 'B One' }),
      input('WR', 9, { id: 'b2', name: 'B Two' }),
      input('WR', 12, { id: 'b3' }),
      input('QB', 18, { id: 'b-qb' }),
      input('TE', 9, { id: 'b-te' }),
    ]);

    const result = evaluateTrade(
      { a: { team: a, sending: ['a1', 'a2'] }, b: { team: b, sending: ['b1', 'b2'] } },
      settings,
      ctx,
    );
    expect(result.a.outgoing).toHaveLength(2);
    expect(result.a.incoming).toHaveLength(2);
    expect(result.b.incoming.map((i) => i.name).sort()).toEqual(['A One', 'A Two']);
    expect(result.explanation.length).toBeGreaterThan(1);
  });

  it('produces an explanation naming both teams and the headline players', () => {
    const a = team('a', 'Sharks', [
      input('RB', 17, { id: 'shark-rb', name: 'Shark Back' }),
      input('QB', 18, { id: 'shark-qb' }),
    ]);
    const b = team('b', 'Jets', [
      input('WR', 16, { id: 'jet-wr', name: 'Jet Wideout' }),
      input('QB', 18, { id: 'jet-qb' }),
    ]);

    const result = evaluateTrade(
      { a: { team: a, sending: ['shark-rb'] }, b: { team: b, sending: ['jet-wr'] } },
      settings,
      ctx,
    );
    const text = result.explanation.join(' ');
    expect(text).toContain('Sharks');
    expect(text).toContain('Jets');
    expect(text).toMatch(/Jet Wideout|Shark Back/);
  });
});

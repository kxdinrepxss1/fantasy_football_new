import { describe, expect, it } from 'vitest';
import { defaultLeagueSettings } from '../src/scoring/presets.js';
import { rawAgeMultiplier } from '../src/valuation/ageCurves.js';
import { computeReplacementLevels, buildPositionCurves } from '../src/valuation/replacement.js';
import { buildValuationContext, valuePool, valuePoolAsMap } from '../src/valuation/value.js';
import { buildPool, input } from './fixtures.js';

describe('aging curves', () => {
  it('declines running backs earlier and harder than receivers', () => {
    // At 29 an RB is well past plateau; a WR is only just leaving it.
    const rb29 = rawAgeMultiplier('RB', 29);
    const wr29 = rawAgeMultiplier('WR', 29);
    expect(rb29).toBeLessThan(wr29);
    expect(rb29).toBeLessThan(0.7);
    expect(wr29).toBe(1);
  });

  it('holds quarterbacks flat deep into their thirties', () => {
    expect(rawAgeMultiplier('QB', 32)).toBe(1);
    expect(rawAgeMultiplier('QB', 35)).toBeGreaterThan(0.8);
  });

  it('rewards youth below the peak', () => {
    expect(rawAgeMultiplier('WR', 22)).toBeGreaterThan(1);
    expect(rawAgeMultiplier('WR', 22)).toBeLessThanOrEqual(1.15);
  });

  it('never falls below the positional floor', () => {
    expect(rawAgeMultiplier('RB', 40)).toBeGreaterThanOrEqual(0.25);
  });

  it('treats kickers and defenses as ageless', () => {
    expect(rawAgeMultiplier('K', 40)).toBe(1);
    expect(rawAgeMultiplier('DST', null)).toBe(1);
  });
});

describe('replacement level', () => {
  it('scales starter demand with team count', () => {
    const pool = buildPool(12);
    const settings = defaultLeagueSettings('ppr', 12);
    const ctx = buildValuationContext(pool, settings);
    // One QB slot, no superflex → exactly one QB per team.
    expect(ctx.replacement.demand.QB).toBe(12);
  });

  it('roughly doubles QB demand in superflex and craters the replacement QB', () => {
    const pool = buildPool(12);
    const oneQb = buildValuationContext(pool, defaultLeagueSettings('ppr', 12));
    const superflex = buildValuationContext(pool, defaultLeagueSettings('superflex', 12));

    expect(superflex.replacement.demand.QB).toBeGreaterThan(oneQb.replacement.demand.QB);
    expect(superflex.replacement.replacementPoints.QB).toBeLessThan(
      oneQb.replacement.replacementPoints.QB,
    );
  });

  it('feeds flex slots from whichever position has the best player left', () => {
    const curves = buildPositionCurves([
      ...Array.from({ length: 40 }, (_, i) => ({ position: 'RB' as const, perGame: 20 - i })),
      ...Array.from({ length: 40 }, (_, i) => ({ position: 'WR' as const, perGame: 10 - i * 0.1 })),
      ...Array.from({ length: 20 }, (_, i) => ({ position: 'TE' as const, perGame: 5 - i * 0.1 })),
    ]);
    const levels = computeReplacementLevels(
      curves,
      { slots: { RB: 1, WR: 1, FLEX: 1 }, benchSize: 5, irSlots: 1 },
      10,
    );
    // WRs stay flat around 9-10 while RBs fall off a cliff past the top 10,
    // so the flex seats should mostly go to receivers.
    expect(levels.flexDemand.WR).toBeGreaterThan(levels.flexDemand.TE);
    expect(levels.demand.RB + levels.demand.WR + levels.demand.TE).toBe(30);
  });
});

describe('player value', () => {
  const settings = defaultLeagueSettings('ppr', 12);

  it('ranks a scarce elite player above an equally productive abundant one', () => {
    const pool = buildPool(12);
    const values = valuePoolAsMap(pool, buildValuationContext(pool, settings));
    const rb1 = values.get('RB1')!;
    const wr1 = values.get('WR1')!;
    expect(rb1.positionalRank).toBe(1);
    expect(wr1.positionalRank).toBe(1);
    // RB curve decays faster in the fixture, so RB1 carries more value over
    // replacement than the similarly-projected WR1.
    expect(rb1.vorpPerGame).toBeGreaterThan(wr1.vorpPerGame);
  });

  it('separates two identical producers by age in a dynasty league', () => {
    const dynasty = { ...defaultLeagueSettings('ppr', 12), dynastyWeight: 1 };
    const pool = buildPool(12);
    const young = input('RB', 15, { id: 'young', name: 'Young RB', age: 23 });
    const old = input('RB', 15, { id: 'old', name: 'Old RB', age: 31 });
    const full = [...pool, young, old];

    const values = valuePoolAsMap(full, buildValuationContext(full, dynasty));
    expect(values.get('young')!.value).toBeGreaterThan(values.get('old')!.value * 1.3);
  });

  it('nearly ignores age in a pure redraft league', () => {
    const redraft = { ...defaultLeagueSettings('ppr', 12), dynastyWeight: 0 };
    const pool = buildPool(12);
    const young = input('RB', 15, { id: 'young', age: 23 });
    const old = input('RB', 15, { id: 'old', age: 31 });
    const full = [...pool, young, old];

    const values = valuePoolAsMap(full, buildValuationContext(full, redraft));
    expect(values.get('young')!.value).toBeCloseTo(values.get('old')!.value, 5);
  });

  it('lifts quarterback value in superflex without any special-casing', () => {
    const pool = buildPool(12);
    const single = valuePoolAsMap(pool, buildValuationContext(pool, defaultLeagueSettings('ppr', 12)));
    const sf = valuePoolAsMap(
      pool,
      buildValuationContext(pool, defaultLeagueSettings('superflex', 12)),
    );
    expect(sf.get('QB1')!.value).toBeGreaterThan(single.get('QB1')!.value * 1.2);
  });

  it('normalises display scores onto a 0-100 scale', () => {
    const pool = buildPool(12);
    const values = valuePool(pool, buildValuationContext(pool, settings));
    const max = Math.max(...values.map((v) => v.score));
    expect(max).toBe(100);
    expect(Math.min(...values.map((v) => v.score))).toBeGreaterThanOrEqual(0);
  });

  it('explains itself in plain language', () => {
    const pool = buildPool(12);
    const values = valuePoolAsMap(pool, buildValuationContext(pool, settings));
    const rb1 = values.get('RB1')!;
    expect(rb1.reasons[0]).toMatch(/RB1 at .* pts\/gm/);
  });
});

import { describe, expect, it } from 'vitest';
import { defaultLeagueSettings } from '../src/scoring/presets.js';
import {
  detectValuationDrift,
  toSnapshot,
  verifyValuation,
  type ValuationSnapshotEntry,
} from '../src/valuation/verify.js';
import { buildValuationContext, valuePool } from '../src/valuation/value.js';
import { buildPool, input } from './fixtures.js';

describe('valuation verification', () => {
  it('passes a healthy pool with no errors', () => {
    const pool = buildPool(12);
    const report = verifyValuation(pool, defaultLeagueSettings('ppr', 12));
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.poolSize).toBe(pool.length);
  });

  it('reports a per-position summary a dashboard can render', () => {
    const pool = buildPool(12);
    const report = verifyValuation(pool, defaultLeagueSettings('superflex', 12));
    const qb = report.positionSummary.find((p) => p.position === 'QB')!;
    // Superflex pushes QB starter demand past one per team.
    expect(qb.starterDemand).toBeGreaterThan(12);
    expect(qb.topValue).toBeGreaterThan(0);
  });

  it('warns when the pool is too shallow to establish replacement level', () => {
    // Only 6 QBs in a 12-team league — replacement is read off the bottom.
    const thin = [
      ...Array.from({ length: 6 }, (_, i) =>
        input('QB', 20 - i, { id: `qb${i}`, name: `QB${i}` }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        input('RB', 18 - i * 0.3, { id: `rb${i}`, name: `RB${i}` }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        input('WR', 17 - i * 0.25, { id: `wr${i}`, name: `WR${i}` }),
      ),
    ];
    const report = verifyValuation(thin, defaultLeagueSettings('ppr', 12));
    expect(report.warnings.some((w) => w.check === 'replacement-depth')).toBe(true);
  });

  it('catches a pool where a projection is missing entirely', () => {
    const pool = buildPool(12);
    // NaN is what a missing projection looks like once it reaches the engine.
    pool.push(input('RB', Number.NaN, { id: 'broken', name: 'Broken Feed' }));
    const report = verifyValuation(pool, defaultLeagueSettings('ppr', 12));
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.check === 'finite-values')).toBe(true);
  });

  it('verifies superflex actually reaches the valuation', () => {
    const pool = buildPool(12);
    const report = verifyValuation(pool, defaultLeagueSettings('ppr', 12));
    expect(report.errors.some((e) => e.check === 'superflex-sensitivity')).toBe(false);
  });
});

describe('valuation drift', () => {
  const prev: ValuationSnapshotEntry[] = [
    { playerId: 'a', name: 'Steady Sam', position: 'RB', value: 100, positionalRank: 5 },
    { playerId: 'b', name: 'Breakout Ben', position: 'WR', value: 40, positionalRank: 40 },
    { playerId: 'c', name: 'Gone Greg', position: 'TE', value: 20, positionalRank: 20 },
    { playerId: 'd', name: 'Crashed Carl', position: 'RB', value: 90, positionalRank: 6 },
  ];

  it('separates newsworthy movement from suspicious movement', () => {
    const curr: ValuationSnapshotEntry[] = [
      { playerId: 'a', name: 'Steady Sam', position: 'RB', value: 103, positionalRank: 5 },
      { playerId: 'b', name: 'Breakout Ben', position: 'WR', value: 55, positionalRank: 22 },
      { playerId: 'd', name: 'Crashed Carl', position: 'RB', value: 5, positionalRank: 60 },
      { playerId: 'e', name: 'New Ned', position: 'WR', value: 30, positionalRank: 45 },
    ];

    const drift = detectValuationDrift(prev, curr);

    expect(drift.significant.map((s) => s.playerId)).toContain('b');
    expect(drift.suspicious.map((s) => s.playerId)).toContain('d');
    expect(drift.added.map((a) => a.playerId)).toEqual(['e']);
    expect(drift.removed.map((r) => r.playerId)).toEqual(['c']);

    const ben = drift.significant.find((s) => s.playerId === 'b')!;
    expect(ben.rankChange).toBe(18);
    expect(ben.changePct).toBeCloseTo(37.5, 1);
  });

  it('ignores small week-to-week noise', () => {
    const curr = prev.map((p) => ({ ...p, value: p.value * 1.02 }));
    const drift = detectValuationDrift(prev, curr);
    expect(drift.significant).toHaveLength(0);
    expect(drift.suspicious).toHaveLength(0);
    expect(drift.medianAbsChangePct).toBeCloseTo(2, 0);
  });

  it('respects custom thresholds', () => {
    const curr = prev.map((p) => ({ ...p, value: p.value * 1.1 }));
    const drift = detectValuationDrift(prev, curr, { significantPct: 5, suspiciousPct: 50 });
    expect(drift.significant).toHaveLength(4);
  });

  it('round-trips a valuation run into a snapshot', () => {
    const pool = buildPool(12);
    const values = valuePool(pool, buildValuationContext(pool, defaultLeagueSettings('ppr', 12)));
    const names = new Map(pool.map((p) => [p.player.id, p.player.name]));
    const snapshot = toSnapshot(values, names);

    expect(snapshot).toHaveLength(values.length);
    expect(snapshot[0]!.name).toBeTruthy();
    // Comparing a snapshot with itself must show no movement at all.
    const drift = detectValuationDrift(snapshot, snapshot);
    expect(drift.significant).toHaveLength(0);
    expect(drift.suspicious).toHaveLength(0);
    expect(drift.added).toHaveLength(0);
    expect(drift.removed).toHaveLength(0);
  });
});

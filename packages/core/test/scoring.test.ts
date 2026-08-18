import { describe, expect, it } from 'vitest';
import { scoreStatLine, tierPoints } from '../src/scoring/engine.js';
import { SCORING_PRESETS, defaultLeagueSettings } from '../src/scoring/presets.js';

describe('scoring engine', () => {
  const ppr = SCORING_PRESETS.ppr();
  const standard = SCORING_PRESETS.standard();
  const half = SCORING_PRESETS.half_ppr();

  it('scores a receiving line and the reception setting is the only difference', () => {
    const line = { rec: 8, rec_yd: 95, rec_td: 1 };
    // 95 yds = 9.5, TD = 6 → 15.5 base
    expect(scoreStatLine(line, standard).total).toBe(15.5);
    expect(scoreStatLine(line, half).total).toBe(19.5);
    expect(scoreStatLine(line, ppr).total).toBe(23.5);
  });

  it('scores a passing line with the standard 25-yards-per-point rate', () => {
    const line = { pass_yd: 300, pass_td: 3, pass_int: 1, rush_yd: 20 };
    // 300*0.04=12, 3 TD=12, INT=-2, 20 rush=2
    expect(scoreStatLine(line, ppr).total).toBe(24);
  });

  it('applies kicker distance bands', () => {
    const line = { fg_made_20_29: 1, fg_made_40_49: 1, fg_made_50_plus: 1, xp_made: 3 };
    // 3 + 4 + 5 + 3
    expect(scoreStatLine(line, ppr).total).toBe(15);
  });

  it('scores defense through the points-allowed tier table', () => {
    const shutout = scoreStatLine({ def_pts_allowed: 0, def_sack: 3, def_int: 2 }, ppr);
    // 10 (shutout) + 3 sacks + 4 INT
    expect(shutout.total).toBe(17);

    const blowout = scoreStatLine({ def_pts_allowed: 38, def_sack: 1 }, ppr);
    // -4 + 1
    expect(blowout.total).toBe(-3);
  });

  it('respects a commissioner overriding a single stat value', () => {
    const settings = defaultLeagueSettings('ppr');
    settings.scoring.perUnit.pass_td = 6;
    settings.scoring.perUnit.rec = 1.5;

    const line = { pass_td: 2, rec: 4 };
    expect(scoreStatLine(line, settings.scoring).total).toBe(18);
  });

  it('lets a commissioner rewrite the points-allowed tiers', () => {
    const settings = defaultLeagueSettings('ppr');
    settings.scoring.defPointsAllowedTiers = [
      { min: 0, max: 10, points: 15 },
      { min: 11, max: null, points: -5 },
    ];
    expect(scoreStatLine({ def_pts_allowed: 7 }, settings.scoring).total).toBe(15);
    expect(scoreStatLine({ def_pts_allowed: 11 }, settings.scoring).total).toBe(-5);
  });

  it('returns a breakdown that sums to the total', () => {
    const line = { rec: 6, rec_yd: 80, rec_td: 1, fum_lost: 1 };
    const result = scoreStatLine(line, ppr);
    const sum = result.breakdown.reduce((s, r) => s + r.points, 0);
    expect(Math.round(sum * 100) / 100).toBe(result.total);
  });

  it('ignores stats the league does not score', () => {
    // rec_tgt has no per-unit value by default.
    expect(scoreStatLine({ rec_tgt: 12 }, ppr).total).toBe(0);
  });

  it('handles open-ended top tiers', () => {
    const tiers = [
      { min: 0, max: 6, points: 7 },
      { min: 7, max: null, points: -1 },
    ];
    expect(tierPoints(tiers, 3)).toBe(7);
    expect(tierPoints(tiers, 999)).toBe(-1);
  });
});

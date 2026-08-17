import { describe, expect, it } from 'vitest';
import {
  lineupGainFromAdding,
  marginalLineupValue,
  optimizeLineup,
} from '../src/lineup/optimizer.js';
import type { RosterSettings } from '../src/types.js';
import { player } from './fixtures.js';

const roster: RosterSettings = {
  slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
  benchSize: 5,
  irSlots: 1,
};

const c = (pos: Parameters<typeof player>[0], points: number, overrides = {}) => ({
  player: player(pos, overrides),
  points,
});

describe('lineup optimizer', () => {
  it('fills every starting slot with the best eligible player', () => {
    const lineup = optimizeLineup(
      [
        c('QB', 20, { id: 'qb1' }),
        c('QB', 15, { id: 'qb2' }),
        c('RB', 18, { id: 'rb1' }),
        c('RB', 12, { id: 'rb2' }),
        c('RB', 9, { id: 'rb3' }),
        c('WR', 16, { id: 'wr1' }),
        c('WR', 11, { id: 'wr2' }),
        c('TE', 8, { id: 'te1' }),
      ],
      roster,
    );
    // QB 20 + RB 18/12 + WR 16/11 + TE 8 + FLEX (best left = RB3 at 9)
    expect(lineup.total).toBe(94);
    expect(lineup.assignments.find((a) => a.slot === 'FLEX')?.playerId).toBe('rb3');
  });

  it('puts a second quarterback in the superflex when he outscores the flex options', () => {
    const sfRoster: RosterSettings = {
      slots: { QB: 1, RB: 1, WR: 1, SUPERFLEX: 1 },
      benchSize: 5,
      irSlots: 0,
    };
    const lineup = optimizeLineup(
      [
        c('QB', 24, { id: 'qb1' }),
        c('QB', 21, { id: 'qb2' }),
        c('RB', 14, { id: 'rb1' }),
        c('WR', 13, { id: 'wr1' }),
        c('WR', 10, { id: 'wr2' }),
      ],
      sfRoster,
    );
    expect(lineup.assignments.find((a) => a.slot === 'SUPERFLEX')?.playerId).toBe('qb2');
    expect(lineup.total).toBe(72);
  });

  it('leaves out players who cannot suit up', () => {
    const lineup = optimizeLineup(
      [
        c('QB', 25, { id: 'hurt', injuryStatus: 'OUT' }),
        c('QB', 12, { id: 'healthy' }),
        c('RB', 10, { id: 'rb1' }),
        c('RB', 9, { id: 'rb2' }),
        c('WR', 9, { id: 'wr1' }),
        c('WR', 8, { id: 'wr2' }),
        c('TE', 6, { id: 'te1' }),
      ],
      roster,
    );
    expect(lineup.assignments.find((a) => a.slot === 'QB')?.playerId).toBe('healthy');
  });

  it('leaves a slot empty rather than starting an ineligible player', () => {
    const lineup = optimizeLineup([c('RB', 10, { id: 'rb1' })], {
      slots: { QB: 1, RB: 1 },
      benchSize: 2,
      irSlots: 0,
    });
    expect(lineup.assignments.find((a) => a.slot === 'QB')?.playerId).toBeNull();
    expect(lineup.total).toBe(10);
  });

  it('values a spare running back at almost nothing on a deep roster', () => {
    const deep = [
      c('QB', 20, { id: 'qb1' }),
      c('RB', 18, { id: 'rb1' }),
      c('RB', 17, { id: 'rb2' }),
      c('RB', 16, { id: 'rb3' }),
      c('RB', 15, { id: 'rb4' }),
      c('WR', 14, { id: 'wr1' }),
      c('WR', 13, { id: 'wr2' }),
      c('TE', 9, { id: 'te1' }),
    ];
    // rb4 is behind rb3 for the flex spot, so losing him costs nothing.
    expect(marginalLineupValue(deep, roster, 'rb4')).toBe(0);
    // rb1 is a genuine starter — losing him costs the gap down to rb4.
    expect(marginalLineupValue(deep, roster, 'rb1')).toBe(3);
  });

  it('measures what an add is actually worth to a specific roster', () => {
    const thin = [
      c('QB', 20, { id: 'qb1' }),
      c('RB', 18, { id: 'rb1' }),
      c('WR', 14, { id: 'wr1' }),
      c('WR', 13, { id: 'wr2' }),
      c('TE', 9, { id: 'te1' }),
    ];
    // An RB2 slot and the flex are both empty, so a decent back is worth his full score.
    expect(lineupGainFromAdding(thin, roster, c('RB', 11, { id: 'new' }))).toBe(11);

    const deep = [...thin, c('RB', 16, { id: 'rb2' }), c('RB', 15, { id: 'rb3' })];
    // Now he only beats out nobody — the same player adds nothing.
    expect(lineupGainFromAdding(deep, roster, c('RB', 11, { id: 'new2' }))).toBe(0);
  });
});

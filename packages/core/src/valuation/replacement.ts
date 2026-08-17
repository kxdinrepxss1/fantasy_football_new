import {
  POSITIONS,
  SLOT_ELIGIBILITY,
  type LineupSlot,
  type Position,
  type RosterSettings,
} from '../types.js';
import { startingSlots } from '../lineup/optimizer.js';

/** Projection curve for one position: points per game, sorted best to worst. */
export type PositionCurves = Record<Position, number[]>;

export interface ReplacementLevels {
  /** League-wide count of starters demanded at each position. */
  demand: Record<Position, number>;
  /** Points-per-game of the first player past the starter cutoff. */
  replacementPoints: Record<Position, number>;
  /** How many of the demanded starters came from flex-type slots. */
  flexDemand: Record<Position, number>;
}

function emptyCounts(): Record<Position, number> {
  return { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
}

/**
 * Work out, for this specific league, how deep into each position the starting
 * requirement actually reaches — and therefore who counts as "replacement level".
 *
 * This is where league settings turn into positional value. A 12-team league
 * starting one QB needs 12 QBs, so QB13 is freely available and even a very good
 * QB is only worth a little more than a waiver-wire one. Add a superflex and the
 * requirement jumps toward 24, the replacement QB becomes genuinely bad, and
 * every startable QB gains a lot of value. Nothing in the trade calculator needs
 * a special case for superflex — it falls out of this calculation.
 *
 * Multi-position slots are allocated greedily: each flex seat goes to whichever
 * eligible position has the best player still unclaimed, which is how real
 * managers fill them.
 */
export function computeReplacementLevels(
  curves: PositionCurves,
  roster: RosterSettings,
  teamCount: number,
): ReplacementLevels {
  const demand = emptyCounts();
  const flexDemand = emptyCounts();

  const slots = startingSlots(roster);
  const flexSlots: LineupSlot[] = [];

  for (const slot of slots) {
    const eligible = SLOT_ELIGIBILITY[slot];
    if (eligible.length === 1) {
      const pos = eligible[0]!;
      demand[pos] += teamCount;
    } else {
      flexSlots.push(slot);
    }
  }

  // Each flex seat across the whole league picks the best remaining player among
  // the positions it accepts.
  for (const slot of flexSlots) {
    const eligible = SLOT_ELIGIBILITY[slot];
    for (let i = 0; i < teamCount; i++) {
      let bestPos: Position | null = null;
      let bestValue = -Infinity;
      for (const pos of eligible) {
        const value = curves[pos]?.[demand[pos]] ?? -Infinity;
        if (value > bestValue) {
          bestValue = value;
          bestPos = pos;
        }
      }
      if (bestPos) {
        demand[bestPos] += 1;
        flexDemand[bestPos] += 1;
      }
    }
  }

  const replacementPoints = emptyCounts();
  for (const pos of POSITIONS) {
    const curve = curves[pos] ?? [];
    if (curve.length === 0) {
      replacementPoints[pos] = 0;
      continue;
    }
    // The first player past the starter cutoff is what you can get for free.
    const idx = Math.min(demand[pos], curve.length - 1);
    replacementPoints[pos] = curve[idx] ?? 0;
  }

  return { demand, replacementPoints, flexDemand };
}

/**
 * Build per-position projection curves from a flat list of projections.
 * Curves are the raw material for both replacement level and positional rank.
 */
export function buildPositionCurves(
  players: Array<{ position: Position; perGame: number }>,
): PositionCurves {
  const curves: PositionCurves = { QB: [], RB: [], WR: [], TE: [], K: [], DST: [] };
  for (const p of players) curves[p.position].push(p.perGame);
  for (const pos of POSITIONS) curves[pos].sort((a, b) => b - a);
  return curves;
}

/**
 * Positional rank (1-based) for a points-per-game value within its curve.
 * Ties resolve to the better rank, matching how "RB8" is quoted in practice.
 */
export function positionalRank(curve: number[], perGame: number): number {
  let rank = 1;
  for (const v of curve) {
    if (v > perGame) rank++;
    else break;
  }
  return rank;
}

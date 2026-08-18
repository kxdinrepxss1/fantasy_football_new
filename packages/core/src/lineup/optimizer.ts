import {
  SLOT_ELIGIBILITY,
  slotAccepts,
  type LineupSlot,
  type Player,
  type RosterSettings,
} from '../types.js';

export interface LineupCandidate {
  player: Player;
  /** Projected points used for the optimisation, already in league scoring. */
  points: number;
}

export interface LineupAssignment {
  slot: LineupSlot;
  playerId: string | null;
  points: number;
}

export interface OptimalLineup {
  assignments: LineupAssignment[];
  /** Total projected points of the optimal starting lineup. */
  total: number;
  /** Players who did not make the starting lineup. */
  benched: LineupCandidate[];
}

/** Starting slots only — BENCH and IR never hold a scoring player. */
export function startingSlots(roster: RosterSettings): LineupSlot[] {
  const out: LineupSlot[] = [];
  for (const [slot, count] of Object.entries(roster.slots) as [LineupSlot, number][]) {
    if (slot === 'BENCH' || slot === 'IR') continue;
    for (let i = 0; i < (count ?? 0); i++) out.push(slot);
  }
  return out;
}

/**
 * Fill the starting lineup to maximise projected points.
 *
 * The slot eligibility sets in this app form a laminar family — every set is
 * either disjoint from or fully contained in every other (QB ⊂ SUPERFLEX,
 * WR ⊂ REC_FLEX ⊂ FLEX ⊂ SUPERFLEX, and so on). For a laminar family, filling
 * the most restrictive slots first and always taking the best eligible player
 * left is provably optimal, so we get the exact answer without searching.
 */
export function optimizeLineup(
  candidates: LineupCandidate[],
  roster: RosterSettings,
): OptimalLineup {
  const slots = startingSlots(roster).sort(
    (a, b) => SLOT_ELIGIBILITY[a].length - SLOT_ELIGIBILITY[b].length,
  );

  // Best-first within each position so the pick per slot is a simple scan.
  const pool = [...candidates].sort((a, b) => b.points - a.points);
  const used = new Set<string>();
  const assignments: LineupAssignment[] = [];
  let total = 0;

  for (const slot of slots) {
    const pick = pool.find(
      (c) => !used.has(c.player.id) && slotAccepts(slot, c.player.position) && isStartable(c.player),
    );
    if (pick) {
      used.add(pick.player.id);
      assignments.push({ slot, playerId: pick.player.id, points: pick.points });
      total += pick.points;
    } else {
      assignments.push({ slot, playerId: null, points: 0 });
    }
  }

  return {
    assignments,
    total: Math.round((total + Number.EPSILON) * 100) / 100,
    benched: pool.filter((c) => !used.has(c.player.id)),
  };
}

/** A player who cannot suit up should not be counted as a starter. */
function isStartable(player: Player): boolean {
  return player.injuryStatus !== 'OUT' && player.injuryStatus !== 'IR' && player.injuryStatus !== 'PUP';
}

/**
 * How many points the starting lineup would lose if this player vanished.
 * This is the honest measure of what a player is worth *to a specific roster*:
 * a third good RB on an RB-rich team has a small delta, the same RB on a bare
 * roster has a large one.
 */
export function marginalLineupValue(
  candidates: LineupCandidate[],
  roster: RosterSettings,
  playerId: string,
): number {
  const withPlayer = optimizeLineup(candidates, roster).total;
  const withoutPlayer = optimizeLineup(
    candidates.filter((c) => c.player.id !== playerId),
    roster,
  ).total;
  return Math.round((withPlayer - withoutPlayer + Number.EPSILON) * 100) / 100;
}

/** Points the lineup would gain by adding this player to the roster. */
export function lineupGainFromAdding(
  candidates: LineupCandidate[],
  roster: RosterSettings,
  incoming: LineupCandidate,
): number {
  const before = optimizeLineup(candidates, roster).total;
  const after = optimizeLineup([...candidates, incoming], roster).total;
  return Math.round((after - before + Number.EPSILON) * 100) / 100;
}

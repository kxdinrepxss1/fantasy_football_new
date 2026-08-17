import { lineupGainFromAdding, marginalLineupValue, optimizeLineup, type LineupCandidate } from '../lineup/optimizer.js';
import { POSITIONS, type LeagueSettings, type Position } from '../types.js';
import type { ValuationContext, ValuationInput } from '../valuation/value.js';
import { valuePlayer } from '../valuation/value.js';

/** A player counts as "trending" once weekly rostership moves this much. */
const TRENDING_DELTA_PCT = 4;

export interface WaiverInput {
  /** The team being advised, with projections for everyone on its roster. */
  roster: ValuationInput[];
  /** Unrostered players in the league. */
  available: ValuationInput[];
  /** All rostered players league-wide — used to spot injury-driven openings. */
  leagueRostered?: ValuationInput[];
  settings: LeagueSettings;
  ctx: ValuationContext;
  /** Weeks to look ahead for bye coverage. Defaults to the next 4. */
  currentWeek?: number;
  lookaheadWeeks?: number;
}

export interface DropCandidate {
  playerId: string;
  name: string;
  position: Position;
  /** Points per game the lineup loses by cutting him — lower is safer to drop. */
  lineupCost: number;
  reason: string;
}

export interface WaiverRecommendation {
  playerId: string;
  name: string;
  position: Position;
  positionalRank: number;
  perGame: number;
  /** Market value from the league-wide valuation. */
  rawValue: number;
  /** Points per game this add would swing this team's starting lineup. */
  lineupGain: number;
  /** Composite ranking score for this specific team. */
  fitScore: number;
  trending: boolean;
  rosteredPctDelta: number;
  /** Set when a starter ahead of him is hurt. */
  opportunity: string | null;
  /** Bye weeks this add would cover that the roster currently cannot. */
  coversByeWeeks: number[];
  dropCandidate: DropCandidate | null;
  reasons: string[];
}

/** Positions the roster is thin at, scored by how badly they are covered. */
export interface RosterNeed {
  position: Position;
  /** Startable bodies at this position, counting injuries. */
  depth: number;
  /** Starting slots the league demands at this position. */
  required: number;
  severity: 'critical' | 'thin' | 'ok' | 'surplus';
}

function toCandidates(inputs: ValuationInput[]): LineupCandidate[] {
  return inputs.map((i) => ({ player: i.player, points: i.perGame }));
}

function isAvailableToPlay(status: string): boolean {
  return status !== 'OUT' && status !== 'IR' && status !== 'PUP' && status !== 'SUSPENDED';
}

/**
 * Where this roster is actually short. Required counts include a share of any
 * flex slots so a team in a 3-WR league is not told it is fine with three
 * receivers when one bye week would leave it starting an empty slot.
 */
export function analyzeRosterNeeds(
  roster: ValuationInput[],
  settings: LeagueSettings,
): RosterNeed[] {
  const required: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 };
  for (const [slot, count] of Object.entries(settings.roster.slots)) {
    if (!count || slot === 'BENCH' || slot === 'IR') continue;
    if (slot === 'FLEX') {
      required.RB += count * 0.5;
      required.WR += count * 0.4;
      required.TE += count * 0.1;
    } else if (slot === 'SUPERFLEX') {
      required.QB += count * 0.8;
      required.RB += count * 0.1;
      required.WR += count * 0.1;
    } else if (slot === 'REC_FLEX') {
      required.WR += count * 0.75;
      required.TE += count * 0.25;
    } else if ((POSITIONS as readonly string[]).includes(slot)) {
      required[slot as Position] += count;
    }
  }

  return POSITIONS.map((pos) => {
    const depth = roster.filter(
      (r) => r.player.position === pos && isAvailableToPlay(r.player.injuryStatus),
    ).length;
    const req = required[pos];
    let severity: RosterNeed['severity'] = 'ok';
    if (depth < req) {
      severity = 'critical';
    } else if (req >= 2 && depth < req + 1) {
      // Only positions that start more than one player warrant a "carry a
      // backup" nudge. At kicker and defense — and quarterback outside
      // superflex — having exactly the required number is how leagues are
      // actually played, and flagging it as thin pushes streamable defenses to
      // the top of every waiver list.
      severity = 'thin';
    } else if (depth >= req + 2.5) {
      severity = 'surplus';
    }
    return { position: pos, depth, required: Math.round(req * 10) / 10, severity };
  });
}

/** Bye weeks where this roster cannot field a legal starting lineup at a position. */
function uncoveredByeWeeks(
  roster: ValuationInput[],
  settings: LeagueSettings,
  currentWeek: number,
  lookahead: number,
): Map<Position, number[]> {
  const out = new Map<Position, number[]>();
  const needs = analyzeRosterNeeds(roster, settings);

  for (let week = currentWeek; week < currentWeek + lookahead; week++) {
    for (const need of needs) {
      // Bye coverage asks a narrow question: can this roster field a *legal*
      // lineup that week? That is the dedicated slot count, so the fractional
      // flex share is floored away — otherwise every team looks permanently
      // short at tight end because flex contributes a tenth of a starter.
      const mustField = Math.floor(need.required);
      if (mustField < 1) continue;
      const availableThatWeek = roster.filter(
        (r) =>
          r.player.position === need.position &&
          r.player.byeWeek !== week &&
          isAvailableToPlay(r.player.injuryStatus),
      ).length;
      if (availableThatWeek < mustField) {
        const list = out.get(need.position) ?? [];
        if (!list.includes(week)) list.push(week);
        out.set(need.position, list);
      }
    }
  }
  return out;
}

/**
 * A starter on the same NFL team and position who is now hurt — the classic
 * "handcuff just became the starter" waiver claim.
 */
function injuryOpportunity(
  candidate: ValuationInput,
  leagueRostered: ValuationInput[],
): string | null {
  const hurtAhead = leagueRostered.filter(
    (r) =>
      r.player.nflTeam &&
      r.player.nflTeam === candidate.player.nflTeam &&
      r.player.position === candidate.player.position &&
      r.player.id !== candidate.player.id &&
      !isAvailableToPlay(r.player.injuryStatus) &&
      r.perGame > candidate.perGame,
  );
  if (hurtAhead.length === 0) return null;
  const worst = hurtAhead.sort((a, b) => b.perGame - a.perGame)[0]!;
  return `${worst.player.name} (${worst.player.injuryStatus.toLowerCase()}) is ahead of him in ${candidate.player.nflTeam} — the workload should shift his way`;
}

/**
 * Pick who to cut for an add. The safest drop is the bench player whose removal
 * costs the starting lineup the least, with a nudge toward players who are hurt
 * or who play a position the roster is already deep at.
 */
export function suggestDrop(
  roster: ValuationInput[],
  settings: LeagueSettings,
  ctx: ValuationContext,
  protectPlayerIds: string[] = [],
): DropCandidate | null {
  const candidates = toCandidates(roster);
  const lineup = optimizeLineup(candidates, settings.roster);
  const starterIds = new Set(lineup.assignments.map((a) => a.playerId).filter(Boolean) as string[]);

  const benchOnly = roster.filter(
    (r) => !starterIds.has(r.player.id) && !protectPlayerIds.includes(r.player.id),
  );

  // A roster with no bench still has to cut someone to make an add, so fall back
  // to the full roster rather than refusing to answer. The cost of the drop is
  // reported either way, so the caller can see when it hurts.
  const droppable =
    benchOnly.length > 0
      ? benchOnly
      : roster.filter((r) => !protectPlayerIds.includes(r.player.id));
  if (droppable.length === 0) return null;
  const cuttingAStarter = benchOnly.length === 0;

  const needs = new Map(analyzeRosterNeeds(roster, settings).map((n) => [n.position, n]));

  const scored = droppable.map((r) => {
    const lineupCost = marginalLineupValue(candidates, settings.roster, r.player.id);
    const value = valuePlayer(r, ctx);
    const need = needs.get(r.player.position);
    // Depth at a surplus position is the cheapest thing to give up.
    const surplusBonus = need?.severity === 'surplus' ? -0.15 : need?.severity === 'critical' ? 0.3 : 0;
    const injuredPenalty = isAvailableToPlay(r.player.injuryStatus) ? 0 : -0.25;
    return {
      entry: r,
      lineupCost,
      // Lower is more droppable.
      dropScore: value.value * (1 + surplusBonus + injuredPenalty),
    };
  });

  scored.sort((a, b) => a.dropScore - b.dropScore);
  const pick = scored[0]!;
  const need = needs.get(pick.entry.player.position);

  const bits: string[] = [];
  if (!isAvailableToPlay(pick.entry.player.injuryStatus)) {
    bits.push(`he is ${pick.entry.player.injuryStatus.toLowerCase()}`);
  }
  if (need?.severity === 'surplus') bits.push(`you are ${need.depth} deep at ${need.position}`);
  if (pick.lineupCost <= 0) bits.push('he never cracks your optimal lineup');

  const reason = cuttingAStarter
    ? `You have no bench to cut — this is your cheapest starter to lose, at ${pick.lineupCost.toFixed(1)} pts/gm.`
    : bits.length
      ? `Lowest-cost drop — ${bits.join(', ')}.`
      : 'Lowest-value bench player.';

  return {
    playerId: pick.entry.player.id,
    name: pick.entry.player.name,
    position: pick.entry.player.position,
    lineupCost: pick.lineupCost,
    reason,
  };
}

/**
 * Rank the waiver wire for one specific team.
 *
 * The ordering is deliberately not "best player available". It is how much this
 * roster improves, which folds in positional need, what the add does to the
 * optimal starting lineup, bye weeks the team currently cannot cover, and
 * whether an injury just opened up a role.
 */
export function recommendWaivers(input: WaiverInput, limit = 25): WaiverRecommendation[] {
  const {
    roster,
    available,
    settings,
    ctx,
    leagueRostered = [],
    currentWeek = 1,
    lookaheadWeeks = 4,
  } = input;

  const candidates = toCandidates(roster);
  const byeGaps = uncoveredByeWeeks(roster, settings, currentWeek, lookaheadWeeks);
  const needs = new Map(analyzeRosterNeeds(roster, settings).map((n) => [n.position, n]));

  /**
   * How many players at a position should get the "fills a hole" treatment.
   *
   * A roster starting three receivers with only one on it needs two more; a
   * roster whose lone defense is on bye needs exactly one. Boosting every
   * candidate at the position instead would bury the rest of the wire under
   * five interchangeable defenses, which is the most common way a waiver list
   * stops being useful.
   */
  const slotsToFill = new Map<Position, number>();
  for (const need of needs.values()) {
    const short = Math.max(0, Math.ceil(need.required - need.depth));
    const byeGap = (byeGaps.get(need.position) ?? []).length > 0 ? 1 : 0;
    const boostable = Math.max(short, byeGap);
    if (boostable > 0) slotsToFill.set(need.position, boostable);
  }

  const scored = available.map((entry) => {
    const value = valuePlayer(entry, ctx);
    const lineupGain = lineupGainFromAdding(candidates, settings.roster, {
      player: entry.player,
      points: entry.perGame,
    });

    const gapWeeks = byeGaps.get(entry.player.position) ?? [];
    const coversByeWeeks = gapWeeks.filter((w) => entry.player.byeWeek !== w);
    const opportunity = injuryOpportunity(entry, leagueRostered);

    // Lineup impact is what actually wins matchups, so it carries the ranking;
    // market value keeps genuinely good players ahead of marginal streamers who
    // happen to plug a hole this week.
    const base = lineupGain * 10 + value.value * 0.35;

    return { entry, value, lineupGain, coversByeWeeks, opportunity, base };
  });

  // Rank within each position so the players that fill a hole are the best ones
  // available there, not whoever happens to come first.
  const rankInPosition = new Map<string, number>();
  for (const position of POSITIONS) {
    const inPos = scored
      .filter((s) => s.entry.player.position === position)
      .sort((a, b) => b.base - a.base);
    inPos.forEach((s, i) => rankInPosition.set(s.entry.player.id, i));
  }

  const recs = scored.map((s): WaiverRecommendation => {
    const { entry, value, lineupGain, coversByeWeeks, opportunity } = s;
    const need = needs.get(entry.player.position);

    // Only the players who would actually fill the gap get the boosts.
    const fillable = slotsToFill.get(entry.player.position) ?? 0;
    const fillsAHole = (rankInPosition.get(entry.player.id) ?? 0) < fillable;

    const needBoost = !fillsAHole
      ? need?.severity === 'surplus'
        ? 0.8
        : 1
      : need?.severity === 'critical'
        ? 1.35
        : need?.severity === 'thin'
          ? 1.15
          : 1;

    const byeBoost = fillsAHole && coversByeWeeks.length > 0 ? 1.1 : 1;

    const delta = entry.player.rosteredPctDelta ?? 0;
    const trending = delta >= TRENDING_DELTA_PCT;
    const opportunityBoost = opportunity ? 1.2 : 1;

    const fitScore = s.base * needBoost * byeBoost * opportunityBoost;

    const reasons: string[] = [];
    reasons.push(value.reasons[0]!);
    if (lineupGain > 0) {
      reasons.push(`would start for you immediately, worth ${lineupGain.toFixed(1)} pts/gm`);
    } else if (need?.severity === 'critical' || need?.severity === 'thin') {
      reasons.push(`depth at ${entry.player.position}, where you are ${need.severity}`);
    }
    if (opportunity) reasons.push(opportunity);
    if (trending) reasons.push(`rostership up ${delta.toFixed(0)} pts this week`);
    // Only claim to cover a bye when this is one of the players that actually
    // would; the sixth-best defense does not solve anything the first has not.
    const covers = fillsAHole ? coversByeWeeks : [];
    if (covers.length > 0) {
      reasons.push(`covers your week ${covers.join(', ')} hole at ${entry.player.position}`);
    }

    return {
      playerId: entry.player.id,
      name: entry.player.name,
      position: entry.player.position,
      positionalRank: value.positionalRank,
      perGame: entry.perGame,
      rawValue: value.value,
      lineupGain,
      fitScore: Math.round(fitScore * 10) / 10,
      trending,
      rosteredPctDelta: delta,
      opportunity,
      coversByeWeeks: covers,
      dropCandidate: null,
      reasons,
    };
  });

  recs.sort((a, b) => b.fitScore - a.fitScore);
  const top = recs.slice(0, limit);

  // The drop suggestion depends only on the roster, so it is computed once and
  // shared rather than re-running the lineup optimizer for every row.
  const rosterFull = roster.length >= settings.roster.benchSize + countStartingSlots(settings);
  const drop = rosterFull ? suggestDrop(roster, settings, ctx) : null;
  for (const rec of top) rec.dropCandidate = drop;

  return top;
}

function countStartingSlots(settings: LeagueSettings): number {
  return Object.entries(settings.roster.slots)
    .filter(([slot]) => slot !== 'BENCH' && slot !== 'IR')
    .reduce((n, [, count]) => n + (count ?? 0), 0);
}

/** League-wide trending adds, independent of any one team's needs. */
export function trendingAdds(
  available: ValuationInput[],
  limit = 10,
): Array<{ playerId: string; name: string; position: Position; delta: number; rosteredPct: number }> {
  return available
    .filter((a) => (a.player.rosteredPctDelta ?? 0) > 0)
    .sort((a, b) => (b.player.rosteredPctDelta ?? 0) - (a.player.rosteredPctDelta ?? 0))
    .slice(0, limit)
    .map((a) => ({
      playerId: a.player.id,
      name: a.player.name,
      position: a.player.position,
      delta: a.player.rosteredPctDelta ?? 0,
      rosteredPct: a.player.rosteredPct ?? 0,
    }));
}

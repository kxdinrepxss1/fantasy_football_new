import type { LeagueSettings, Player, Position } from '../types.js';
import { ageMultiplier, clamp, describeAge } from './ageCurves.js';
import {
  buildPositionCurves,
  computeReplacementLevels,
  positionalRank,
  type PositionCurves,
  type ReplacementLevels,
} from './replacement.js';

/**
 * How much a steeper-than-normal stretch of the positional curve inflates value.
 * Kept deliberately modest: rank should matter, but it shouldn't overwhelm the
 * points a player actually scores.
 */
const SCARCITY_WEIGHT = 0.18;

/** How many spots down the curve we look to measure the drop-off behind a player. */
const SCARCITY_WINDOW = 4;

/**
 * Sub-replacement players still have value — they occupy a bench spot and can be
 * started in a bye week. This keeps their ordering sensible instead of flattening
 * everyone below the starter cutoff to zero.
 */
const BENCH_FLOOR_WEIGHT = 0.12;

export interface ValuationInput {
  player: Player;
  /** Projected points per game in this league's scoring. */
  perGame: number;
  /** Games left this season for this player. */
  gamesRemaining: number;
}

export interface PlayerValue {
  playerId: string;
  position: Position;
  perGame: number;
  /** 1-based rank within position, e.g. 8 means "RB8". */
  positionalRank: number;
  /** Points per game above the freely-available replacement at this position. */
  vorpPerGame: number;
  /** Season-long value over replacement, before adjustments. */
  baseValue: number;
  ageMultiplier: number;
  /** Multiplier from local steepness of the positional curve. */
  scarcityMultiplier: number;
  /** Final value in league-points-over-replacement units. */
  value: number;
  /** 0-100 scale relative to the most valuable player in the pool. */
  score: number;
  reasons: string[];
}

export interface ValuationContext {
  settings: LeagueSettings;
  curves: PositionCurves;
  replacement: ReplacementLevels;
}

export function buildValuationContext(
  pool: ValuationInput[],
  settings: LeagueSettings,
): ValuationContext {
  const curves = buildPositionCurves(
    pool.map((p) => ({ position: p.player.position, perGame: p.perGame })),
  );
  const replacement = computeReplacementLevels(curves, settings.roster, settings.teamCount);
  return { settings, curves, replacement };
}

/**
 * Average drop over a `SCARCITY_WINDOW` stretch across the startable range of a
 * position — the yardstick a player's own local drop-off is measured against.
 */
function averageDrop(curve: number[], demand: number): number {
  const end = Math.max(2, Math.min(demand, curve.length - 1));
  let sum = 0;
  let n = 0;
  for (let i = 0; i < end; i++) {
    const a = curve[i];
    const b = curve[Math.min(i + SCARCITY_WINDOW, curve.length - 1)];
    if (a === undefined || b === undefined) continue;
    sum += a - b;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

export function valuePlayer(input: ValuationInput, ctx: ValuationContext): PlayerValue {
  const { player, perGame, gamesRemaining } = input;
  const pos = player.position;
  const curve = ctx.curves[pos] ?? [];
  const rank = positionalRank(curve, perGame);
  const replacementPoints = ctx.replacement.replacementPoints[pos] ?? 0;
  const vorpPerGame = perGame - replacementPoints;

  const baseValue =
    (Math.max(vorpPerGame, 0) + BENCH_FLOOR_WEIGHT * Math.max(perGame, 0)) * gamesRemaining;

  const age = ageMultiplier(pos, player.age, ctx.settings.dynastyWeight);

  // Local steepness: how much production falls off in the few spots behind him.
  const here = curve[rank - 1] ?? perGame;
  const below = curve[Math.min(rank - 1 + SCARCITY_WINDOW, curve.length - 1)] ?? here;
  const localDrop = here - below;
  const avgDrop = averageDrop(curve, ctx.replacement.demand[pos] ?? 1);
  const relativeSteepness = avgDrop > 0 ? localDrop / avgDrop - 1 : 0;
  const scarcity = 1 + SCARCITY_WEIGHT * clamp(relativeSteepness, -0.5, 1.5);

  const value = baseValue * age * scarcity;

  const reasons: string[] = [];
  reasons.push(
    `${pos}${rank} at ${perGame.toFixed(1)} pts/gm, ${vorpPerGame >= 0 ? '+' : ''}${vorpPerGame.toFixed(1)} vs the ${pos} you could stream (${replacementPoints.toFixed(1)})`,
  );
  const ageNote = describeAge(pos, player.age);
  if (ageNote && Math.abs(age - 1) > 0.01) {
    reasons.push(`${ageNote}${ctx.settings.dynastyWeight < 1 ? ', softened for a mostly-redraft league' : ''}`);
  }
  if (Math.abs(scarcity - 1) > 0.02) {
    reasons.push(
      scarcity > 1
        ? `sits on a steep part of the ${pos} board — the next ${SCARCITY_WINDOW} are ${localDrop.toFixed(1)} pts/gm worse`
        : `sits on a flat part of the ${pos} board, so he is easier to replace than his rank suggests`,
    );
  }
  if (player.injuryStatus !== 'ACTIVE') {
    reasons.push(`currently ${player.injuryStatus.toLowerCase()}`);
  }

  return {
    playerId: player.id,
    position: pos,
    perGame,
    positionalRank: rank,
    vorpPerGame: r2(vorpPerGame),
    baseValue: r2(baseValue),
    ageMultiplier: r3(age),
    scarcityMultiplier: r3(scarcity),
    value: r2(value),
    score: 0,
    reasons,
  };
}

/** Value an entire pool and attach the 0-100 comparative score. */
export function valuePool(pool: ValuationInput[], ctx: ValuationContext): PlayerValue[] {
  const valued = pool.map((p) => valuePlayer(p, ctx));
  const max = valued.reduce((m, v) => Math.max(m, v.value), 0);
  if (max > 0) for (const v of valued) v.score = r1((v.value / max) * 100);
  return valued;
}

export function valuePoolAsMap(
  pool: ValuationInput[],
  ctx: ValuationContext,
): Map<string, PlayerValue> {
  return new Map(valuePool(pool, ctx).map((v) => [v.playerId, v]));
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

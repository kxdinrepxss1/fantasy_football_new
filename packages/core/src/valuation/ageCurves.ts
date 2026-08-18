import type { Position } from '../types.js';

/**
 * A positional aging curve.
 *
 * `peakStart`..`peakEnd` is the plateau where a player is at full value.
 * Below the plateau a player is still ascending — in a league that cares about
 * the future that is a *bonus*, because the remaining runway is longer.
 * Above the plateau value falls off at `declinePerYear`, compounding.
 *
 * The shape differences are the point: running backs fall off a cliff in their
 * late twenties, receivers and quarterbacks hold value far longer. Without this,
 * "similar production, different age" trades grade out as even, which is the
 * single most common way a trade calculator misleads people.
 */
export interface AgeCurve {
  peakStart: number;
  peakEnd: number;
  /** Compounding fractional loss per year past peakEnd. */
  declinePerYear: number;
  /** Compounding fractional gain per year below peakStart (capped by maxYouthBonus). */
  risePerYear: number;
  maxYouthBonus: number;
  /** Floor so an old player never values at zero. */
  floor: number;
}

export const AGE_CURVES: Record<Position, AgeCurve> = {
  QB: {
    peakStart: 26,
    peakEnd: 33,
    declinePerYear: 0.05,
    risePerYear: 0.03,
    maxYouthBonus: 0.12,
    floor: 0.4,
  },
  RB: {
    peakStart: 23,
    peakEnd: 26,
    declinePerYear: 0.14,
    risePerYear: 0.04,
    maxYouthBonus: 0.1,
    floor: 0.25,
  },
  WR: {
    peakStart: 25,
    peakEnd: 29,
    declinePerYear: 0.08,
    risePerYear: 0.05,
    maxYouthBonus: 0.15,
    floor: 0.3,
  },
  TE: {
    peakStart: 25,
    peakEnd: 30,
    declinePerYear: 0.07,
    risePerYear: 0.04,
    maxYouthBonus: 0.12,
    floor: 0.3,
  },
  // Kickers and defenses are volatile and effectively ageless for fantasy.
  K: { peakStart: 22, peakEnd: 40, declinePerYear: 0.0, risePerYear: 0, maxYouthBonus: 0, floor: 1 },
  DST: {
    peakStart: 0,
    peakEnd: 99,
    declinePerYear: 0,
    risePerYear: 0,
    maxYouthBonus: 0,
    floor: 1,
  },
};

/**
 * Raw age multiplier on a full-dynasty horizon, before the league's
 * dynastyWeight is applied.
 */
export function rawAgeMultiplier(position: Position, age: number | null): number {
  if (age === null) return 1;
  const curve = AGE_CURVES[position];

  if (age >= curve.peakStart && age <= curve.peakEnd) return 1;

  if (age < curve.peakStart) {
    const yearsToPeak = curve.peakStart - age;
    const bonus = Math.min(curve.maxYouthBonus, yearsToPeak * curve.risePerYear);
    return 1 + bonus;
  }

  const yearsPast = age - curve.peakEnd;
  const multiplier = Math.pow(1 - curve.declinePerYear, yearsPast);
  return Math.max(curve.floor, multiplier);
}

/**
 * Age multiplier scaled to how much this league actually cares about the future.
 *
 * In a pure redraft league (dynastyWeight 0) age is nearly irrelevant — all that
 * matters is what a player does over the next few months — so the multiplier
 * collapses toward 1. In a dynasty league it applies in full.
 */
export function ageMultiplier(
  position: Position,
  age: number | null,
  dynastyWeight: number,
): number {
  const raw = rawAgeMultiplier(position, age);
  const weight = clamp(dynastyWeight, 0, 1);
  return 1 + (raw - 1) * weight;
}

/** Plain-language note about what age is doing to this player's value. */
export function describeAge(position: Position, age: number | null): string | null {
  if (age === null) return null;
  const curve = AGE_CURVES[position];
  const raw = rawAgeMultiplier(position, age);
  if (age > curve.peakEnd) {
    const pct = Math.round((1 - raw) * 100);
    return `${age} is past the ${position} plateau (${curve.peakStart}-${curve.peakEnd}), costing about ${pct}% of long-term value`;
  }
  if (age < curve.peakStart) {
    const pct = Math.round((raw - 1) * 100);
    return pct > 0
      ? `${age} is still ascending toward the ${position} peak (${curve.peakStart}), worth about ${pct}% extra`
      : null;
  }
  return `${age} is squarely in the ${position} prime (${curve.peakStart}-${curve.peakEnd})`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

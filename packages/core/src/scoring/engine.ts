import type { ScoringSettings, ScoringTier, StatKey, StatLine } from '../types.js';

/** Stats that are scored through a tier table rather than per-unit. */
const TIERED_STATS = new Set<StatKey>(['def_pts_allowed', 'def_yds_allowed']);

export function tierPoints(tiers: ScoringTier[], value: number): number {
  for (const tier of tiers) {
    const underMax = tier.max === null || value <= tier.max;
    if (value >= tier.min && underMax) return tier.points;
  }
  return 0;
}

export interface ScoreBreakdownRow {
  stat: StatKey;
  value: number;
  points: number;
}

export interface ScoreResult {
  total: number;
  breakdown: ScoreBreakdownRow[];
}

/**
 * Score a single stat line under a league's scoring settings.
 *
 * Everything countable is a per-unit multiply; the two defensive "allowed"
 * stats run through their tier tables. Rounded to 2dp at the end so that a
 * league's displayed score always matches the sum of its own breakdown rows.
 */
export function scoreStatLine(stats: StatLine, scoring: ScoringSettings): ScoreResult {
  const breakdown: ScoreBreakdownRow[] = [];
  let total = 0;

  for (const [key, rawValue] of Object.entries(stats) as [StatKey, number | undefined][]) {
    if (rawValue === undefined || rawValue === null) continue;
    if (TIERED_STATS.has(key)) continue;

    const perUnit = scoring.perUnit[key];
    if (!perUnit) continue;

    const points = rawValue * perUnit;
    if (points === 0) continue;
    breakdown.push({ stat: key, value: rawValue, points: round2(points) });
    total += points;
  }

  if (stats.def_pts_allowed !== undefined) {
    const points = tierPoints(scoring.defPointsAllowedTiers, stats.def_pts_allowed);
    if (points !== 0) {
      breakdown.push({ stat: 'def_pts_allowed', value: stats.def_pts_allowed, points });
      total += points;
    }
  }

  if (stats.def_yds_allowed !== undefined) {
    const points = tierPoints(scoring.defYardsAllowedTiers, stats.def_yds_allowed);
    if (points !== 0) {
      breakdown.push({ stat: 'def_yds_allowed', value: stats.def_yds_allowed, points });
      total += points;
    }
  }

  breakdown.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { total: round2(total), breakdown };
}

/** Sum a set of stat lines (e.g. a whole team's starters) into one score. */
export function scoreMany(
  lines: Array<{ playerId: string; stats: StatLine }>,
  scoring: ScoringSettings,
): { total: number; byPlayer: Record<string, number> } {
  const byPlayer: Record<string, number> = {};
  let total = 0;
  for (const line of lines) {
    const { total: pts } = scoreStatLine(line.stats, scoring);
    byPlayer[line.playerId] = pts;
    total += pts;
  }
  return { total: round2(total), byPlayer };
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

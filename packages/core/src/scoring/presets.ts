import type { LeagueSettings, RosterSettings, ScoringSettings, ScoringTier } from '../types.js';

/**
 * Points-allowed tiers used by essentially every mainstream league. A shutout is
 * worth a lot, a blowout loss is negative.
 */
export const DEFAULT_DEF_POINTS_ALLOWED_TIERS: ScoringTier[] = [
  { min: 0, max: 0, points: 10 },
  { min: 1, max: 6, points: 7 },
  { min: 7, max: 13, points: 4 },
  { min: 14, max: 20, points: 1 },
  { min: 21, max: 27, points: 0 },
  { min: 28, max: 34, points: -1 },
  { min: 35, max: null, points: -4 },
];

/**
 * Yards-allowed tiers. Off by default (all zero) because many leagues don't use
 * them, but present so a commissioner can switch them on without a schema change.
 */
export const DEFAULT_DEF_YARDS_ALLOWED_TIERS: ScoringTier[] = [
  { min: 0, max: 99, points: 0 },
  { min: 100, max: 199, points: 0 },
  { min: 200, max: 299, points: 0 },
  { min: 300, max: 399, points: 0 },
  { min: 400, max: 449, points: 0 },
  { min: 450, max: null, points: 0 },
];

/** Everything that is identical across the standard/PPR family. */
const SHARED_PER_UNIT = {
  // Passing — 1 point per 25 yards is the near-universal default.
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -2,
  pass_2pt: 2,
  // Rushing — 1 point per 10 yards.
  rush_yd: 0.1,
  rush_td: 6,
  rush_2pt: 2,
  // Receiving
  rec_yd: 0.1,
  rec_td: 6,
  rec_2pt: 2,
  // Turnovers
  fum_lost: -2,
  // Kicking by distance band
  fg_made_0_19: 3,
  fg_made_20_29: 3,
  fg_made_30_39: 3,
  fg_made_40_49: 4,
  fg_made_50_plus: 5,
  fg_miss: -1,
  xp_made: 1,
  xp_miss: -1,
  // Defense / special teams
  def_sack: 1,
  def_int: 2,
  def_fum_rec: 2,
  def_td: 6,
  def_safety: 2,
  def_blk_kick: 2,
  st_td: 6,
} as const;

function scoringWithReception(pointsPerReception: number): ScoringSettings {
  return {
    perUnit: { ...SHARED_PER_UNIT, rec: pointsPerReception },
    defPointsAllowedTiers: DEFAULT_DEF_POINTS_ALLOWED_TIERS.map((t) => ({ ...t })),
    defYardsAllowedTiers: DEFAULT_DEF_YARDS_ALLOWED_TIERS.map((t) => ({ ...t })),
  };
}

export const SCORING_PRESETS = {
  standard: () => scoringWithReception(0),
  half_ppr: () => scoringWithReception(0.5),
  ppr: () => scoringWithReception(1),
  /** Superflex is a roster shape, not a scoring change — scoring matches half-PPR. */
  superflex: () => scoringWithReception(0.5),
} as const;

export type ScoringPresetName = keyof typeof SCORING_PRESETS;

export const ROSTER_PRESETS: Record<ScoringPresetName, RosterSettings> = {
  standard: {
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
    benchSize: 6,
    irSlots: 1,
  },
  half_ppr: {
    slots: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1 },
    benchSize: 6,
    irSlots: 1,
  },
  ppr: {
    slots: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1 },
    benchSize: 6,
    irSlots: 1,
  },
  superflex: {
    slots: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, SUPERFLEX: 1, K: 1, DST: 1 },
    benchSize: 6,
    irSlots: 1,
  },
};

export function defaultLeagueSettings(
  preset: ScoringPresetName = 'half_ppr',
  teamCount = 12,
): LeagueSettings {
  return {
    teamCount,
    scoring: SCORING_PRESETS[preset](),
    roster: structuredClone(ROSTER_PRESETS[preset]),
    waivers: { type: 'FAAB', faabBudget: 100, waiverPeriodDays: 2 },
    playoffs: {
      teams: 6,
      startWeek: 15,
      weeksPerRound: 1,
      tiebreakers: ['H2H', 'POINTS_FOR'],
    },
    dynastyWeight: 0.25,
  };
}

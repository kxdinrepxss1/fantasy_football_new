/**
 * Core domain types. These are deliberately framework-free and DB-free so the
 * scoring / valuation / trade engines can be unit tested without any I/O.
 */

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;
export type Position = (typeof POSITIONS)[number];

/**
 * Lineup slots a league can require. Multi-position slots list what they accept.
 * SUPERFLEX is the FLEX variant that also accepts a QB — the single setting that
 * most changes positional value in a league.
 */
export const LINEUP_SLOTS = [
  'QB',
  'RB',
  'WR',
  'TE',
  'K',
  'DST',
  'FLEX',
  'SUPERFLEX',
  'REC_FLEX',
  'BENCH',
  'IR',
] as const;
export type LineupSlot = (typeof LINEUP_SLOTS)[number];

/** Which positions each slot will accept. BENCH/IR accept anything. */
export const SLOT_ELIGIBILITY: Record<LineupSlot, readonly Position[]> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DST: ['DST'],
  FLEX: ['RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
  BENCH: POSITIONS,
  IR: POSITIONS,
};

export function slotAccepts(slot: LineupSlot, position: Position): boolean {
  return SLOT_ELIGIBILITY[slot].includes(position);
}

export type InjuryStatus =
  | 'ACTIVE'
  | 'QUESTIONABLE'
  | 'DOUBTFUL'
  | 'OUT'
  | 'IR'
  | 'PUP'
  | 'SUSPENDED';

export interface Player {
  id: string;
  name: string;
  position: Position;
  nflTeam: string | null;
  /** Age in years. Null for DST and for players with unknown birthdates. */
  age: number | null;
  byeWeek: number | null;
  injuryStatus: InjuryStatus;
  /** Rostered percentage across the wider fantasy world, 0-100. Drives "trending". */
  rosteredPct?: number;
  /** Change in rostered percentage over the last week, in points. */
  rosteredPctDelta?: number;
}

/**
 * A single player's stat line for one week. All keys optional — a WR line simply
 * omits passing stats. Keys match the scoring-settings keys one-for-one so the
 * scoring engine is a straight dot product over shared keys.
 */
export interface StatLine {
  // Passing
  pass_yd?: number;
  pass_td?: number;
  pass_int?: number;
  pass_2pt?: number;
  pass_cmp?: number;
  pass_att?: number;
  pass_inc?: number;
  // Rushing
  rush_yd?: number;
  rush_td?: number;
  rush_att?: number;
  rush_2pt?: number;
  // Receiving
  rec?: number;
  rec_yd?: number;
  rec_td?: number;
  rec_2pt?: number;
  rec_tgt?: number;
  // Misc offense
  fum_lost?: number;
  fum?: number;
  // Kicking — made/missed by distance band
  fg_made_0_19?: number;
  fg_made_20_29?: number;
  fg_made_30_39?: number;
  fg_made_40_49?: number;
  fg_made_50_plus?: number;
  fg_miss?: number;
  xp_made?: number;
  xp_miss?: number;
  // Team defense / special teams
  def_sack?: number;
  def_int?: number;
  def_fum_rec?: number;
  def_td?: number;
  def_safety?: number;
  def_blk_kick?: number;
  st_td?: number;
  /** Points the defense allowed — scored through the tier table, not per-unit. */
  def_pts_allowed?: number;
  /** Yards the defense allowed — scored through the tier table, not per-unit. */
  def_yds_allowed?: number;
}

export type StatKey = keyof StatLine;

/** A threshold tier: applies `points` when the value falls in [min, max]. */
export interface ScoringTier {
  min: number;
  /** Inclusive upper bound. Use null for "and above". */
  max: number | null;
  points: number;
}

/**
 * Per-league scoring configuration. `perUnit` covers every countable stat; the
 * tier tables cover the two things that are not linear in real leagues: points
 * allowed by a defense, and yards allowed by a defense.
 *
 * Kicker distance is handled in `perUnit` via the fg_made_* bands, which keeps
 * the whole thing overridable stat-by-stat by the commissioner.
 */
export interface ScoringSettings {
  perUnit: Partial<Record<StatKey, number>>;
  defPointsAllowedTiers: ScoringTier[];
  defYardsAllowedTiers: ScoringTier[];
}

export interface RosterSettings {
  /** Count of each starting slot. Omitted slots are zero. */
  slots: Partial<Record<LineupSlot, number>>;
  benchSize: number;
  irSlots: number;
}

export type WaiverType = 'FAAB' | 'ROLLING' | 'REVERSE_STANDINGS';

export interface WaiverSettings {
  type: WaiverType;
  /** FAAB budget per team per season. Only meaningful when type is FAAB. */
  faabBudget: number;
  /** Days a dropped player sits on waivers before clearing to free agency. */
  waiverPeriodDays: number;
}

export interface PlayoffSettings {
  teams: number;
  /** First week of the playoff bracket. */
  startWeek: number;
  /** Weeks per playoff round — 2 gives two-week championship rounds. */
  weeksPerRound: number;
  /** How ties in seeding are broken, applied in order. */
  tiebreakers: Array<'H2H' | 'POINTS_FOR' | 'POINTS_AGAINST' | 'DIVISION_RECORD'>;
}

export interface LeagueSettings {
  teamCount: number;
  scoring: ScoringSettings;
  roster: RosterSettings;
  waivers: WaiverSettings;
  playoffs: PlayoffSettings;
  /**
   * How much roster decisions should weigh a player's future beyond this season.
   * 0 = pure redraft (age barely matters), 1 = full dynasty (age matters a lot).
   */
  dynastyWeight: number;
}

/** A player as held by a team, with where they sit on that team's roster. */
export interface RosterEntry {
  playerId: string;
  slot: LineupSlot;
}

export interface Team {
  id: string;
  name: string;
  ownerId: string | null;
  roster: RosterEntry[];
}

/** Projected points for a player, already converted to this league's scoring. */
export interface PlayerProjection {
  playerId: string;
  /** Expected points per game for the rest of the season. */
  perGame: number;
  /** Games expected to be played across the remainder of the season. */
  gamesRemaining: number;
}

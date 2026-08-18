import { z } from 'zod';
import { LINEUP_SLOTS, POSITIONS } from '@ff/core';

/**
 * Request validation mirroring the LeagueSettings shape from @ff/core.
 *
 * Scoring is deliberately open: any stat key may be given any point value, so a
 * commissioner can invent rules the app has never seen. The keys are still
 * constrained to known stats so a typo becomes a 400 rather than a setting that
 * silently never applies.
 */

const STAT_KEYS = [
  'pass_yd', 'pass_td', 'pass_int', 'pass_2pt', 'pass_cmp', 'pass_att', 'pass_inc',
  'rush_yd', 'rush_td', 'rush_att', 'rush_2pt',
  'rec', 'rec_yd', 'rec_td', 'rec_2pt', 'rec_tgt',
  'fum_lost', 'fum',
  'fg_made_0_19', 'fg_made_20_29', 'fg_made_30_39', 'fg_made_40_49', 'fg_made_50_plus',
  'fg_miss', 'xp_made', 'xp_miss',
  'def_sack', 'def_int', 'def_fum_rec', 'def_td', 'def_safety', 'def_blk_kick', 'st_td',
  'def_pts_allowed', 'def_yds_allowed',
] as const;

export const statKeySchema = z.enum(STAT_KEYS);

export const scoringTierSchema = z.object({
  min: z.number(),
  max: z.number().nullable(),
  points: z.number(),
});

export const scoringSettingsSchema = z.object({
  perUnit: z.record(statKeySchema, z.number()),
  defPointsAllowedTiers: z.array(scoringTierSchema),
  defYardsAllowedTiers: z.array(scoringTierSchema),
});

export const rosterSettingsSchema = z.object({
  slots: z.record(z.enum(LINEUP_SLOTS), z.number().int().min(0).max(10)),
  benchSize: z.number().int().min(0).max(30),
  irSlots: z.number().int().min(0).max(10),
});

export const waiverSettingsSchema = z.object({
  type: z.enum(['FAAB', 'ROLLING', 'REVERSE_STANDINGS']),
  faabBudget: z.number().int().min(0).max(10_000),
  waiverPeriodDays: z.number().int().min(0).max(7),
});

export const playoffSettingsSchema = z.object({
  teams: z.number().int().min(2).max(16),
  startWeek: z.number().int().min(2).max(18),
  weeksPerRound: z.number().int().min(1).max(3),
  tiebreakers: z.array(z.enum(['H2H', 'POINTS_FOR', 'POINTS_AGAINST', 'DIVISION_RECORD'])),
});

export const leagueSettingsSchema = z.object({
  teamCount: z.number().int().min(4).max(16),
  scoring: scoringSettingsSchema,
  roster: rosterSettingsSchema,
  waivers: waiverSettingsSchema,
  playoffs: playoffSettingsSchema,
  dynastyWeight: z.number().min(0).max(1),
});

export const positionSchema = z.enum(POSITIONS);
export const lineupSlotSchema = z.enum(LINEUP_SLOTS);

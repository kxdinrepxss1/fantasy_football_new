import {
  buildValuationContext,
  scoreStatLine,
  type LeagueSettings,
  type Player,
  type StatLine,
  type ValuationContext,
  type ValuationInput,
} from '@ff/core';
import { num, type Db, type LeagueRow, type PlayerRow, type RosterSlotRow, type TeamRow } from '../db.js';

/** Total weeks in an NFL regular season, used to work out games remaining. */
const REGULAR_SEASON_WEEKS = 18;

export interface LeagueContext {
  league: LeagueRow;
  teams: TeamRow[];
  /** Every player with a projection, valued in this league's scoring. */
  pool: ValuationInput[];
  poolById: Map<string, ValuationInput>;
  /** playerId -> teamId for everyone rostered in this league. */
  ownership: Map<string, string>;
  rosterSlots: RosterSlotRow[];
  valuation: ValuationContext;
}

export function toPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    name: row.full_name,
    position: row.position,
    nflTeam: row.nfl_team,
    age: row.age === null ? null : num(row.age),
    byeWeek: row.bye_week,
    injuryStatus: row.injury_status,
    rosteredPct: row.rostered_pct === null ? undefined : num(row.rostered_pct),
    rosteredPctDelta: row.rostered_pct_delta === null ? undefined : num(row.rostered_pct_delta),
  };
}

/**
 * Load everything the valuation, trade and waiver engines need for one league.
 *
 * Projections are stored as raw stat lines rather than as points, so this is
 * where they become league-specific: the same projection scores differently in
 * a PPR league than a standard one, and every downstream number inherits that
 * without any of the engines knowing about scoring at all.
 */
export async function loadLeagueContext(
  db: Db,
  leagueId: string,
  options: { week?: number } = {},
): Promise<LeagueContext | null> {
  const [league] = await db<LeagueRow[]>`
    SELECT id, name, commissioner_id, season, team_count, settings, status, current_week
    FROM leagues WHERE id = ${leagueId}
  `;
  if (!league) return null;

  const week = options.week ?? league.current_week;

  const [teams, players, projections, rosterSlots] = await Promise.all([
    db<TeamRow[]>`
      SELECT id, league_id, owner_id, name, abbreviation, faab_remaining, waiver_priority, draft_position
      FROM teams WHERE league_id = ${leagueId} ORDER BY name
    `,
    db<PlayerRow[]>`
      SELECT id, source, source_id, full_name, position, nfl_team, age, bye_week,
             injury_status, injury_note, rostered_pct, rostered_pct_delta, active
      FROM players WHERE active
    `,
    // Week 0 is the rest-of-season projection, which is what valuation wants.
    db<Array<{ player_id: string; stats: StatLine }>>`
      SELECT DISTINCT ON (player_id) player_id, stats
      FROM player_projections
      WHERE season = ${league.season} AND week IN (0, ${week})
      ORDER BY player_id, week ASC
    `,
    db<RosterSlotRow[]>`
      SELECT rs.id, rs.team_id, rs.player_id, rs.slot
      FROM roster_slots rs
      JOIN teams t ON t.id = rs.team_id
      WHERE t.league_id = ${leagueId}
    `,
  ]);

  const settings = league.settings;
  const projectionByPlayer = new Map(projections.map((p) => [p.player_id, p.stats]));
  const gamesRemaining = Math.max(1, REGULAR_SEASON_WEEKS - week + 1);

  const pool: ValuationInput[] = [];
  for (const row of players) {
    const stats = projectionByPlayer.get(row.id);
    // A player with no projection cannot be valued; leaving them out is safer
    // than valuing them at zero, which would rank them below every scrub.
    if (!stats) continue;
    pool.push({
      player: toPlayer(row),
      perGame: scoreStatLine(stats, settings.scoring).total,
      gamesRemaining,
    });
  }

  const ownership = new Map(rosterSlots.map((rs) => [rs.player_id, rs.team_id]));

  return {
    league,
    teams,
    pool,
    poolById: new Map(pool.map((p) => [p.player.id, p])),
    ownership,
    rosterSlots,
    valuation: buildValuationContext(pool, settings),
  };
}

/** The valuation inputs for one team's roster, in roster order. */
export function rosterFor(ctx: LeagueContext, teamId: string): ValuationInput[] {
  const ids = ctx.rosterSlots.filter((rs) => rs.team_id === teamId).map((rs) => rs.player_id);
  return ids
    .map((id) => ctx.poolById.get(id))
    .filter((x): x is ValuationInput => Boolean(x));
}

/** Everyone in the pool who is not on a roster in this league. */
export function freeAgents(ctx: LeagueContext): ValuationInput[] {
  return ctx.pool.filter((p) => !ctx.ownership.has(p.player.id));
}

/** Everyone rostered anywhere in the league — used to spot injury openings. */
export function rosteredPlayers(ctx: LeagueContext): ValuationInput[] {
  return ctx.pool.filter((p) => ctx.ownership.has(p.player.id));
}

export function settingsOf(ctx: LeagueContext): LeagueSettings {
  return ctx.league.settings;
}

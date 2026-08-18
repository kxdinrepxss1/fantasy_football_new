import { scoreStatLine, type LeagueSettings, type LineupSlot, type StatLine } from '@ff/core';
import { num, type Db } from '../db.js';

export interface ScoredPlayer {
  playerId: string;
  name: string;
  position: string;
  slot: LineupSlot;
  points: number;
  /** True when this player's slot counts toward the team total. */
  starting: boolean;
  /** False until the player's real-world game has been played. */
  hasStats: boolean;
}

export interface ScoredTeam {
  teamId: string;
  teamName: string;
  total: number;
  benchTotal: number;
  players: ScoredPlayer[];
}

/**
 * Score a week for a set of teams.
 *
 * Points are always computed from raw stat lines against the league's current
 * scoring settings rather than read from a stored total. That costs a little
 * arithmetic per request and buys the thing commissioners actually want: change
 * a scoring rule and every week, past and present, immediately reflects it.
 */
export async function scoreWeek(
  db: Db,
  leagueId: string,
  season: number,
  week: number,
  settings: LeagueSettings,
): Promise<Map<string, ScoredTeam>> {
  const rows = await db<
    Array<{
      team_id: string;
      team_name: string;
      player_id: string;
      full_name: string;
      position: string;
      slot: LineupSlot;
      stats: StatLine | null;
    }>
  >`
    SELECT t.id   AS team_id,
           t.name AS team_name,
           p.id   AS player_id,
           p.full_name,
           p.position,
           rs.slot,
           ps.stats
    FROM teams t
    JOIN roster_slots rs ON rs.team_id = t.id
    JOIN players p       ON p.id = rs.player_id
    LEFT JOIN player_stats ps
           ON ps.player_id = p.id AND ps.season = ${season} AND ps.week = ${week}
    WHERE t.league_id = ${leagueId}
    ORDER BY t.name, rs.slot
  `;

  const teams = new Map<string, ScoredTeam>();

  for (const row of rows) {
    let team = teams.get(row.team_id);
    if (!team) {
      team = { teamId: row.team_id, teamName: row.team_name, total: 0, benchTotal: 0, players: [] };
      teams.set(row.team_id, team);
    }

    const points = row.stats ? scoreStatLine(row.stats, settings.scoring).total : 0;
    const starting = row.slot !== 'BENCH' && row.slot !== 'IR';

    team.players.push({
      playerId: row.player_id,
      name: row.full_name,
      position: row.position,
      slot: row.slot,
      points,
      starting,
      hasStats: row.stats !== null,
    });

    if (starting) team.total += points;
    else team.benchTotal += points;
  }

  for (const team of teams.values()) {
    team.total = round2(team.total);
    team.benchTotal = round2(team.benchTotal);
  }

  return teams;
}

/**
 * Write the week's scores onto the matchup rows, and freeze each team's lineup
 * once the week is final so later roster moves cannot rewrite history.
 */
export async function persistWeekScores(
  db: Db,
  leagueId: string,
  season: number,
  week: number,
  settings: LeagueSettings,
  markFinal: boolean,
): Promise<number> {
  const scored = await scoreWeek(db, leagueId, season, week, settings);

  const matchups = await db<
    Array<{ id: string; home_team_id: string; away_team_id: string; final: boolean }>
  >`
    SELECT id, home_team_id, away_team_id, final
    FROM matchups WHERE league_id = ${leagueId} AND week = ${week}
  `;

  let updated = 0;
  await db.begin(async (tx) => {
    for (const matchup of matchups) {
      // A finalised week is immutable — re-running the job must not disturb it.
      if (matchup.final) continue;

      const home = scored.get(matchup.home_team_id);
      const away = scored.get(matchup.away_team_id);

      await tx`
        UPDATE matchups
        SET home_score = ${home?.total ?? 0},
            away_score = ${away?.total ?? 0},
            final = ${markFinal}
        WHERE id = ${matchup.id}
      `;

      if (markFinal) {
        await tx`DELETE FROM lineup_entries WHERE matchup_id = ${matchup.id}`;
        for (const team of [home, away]) {
          if (!team) continue;
          for (const player of team.players) {
            await tx`
              INSERT INTO lineup_entries (matchup_id, team_id, player_id, slot, points)
              VALUES (${matchup.id}, ${team.teamId}, ${player.playerId}, ${player.slot}, ${player.points})
              ON CONFLICT (matchup_id, team_id, player_id) DO UPDATE SET points = EXCLUDED.points
            `;
          }
        }
      }
      updated++;
    }
  });

  return updated;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export { num };

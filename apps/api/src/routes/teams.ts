import { Hono } from 'hono';
import { z } from 'zod';
import {
  analyzeRosterNeeds,
  optimizeLineup,
  slotAccepts,
  startingSlots,
  valuePlayer,
  type LineupSlot,
} from '@ff/core';
import type { Variables } from '../app.js';
import type { PlayerRow, RosterSlotRow } from '../db.js';
import { badRequest, body, notFound, requireLeagueMember, requireTeamOwner } from '../http.js';
import { loadLeagueContext, rosterFor } from '../services/leagueContext.js';
import { lineupSlotSchema } from '../validation.js';

const routes = new Hono<{ Variables: Variables }>();

/** A team's roster, with each player's value and the optimal lineup alongside. */
routes.get('/:id', async (c) => {
  const teamId = c.req.param('id');
  const db = c.get('db');

  const [team] = await db<Array<{ id: string; league_id: string; name: string; faab_remaining: number }>>`
    SELECT id, league_id, name, faab_remaining FROM teams WHERE id = ${teamId}
  `;
  if (!team) notFound('Team not found');

  await requireLeagueMember(c, team.league_id);

  const ctx = await loadLeagueContext(db, team.league_id);
  if (!ctx) notFound('League not found');

  const slots = new Map(
    ctx.rosterSlots.filter((rs) => rs.team_id === teamId).map((rs) => [rs.player_id, rs.slot]),
  );

  const roster = rosterFor(ctx, teamId);
  const settings = ctx.league.settings;

  const players = roster.map((entry) => {
    const value = valuePlayer(entry, ctx.valuation);
    return {
      ...entry.player,
      slot: slots.get(entry.player.id) ?? 'BENCH',
      projectedPerGame: entry.perGame,
      value: value.value,
      score: value.score,
      positionalRank: value.positionalRank,
      vorpPerGame: value.vorpPerGame,
      reasons: value.reasons,
    };
  });

  const optimal = optimizeLineup(
    roster.map((r) => ({ player: r.player, points: r.perGame })),
    settings.roster,
  );

  const current = players
    .filter((p) => p.slot !== 'BENCH' && p.slot !== 'IR')
    .reduce((sum, p) => sum + p.projectedPerGame, 0);

  return c.json({
    team,
    players,
    needs: analyzeRosterNeeds(roster, settings),
    lineup: {
      slots: startingSlots(settings.roster),
      optimal,
      currentProjected: Math.round(current * 100) / 100,
      // The gap between what they have set and the best they could set — the
      // single most actionable number on the roster page.
      pointsLeftOnBench: Math.round((optimal.total - current) * 100) / 100,
    },
  });
});

const setLineup = z.object({
  assignments: z
    .array(z.object({ playerId: z.string().uuid(), slot: lineupSlotSchema }))
    .min(1)
    .max(60),
});

/**
 * Set a team's lineup.
 *
 * Validated as a whole rather than per player: a lineup is only legal if every
 * player is eligible for their slot and no slot is over-filled, and it is much
 * clearer to reject the whole submission with a reason than to apply half of it.
 */
routes.put('/:id/lineup', async (c) => {
  const teamId = c.req.param('id');
  const team = await requireTeamOwner(c, teamId);
  const { assignments } = await body(c, setLineup);
  const db = c.get('db');

  const ctx = await loadLeagueContext(db, team.league_id);
  if (!ctx) notFound('League not found');
  const settings = ctx.league.settings;

  const owned = new Set(
    ctx.rosterSlots.filter((rs) => rs.team_id === teamId).map((rs) => rs.player_id),
  );

  const rows = await db<PlayerRow[]>`
    SELECT id, full_name, position, injury_status FROM players
    WHERE id = ANY(${assignments.map((a) => a.playerId)})
  `;
  const byId = new Map(rows.map((r) => [r.id, r]));

  const counts = new Map<LineupSlot, number>();
  for (const assignment of assignments) {
    if (!owned.has(assignment.playerId)) {
      badRequest('That lineup includes a player who is not on this roster');
    }
    const player = byId.get(assignment.playerId);
    if (!player) badRequest('That lineup includes an unknown player');

    if (assignment.slot === 'IR') {
      // IR is only for players who are genuinely unavailable, otherwise it is a
      // way to carry extra bench players.
      if (player.injury_status === 'ACTIVE' || player.injury_status === 'QUESTIONABLE') {
        badRequest(`${player.full_name} is not injured enough to sit on IR`);
      }
    } else if (assignment.slot !== 'BENCH' && !slotAccepts(assignment.slot, player.position)) {
      badRequest(`A ${player.position} cannot start at ${assignment.slot}`);
    }

    counts.set(assignment.slot, (counts.get(assignment.slot) ?? 0) + 1);
  }

  for (const [slot, count] of counts) {
    const limit =
      slot === 'BENCH'
        ? settings.roster.benchSize
        : slot === 'IR'
          ? settings.roster.irSlots
          : (settings.roster.slots[slot] ?? 0);
    if (count > limit) {
      badRequest(`Too many players at ${slot}: ${count} assigned but only ${limit} available`);
    }
  }

  await db.begin(async (tx) => {
    for (const assignment of assignments) {
      await tx`
        UPDATE roster_slots SET slot = ${assignment.slot}
        WHERE team_id = ${teamId} AND player_id = ${assignment.playerId}
      `;
    }
  });

  return c.json({ ok: true, updated: assignments.length });
});

/** Rename a team or set its abbreviation. */
routes.patch('/:id', async (c) => {
  const teamId = c.req.param('id');
  await requireTeamOwner(c, teamId);
  const input = await body(
    c,
    z.object({
      name: z.string().min(1).max(60).optional(),
      abbreviation: z.string().min(1).max(5).optional(),
    }),
  );
  const db = c.get('db');

  const [updated] = await db<Array<{ id: string; name: string; abbreviation: string | null }>>`
    UPDATE teams
    SET name = COALESCE(${input.name ?? null}, name),
        abbreviation = COALESCE(${input.abbreviation ?? null}, abbreviation)
    WHERE id = ${teamId}
    RETURNING id, name, abbreviation
  `;
  return c.json({ team: updated });
});

/** Add a free agent, optionally dropping someone to make room. */
routes.post('/:id/transactions', async (c) => {
  const teamId = c.req.param('id');
  const team = await requireTeamOwner(c, teamId);
  const input = await body(
    c,
    z.object({
      addPlayerId: z.string().uuid().optional(),
      dropPlayerId: z.string().uuid().optional(),
    }),
  );
  if (!input.addPlayerId && !input.dropPlayerId) badRequest('Nothing to do');

  const db = c.get('db');
  const ctx = await loadLeagueContext(db, team.league_id);
  if (!ctx) notFound('League not found');

  const settings = ctx.league.settings;
  const rosterSize = ctx.rosterSlots.filter((rs) => rs.team_id === teamId).length;
  const maxRoster =
    startingSlots(settings.roster).length + settings.roster.benchSize + settings.roster.irSlots;

  const result = await db.begin(async (tx) => {
    if (input.dropPlayerId) {
      const dropped = await tx<RosterSlotRow[]>`
        DELETE FROM roster_slots
        WHERE team_id = ${teamId} AND player_id = ${input.dropPlayerId}
        RETURNING id, player_id
      `;
      if (dropped.length === 0) return { error: 'That player is not on your roster' } as const;
    }

    if (input.addPlayerId) {
      if (ctx.ownership.has(input.addPlayerId)) {
        return { error: 'That player is already rostered in this league' } as const;
      }
      const after = rosterSize + 1 - (input.dropPlayerId ? 1 : 0);
      if (after > maxRoster) {
        return { error: `Roster is full (${maxRoster}) — drop someone first` } as const;
      }
      await tx`
        INSERT INTO roster_slots (team_id, player_id, slot)
        VALUES (${teamId}, ${input.addPlayerId}, 'BENCH')
      `;
    }

    await tx`
      INSERT INTO transactions (league_id, type, team_id, week, payload)
      VALUES (
        ${team.league_id},
        ${input.addPlayerId && input.dropPlayerId ? 'add_drop' : input.addPlayerId ? 'add' : 'drop'},
        ${teamId},
        ${ctx.league.current_week},
        ${tx.json({ add: input.addPlayerId ?? null, drop: input.dropPlayerId ?? null })}
      )
    `;
    return { ok: true } as const;
  });

  if ('error' in result && result.error) badRequest(result.error);
  return c.json(result);
});

export default routes;

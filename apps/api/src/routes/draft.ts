import { Hono } from 'hono';
import { z } from 'zod';
import { startingSlots, valuePool } from '@ff/core';
import type { Variables } from '../app.js';
import type { TeamRow } from '../db.js';
import {
  badRequest,
  body,
  conflict,
  notFound,
  requireCommissioner,
  requireLeagueMember,
  requireTeamOwner,
} from '../http.js';
import { loadLeagueContext } from '../services/leagueContext.js';

const routes = new Hono<{ Variables: Variables }>();

/**
 * Snake order: odd rounds run through the draft order, even rounds run back.
 * Auction drafts still use this order, for nomination rather than picking.
 */
function orderForPick(teamIds: string[], pickNumber: number): { team: string; round: number } {
  const n = teamIds.length;
  const round = Math.floor((pickNumber - 1) / n) + 1;
  const indexInRound = (pickNumber - 1) % n;
  const index = round % 2 === 1 ? indexInRound : n - 1 - indexInRound;
  return { team: teamIds[index]!, round };
}

const createDraft = z.object({
  type: z.enum(['snake', 'auction']).default('snake'),
  pickTimerSeconds: z.number().int().min(10).max(600).default(90),
  budget: z.number().int().min(1).max(1000).default(200),
  scheduledAt: z.string().datetime().optional(),
  /** Team ids in draft order. Defaults to the league's stored draft positions. */
  order: z.array(z.string().uuid()).optional(),
});

routes.post('/league/:leagueId', async (c) => {
  const leagueId = c.req.param('leagueId');
  const { league } = await requireCommissioner(c, leagueId);
  const input = await body(c, createDraft);
  const db = c.get('db');

  const teams = await db<TeamRow[]>`
    SELECT id, draft_position FROM teams WHERE league_id = ${leagueId}
    ORDER BY draft_position NULLS LAST, name
  `;
  if (teams.length < 2) badRequest('The league needs at least two teams');

  const order = input.order ?? teams.map((t) => t.id);
  if (order.length !== teams.length) badRequest('The draft order must include every team');
  const teamIds = new Set(teams.map((t) => t.id));
  if (!order.every((id) => teamIds.has(id))) badRequest('The draft order names a team not in this league');

  const rosterSize = startingSlots(league.settings.roster).length + league.settings.roster.benchSize;

  const draft = await db.begin(async (tx) => {
    const [existing] = await tx<Array<{ id: string; status: string }>>`
      SELECT id, status FROM drafts WHERE league_id = ${leagueId}
    `;
    if (existing && existing.status !== 'scheduled') {
      return { error: 'This draft is already under way' } as const;
    }
    if (existing) await tx`DELETE FROM drafts WHERE id = ${existing.id}`;

    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO drafts (league_id, type, rounds, pick_timer_secs, budget, scheduled_at)
      VALUES (${leagueId}, ${input.type}, ${rosterSize}, ${input.pickTimerSeconds},
              ${input.budget}, ${input.scheduledAt ?? null})
      RETURNING id
    `;
    if (!row) throw new Error('Failed to create the draft');

    // Every pick exists up front, so the board can be rendered before a single
    // selection is made and the order is fixed rather than derived per request.
    for (let pick = 1; pick <= rosterSize * order.length; pick++) {
      const { team, round } = orderForPick(order, pick);
      await tx`
        INSERT INTO draft_picks (draft_id, pick_number, round, team_id)
        VALUES (${row.id}, ${pick}, ${round}, ${team})
      `;
    }

    // Persist the order so the board and the timer agree on whose turn it is.
    for (const [i, teamId] of order.entries()) {
      await tx`UPDATE teams SET draft_position = ${i + 1} WHERE id = ${teamId}`;
    }

    return { id: row.id, rounds: rosterSize, totalPicks: rosterSize * order.length } as const;
  });

  if ('error' in draft && draft.error) conflict(draft.error);
  return c.json({ draft }, 201);
});

/** The draft board: every pick, who is on the clock, and how long they have. */
routes.get('/league/:leagueId', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const [draft] = await db<
    Array<{
      id: string;
      type: string;
      status: string;
      rounds: number;
      pick_timer_secs: number;
      budget: number;
      current_pick: number;
      pick_started_at: Date | null;
      scheduled_at: Date | null;
    }>
  >`
    SELECT id, type, status, rounds, pick_timer_secs, budget, current_pick, pick_started_at, scheduled_at
    FROM drafts WHERE league_id = ${leagueId}
  `;
  if (!draft) notFound('No draft has been set up for this league');

  const picks = await db`
    SELECT dp.id, dp.pick_number, dp.round, dp.team_id, dp.player_id, dp.amount, dp.auto, dp.picked_at,
           t.name AS team_name, p.full_name AS player_name, p.position, p.nfl_team
    FROM draft_picks dp
    JOIN teams t ON t.id = dp.team_id
    LEFT JOIN players p ON p.id = dp.player_id
    WHERE dp.draft_id = ${draft.id}
    ORDER BY dp.pick_number
  `;

  // The clock is derived from when the pick started rather than tracked in the
  // client, so refreshing the page cannot buy anyone extra time.
  const secondsRemaining =
    draft.status === 'in_progress' && draft.pick_started_at
      ? Math.max(
          0,
          draft.pick_timer_secs -
            Math.floor((Date.now() - new Date(draft.pick_started_at).getTime()) / 1000),
        )
      : null;

  const onTheClock = picks.find((p) => p.pick_number === draft.current_pick) ?? null;

  return c.json({ draft: { ...draft, secondsRemaining }, picks, onTheClock });
});

routes.post('/league/:leagueId/start', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireCommissioner(c, leagueId);
  const db = c.get('db');

  const [draft] = await db<Array<{ id: string; status: string }>>`
    SELECT id, status FROM drafts WHERE league_id = ${leagueId}
  `;
  if (!draft) notFound('No draft has been set up for this league');
  if (draft.status === 'complete') conflict('That draft has already finished');

  await db`
    UPDATE drafts SET status = 'in_progress', pick_started_at = now() WHERE id = ${draft.id}
  `;
  await db`UPDATE leagues SET status = 'drafting' WHERE id = ${leagueId}`;

  return c.json({ ok: true });
});

/** Suggested picks for whoever is on the clock, using the league's valuations. */
routes.get('/league/:leagueId/suggestions', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const ctx = await loadLeagueContext(db, leagueId);
  if (!ctx) notFound('League not found');

  const [draft] = await db<Array<{ id: string }>>`
    SELECT id FROM drafts WHERE league_id = ${leagueId}
  `;
  if (!draft) notFound('No draft has been set up for this league');

  const taken = await db<Array<{ player_id: string }>>`
    SELECT player_id FROM draft_picks WHERE draft_id = ${draft.id} AND player_id IS NOT NULL
  `;
  const takenIds = new Set(taken.map((t) => t.player_id));

  const names = new Map(ctx.pool.map((p) => [p.player.id, p.player.name]));
  const available = ctx.pool.filter((p) => !takenIds.has(p.player.id));

  return c.json({
    suggestions: valuePool(available, ctx.valuation)
      .sort((a, b) => b.value - a.value)
      .slice(0, 30)
      .map((v) => ({ ...v, name: names.get(v.playerId) ?? v.playerId })),
  });
});

const makePick = z.object({
  playerId: z.string().uuid(),
  /** Auction price. Ignored for snake drafts. */
  amount: z.number().int().min(0).max(1000).optional(),
});

routes.post('/league/:leagueId/pick', async (c) => {
  const leagueId = c.req.param('leagueId');
  const access = await requireLeagueMember(c, leagueId);
  const input = await body(c, makePick);
  const db = c.get('db');

  const result = await db.begin(async (tx) => {
    const [draft] = await tx<
      Array<{
        id: string;
        type: string;
        status: string;
        current_pick: number;
        pick_timer_secs: number;
        pick_started_at: Date | null;
        budget: number;
      }>
    >`
      SELECT id, type, status, current_pick, pick_timer_secs, pick_started_at, budget
      FROM drafts WHERE league_id = ${leagueId} FOR UPDATE
    `;
    if (!draft) return { error: 'No draft has been set up for this league', code: 404 } as const;
    if (draft.status !== 'in_progress') return { error: 'The draft is not running', code: 409 } as const;

    const [pick] = await tx<Array<{ id: string; team_id: string; player_id: string | null }>>`
      SELECT id, team_id, player_id FROM draft_picks
      WHERE draft_id = ${draft.id} AND pick_number = ${draft.current_pick}
    `;
    if (!pick) return { error: 'The draft has run out of picks', code: 409 } as const;
    if (pick.player_id) return { error: 'That pick has already been made', code: 409 } as const;

    // Anyone can pick once the clock has expired, which is how a draft keeps
    // moving when someone steps away; before that it is the owner's alone.
    const elapsed = draft.pick_started_at
      ? (Date.now() - new Date(draft.pick_started_at).getTime()) / 1000
      : 0;
    const expired = elapsed >= draft.pick_timer_secs;
    const isOwner = access.team?.id === pick.team_id;
    if (!isOwner && !expired && !access.isCommissioner) {
      return { error: 'It is not your turn to pick', code: 403 } as const;
    }

    const [alreadyDrafted] = await tx<Array<{ id: string }>>`
      SELECT id FROM draft_picks WHERE draft_id = ${draft.id} AND player_id = ${input.playerId}
    `;
    if (alreadyDrafted) return { error: 'That player has already been drafted', code: 409 } as const;

    await tx`
      UPDATE draft_picks
      SET player_id = ${input.playerId},
          amount = ${draft.type === 'auction' ? (input.amount ?? 0) : null},
          auto = ${!isOwner},
          picked_at = now()
      WHERE id = ${pick.id}
    `;

    await tx`
      INSERT INTO roster_slots (team_id, player_id, slot)
      VALUES (${pick.team_id}, ${input.playerId}, 'BENCH')
    `;

    const [remaining] = await tx<Array<{ count: string }>>`
      SELECT count(*) FROM draft_picks WHERE draft_id = ${draft.id} AND player_id IS NULL
    `;
    const done = Number(remaining?.count ?? 0) === 0;

    await tx`
      UPDATE drafts
      SET current_pick = ${draft.current_pick + 1},
          pick_started_at = ${done ? null : new Date()},
          status = ${done ? 'complete' : 'in_progress'}
      WHERE id = ${draft.id}
    `;

    if (done) await tx`UPDATE leagues SET status = 'in_season' WHERE id = ${leagueId}`;

    await tx`
      INSERT INTO transactions (league_id, type, team_id, payload)
      VALUES (${leagueId}, 'draft', ${pick.team_id},
              ${tx.json({ playerId: input.playerId, pickNumber: draft.current_pick })})
    `;

    return { ok: true, pickNumber: draft.current_pick, complete: done } as const;
  });

  if ('error' in result && result.error) {
    const { error, code } = result;
    if (code === 404) notFound(error);
    if (code === 403) badRequest(error);
    conflict(error);
  }
  return c.json(result);
});

/** Pause or resume the draft. */
routes.post('/league/:leagueId/pause', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireCommissioner(c, leagueId);
  const { paused } = await body(c, z.object({ paused: z.boolean() }));
  const db = c.get('db');

  const [draft] = await db<Array<{ id: string; status: string }>>`
    SELECT id, status FROM drafts WHERE league_id = ${leagueId}
  `;
  if (!draft) notFound('No draft has been set up for this league');

  await db`
    UPDATE drafts
    SET status = ${paused ? 'paused' : 'in_progress'},
        pick_started_at = ${paused ? null : new Date()}
    WHERE id = ${draft.id}
  `;
  return c.json({ status: paused ? 'paused' : 'in_progress' });
});

export default routes;

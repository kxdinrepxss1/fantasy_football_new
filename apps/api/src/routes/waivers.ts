import { Hono } from 'hono';
import { z } from 'zod';
import { recommendWaivers, suggestDrop, trendingAdds } from '@ff/core';
import type { Variables } from '../app.js';
import { num } from '../db.js';
import {
  badRequest,
  body,
  conflict,
  notFound,
  requireLeagueMember,
  requireTeamOwner,
} from '../http.js';
import {
  freeAgents,
  loadLeagueContext,
  rosterFor,
  rosteredPlayers,
} from '../services/leagueContext.js';

const routes = new Hono<{ Variables: Variables }>();

/**
 * Waiver recommendations for one team.
 *
 * Ranked by value added to this roster rather than by raw player quality, so a
 * good player at a position the team is already deep at falls below a modest
 * one who plugs a hole or covers a bye.
 */
routes.get('/team/:teamId', async (c) => {
  const teamId = c.req.param('teamId');
  const db = c.get('db');

  const [team] = await db<Array<{ id: string; league_id: string }>>`
    SELECT id, league_id FROM teams WHERE id = ${teamId}
  `;
  if (!team) notFound('Team not found');
  await requireLeagueMember(c, team.league_id);

  const ctx = await loadLeagueContext(db, team.league_id);
  if (!ctx) notFound('League not found');

  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 25)));
  const roster = rosterFor(ctx, teamId);

  // Filtering by position is how the UI tabs the wire. Note that kickers and
  // defenses legitimately top an unfiltered list — every team rosters exactly
  // one, so the best available is right at replacement level, while every
  // startable running back and receiver is already owned.
  const position = c.req.query('position');
  const available = position
    ? freeAgents(ctx).filter((p) => p.player.position === position)
    : freeAgents(ctx);

  const recommendations = recommendWaivers(
    {
      roster,
      available,
      leagueRostered: rosteredPlayers(ctx),
      settings: ctx.league.settings,
      ctx: ctx.valuation,
      currentWeek: ctx.league.current_week,
      lookaheadWeeks: 4,
    },
    limit,
  );

  const names = new Map(ctx.pool.map((p) => [p.player.id, p.player.name]));

  return c.json({
    recommendations,
    trending: trendingAdds(available, 10),
    suggestedDrop: suggestDrop(roster, ctx.league.settings, ctx.valuation),
    // Names for anything the recommendations reference so the client does not
    // need a second round trip.
    playerNames: Object.fromEntries(names),
  });
});

/** Free agents, filterable, for the waiver wire browser. */
routes.get('/league/:leagueId/available', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const ctx = await loadLeagueContext(db, leagueId);
  if (!ctx) notFound('League not found');

  const position = c.req.query('position');
  const search = c.req.query('q')?.toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100)));

  let available = freeAgents(ctx);
  if (position) available = available.filter((p) => p.player.position === position);
  if (search) available = available.filter((p) => p.player.name.toLowerCase().includes(search));

  available.sort((a, b) => b.perGame - a.perGame);

  return c.json({
    players: available.slice(0, limit).map((p) => ({
      ...p.player,
      projectedPerGame: p.perGame,
    })),
    total: available.length,
  });
});

const claimSchema = z.object({
  addPlayerId: z.string().uuid(),
  dropPlayerId: z.string().uuid().optional(),
  bidAmount: z.number().int().min(0).max(10_000).default(0),
});

/** Submit a waiver claim, processed when the waiver period clears. */
routes.post('/team/:teamId/claims', async (c) => {
  const teamId = c.req.param('teamId');
  const team = await requireTeamOwner(c, teamId);
  const input = await body(c, claimSchema);
  const db = c.get('db');

  const ctx = await loadLeagueContext(db, team.league_id);
  if (!ctx) notFound('League not found');

  if (ctx.ownership.has(input.addPlayerId)) {
    conflict('That player is already rostered in this league');
  }
  if (input.dropPlayerId && ctx.ownership.get(input.dropPlayerId) !== teamId) {
    badRequest('You can only drop a player from your own roster');
  }

  const settings = ctx.league.settings;
  if (settings.waivers.type === 'FAAB' && input.bidAmount > num(team.faab_remaining)) {
    badRequest(`Bid exceeds your remaining FAAB budget of ${team.faab_remaining}`);
  }

  const processAt = new Date(Date.now() + settings.waivers.waiverPeriodDays * 86_400_000);

  const [claim] = await db<Array<{ id: string; process_at: Date }>>`
    INSERT INTO waiver_claims (league_id, team_id, add_player_id, drop_player_id, bid_amount, process_at)
    VALUES (${team.league_id}, ${teamId}, ${input.addPlayerId}, ${input.dropPlayerId ?? null},
            ${input.bidAmount}, ${processAt})
    RETURNING id, process_at
  `;

  return c.json({ claim }, 201);
});

routes.get('/team/:teamId/claims', async (c) => {
  const teamId = c.req.param('teamId');
  const team = await requireTeamOwner(c, teamId);
  const db = c.get('db');

  const claims = await db`
    SELECT wc.id, wc.bid_amount, wc.status, wc.process_at, wc.processed_at,
           ap.full_name AS add_player, dp.full_name AS drop_player
    FROM waiver_claims wc
    JOIN players ap ON ap.id = wc.add_player_id
    LEFT JOIN players dp ON dp.id = wc.drop_player_id
    WHERE wc.team_id = ${teamId}
    ORDER BY wc.created_at DESC LIMIT 50
  `;
  return c.json({ claims, faabRemaining: team.faab_remaining });
});

routes.delete('/claims/:id', async (c) => {
  const claimId = c.req.param('id');
  const db = c.get('db');

  const [claim] = await db<Array<{ id: string; team_id: string; status: string }>>`
    SELECT id, team_id, status FROM waiver_claims WHERE id = ${claimId}
  `;
  if (!claim) notFound('Claim not found');
  await requireTeamOwner(c, claim.team_id);
  if (claim.status !== 'pending') conflict('That claim has already been processed');

  await db`UPDATE waiver_claims SET status = 'cancelled' WHERE id = ${claimId}`;
  return c.json({ ok: true });
});

/**
 * Process all due waiver claims for a league.
 *
 * FAAB resolves by highest bid, ties going to the worse waiver priority; the
 * other modes resolve purely by priority. Losing claims for a player somebody
 * else won are marked lost rather than silently dropped, so an owner can see
 * what happened to their bid.
 */
routes.post('/league/:leagueId/process', async (c) => {
  const leagueId = c.req.param('leagueId');
  const access = await requireLeagueMember(c, leagueId);
  if (!access.isCommissioner) badRequest('Only the commissioner can process waivers');

  const db = c.get('db');
  const ctx = await loadLeagueContext(db, leagueId);
  if (!ctx) notFound('League not found');
  const isFaab = ctx.league.settings.waivers.type === 'FAAB';

  const processed = await db.begin(async (tx) => {
    const claims = await tx<
      Array<{
        id: string;
        team_id: string;
        add_player_id: string;
        drop_player_id: string | null;
        bid_amount: number;
        waiver_priority: number;
      }>
    >`
      SELECT wc.id, wc.team_id, wc.add_player_id, wc.drop_player_id, wc.bid_amount,
             t.waiver_priority
      FROM waiver_claims wc
      JOIN teams t ON t.id = wc.team_id
      WHERE wc.league_id = ${leagueId} AND wc.status = 'pending' AND wc.process_at <= now()
      ORDER BY wc.bid_amount DESC, t.waiver_priority ASC, wc.created_at ASC
      FOR UPDATE OF wc
    `;

    const awarded = new Set<string>();
    const results: Array<{ claimId: string; status: string }> = [];

    for (const claim of claims) {
      // Someone earlier in this same run already took him.
      if (awarded.has(claim.add_player_id)) {
        await tx`UPDATE waiver_claims SET status = 'lost', processed_at = now() WHERE id = ${claim.id}`;
        results.push({ claimId: claim.id, status: 'lost' });
        continue;
      }

      const [taken] = await tx<Array<{ id: string }>>`
        SELECT rs.id FROM roster_slots rs
        JOIN teams t ON t.id = rs.team_id
        WHERE t.league_id = ${leagueId} AND rs.player_id = ${claim.add_player_id}
      `;
      if (taken) {
        await tx`UPDATE waiver_claims SET status = 'lost', processed_at = now() WHERE id = ${claim.id}`;
        results.push({ claimId: claim.id, status: 'lost' });
        continue;
      }

      if (claim.drop_player_id) {
        await tx`
          DELETE FROM roster_slots
          WHERE team_id = ${claim.team_id} AND player_id = ${claim.drop_player_id}
        `;
      }

      await tx`
        INSERT INTO roster_slots (team_id, player_id, slot)
        VALUES (${claim.team_id}, ${claim.add_player_id}, 'BENCH')
      `;

      if (isFaab && claim.bid_amount > 0) {
        await tx`
          UPDATE teams SET faab_remaining = GREATEST(0, faab_remaining - ${claim.bid_amount})
          WHERE id = ${claim.team_id}
        `;
      } else if (!isFaab) {
        // Winning a priority claim sends the team to the back of the queue.
        await tx`
          UPDATE teams SET waiver_priority = (
            SELECT COALESCE(MAX(waiver_priority), 0) + 1 FROM teams WHERE league_id = ${leagueId}
          ) WHERE id = ${claim.team_id}
        `;
      }

      await tx`UPDATE waiver_claims SET status = 'won', processed_at = now() WHERE id = ${claim.id}`;
      await tx`
        INSERT INTO transactions (league_id, type, team_id, payload)
        VALUES (${leagueId}, ${claim.drop_player_id ? 'add_drop' : 'add'}, ${claim.team_id},
                ${tx.json({ add: claim.add_player_id, drop: claim.drop_player_id, bid: claim.bid_amount })})
      `;

      awarded.add(claim.add_player_id);
      results.push({ claimId: claim.id, status: 'won' });
    }

    return results;
  });

  return c.json({
    processed: processed.length,
    won: processed.filter((r) => r.status === 'won').length,
    results: processed,
  });
});

export default routes;

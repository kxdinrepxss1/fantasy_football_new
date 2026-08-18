import { Hono } from 'hono';
import { z } from 'zod';
import { evaluateTrade, type TradeInput } from '@ff/core';
import type { Variables } from '../app.js';
import { toJson, type TeamRow } from '../db.js';
import {
  badRequest,
  body,
  conflict,
  notFound,
  requireLeagueMember,
  requireTeamOwner,
} from '../http.js';
import { loadLeagueContext, rosterFor } from '../services/leagueContext.js';

const routes = new Hono<{ Variables: Variables }>();

const tradeShape = z.object({
  leagueId: z.string().uuid(),
  teamAId: z.string().uuid(),
  teamBId: z.string().uuid(),
  /** Players leaving team A. */
  teamASends: z.array(z.string().uuid()).max(10),
  /** Players leaving team B. */
  teamBSends: z.array(z.string().uuid()).max(10),
});

/**
 * Evaluate a hypothetical trade without proposing it.
 *
 * This is the endpoint the trade calculator page calls on every change, so it
 * does no writes and works for any two teams in a league the caller belongs to
 * — including two teams that are not theirs, which is how people talk each
 * other into deals.
 */
routes.post('/evaluate', async (c) => {
  const input = await body(c, tradeShape);
  await requireLeagueMember(c, input.leagueId);
  const db = c.get('db');

  const ctx = await loadLeagueContext(db, input.leagueId);
  if (!ctx) notFound('League not found');

  const teamA = ctx.teams.find((t) => t.id === input.teamAId);
  const teamB = ctx.teams.find((t) => t.id === input.teamBId);
  if (!teamA || !teamB) notFound('One of those teams is not in this league');
  if (teamA.id === teamB.id) badRequest('A team cannot trade with itself');
  if (input.teamASends.length === 0 && input.teamBSends.length === 0) {
    badRequest('Add at least one player to the trade');
  }

  // Everything on the block has to actually be owned by the side sending it.
  for (const [teamId, ids] of [
    [teamA.id, input.teamASends],
    [teamB.id, input.teamBSends],
  ] as const) {
    for (const playerId of ids) {
      if (ctx.ownership.get(playerId) !== teamId) {
        badRequest('That trade includes a player who is not on the sending roster');
      }
    }
  }

  const trade: TradeInput = {
    a: {
      team: { id: teamA.id, name: teamA.name, roster: rosterFor(ctx, teamA.id) },
      sending: input.teamASends,
    },
    b: {
      team: { id: teamB.id, name: teamB.name, roster: rosterFor(ctx, teamB.id) },
      sending: input.teamBSends,
    },
  };

  return c.json({ evaluation: evaluateTrade(trade, ctx.league.settings, ctx.valuation) });
});

/** Propose a trade to another team, storing the evaluation alongside it. */
routes.post('/', async (c) => {
  const input = await body(c, tradeShape.extend({ message: z.string().max(1000).optional() }));
  const proposing = await requireTeamOwner(c, input.teamAId);
  if (proposing.league_id !== input.leagueId) badRequest('That team is not in this league');

  const db = c.get('db');
  const ctx = await loadLeagueContext(db, input.leagueId);
  if (!ctx) notFound('League not found');

  const teamA = ctx.teams.find((t) => t.id === input.teamAId);
  const teamB = ctx.teams.find((t) => t.id === input.teamBId);
  if (!teamA || !teamB) notFound('One of those teams is not in this league');
  if (teamA.id === teamB.id) badRequest('A team cannot trade with itself');

  for (const [teamId, ids] of [
    [teamA.id, input.teamASends],
    [teamB.id, input.teamBSends],
  ] as const) {
    for (const playerId of ids) {
      if (ctx.ownership.get(playerId) !== teamId) {
        badRequest('That trade includes a player who is not on the sending roster');
      }
    }
  }

  const evaluation = evaluateTrade(
    {
      a: {
        team: { id: teamA.id, name: teamA.name, roster: rosterFor(ctx, teamA.id) },
        sending: input.teamASends,
      },
      b: {
        team: { id: teamB.id, name: teamB.name, roster: rosterFor(ctx, teamB.id) },
        sending: input.teamBSends,
      },
    },
    ctx.league.settings,
    ctx.valuation,
  );

  const trade = await db.begin(async (tx) => {
    const [row] = await tx<Array<{ id: string }>>`
      INSERT INTO trades (league_id, proposing_team_id, receiving_team_id, message, evaluation)
      VALUES (${input.leagueId}, ${teamA.id}, ${teamB.id}, ${input.message ?? null},
              ${tx.json(toJson(evaluation))})
      RETURNING id
    `;
    if (!row) throw new Error('Failed to record the trade');

    for (const playerId of input.teamASends) {
      await tx`
        INSERT INTO trade_players (trade_id, player_id, from_team_id)
        VALUES (${row.id}, ${playerId}, ${teamA.id})
      `;
    }
    for (const playerId of input.teamBSends) {
      await tx`
        INSERT INTO trade_players (trade_id, player_id, from_team_id)
        VALUES (${row.id}, ${playerId}, ${teamB.id})
      `;
    }
    return row;
  });

  return c.json({ tradeId: trade.id, evaluation }, 201);
});

routes.get('/league/:leagueId', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const trades = await db<
    Array<{
      id: string;
      status: string;
      message: string | null;
      evaluation: unknown;
      created_at: Date;
      proposing_team: string;
      receiving_team: string;
    }>
  >`
    SELECT t.id, t.status, t.message, t.evaluation, t.created_at,
           pt.name AS proposing_team, rt.name AS receiving_team
    FROM trades t
    JOIN teams pt ON pt.id = t.proposing_team_id
    JOIN teams rt ON rt.id = t.receiving_team_id
    WHERE t.league_id = ${leagueId}
    ORDER BY t.created_at DESC
    LIMIT 50
  `;

  const players = await db<
    Array<{ trade_id: string; player_id: string; from_team_id: string; full_name: string; position: string }>
  >`
    SELECT tp.trade_id, tp.player_id, tp.from_team_id, p.full_name, p.position
    FROM trade_players tp
    JOIN players p ON p.id = tp.player_id
    WHERE tp.trade_id = ANY(${trades.map((t) => t.id)})
  `;

  return c.json({
    trades: trades.map((t) => ({
      ...t,
      players: players.filter((p) => p.trade_id === t.id),
    })),
  });
});

/** Accept, reject or cancel a proposed trade. */
routes.post('/:id/respond', async (c) => {
  const tradeId = c.req.param('id');
  const { action } = await body(
    c,
    z.object({ action: z.enum(['accept', 'reject', 'cancel', 'veto']) }),
  );
  const db = c.get('db');

  const [trade] = await db<
    Array<{
      id: string;
      league_id: string;
      proposing_team_id: string;
      receiving_team_id: string;
      status: string;
    }>
  >`
    SELECT id, league_id, proposing_team_id, receiving_team_id, status
    FROM trades WHERE id = ${tradeId}
  `;
  if (!trade) notFound('Trade not found');
  if (trade.status !== 'proposed') conflict(`That trade has already been ${trade.status}`);

  const access = await requireLeagueMember(c, trade.league_id);

  // Only the receiving team accepts or rejects; only the proposer cancels; only
  // the commissioner vetoes.
  if (action === 'accept' || action === 'reject') {
    if (access.team?.id !== trade.receiving_team_id) {
      badRequest('Only the team receiving the offer can respond to it');
    }
  } else if (action === 'cancel') {
    if (access.team?.id !== trade.proposing_team_id) {
      badRequest('Only the proposing team can cancel');
    }
  } else if (!access.isCommissioner) {
    badRequest('Only the commissioner can veto a trade');
  }

  if (action !== 'accept') {
    const status = action === 'reject' ? 'rejected' : action === 'cancel' ? 'cancelled' : 'vetoed';
    await db`UPDATE trades SET status = ${status}, responded_at = now() WHERE id = ${tradeId}`;
    return c.json({ status });
  }

  // Accepting swaps the players over in one transaction so a failure cannot
  // leave a player on both rosters or on neither.
  const result = await db.begin(async (tx) => {
    const pieces = await tx<Array<{ player_id: string; from_team_id: string }>>`
      SELECT player_id, from_team_id FROM trade_players WHERE trade_id = ${tradeId}
    `;

    for (const piece of pieces) {
      const to =
        piece.from_team_id === trade.proposing_team_id
          ? trade.receiving_team_id
          : trade.proposing_team_id;

      const moved = await tx<Array<{ id: string }>>`
        UPDATE roster_slots SET team_id = ${to}, slot = 'BENCH'
        WHERE team_id = ${piece.from_team_id} AND player_id = ${piece.player_id}
        RETURNING id
      `;
      if (moved.length === 0) {
        // A player moved since the offer was made — reject rather than apply a
        // trade that no longer matches what was agreed.
        return { error: 'A player in this trade is no longer on the roster that offered him' } as const;
      }
    }

    await tx`
      UPDATE trades SET status = 'executed', responded_at = now() WHERE id = ${tradeId}
    `;
    await tx`
      INSERT INTO transactions (league_id, type, team_id, payload)
      VALUES (${trade.league_id}, 'trade', ${trade.proposing_team_id},
              ${tx.json({ tradeId, pieces })})
    `;
    return { status: 'executed' } as const;
  });

  if ('error' in result && result.error) conflict(result.error);
  return c.json(result);
});

export default routes;

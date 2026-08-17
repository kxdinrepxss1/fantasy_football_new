import { Hono } from 'hono';
import { z } from 'zod';
import {
  detectValuationDrift,
  toSnapshot,
  valuePool,
  verifyValuation,
  type ValuationSnapshotEntry,
} from '@ff/core';
import type { Variables } from '../app.js';
import { body, notFound, requireCommissioner, requireLeagueMember } from '../http.js';
import { toJson } from '../db.js';
import { loadLeagueContext } from '../services/leagueContext.js';

const routes = new Hono<{ Variables: Variables }>();

/** Every player valued for this league, best first. */
routes.get('/league/:leagueId', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const ctx = await loadLeagueContext(db, leagueId);
  if (!ctx) notFound('League not found');

  const position = c.req.query('position');
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200)));

  const names = new Map(ctx.pool.map((p) => [p.player.id, p.player.name]));
  let values = valuePool(ctx.pool, ctx.valuation);
  if (position) values = values.filter((v) => v.position === position);
  values.sort((a, b) => b.value - a.value);

  return c.json({
    replacementLevels: ctx.valuation.replacement,
    values: values.slice(0, limit).map((v) => ({
      ...v,
      name: names.get(v.playerId) ?? v.playerId,
      ownedBy: ctx.ownership.get(v.playerId) ?? null,
    })),
    total: values.length,
  });
});

/**
 * Run the verification checks against the current valuation.
 *
 * Safe to call at any time — it is read-only and takes no arguments beyond the
 * league. Intended both for a commissioner poking at it in the UI and for the
 * scheduled refresh to call after every data sync.
 */
routes.get('/league/:leagueId/verify', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const ctx = await loadLeagueContext(db, leagueId);
  if (!ctx) notFound('League not found');

  return c.json({ report: verifyValuation(ctx.pool, ctx.league.settings) });
});

/**
 * Take a valuation snapshot: verify the current numbers, diff them against the
 * previous run, and record all three. This is what the scheduled refresh calls
 * once new stats and projections have landed, and it is what makes the
 * valuations trustworthy without anyone checking them by hand.
 */
routes.post('/league/:leagueId/snapshot', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireCommissioner(c, leagueId);
  const input = await body(
    c,
    z.object({
      significantPct: z.number().min(1).max(500).optional(),
      suspiciousPct: z.number().min(1).max(1000).optional(),
    }).partial(),
  );
  const db = c.get('db');

  const ctx = await loadLeagueContext(db, leagueId);
  if (!ctx) notFound('League not found');

  const names = new Map(ctx.pool.map((p) => [p.player.id, p.player.name]));
  const values = valuePool(ctx.pool, ctx.valuation);
  const entries = toSnapshot(values, names);
  const report = verifyValuation(ctx.pool, ctx.league.settings);

  const [previous] = await db<Array<{ entries: ValuationSnapshotEntry[] }>>`
    SELECT entries FROM valuation_runs
    WHERE league_id = ${leagueId}
    ORDER BY created_at DESC LIMIT 1
  `;

  const drift = previous
    ? detectValuationDrift(previous.entries, entries, {
        significantPct: input.significantPct,
        suspiciousPct: input.suspiciousPct,
      })
    : null;

  const [run] = await db<Array<{ id: string; created_at: Date }>>`
    INSERT INTO valuation_runs (league_id, season, week, entries, verification, drift, ok, player_count)
    VALUES (${leagueId}, ${ctx.league.season}, ${ctx.league.current_week},
            ${db.json(toJson(entries))}, ${db.json(toJson(report))}, ${drift ? db.json(toJson(drift)) : null},
            ${report.ok}, ${entries.length})
    RETURNING id, created_at
  `;

  return c.json({ runId: run?.id, createdAt: run?.created_at, report, drift }, 201);
});

/** History of valuation runs, so a bad refresh can be traced back. */
routes.get('/league/:leagueId/runs', async (c) => {
  const leagueId = c.req.param('leagueId');
  await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const runs = await db`
    SELECT id, season, week, ok, player_count, verification, drift, created_at
    FROM valuation_runs
    WHERE league_id = ${leagueId}
    ORDER BY created_at DESC
    LIMIT 20
  `;

  return c.json({ runs });
});

export default routes;

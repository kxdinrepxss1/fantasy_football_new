import { Hono } from 'hono';
import { scoreStatLine, valuePlayer, type StatLine } from '@ff/core';
import type { Variables } from '../app.js';
import { num, type PlayerRow } from '../db.js';
import { notFound, requireLeagueMember, requireUser } from '../http.js';
import { loadLeagueContext, toPlayer } from '../services/leagueContext.js';

const routes = new Hono<{ Variables: Variables }>();

/** Search the player database. Not league-specific. */
routes.get('/', async (c) => {
  requireUser(c);
  const db = c.get('db');

  const search = c.req.query('q')?.trim().toLowerCase();
  const position = c.req.query('position');
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50)));

  const players = await db<PlayerRow[]>`
    SELECT id, source, source_id, full_name, position, nfl_team, age, bye_week,
           injury_status, injury_note, rostered_pct, rostered_pct_delta, active
    FROM players
    WHERE active
      ${search ? db`AND lower(full_name) LIKE ${`%${search}%`}` : db``}
      ${position ? db`AND position = ${position}` : db``}
    ORDER BY rostered_pct DESC NULLS LAST, full_name
    LIMIT ${limit}
  `;

  return c.json({ players: players.map(toPlayer) });
});

/** One player, with league-specific value when a league is supplied. */
routes.get('/:id', async (c) => {
  requireUser(c);
  const playerId = c.req.param('id');
  const leagueId = c.req.query('leagueId');
  const db = c.get('db');

  const [row] = await db<PlayerRow[]>`
    SELECT id, source, source_id, full_name, position, nfl_team, age, bye_week,
           injury_status, injury_note, rostered_pct, rostered_pct_delta, active
    FROM players WHERE id = ${playerId}
  `;
  if (!row) notFound('Player not found');

  const news = await db<Array<{ headline: string; body: string | null; source: string | null; published_at: Date }>>`
    SELECT headline, body, source, url, published_at
    FROM player_news WHERE player_id = ${playerId}
    ORDER BY published_at DESC LIMIT 10
  `;

  if (!leagueId) {
    return c.json({ player: toPlayer(row), news, value: null });
  }

  const { league } = await requireLeagueMember(c, leagueId);
  const ctx = await loadLeagueContext(db, leagueId);
  if (!ctx) notFound('League not found');

  const entry = ctx.poolById.get(playerId);
  const stats = await db<Array<{ week: number; stats: StatLine }>>`
    SELECT week, stats FROM player_stats
    WHERE player_id = ${playerId} AND season = ${league.season}
    ORDER BY week
  `;

  return c.json({
    player: toPlayer(row),
    news,
    value: entry ? valuePlayer(entry, ctx.valuation) : null,
    projectedPerGame: entry?.perGame ?? null,
    ownedBy: ctx.ownership.get(playerId) ?? null,
    // Week-by-week actual scoring in this league's rules.
    weeklyScores: stats.map((s) => ({
      week: s.week,
      points: scoreStatLine(s.stats, league.settings.scoring).total,
    })),
  });
});

/** The league-wide news and injury feed. */
routes.get('/news/feed', async (c) => {
  requireUser(c);
  const db = c.get('db');
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 40)));
  const onlyInjuries = c.req.query('injuriesOnly') === '1';

  const news = await db`
    SELECT n.id, n.headline, n.body, n.source, n.url, n.injury_status, n.published_at,
           p.id AS player_id, p.full_name, p.position, p.nfl_team
    FROM player_news n
    LEFT JOIN players p ON p.id = n.player_id
    WHERE true ${onlyInjuries ? db`AND n.injury_status IS NOT NULL` : db``}
    ORDER BY n.published_at DESC
    LIMIT ${limit}
  `;

  return c.json({ news });
});

export default routes;

import { Hono } from 'hono';
import { z } from 'zod';
import {
  SCORING_PRESETS,
  computePowerRankings,
  computeStandings,
  buildPlayoffBracket,
  defaultLeagueSettings,
  playoffSchedule,
  type LeagueSettings,
  type MatchupResult,
} from '@ff/core';
import type { Variables } from '../app.js';
import { generateToken, hashToken } from '../auth.js';
import { num, toJson, type LeagueRow, type MatchupRow, type TeamRow } from '../db.js';
import {
  badRequest,
  body,
  conflict,
  notFound,
  requireCommissioner,
  requireLeagueMember,
  requireUser,
} from '../http.js';
import { generateSchedule, regularSeasonWeeks } from '../services/schedule.js';
import { leagueSettingsSchema } from '../validation.js';

const routes = new Hono<{ Variables: Variables }>();

const INVITE_TTL_DAYS = 14;

const createLeague = z.object({
  name: z.string().min(1).max(80),
  teamCount: z.number().int().min(4).max(16),
  preset: z.enum(['standard', 'half_ppr', 'ppr', 'superflex']).default('half_ppr'),
  season: z.number().int().min(2000).max(2100).optional(),
  /** Optional overrides applied on top of the preset. */
  settings: leagueSettingsSchema.partial().optional(),
  /** Names for the teams; missing ones are filled in as "Team 1" and so on. */
  teamNames: z.array(z.string().min(1).max(60)).optional(),
});

routes.post('/', async (c) => {
  const user = requireUser(c);
  const input = await body(c, createLeague);
  const db = c.get('db');
  const env = c.get('env');

  const base = defaultLeagueSettings(input.preset, input.teamCount);
  const settings: LeagueSettings = {
    ...base,
    ...(input.settings ?? {}),
    teamCount: input.teamCount,
    scoring: { ...base.scoring, ...(input.settings?.scoring ?? {}) },
    roster: { ...base.roster, ...(input.settings?.roster ?? {}) },
    waivers: { ...base.waivers, ...(input.settings?.waivers ?? {}) },
    playoffs: { ...base.playoffs, ...(input.settings?.playoffs ?? {}) },
  };

  if (settings.playoffs.teams > input.teamCount) {
    badRequest('More playoff spots than teams in the league');
  }

  const league = await db.begin(async (tx) => {
    const [row] = await tx<LeagueRow[]>`
      INSERT INTO leagues (name, commissioner_id, season, team_count, settings)
      VALUES (${input.name}, ${user.sub}, ${input.season ?? env.SEASON}, ${input.teamCount}, ${tx.json(toJson(settings))})
      RETURNING id, name, commissioner_id, season, team_count, settings, status, current_week
    `;
    if (!row) throw new Error('Failed to create league');

    // Every team exists from the start so the schedule and draft order are
    // stable; owners claim them by invite afterwards.
    for (let i = 0; i < input.teamCount; i++) {
      const name = input.teamNames?.[i] ?? `Team ${i + 1}`;
      // The commissioner takes the first team by default.
      const ownerId = i === 0 ? user.sub : null;
      await tx`
        INSERT INTO teams (league_id, owner_id, name, faab_remaining, waiver_priority, draft_position)
        VALUES (${row.id}, ${ownerId}, ${name}, ${settings.waivers.faabBudget}, ${i + 1}, ${i + 1})
      `;
    }
    return row;
  });

  return c.json({ league }, 201);
});

routes.get('/:id', async (c) => {
  const { league, team, isCommissioner } = await requireLeagueMember(c, c.req.param('id'));
  const db = c.get('db');

  const teams = await db<TeamRow[]>`
    SELECT t.id, t.league_id, t.owner_id, t.name, t.abbreviation, t.faab_remaining,
           t.waiver_priority, t.draft_position
    FROM teams t WHERE t.league_id = ${league.id}
    ORDER BY t.draft_position NULLS LAST, t.name
  `;

  const owners = await db<Array<{ id: string; display_name: string; email: string }>>`
    SELECT u.id, u.display_name, u.email
    FROM users u
    JOIN teams t ON t.owner_id = u.id
    WHERE t.league_id = ${league.id}
  `;
  const ownerById = new Map(owners.map((o) => [o.id, o]));

  return c.json({
    league,
    myTeamId: team?.id ?? null,
    isCommissioner,
    teams: teams.map((t) => ({
      ...t,
      owner: t.owner_id ? (ownerById.get(t.owner_id) ?? null) : null,
    })),
  });
});

/** Scoring and roster rules can be changed before the season or mid-season. */
routes.patch('/:id/settings', async (c) => {
  const leagueId = c.req.param('id');
  const { league } = await requireCommissioner(c, leagueId);
  const patch = await body(c, leagueSettingsSchema.partial());
  const db = c.get('db');

  const current = league.settings;
  const settings: LeagueSettings = {
    ...current,
    ...patch,
    // Team count is fixed once teams exist; changing it would orphan rosters.
    teamCount: current.teamCount,
    scoring: { ...current.scoring, ...(patch.scoring ?? {}) },
    roster: { ...current.roster, ...(patch.roster ?? {}) },
    waivers: { ...current.waivers, ...(patch.waivers ?? {}) },
    playoffs: { ...current.playoffs, ...(patch.playoffs ?? {}) },
  };

  if (settings.playoffs.teams > current.teamCount) {
    badRequest('More playoff spots than teams in the league');
  }

  const [updated] = await db<LeagueRow[]>`
    UPDATE leagues SET settings = ${db.json(toJson(settings))}, updated_at = now()
    WHERE id = ${leagueId}
    RETURNING id, name, commissioner_id, season, team_count, settings, status, current_week
  `;

  // Scores are always recomputed from raw stat lines, so a mid-season scoring
  // change applies to completed weeks too rather than leaving history stale.
  return c.json({ league: updated, note: 'Scoring changes apply to past weeks as well.' });
});

routes.get('/:id/scoring-presets', async (c) => {
  await requireLeagueMember(c, c.req.param('id'));
  return c.json({
    presets: Object.fromEntries(
      Object.entries(SCORING_PRESETS).map(([name, build]) => [name, build()]),
    ),
  });
});

/* -------------------------------------------------------------------------- */
/* Invites                                                                    */
/* -------------------------------------------------------------------------- */

routes.post('/:id/invites', async (c) => {
  const leagueId = c.req.param('id');
  const { user } = await requireLeagueMember(c, leagueId);
  await requireCommissioner(c, leagueId);

  const input = await body(
    c,
    z.object({ email: z.string().email().optional(), teamId: z.string().uuid().optional() }),
  );
  const db = c.get('db');
  const env = c.get('env');

  if (input.teamId) {
    const [team] = await db<TeamRow[]>`
      SELECT id, owner_id FROM teams WHERE id = ${input.teamId} AND league_id = ${leagueId}
    `;
    if (!team) notFound('That team is not in this league');
    if (team.owner_id) conflict('That team already has an owner');
  }

  const token = generateToken();
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

  await db`
    INSERT INTO league_invites (league_id, team_id, email, token_hash, created_by, expires_at)
    VALUES (${leagueId}, ${input.teamId ?? null}, ${input.email ?? null},
            ${await hashToken(token)}, ${user.sub}, ${expires})
  `;

  const url = `${env.APP_URL}/join?token=${token}`;
  if (env.DEV_EMAIL_TO_CONSOLE) console.log(`\n  League invite: ${url}\n`);

  return c.json({ inviteUrl: url, expiresAt: expires.toISOString() }, 201);
});

/** Accept an invite and claim a team. */
routes.post('/join', async (c) => {
  const user = requireUser(c);
  const { token, teamName } = await body(
    c,
    z.object({ token: z.string().min(10), teamName: z.string().min(1).max(60).optional() }),
  );
  const db = c.get('db');

  const result = await db.begin(async (tx) => {
    const [invite] = await tx<
      Array<{ id: string; league_id: string; team_id: string | null }>
    >`
      SELECT id, league_id, team_id FROM league_invites
      WHERE token_hash = ${await hashToken(token)}
        AND accepted_at IS NULL
        AND expires_at > now()
      FOR UPDATE
    `;
    if (!invite) return { error: 'That invite is invalid or has expired' } as const;

    const [already] = await tx<TeamRow[]>`
      SELECT id FROM teams WHERE league_id = ${invite.league_id} AND owner_id = ${user.sub}
    `;
    if (already) return { error: 'You already have a team in this league' } as const;

    // A targeted invite names its team; a shareable link takes the first team
    // that nobody has claimed yet.
    const [team] = invite.team_id
      ? await tx<TeamRow[]>`
          SELECT id, name, owner_id FROM teams
          WHERE id = ${invite.team_id} AND owner_id IS NULL FOR UPDATE
        `
      : await tx<TeamRow[]>`
          SELECT id, name, owner_id FROM teams
          WHERE league_id = ${invite.league_id} AND owner_id IS NULL
          ORDER BY draft_position NULLS LAST LIMIT 1 FOR UPDATE
        `;
    if (!team) return { error: 'Every team in this league has been claimed' } as const;

    await tx`
      UPDATE teams SET owner_id = ${user.sub},
                       name = ${teamName ?? team.name}
      WHERE id = ${team.id}
    `;
    await tx`
      UPDATE league_invites SET accepted_at = now(), accepted_by = ${user.sub}
      WHERE id = ${invite.id}
    `;

    return { leagueId: invite.league_id, teamId: team.id } as const;
  });

  if ('error' in result && result.error) badRequest(result.error);
  return c.json(result);
});

/* -------------------------------------------------------------------------- */
/* Schedule, standings, playoffs                                              */
/* -------------------------------------------------------------------------- */

/** Generate the regular-season schedule. Safe to re-run before week 1. */
routes.post('/:id/schedule', async (c) => {
  const leagueId = c.req.param('id');
  const { league } = await requireCommissioner(c, leagueId);
  const db = c.get('db');

  const teams = await db<TeamRow[]>`
    SELECT id FROM teams WHERE league_id = ${leagueId} ORDER BY draft_position NULLS LAST, name
  `;
  if (teams.length < 2) badRequest('The league needs at least two teams');

  const [played] = await db<Array<{ count: string }>>`
    SELECT count(*) FROM matchups WHERE league_id = ${leagueId} AND final
  `;
  if (num(played?.count) > 0) conflict('Games have already been played — the schedule is locked');

  const weeks = regularSeasonWeeks(league.settings.playoffs.startWeek);
  const schedule = generateSchedule(
    teams.map((t) => t.id),
    weeks,
  );

  await db.begin(async (tx) => {
    await tx`DELETE FROM matchups WHERE league_id = ${leagueId}`;
    for (const m of schedule) {
      await tx`
        INSERT INTO matchups (league_id, week, home_team_id, away_team_id)
        VALUES (${leagueId}, ${m.week}, ${m.homeTeamId}, ${m.awayTeamId})
      `;
    }
  });

  return c.json({ weeks, matchups: schedule.length });
});

routes.get('/:id/standings', async (c) => {
  const leagueId = c.req.param('id');
  const { league } = await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const [teams, matchups] = await Promise.all([
    db<TeamRow[]>`SELECT id, name FROM teams WHERE league_id = ${leagueId}`,
    db<MatchupRow[]>`
      SELECT week, home_team_id, away_team_id, home_score, away_score, final
      FROM matchups WHERE league_id = ${leagueId}
    `,
  ]);

  const results: MatchupResult[] = matchups.map((m) => ({
    week: m.week,
    homeTeamId: m.home_team_id,
    awayTeamId: m.away_team_id,
    homeScore: num(m.home_score),
    awayScore: num(m.away_score),
    final: m.final,
  }));

  const standings = computeStandings(
    teams.map((t) => ({ id: t.id, name: t.name })),
    results,
    league.settings.playoffs,
  );

  return c.json({
    standings,
    powerRankings: computePowerRankings(standings, results),
    bracket: buildPlayoffBracket(standings, league.settings.playoffs),
    playoffSchedule: playoffSchedule(league.settings.playoffs),
  });
});

/** Advance the league to the next week. */
routes.post('/:id/advance-week', async (c) => {
  const leagueId = c.req.param('id');
  await requireCommissioner(c, leagueId);
  const db = c.get('db');

  const [updated] = await db<LeagueRow[]>`
    UPDATE leagues SET current_week = current_week + 1, updated_at = now()
    WHERE id = ${leagueId}
    RETURNING id, current_week, status
  `;
  return c.json({ league: updated });
});

export default routes;

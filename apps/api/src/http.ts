import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { Variables } from './app.js';
import type { JwtPayload } from './auth.js';
import type { Db, LeagueRow, TeamRow } from './db.js';

export type Ctx = Context<{ Variables: Variables }>;

/** The signed-in user, or a 401. */
export function requireUser(c: Ctx): JwtPayload {
  const user = c.get('user');
  if (!user) throw new HTTPException(401, { message: 'Sign in required' });
  return user;
}

/** Parse and validate a JSON body, turning schema failures into a 400. */
export async function body<T extends z.ZodTypeAny>(c: Ctx, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Expected a JSON body' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    throw new HTTPException(400, {
      message: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request',
    });
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* League access                                                              */
/* -------------------------------------------------------------------------- */

export interface LeagueAccess {
  league: LeagueRow;
  /** The caller's team in this league, if they own one. */
  team: TeamRow | null;
  isCommissioner: boolean;
}

/**
 * Load a league and confirm the caller belongs to it.
 *
 * Membership means either running the league or owning a team in it — the two
 * roles a user can hold, and a user may hold different roles in different
 * leagues at the same time.
 */
export async function requireLeagueMember(
  c: Ctx,
  leagueId: string,
): Promise<LeagueAccess & { user: JwtPayload }> {
  const user = requireUser(c);
  const db = c.get('db');

  const [league] = await db<LeagueRow[]>`
    SELECT id, name, commissioner_id, season, team_count, settings, status, current_week
    FROM leagues WHERE id = ${leagueId}
  `;
  if (!league) throw new HTTPException(404, { message: 'League not found' });

  const [team] = await db<TeamRow[]>`
    SELECT id, league_id, owner_id, name, abbreviation, faab_remaining, waiver_priority, draft_position
    FROM teams WHERE league_id = ${leagueId} AND owner_id = ${user.sub}
  `;

  const isCommissioner = league.commissioner_id === user.sub;
  if (!team && !isCommissioner) {
    throw new HTTPException(403, { message: 'You are not a member of this league' });
  }

  return { league, team: team ?? null, isCommissioner, user };
}

export async function requireCommissioner(c: Ctx, leagueId: string): Promise<LeagueAccess> {
  const access = await requireLeagueMember(c, leagueId);
  if (!access.isCommissioner) {
    throw new HTTPException(403, { message: 'Only the commissioner can do that' });
  }
  return access;
}

/** Confirm the caller owns this team, returning it. */
export async function requireTeamOwner(c: Ctx, teamId: string): Promise<TeamRow> {
  const user = requireUser(c);
  const db: Db = c.get('db');
  const [team] = await db<TeamRow[]>`
    SELECT id, league_id, owner_id, name, abbreviation, faab_remaining, waiver_priority, draft_position
    FROM teams WHERE id = ${teamId}
  `;
  if (!team) throw new HTTPException(404, { message: 'Team not found' });

  if (team.owner_id !== user.sub) {
    // A commissioner can act on any team in their own league.
    const [league] = await db<Array<{ commissioner_id: string }>>`
      SELECT commissioner_id FROM leagues WHERE id = ${team.league_id}
    `;
    if (league?.commissioner_id !== user.sub) {
      throw new HTTPException(403, { message: 'That is not your team' });
    }
  }
  return team;
}

export function notFound(message: string): never {
  throw new HTTPException(404, { message });
}

export function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

export function conflict(message: string): never {
  throw new HTTPException(409, { message });
}

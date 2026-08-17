import postgres from 'postgres';
import type { JSONValue, Sql } from 'postgres';

export type Db = Sql;

/**
 * postgres.js types its json() helper against a structural JSONValue that our
 * interfaces do not declare an index signature for, even though they serialise
 * perfectly well. This keeps the cast in one place instead of scattering it
 * across every insert that writes a jsonb column.
 */
export function toJson(value: unknown): JSONValue {
  return value as JSONValue;
}

/**
 * postgres.js works on both Node and Cloudflare Workers (via Hyperdrive), so a
 * single client factory covers both deployment targets.
 *
 * Workers spin up per request, so the connection pool is kept small and idle
 * connections are closed quickly; under Node the same settings are harmless.
 */
/**
 * Supavisor (Supabase's pooler) in *transaction* mode hands each query a
 * different backend connection, so server-side prepared statements — which
 * postgres.js uses by default — fail with "prepared statement already exists".
 * Session mode on port 5432 is fine.
 *
 * Detecting the transaction port saves a confusing runtime failure for anyone
 * who copies the pooled string Supabase shows first. Override explicitly with
 * DATABASE_PREPARE=false if another pooler (PgBouncer, pgcat) is in the way.
 */
export function usesTransactionPooler(databaseUrl: string): boolean {
  return /pooler\.supabase\.com:6543/.test(databaseUrl) || /[?&]pgbouncer=true/.test(databaseUrl);
}

export function createDb(databaseUrl: string, options: { prepare?: boolean } = {}): Db {
  const prepare = options.prepare ?? !usesTransactionPooler(databaseUrl);

  return postgres(databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare,
    onnotice: () => {},
    transform: { undefined: null },
  });
}

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                 */
/* -------------------------------------------------------------------------- */

import type { LeagueSettings, LineupSlot, Position, StatLine } from '@ff/core';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string;
  created_at: Date;
}

export interface LeagueRow {
  id: string;
  name: string;
  commissioner_id: string;
  season: number;
  team_count: number;
  settings: LeagueSettings;
  status: 'setup' | 'drafting' | 'in_season' | 'complete';
  current_week: number;
}

export interface TeamRow {
  id: string;
  league_id: string;
  owner_id: string | null;
  name: string;
  abbreviation: string | null;
  faab_remaining: number;
  waiver_priority: number;
  draft_position: number | null;
}

export interface PlayerRow {
  id: string;
  source: string;
  source_id: string;
  full_name: string;
  position: Position;
  nfl_team: string | null;
  age: string | number | null;
  bye_week: number | null;
  injury_status:
    | 'ACTIVE'
    | 'QUESTIONABLE'
    | 'DOUBTFUL'
    | 'OUT'
    | 'IR'
    | 'PUP'
    | 'SUSPENDED';
  injury_note: string | null;
  rostered_pct: string | number | null;
  rostered_pct_delta: string | number | null;
  active: boolean;
}

export interface RosterSlotRow {
  id: string;
  team_id: string;
  player_id: string;
  slot: LineupSlot;
}

export interface ProjectionRow {
  player_id: string;
  season: number;
  week: number;
  stats: StatLine;
  source: string;
}

export interface MatchupRow {
  id: string;
  league_id: string;
  week: number;
  home_team_id: string;
  away_team_id: string;
  home_score: string | number;
  away_score: string | number;
  final: boolean;
  playoff_round: number;
}

/**
 * Postgres returns numeric columns as strings to avoid precision loss. Every
 * read path funnels through here so a numeric never reaches the engines as a
 * string and silently poisons the arithmetic.
 */
export function num(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

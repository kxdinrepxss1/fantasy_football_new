-- Initial schema for the fantasy football league app.
--
-- Written for plain Postgres so it works on Supabase, a local cluster, or any
-- managed Postgres. No Supabase-specific extensions are required.

-- gen_random_uuid() is core Postgres from version 13 onward, so no extension is
-- required on any currently supported server. This block is only a fallback for
-- older installs, and it tolerates failure because managed hosts (Supabase among
-- them) often restrict CREATE EXTENSION to a specific schema or to superusers —
-- in which case the function is already present anyway.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipping pgcrypto (%). gen_random_uuid() is built in on Postgres 13+.', SQLERRM;
END
$$;

/* -------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* -------------------------------------------------------------------------- */

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  -- Null for accounts that only ever sign in by magic link.
  password_hash text,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_email_idx ON users (lower(email));

-- Single-use tokens backing both magic-link sign-in and password resets.
CREATE TABLE auth_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  purpose    text NOT NULL CHECK (purpose IN ('magic_link', 'password_reset')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id);

/* -------------------------------------------------------------------------- */
/* Leagues                                                                    */
/* -------------------------------------------------------------------------- */

CREATE TABLE leagues (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  commissioner_id  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  season           integer NOT NULL,
  team_count       integer NOT NULL CHECK (team_count BETWEEN 4 AND 16),
  -- The full LeagueSettings object from @ff/core: scoring, roster, waivers,
  -- playoffs and dynasty weight. Kept as one document so a commissioner can
  -- change any individual stat value without a migration, and so two leagues
  -- can run completely different rules at the same time.
  settings         jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'setup'
                     CHECK (status IN ('setup', 'drafting', 'in_season', 'complete')),
  current_week     integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leagues_commissioner_idx ON leagues (commissioner_id);

CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id       uuid NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
  -- Null until an invited owner claims the team.
  owner_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  name            text NOT NULL,
  abbreviation    text,
  faab_remaining  integer NOT NULL DEFAULT 100,
  waiver_priority integer NOT NULL DEFAULT 1,
  draft_position  integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, name)
);

CREATE INDEX teams_league_idx ON teams (league_id);
-- A user holds at most one team per league, but may own teams in many leagues.
CREATE UNIQUE INDEX teams_one_per_owner_idx
  ON teams (league_id, owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE league_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   uuid NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
  team_id     uuid REFERENCES teams (id) ON DELETE SET NULL,
  -- Null for a shareable link that anyone can use; set for a targeted email.
  email       text,
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX league_invites_league_idx ON league_invites (league_id);

/* -------------------------------------------------------------------------- */
/* Players and their data                                                     */
/* -------------------------------------------------------------------------- */

CREATE TABLE players (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Where this record came from, so a second provider can be added later
  -- without colliding ids.
  source             text NOT NULL DEFAULT 'sleeper',
  source_id          text NOT NULL,
  full_name          text NOT NULL,
  position           text NOT NULL CHECK (position IN ('QB','RB','WR','TE','K','DST')),
  nfl_team           text,
  birthdate          date,
  -- Denormalised from birthdate at sync time so valuation does not have to
  -- recompute it per request; refreshed by the same job.
  age                numeric(4,1),
  bye_week           integer,
  injury_status      text NOT NULL DEFAULT 'ACTIVE'
                       CHECK (injury_status IN ('ACTIVE','QUESTIONABLE','DOUBTFUL','OUT','IR','PUP','SUSPENDED')),
  injury_note        text,
  -- Rostership across the wider fantasy world; drives the trending-adds list.
  rostered_pct       numeric(5,2),
  rostered_pct_delta numeric(5,2),
  active             boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX players_position_idx ON players (position) WHERE active;
CREATE INDEX players_name_idx ON players (lower(full_name));
CREATE INDEX players_nfl_team_idx ON players (nfl_team);

-- Actual weekly production. Scoring is computed from this per league, never
-- stored pre-scored, so changing a league's scoring retroactively recomputes
-- every historical week correctly.
CREATE TABLE player_stats (
  player_id uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  season    integer NOT NULL,
  week      integer NOT NULL,
  stats     jsonb NOT NULL,
  source    text NOT NULL DEFAULT 'sleeper',
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season, week)
);

CREATE INDEX player_stats_week_idx ON player_stats (season, week);

CREATE TABLE player_projections (
  player_id uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  season    integer NOT NULL,
  -- Week 0 holds a rest-of-season projection; 1-18 hold weekly ones.
  week      integer NOT NULL,
  stats     jsonb NOT NULL,
  source    text NOT NULL DEFAULT 'sleeper',
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season, week, source)
);

CREATE INDEX player_projections_week_idx ON player_projections (season, week);

CREATE TABLE player_news (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id    uuid REFERENCES players (id) ON DELETE CASCADE,
  headline     text NOT NULL,
  body         text,
  source       text,
  url          text,
  -- Set when the item is an injury update, so the waiver engine can react.
  injury_status text,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX player_news_player_idx ON player_news (player_id, published_at DESC);
CREATE INDEX player_news_recent_idx ON player_news (published_at DESC);

/* -------------------------------------------------------------------------- */
/* Rosters                                                                    */
/* -------------------------------------------------------------------------- */

CREATE TABLE roster_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  player_id   uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  slot        text NOT NULL
                CHECK (slot IN ('QB','RB','WR','TE','K','DST','FLEX','SUPERFLEX','REC_FLEX','BENCH','IR')),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, player_id)
);

CREATE INDEX roster_slots_team_idx ON roster_slots (team_id);
CREATE INDEX roster_slots_player_idx ON roster_slots (player_id);

-- A player may be rostered by at most one team within a league. Enforced with a
-- trigger because the league id lives on teams rather than on roster_slots.
CREATE OR REPLACE FUNCTION enforce_single_roster_per_league() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM roster_slots rs
    JOIN teams t  ON t.id = rs.team_id
    JOIN teams nt ON nt.id = NEW.team_id
    WHERE rs.player_id = NEW.player_id
      AND t.league_id = nt.league_id
      AND rs.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'player % is already rostered in this league', NEW.player_id
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roster_slots_single_league_owner
  BEFORE INSERT OR UPDATE OF player_id, team_id ON roster_slots
  FOR EACH ROW EXECUTE FUNCTION enforce_single_roster_per_league();

/* -------------------------------------------------------------------------- */
/* Schedule and scoring                                                       */
/* -------------------------------------------------------------------------- */

CREATE TABLE matchups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id    uuid NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
  week         integer NOT NULL,
  home_team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  away_team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  home_score   numeric(8,2) NOT NULL DEFAULT 0,
  away_score   numeric(8,2) NOT NULL DEFAULT 0,
  final        boolean NOT NULL DEFAULT false,
  -- 0 for regular season, 1+ for playoff rounds.
  playoff_round integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (home_team_id <> away_team_id),
  UNIQUE (league_id, week, home_team_id)
);

CREATE INDEX matchups_league_week_idx ON matchups (league_id, week);

-- Which players a team actually started in a given week, so a completed week is
-- frozen rather than recomputed from today's roster.
CREATE TABLE lineup_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matchup_id uuid NOT NULL REFERENCES matchups (id) ON DELETE CASCADE,
  team_id    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  slot       text NOT NULL,
  points     numeric(8,2) NOT NULL DEFAULT 0,
  UNIQUE (matchup_id, team_id, player_id)
);

CREATE INDEX lineup_entries_matchup_idx ON lineup_entries (matchup_id);

/* -------------------------------------------------------------------------- */
/* Transactions: adds, drops, trades                                          */
/* -------------------------------------------------------------------------- */

CREATE TABLE transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   uuid NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('add','drop','add_drop','trade','draft')),
  team_id     uuid REFERENCES teams (id) ON DELETE SET NULL,
  week        integer,
  -- Player ids and any FAAB bid, shaped by type.
  payload     jsonb NOT NULL,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transactions_league_idx ON transactions (league_id, created_at DESC);

CREATE TABLE trades (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id         uuid NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
  proposing_team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  receiving_team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','accepted','rejected','cancelled','vetoed','executed')),
  message           text,
  -- The trade calculator's verdict at proposal time, kept for the history feed.
  evaluation        jsonb,
  responded_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (proposing_team_id <> receiving_team_id)
);

CREATE INDEX trades_league_idx ON trades (league_id, created_at DESC);

CREATE TABLE trade_players (
  trade_id  uuid NOT NULL REFERENCES trades (id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  -- The team giving this player up.
  from_team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  PRIMARY KEY (trade_id, player_id)
);

CREATE TABLE waiver_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   uuid NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
  team_id     uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  add_player_id  uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  drop_player_id uuid REFERENCES players (id) ON DELETE SET NULL,
  bid_amount  integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','won','lost','cancelled','invalid')),
  process_at  timestamptz NOT NULL,
  processed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX waiver_claims_pending_idx ON waiver_claims (league_id, process_at)
  WHERE status = 'pending';

/* -------------------------------------------------------------------------- */
/* Draft room                                                                 */
/* -------------------------------------------------------------------------- */

CREATE TABLE drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id        uuid NOT NULL REFERENCES leagues (id) ON DELETE CASCADE UNIQUE,
  type             text NOT NULL DEFAULT 'snake' CHECK (type IN ('snake','auction')),
  status           text NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled','in_progress','paused','complete')),
  rounds           integer NOT NULL,
  pick_timer_secs  integer NOT NULL DEFAULT 90,
  -- Auction only.
  budget           integer NOT NULL DEFAULT 200,
  current_pick     integer NOT NULL DEFAULT 1,
  -- When the current pick's clock started; the timer is derived from this so a
  -- client refresh cannot reset it.
  pick_started_at  timestamptz,
  scheduled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE draft_picks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id    uuid NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
  pick_number integer NOT NULL,
  round       integer NOT NULL,
  team_id     uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  player_id   uuid REFERENCES players (id) ON DELETE SET NULL,
  -- Auction price, null for snake drafts.
  amount      integer,
  -- True when the pick was made by autodraft after the timer expired.
  auto        boolean NOT NULL DEFAULT false,
  picked_at   timestamptz,
  UNIQUE (draft_id, pick_number)
);

CREATE INDEX draft_picks_draft_idx ON draft_picks (draft_id, pick_number);

/* -------------------------------------------------------------------------- */
/* Valuation snapshots                                                        */
/* -------------------------------------------------------------------------- */

-- Every valuation refresh writes a snapshot so the next run can diff against it
-- and report what moved, and so a verification failure can be traced to the run
-- that introduced it.
CREATE TABLE valuation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id     uuid NOT NULL REFERENCES leagues (id) ON DELETE CASCADE,
  season        integer NOT NULL,
  week          integer NOT NULL,
  -- Compact per-player values: the ValuationSnapshotEntry[] shape from @ff/core.
  entries       jsonb NOT NULL,
  -- The VerificationReport for this run.
  verification  jsonb NOT NULL,
  -- The DriftReport against the previous run, null for the first one.
  drift         jsonb,
  ok            boolean NOT NULL DEFAULT true,
  player_count  integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX valuation_runs_league_idx ON valuation_runs (league_id, created_at DESC);

/* -------------------------------------------------------------------------- */
/* Sync bookkeeping                                                           */
/* -------------------------------------------------------------------------- */

-- One row per data-sync job so the app can show when player data was last
-- refreshed and surface failures rather than silently serving stale numbers.
CREATE TABLE sync_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job         text NOT NULL,
  status      text NOT NULL CHECK (status IN ('running','success','failed')),
  season      integer,
  week        integer,
  records     integer NOT NULL DEFAULT 0,
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX sync_runs_job_idx ON sync_runs (job, started_at DESC);

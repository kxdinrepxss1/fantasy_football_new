/**
 * Seed a fully-populated demo league.
 *
 * This exists so the app can be run, developed against and demoed without any
 * external data provider — useful on a machine that cannot reach Sleeper, and
 * as a fixed dataset for working on the valuation and trade engines.
 *
 *   node --experimental-strip-types scripts/seed.ts
 *
 * Everything is generated from a fixed seed, so the same league comes out every
 * time and a change in the engines shows up as a change in the output rather
 * than as noise.
 */
import postgres from 'postgres';
import {
  defaultLeagueSettings,
  optimizeLineup,
  scoreStatLine,
  startingSlots,
  type LineupSlot,
  type Position,
  type StatLine,
} from '@ff/core';
import { hashPassword } from '../apps/api/dist/auth.js';
import { generateSchedule, regularSeasonWeeks } from '../apps/api/dist/services/schedule.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/fantasy_football';

const SEASON = Number(process.env.SEASON ?? 2025);
const WEEKS_PLAYED = 3;
const TEAM_COUNT = 12;
const DEMO_PASSWORD = 'password123';

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

/* -------------------------------------------------------------------------- */
/* Deterministic randomness                                                   */
/* -------------------------------------------------------------------------- */

/** mulberry32 — small, fast, and stable across Node versions. */
function makeRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20250817);

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function jitter(value: number, spread: number): number {
  return value * (1 + (rng() - 0.5) * 2 * spread);
}

/* -------------------------------------------------------------------------- */
/* Player generation                                                          */
/* -------------------------------------------------------------------------- */

const FIRST_NAMES = [
  'Marcus', 'Devon', 'Tyler', 'Jalen', 'Amari', 'Brock', 'Caleb', 'Dante', 'Elijah', 'Finn',
  'Garrett', 'Hunter', 'Isaiah', 'Jamal', 'Kenny', 'Logan', 'Malik', 'Nate', 'Owen', 'Preston',
  'Quinn', 'Rashad', 'Silas', 'Trey', 'Vince', 'Wyatt', 'Xavier', 'Zane', 'Cooper', 'Damon',
];

const LAST_NAMES = [
  'Alvarez', 'Boone', 'Callahan', 'Dawson', 'Ellison', 'Franklin', 'Grady', 'Holloway', 'Iverson',
  'Jennings', 'Kowalski', 'Lockhart', 'Mercer', 'Nakamura', 'Okafor', 'Pruitt', 'Quintero',
  'Reyes', 'Sinclair', 'Thornton', 'Underwood', 'Vaughn', 'Whitfield', 'Yates', 'Zimmerman',
  'Barrett', 'Castillo', 'Delgado', 'Emerson', 'Fitzgerald',
];

const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND',
  'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA',
  'SF', 'TB', 'TEN', 'WAS',
];

const BYE_WEEKS: Record<string, number> = Object.fromEntries(
  NFL_TEAMS.map((team, i) => [team, 5 + (i % 10)]),
);

interface GeneratedPlayer {
  sourceId: string;
  name: string;
  position: Position;
  nflTeam: string;
  age: number;
  byeWeek: number;
  injuryStatus: string;
  rosteredPct: number;
  rosteredPctDelta: number;
  /** Per-game projection as a stat line. */
  projection: StatLine;
  /** Talent level 0-1, used to generate consistent weekly stat lines. */
  talent: number;
}

/**
 * Position shapes: how many exist, the best one's output, the level production
 * flattens out to, and how quickly it gets there.
 *
 * The curve decays exponentially toward `floor` rather than sliding to zero,
 * because that is what real fantasy production does — the 50th receiver is
 * replacement-level, not worthless. Getting this shape right matters more than
 * it looks: replacement level, scarcity premiums and every waiver ranking are
 * read off these curves, and a tail that collapses to zero makes streamable
 * defenses look better than startable skill players.
 */
const POSITION_SHAPE: Record<
  Position,
  { count: number; top: number; floor: number; scale: number }
> = {
  QB: { count: 34, top: 21, floor: 7, scale: 12 },
  RB: { count: 70, top: 19.5, floor: 3.5, scale: 14 },
  WR: { count: 90, top: 18.5, floor: 3.5, scale: 18 },
  TE: { count: 36, top: 14, floor: 2.5, scale: 8 },
  K: { count: 32, top: 9.5, floor: 6, scale: 15 },
  DST: { count: 32, top: 9.5, floor: 4.5, scale: 12 },
};

/** Typical age range by position — running backs skew young, kickers old. */
const AGE_RANGE: Record<Position, [number, number]> = {
  QB: [22, 38],
  RB: [21, 31],
  WR: [21, 34],
  TE: [22, 34],
  K: [23, 40],
  DST: [0, 0],
};

function projectionFor(position: Position, perGame: number, talent: number): StatLine {
  // Build a stat line that scores roughly `perGame` under half-PPR, so the
  // scoring engine is genuinely exercised rather than bypassed.
  switch (position) {
    case 'QB': {
      const passYd = perGame * 12.5;
      return {
        pass_yd: round1(passYd),
        pass_td: round2((perGame * 0.075)),
        pass_int: round2(0.7 - talent * 0.3),
        rush_yd: round1(perGame * 1.1),
        rush_td: round2(perGame * 0.012),
      };
    }
    case 'RB': {
      return {
        rush_yd: round1(perGame * 3.9),
        rush_td: round2(perGame * 0.038),
        rush_att: round1(perGame * 0.85),
        rec: round2(perGame * 0.16),
        rec_yd: round1(perGame * 1.1),
        rec_td: round2(perGame * 0.008),
        fum_lost: round2(0.05),
      };
    }
    case 'WR': {
      return {
        rec: round2(perGame * 0.33),
        rec_yd: round1(perGame * 4.2),
        rec_td: round2(perGame * 0.036),
        rec_tgt: round1(perGame * 0.5),
        rush_yd: round1(perGame * 0.1),
      };
    }
    case 'TE': {
      return {
        rec: round2(perGame * 0.36),
        rec_yd: round1(perGame * 4.0),
        rec_td: round2(perGame * 0.035),
        rec_tgt: round1(perGame * 0.52),
      };
    }
    case 'K': {
      return {
        fg_made_20_29: round2(perGame * 0.06),
        fg_made_30_39: round2(perGame * 0.08),
        fg_made_40_49: round2(perGame * 0.07),
        fg_made_50_plus: round2(perGame * 0.03),
        xp_made: round2(perGame * 0.22),
      };
    }
    case 'DST': {
      return {
        def_sack: round2(1.4 + talent * 1.4),
        def_int: round2(0.5 + talent * 0.6),
        def_fum_rec: round2(0.4 + talent * 0.3),
        def_td: round2(0.08 + talent * 0.1),
        def_pts_allowed: Math.round(26 - talent * 12),
      };
    }
  }
}

function generatePlayers(): GeneratedPlayer[] {
  const players: GeneratedPlayer[] = [];
  const usedNames = new Set<string>();

  for (const [position, shape] of Object.entries(POSITION_SHAPE) as [
    Position,
    (typeof POSITION_SHAPE)[Position],
  ][]) {
    for (let i = 0; i < shape.count; i++) {
      const basePerGame = shape.floor + (shape.top - shape.floor) * Math.exp(-i / shape.scale);
      const perGame = round1(Math.max(1, jitter(basePerGame, 0.04)));
      const talent = 1 - i / shape.count;
      const nflTeam = position === 'DST' ? NFL_TEAMS[i % NFL_TEAMS.length]! : pick(NFL_TEAMS);

      let name: string;
      if (position === 'DST') {
        name = `${nflTeam} Defense`;
      } else {
        do {
          name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
        } while (usedNames.has(name));
      }
      usedNames.add(name);

      const [minAge, maxAge] = AGE_RANGE[position];
      // Better players skew slightly older — they have had time to establish.
      const age =
        position === 'DST'
          ? 0
          : Math.round(minAge + (maxAge - minAge) * (0.25 + rng() * 0.6) * (0.85 + talent * 0.25));

      // A handful of injuries so the injury-driven waiver logic has something
      // to find, weighted toward players who matter.
      const roll = rng();
      const injuryStatus =
        roll > 0.965 ? 'OUT' : roll > 0.94 ? 'QUESTIONABLE' : roll > 0.93 ? 'IR' : 'ACTIVE';

      players.push({
        sourceId: `seed-${position}-${i + 1}`,
        name,
        position,
        nflTeam,
        age: position === 'DST' ? 0 : age,
        byeWeek: BYE_WEEKS[nflTeam] ?? 9,
        injuryStatus,
        rosteredPct: round1(Math.min(100, Math.max(0, 100 * talent - rng() * 12))),
        rosteredPctDelta: rng() > 0.88 ? round1(rng() * 22) : round1((rng() - 0.6) * 4),
        projection: projectionFor(position, perGame, talent),
        talent,
      });
    }
  }

  return players;
}

/** A weekly stat line that varies around the projection. */
function weeklyStatsFrom(projection: StatLine, variance = 0.45): StatLine {
  const out: StatLine = {};
  for (const [key, value] of Object.entries(projection) as [keyof StatLine, number][]) {
    if (key === 'def_pts_allowed') {
      out[key] = Math.max(0, Math.round(jitter(value, 0.5)));
      continue;
    }
    const swung = Math.max(0, jitter(value, variance));
    // Touchdowns and receptions are whole numbers in a real box score.
    out[key] = key.includes('_td') || key === 'rec' || key.startsWith('fg_') || key.startsWith('xp_')
      ? Math.round(swung + (rng() < swung % 1 ? 1 : 0) - (swung % 1))
      : round1(swung);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

const TEAM_NAMES = [
  'Gridiron Gophers', 'Blitz Brigade', 'Hail Mary Homies', 'Sackless Wonders',
  'Play Action Heroes', 'Red Zone Rebels', 'Pylon Pushers', 'Audible Anarchy',
  'Cover Two Cowboys', 'Fourth Down Fever', 'Screen Pass Syndicate', 'Trench Warfare',
];

async function main() {
  console.log('Seeding demo league…\n');

  const existing = await sql<Array<{ count: string }>>`SELECT count(*) FROM leagues`;
  if (Number(existing[0]?.count ?? 0) > 0 && !process.argv.includes('--force')) {
    console.log('Database already has leagues. Re-run with --force to seed anyway.');
    return;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // Users
  const users = await sql.begin(async (tx) => {
    const created: Array<{ id: string; email: string }> = [];
    for (let i = 0; i < TEAM_COUNT; i++) {
      const email = i === 0 ? 'commish@example.com' : `owner${i}@example.com`;
      const [user] = await tx<Array<{ id: string; email: string }>>`
        INSERT INTO users (email, password_hash, display_name)
        VALUES (${email}, ${passwordHash}, ${i === 0 ? 'The Commissioner' : `Owner ${i}`})
        ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
        RETURNING id, email
      `;
      created.push(user!);
    }
    return created;
  });
  console.log(`  ${users.length} users (password: ${DEMO_PASSWORD})`);

  // Players
  const generated = generatePlayers();
  const playerIds = new Map<string, string>();

  await sql.begin(async (tx) => {
    for (const p of generated) {
      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO players (source, source_id, full_name, position, nfl_team, age, bye_week,
                             injury_status, rostered_pct, rostered_pct_delta, active)
        VALUES ('seed', ${p.sourceId}, ${p.name}, ${p.position}, ${p.nflTeam},
                ${p.position === 'DST' ? null : p.age}, ${p.byeWeek}, ${p.injuryStatus},
                ${p.rosteredPct}, ${p.rosteredPctDelta}, true)
        ON CONFLICT (source, source_id) DO UPDATE SET full_name = EXCLUDED.full_name
        RETURNING id
      `;
      playerIds.set(p.sourceId, row!.id);
    }
  });
  console.log(`  ${generated.length} players`);

  // Projections: week 0 holds the per-game average, which is what valuation reads.
  await sql.begin(async (tx) => {
    for (const p of generated) {
      const id = playerIds.get(p.sourceId)!;
      await tx`
        INSERT INTO player_projections (player_id, season, week, stats, source)
        VALUES (${id}, ${SEASON}, 0, ${tx.json(p.projection)}, 'seed')
        ON CONFLICT (player_id, season, week, source) DO UPDATE SET stats = EXCLUDED.stats
      `;
    }
  });
  console.log(`  ${generated.length} rest-of-season projections`);

  // Actual weekly stats for the weeks that have been played.
  let statRows = 0;
  for (let week = 1; week <= WEEKS_PLAYED; week++) {
    await sql.begin(async (tx) => {
      for (const p of generated) {
        if (p.byeWeek === week) continue;
        if (p.injuryStatus === 'OUT' || p.injuryStatus === 'IR') continue;
        const id = playerIds.get(p.sourceId)!;
        await tx`
          INSERT INTO player_stats (player_id, season, week, stats, source)
          VALUES (${id}, ${SEASON}, ${week}, ${tx.json(weeklyStatsFrom(p.projection))}, 'seed')
          ON CONFLICT (player_id, season, week) DO UPDATE SET stats = EXCLUDED.stats
        `;
        statRows++;
      }
    });
  }
  console.log(`  ${statRows} weekly stat lines across ${WEEKS_PLAYED} weeks`);

  // League and teams
  const settings = defaultLeagueSettings('half_ppr', TEAM_COUNT);
  const [league] = await sql<Array<{ id: string }>>`
    INSERT INTO leagues (name, commissioner_id, season, team_count, settings, status, current_week)
    VALUES ('The Demo Dynasty', ${users[0]!.id}, ${SEASON}, ${TEAM_COUNT},
            ${sql.json(settings)}, 'in_season', ${WEEKS_PLAYED + 1})
    RETURNING id
  `;

  const teams = await sql.begin(async (tx) => {
    const created: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < TEAM_COUNT; i++) {
      const [team] = await tx<Array<{ id: string; name: string }>>`
        INSERT INTO teams (league_id, owner_id, name, faab_remaining, waiver_priority, draft_position)
        VALUES (${league!.id}, ${users[i]!.id}, ${TEAM_NAMES[i]}, ${settings.waivers.faabBudget},
                ${i + 1}, ${i + 1})
        RETURNING id, name
      `;
      created.push(team!);
    }
    return created;
  });
  console.log(`  league "The Demo Dynasty" with ${teams.length} teams`);

  // Draft: snake through the ranked pool so every roster is plausible.
  const rosterSize = startingSlots(settings.roster).length + settings.roster.benchSize;
  const byPosition = new Map<Position, GeneratedPlayer[]>();
  for (const p of generated) {
    const list = byPosition.get(p.position) ?? [];
    list.push(p);
    byPosition.set(p.position, list);
  }
  for (const list of byPosition.values()) list.sort((a, b) => b.talent - a.talent);

  // What each roster needs, in the order a sensible drafter fills it.
  const draftPlan: Position[] = [
    'RB', 'WR', 'RB', 'WR', 'QB', 'TE', 'WR', 'RB', 'WR', 'RB', 'TE', 'QB', 'K', 'DST',
  ].slice(0, rosterSize) as Position[];

  const taken = new Set<string>();
  const rosters = new Map<string, GeneratedPlayer[]>(teams.map((t) => [t.id, []]));

  for (let round = 0; round < draftPlan.length; round++) {
    const wanted = draftPlan[round]!;
    const order = round % 2 === 0 ? teams : [...teams].reverse();
    for (const team of order) {
      const available = (byPosition.get(wanted) ?? []).find((p) => !taken.has(p.sourceId));
      if (!available) continue;
      taken.add(available.sourceId);
      rosters.get(team.id)!.push(available);
    }
  }

  await sql.begin(async (tx) => {
    for (const [teamId, roster] of rosters) {
      // Set a sensible starting lineup rather than leaving everyone benched.
      const lineup = optimizeLineup(
        roster.map((p) => ({
          player: {
            id: playerIds.get(p.sourceId)!,
            name: p.name,
            position: p.position,
            nflTeam: p.nflTeam,
            age: p.age,
            byeWeek: p.byeWeek,
            injuryStatus: p.injuryStatus as 'ACTIVE',
          },
          points: scoreStatLine(p.projection, settings.scoring).total,
        })),
        settings.roster,
      );

      const slotByPlayer = new Map<string, LineupSlot>();
      for (const assignment of lineup.assignments) {
        if (assignment.playerId) slotByPlayer.set(assignment.playerId, assignment.slot);
      }

      for (const p of roster) {
        const id = playerIds.get(p.sourceId)!;
        await tx`
          INSERT INTO roster_slots (team_id, player_id, slot)
          VALUES (${teamId}, ${id}, ${slotByPlayer.get(id) ?? 'BENCH'})
          ON CONFLICT (team_id, player_id) DO NOTHING
        `;
      }
    }
  });
  console.log(`  rosters drafted (${rosterSize} players each)`);

  // Schedule
  const weeks = regularSeasonWeeks(settings.playoffs.startWeek);
  const schedule = generateSchedule(
    teams.map((t) => t.id),
    weeks,
  );
  await sql.begin(async (tx) => {
    for (const m of schedule) {
      await tx`
        INSERT INTO matchups (league_id, week, home_team_id, away_team_id)
        VALUES (${league!.id}, ${m.week}, ${m.homeTeamId}, ${m.awayTeamId})
      `;
    }
  });
  console.log(`  ${schedule.length} matchups across ${weeks} weeks`);

  // Score the weeks that have been played.
  const { persistWeekScores } = await import('../apps/api/dist/services/weeklyScoring.js');
  for (let week = 1; week <= WEEKS_PLAYED; week++) {
    await persistWeekScores(sql, league!.id, SEASON, week, settings, true);
  }
  console.log(`  weeks 1-${WEEKS_PLAYED} scored and finalised`);

  // A few news items, including injuries the waiver engine can react to.
  const injured = generated.filter((p) => p.injuryStatus === 'OUT' || p.injuryStatus === 'IR');
  await sql.begin(async (tx) => {
    for (const p of injured.slice(0, 20)) {
      await tx`
        INSERT INTO player_news (player_id, headline, body, source, injury_status, published_at)
        VALUES (${playerIds.get(p.sourceId)!},
                ${`${p.name} ruled ${p.injuryStatus === 'IR' ? 'out long-term' : 'out'}`},
                ${`${p.name} (${p.position}, ${p.nflTeam}) will not play this week. Handcuffs on the same roster gain immediate value.`},
                'seed', ${p.injuryStatus}, now())
      `;
    }
  });
  console.log(`  ${Math.min(20, injured.length)} news items`);

  console.log('\nDone. Sign in as commish@example.com / password123');
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

main()
  .catch((err) => {
    console.error('\nSeed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());

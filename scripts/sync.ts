/**
 * Data sync from Sleeper.
 *
 *   node --experimental-strip-types scripts/sync.ts players
 *   node --experimental-strip-types scripts/sync.ts stats [week]
 *   node --experimental-strip-types scripts/sync.ts projections
 *   node --experimental-strip-types scripts/sync.ts trending
 *   node --experimental-strip-types scripts/sync.ts all
 *
 * Every run is recorded in sync_runs so the app can show when data was last
 * refreshed and surface failures rather than quietly serving stale numbers.
 */
import postgres from 'postgres';
import type { StatLine } from '@ff/core';
import {
  fetchPlayers,
  fetchProjections,
  fetchState,
  fetchTrending,
  fetchWeeklyStats,
  type StatEntry,
} from '../apps/api/dist/providers/sleeper.js';
import { NFL_BYE_WEEKS } from './byeWeeks.ts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/fantasy_football';

const FINAL_REGULAR_SEASON_WEEK = 18;

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

type Job = 'players' | 'stats' | 'projections' | 'trending' | 'all';

async function main() {
  const job = (process.argv[2] ?? 'all') as Job;
  const weekArg = process.argv[3] ? Number(process.argv[3]) : undefined;

  const state = await fetchState();
  const season = Number(state.season);
  const week = weekArg ?? state.week ?? 1;

  console.log(`Sleeper reports season ${season}, week ${week}.`);

  if (job === 'players' || job === 'all') await withRun('players', season, week, syncPlayers);
  if (job === 'projections' || job === 'all') {
    await withRun('projections', season, week, () => syncProjections(season, week));
  }
  if (job === 'stats' || job === 'all') {
    await withRun('stats', season, week, () => syncStats(season, week));
  }
  if (job === 'trending' || job === 'all') await withRun('trending', season, week, syncTrending);
}

/** Wrap a job so every attempt, including failures, lands in sync_runs. */
async function withRun(
  job: string,
  season: number,
  week: number,
  fn: () => Promise<number>,
): Promise<void> {
  const [run] = await sql<Array<{ id: string }>>`
    INSERT INTO sync_runs (job, status, season, week) VALUES (${job}, 'running', ${season}, ${week})
    RETURNING id
  `;
  const started = Date.now();
  try {
    const records = await fn();
    await sql`
      UPDATE sync_runs SET status = 'success', records = ${records}, finished_at = now()
      WHERE id = ${run!.id}
    `;
    console.log(`  ${job}: ${records} records in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE sync_runs SET status = 'failed', error = ${message}, finished_at = now()
      WHERE id = ${run!.id}
    `;
    console.error(`  ${job} FAILED: ${message}`);
    process.exitCode = 1;
  }
}

async function syncPlayers(): Promise<number> {
  const players = await fetchPlayers();
  let written = 0;

  // Chunked so a single statement never carries thousands of rows.
  for (const chunk of chunks(players, 500)) {
    await sql.begin(async (tx) => {
      for (const p of chunk) {
        await tx`
          INSERT INTO players (source, source_id, full_name, position, nfl_team, birthdate, age,
                               bye_week, injury_status, injury_note, active, updated_at)
          VALUES ('sleeper', ${p.sourceId}, ${p.fullName}, ${p.position}, ${p.nflTeam},
                  ${p.birthdate}, ${p.age}, ${p.nflTeam ? (NFL_BYE_WEEKS[p.nflTeam] ?? null) : null},
                  ${p.injuryStatus}, ${p.injuryNote}, ${p.active}, now())
          ON CONFLICT (source, source_id) DO UPDATE SET
            full_name     = EXCLUDED.full_name,
            position      = EXCLUDED.position,
            nfl_team      = EXCLUDED.nfl_team,
            birthdate     = EXCLUDED.birthdate,
            age           = EXCLUDED.age,
            bye_week      = EXCLUDED.bye_week,
            injury_status = EXCLUDED.injury_status,
            injury_note   = EXCLUDED.injury_note,
            active        = EXCLUDED.active,
            updated_at    = now()
        `;
        written++;
      }
    });
  }
  return written;
}

async function syncStats(season: number, week: number): Promise<number> {
  const entries = await fetchWeeklyStats(season, week);
  return writeStatRows('player_stats', season, week, entries);
}

/**
 * Pull weekly projections for the rest of the season and store two things: each
 * remaining week as-is, and a week-0 row holding the per-game average.
 *
 * The week-0 row is what valuation reads. Keeping it as an averaged *stat line*
 * rather than a points total is what lets every league score the same
 * projection under its own rules.
 */
async function syncProjections(season: number, week: number): Promise<number> {
  let written = 0;
  const totals = new Map<string, { sum: StatLine; weeks: number }>();

  for (let w = week; w <= FINAL_REGULAR_SEASON_WEEK; w++) {
    const entries = await fetchProjections(season, w);
    if (entries.length === 0) continue;
    written += await writeStatRows('player_projections', season, w, entries);

    for (const entry of entries) {
      const current = totals.get(entry.sourceId) ?? { sum: {}, weeks: 0 };
      for (const [key, value] of Object.entries(entry.stats) as [keyof StatLine, number][]) {
        current.sum[key] = (current.sum[key] ?? 0) + value;
      }
      current.weeks += 1;
      totals.set(entry.sourceId, current);
    }
  }

  const averaged: StatEntry[] = [...totals.entries()].map(([sourceId, { sum, weeks }]) => {
    const stats: StatLine = {};
    for (const [key, value] of Object.entries(sum) as [keyof StatLine, number][]) {
      stats[key] = Math.round((value / weeks) * 100) / 100;
    }
    return { sourceId, stats };
  });

  written += await writeStatRows('player_projections', season, 0, averaged);
  return written;
}

async function writeStatRows(
  table: 'player_stats' | 'player_projections',
  season: number,
  week: number,
  entries: StatEntry[],
): Promise<number> {
  const ids = await sql<Array<{ id: string; source_id: string }>>`
    SELECT id, source_id FROM players WHERE source = 'sleeper'
  `;
  const bySourceId = new Map(ids.map((r) => [r.source_id, r.id]));

  let written = 0;
  for (const chunk of chunks(entries, 500)) {
    await sql.begin(async (tx) => {
      for (const entry of chunk) {
        const playerId = bySourceId.get(entry.sourceId);
        // A stat line for somebody not in the players table means the player
        // sync has not run yet; skipping is correct and self-healing.
        if (!playerId) continue;

        if (table === 'player_stats') {
          await tx`
            INSERT INTO player_stats (player_id, season, week, stats, source, synced_at)
            VALUES (${playerId}, ${season}, ${week}, ${tx.json(entry.stats)}, 'sleeper', now())
            ON CONFLICT (player_id, season, week)
            DO UPDATE SET stats = EXCLUDED.stats, synced_at = now()
          `;
        } else {
          await tx`
            INSERT INTO player_projections (player_id, season, week, stats, source, synced_at)
            VALUES (${playerId}, ${season}, ${week}, ${tx.json(entry.stats)}, 'sleeper', now())
            ON CONFLICT (player_id, season, week, source)
            DO UPDATE SET stats = EXCLUDED.stats, synced_at = now()
          `;
        }
        written++;
      }
    });
  }
  return written;
}

/**
 * Rostership movement. Sleeper reports raw add counts rather than percentages,
 * so the counts are scaled against the busiest player in the window to get a
 * comparable 0-100 style figure.
 */
async function syncTrending(): Promise<number> {
  const [adds, drops] = await Promise.all([
    fetchTrending('add', 24, 100),
    fetchTrending('drop', 24, 100),
  ]);

  const maxAdds = Math.max(...adds.map((a) => a.count), 1);
  const delta = new Map<string, number>();
  for (const add of adds) delta.set(add.sourceId, (add.count / maxAdds) * 100);
  for (const drop of drops) {
    delta.set(drop.sourceId, (delta.get(drop.sourceId) ?? 0) - (drop.count / maxAdds) * 100);
  }

  let written = 0;
  await sql.begin(async (tx) => {
    // Anyone not in the window has stopped moving; zero them so yesterday's
    // trend does not linger as though it were current.
    await tx`UPDATE players SET rostered_pct_delta = 0 WHERE rostered_pct_delta <> 0`;
    for (const [sourceId, value] of delta) {
      await tx`
        UPDATE players SET rostered_pct_delta = ${Math.round(value * 100) / 100}, updated_at = now()
        WHERE source = 'sleeper' AND source_id = ${sourceId}
      `;
      written++;
    }
  });
  return written;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

main()
  .catch((err) => {
    console.error('Sync failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());

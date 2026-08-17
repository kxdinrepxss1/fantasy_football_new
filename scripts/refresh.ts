/**
 * The scheduled refresh: pull new data, then re-value every league and check the
 * result.
 *
 *   node --experimental-strip-types scripts/refresh.ts
 *   node --experimental-strip-types scripts/refresh.ts --skip-sync
 *
 * This is the job to put on a cron. It is the piece that makes the valuations
 * automated *and* trustworthy: after every data pull it re-runs the invariant
 * checks against each league's own settings, diffs the numbers against the
 * previous run, and records all three. A failed check or a suspicious mover is
 * reported here rather than being discovered weeks later in a bad trade.
 *
 * Exit code is non-zero when any league fails verification, so a cron wrapper or
 * CI job can alert on it.
 */
import postgres from 'postgres';
import { usesTransactionPooler } from '../apps/api/dist/db.js';
import {
  detectValuationDrift,
  toSnapshot,
  valuePool,
  verifyValuation,
  type ValuationSnapshotEntry,
} from '@ff/core';
import { loadLeagueContext } from '../apps/api/dist/services/leagueContext.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/fantasy_football';

/** A move this large is more likely a data problem than football news. */
const SUSPICIOUS_PCT = Number(process.env.DRIFT_SUSPICIOUS_PCT ?? 60);
const SIGNIFICANT_PCT = Number(process.env.DRIFT_SIGNIFICANT_PCT ?? 20);

// Prepared statements break through Supabase's transaction pooler; the shared
// helper works out whether they are safe for this connection string.
const sql = postgres(DATABASE_URL, {
  onnotice: () => {},
  prepare: !usesTransactionPooler(DATABASE_URL),
});

async function main() {
  if (!process.argv.includes('--skip-sync')) {
    console.log('Syncing player data…');
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', new URL('./sync.ts', import.meta.url).pathname, 'all'],
        { stdio: 'inherit', env: process.env },
      );
    } catch {
      // A failed sync is already recorded in sync_runs. Carry on and re-value
      // against whatever data is present, so a provider outage does not also
      // stop the verification from running.
      console.warn('Sync failed — re-valuing against existing data.');
    }
  }

  const leagues = await sql<Array<{ id: string; name: string }>>`
    SELECT id, name FROM leagues WHERE status IN ('drafting', 'in_season') ORDER BY created_at
  `;

  if (leagues.length === 0) {
    console.log('No active leagues to refresh.');
    return;
  }

  console.log(`\nRe-valuing ${leagues.length} league(s):\n`);
  let failures = 0;

  for (const league of leagues) {
    const ctx = await loadLeagueContext(sql, league.id);
    if (!ctx) continue;

    const names = new Map(ctx.pool.map((p) => [p.player.id, p.player.name]));
    const values = valuePool(ctx.pool, ctx.valuation);
    const entries = toSnapshot(values, names);
    const report = verifyValuation(ctx.pool, ctx.league.settings);

    const [previous] = await sql<Array<{ entries: ValuationSnapshotEntry[] }>>`
      SELECT entries FROM valuation_runs
      WHERE league_id = ${league.id}
      ORDER BY created_at DESC LIMIT 1
    `;

    const drift = previous
      ? detectValuationDrift(previous.entries, entries, {
          significantPct: SIGNIFICANT_PCT,
          suspiciousPct: SUSPICIOUS_PCT,
        })
      : null;

    await sql`
      INSERT INTO valuation_runs (league_id, season, week, entries, verification, drift, ok, player_count)
      VALUES (${league.id}, ${ctx.league.season}, ${ctx.league.current_week},
              ${sql.json(entries as never)}, ${sql.json(report as never)},
              ${drift ? sql.json(drift as never) : null}, ${report.ok}, ${entries.length})
    `;

    console.log(`  ${league.name}: ${report.ok ? 'ok' : 'FAILED'} · ${entries.length} players`);

    for (const issue of report.errors) {
      failures++;
      console.error(`    error [${issue.check}] ${issue.message}`);
    }
    for (const issue of report.warnings) {
      console.warn(`    warning [${issue.check}] ${issue.message}`);
    }

    if (drift) {
      console.log(
        `    drift: median ${drift.medianAbsChangePct}% · ${drift.significant.length} notable · ` +
          `${drift.suspicious.length} suspicious · +${drift.added.length}/-${drift.removed.length} players`,
      );
      for (const entry of drift.suspicious.slice(0, 5)) {
        console.warn(
          `    suspicious: ${entry.name} (${entry.position}) ${entry.previousValue} → ${entry.currentValue} (${entry.changePct > 0 ? '+' : ''}${entry.changePct}%)`,
        );
      }
      for (const entry of drift.significant.slice(0, 5)) {
        console.log(
          `    mover: ${entry.name} (${entry.position}) ${entry.changePct > 0 ? '+' : ''}${entry.changePct}%`,
        );
      }
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} verification error(s). Valuations may not be trustworthy.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll leagues verified.');
  }
}

main()
  .catch((err) => {
    console.error('Refresh failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());

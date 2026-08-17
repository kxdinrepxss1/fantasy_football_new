/**
 * Migration runner.
 *
 * Applies every .sql file in db/migrations in filename order, recording each in
 * a schema_migrations table so re-running is a no-op. Deliberately tiny — a
 * side project does not need a migration framework, and plain SQL files stay
 * readable and portable across Supabase and any other Postgres.
 *
 *   node --experimental-strip-types scripts/migrate.ts
 *   node --experimental-strip-types scripts/migrate.ts --reset
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/fantasy_football';

const reset = process.argv.includes('--reset');

const sql = postgres(DATABASE_URL, { onnotice: () => {} });

async function main() {
  if (reset) {
    console.log('Dropping and recreating the public schema…');
    await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name),
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const contents = await readFile(join(migrationsDir, file), 'utf8');
    process.stdout.write(`Applying ${file}… `);
    // Each migration runs in its own transaction so a failure leaves the
    // database on the last good migration rather than half-applied.
    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log('done');
    ran++;
  }

  console.log(ran === 0 ? 'Already up to date.' : `Applied ${ran} migration(s).`);
}

main()
  .catch((err) => {
    console.error('\nMigration failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => sql.end());

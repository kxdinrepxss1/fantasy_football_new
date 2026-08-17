/**
 * Node entry point — the self-hosting path.
 *
 * Loads .env if present, creates one shared database pool for the process, and
 * serves the same Hono app that the Cloudflare Worker entry serves.
 */
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createDb } from './db.js';
import { readEnv } from './env.js';

loadDotEnv();

const env = readEnv(process.env);
const db = createDb(env.DATABASE_URL);
const app = createApp({ db, envSource: process.env });

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ff-api listening on http://localhost:${info.port}`);
});

/**
 * Minimal .env loader so self-hosting needs no extra dependency.
 *
 * Searches upward from this file rather than reading `./.env`, because the
 * working directory depends on how the server was started: `npm run dev -w
 * @ff/api` runs with the cwd inside apps/api, while running the built server
 * from the repo root does not. One .env at the root should work either way.
 */
function loadDotEnv(): void {
  const contents = readDotEnv();
  if (contents === null) return;

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** First .env found walking up from this file, then from the cwd. */
function readDotEnv(): string | null {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];

  for (const start of starts) {
    let dir = resolve(start);
    while (true) {
      try {
        return readFileSync(join(dir, '.env'), 'utf8');
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  return null;
}

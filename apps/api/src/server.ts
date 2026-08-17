/**
 * Node entry point — the self-hosting path.
 *
 * Loads .env if present, creates one shared database pool for the process, and
 * serves the same Hono app that the Cloudflare Worker entry serves.
 */
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
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

/** Minimal .env loader so self-hosting needs no extra dependency. */
function loadDotEnv(path = '.env'): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return;
  }
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

/**
 * Cloudflare Worker entry point.
 *
 * Workers are per-request, so the database handle is created per request and
 * closed when the request finishes. Point DATABASE_URL at a Hyperdrive binding's
 * connection string to get pooling — postgres.js speaks to Hyperdrive without
 * any code change.
 */
import { createApp } from './app.js';
import { createDb } from './db.js';

export interface WorkerEnv {
  DATABASE_URL: string;
  JWT_SECRET: string;
  APP_URL?: string;
  SEASON?: string;
  HYPERDRIVE?: { connectionString: string };
}

/**
 * The slice of the Workers execution context this entry point uses. Declared
 * here rather than pulling in @cloudflare/workers-types, which would otherwise
 * be a build dependency for the Node path too.
 */
interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: unknown;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerContext): Promise<Response> {
    const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    const db = createDb(connectionString);

    const app = createApp({
      db,
      envSource: {
        ...env,
        DATABASE_URL: connectionString,
        VIA_HYPERDRIVE: env.HYPERDRIVE ? '1' : '0',
      },
    });

    try {
      return await app.fetch(request, env, ctx);
    } finally {
      // Let the connection close after the response has been sent.
      ctx.waitUntil(db.end({ timeout: 5 }));
    }
  },
};

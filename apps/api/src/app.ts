import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { createDb, type Db } from './db.js';
import { readEnv, type AppEnv } from './env.js';
import { verifyJwt, type JwtPayload } from './auth.js';
import authRoutes from './routes/auth.js';
import leagueRoutes from './routes/leagues.js';
import teamRoutes from './routes/teams.js';
import playerRoutes from './routes/players.js';
import tradeRoutes from './routes/trades.js';
import waiverRoutes from './routes/waivers.js';
import matchupRoutes from './routes/matchups.js';
import draftRoutes from './routes/draft.js';
import valuationRoutes from './routes/valuation.js';

export interface Variables {
  env: AppEnv;
  db: Db;
  user: JwtPayload | null;
}

export type App = Hono<{ Variables: Variables }>;

export interface CreateAppOptions {
  /** Pre-built db handle. Node reuses one; Workers create per request. */
  db?: Db;
  envSource?: Record<string, unknown>;
}

export function createApp(options: CreateAppOptions = {}): App {
  const app = new Hono<{ Variables: Variables }>();

  /**
   * CORS.
   *
   * The session token travels in an Authorization header rather than a cookie,
   * so credentialed CORS is not needed and reflecting arbitrary origins would
   * only widen the surface. Allowed origins come from ALLOWED_ORIGINS (comma
   * separated) or fall back to APP_URL. During local development, when APP_URL
   * is still a localhost address, any origin is allowed so a phone on the same
   * network can reach the dev server by IP.
   */
  app.use('*', async (c, next) => {
    // This runs before the middleware that reports configuration problems, so
    // it must not throw on bad config itself — otherwise the clear error never
    // gets a chance to be returned and the caller sees a generic 500.
    let env: AppEnv | null = null;
    try {
      env = readEnv(options.envSource ?? (c.env as Record<string, unknown>) ?? process.env);
    } catch {
      return next();
    }

    const configured = (env.ALLOWED_ORIGINS ?? env.APP_URL)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const isLocalDev = configured.every((value) => /localhost|127\.0\.0\.1/.test(value));

    return cors({
      origin: (origin) => {
        if (!origin) return origin;
        if (isLocalDev) return origin;
        return configured.includes(origin) ? origin : null;
      },
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    })(c, next);
  });

  app.use('*', async (c, next) => {
    /**
     * A missing or malformed setting is a deployment mistake, not a runtime
     * fault, and it takes down every route including the health checks. Saying
     * so plainly is worth far more than the generic 500 this used to return —
     * an operator staring at "Internal server error" on an endpoint that does
     * not even touch the database has nothing to go on.
     *
     * The messages name which setting is wrong and never echo its value, so
     * this stays safe to expose on an unauthenticated endpoint.
     */
    let env: AppEnv;
    try {
      env = readEnv(options.envSource ?? (c.env as Record<string, unknown>) ?? process.env);
    } catch (err) {
      return c.json(
        {
          error: 'Configuration error',
          detail: err instanceof Error ? err.message : 'Invalid configuration',
          hint: 'Set the missing value as a Worker secret or environment variable, then redeploy.',
        },
        503,
      );
    }

    c.set('env', env);
    c.set('db', options.db ?? createDb(env.DATABASE_URL));

    // Attach the caller if a valid bearer token is present. Routes decide for
    // themselves whether authentication is required.
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    c.set('user', token ? await verifyJwt(token, env.JWT_SECRET) : null);

    await next();
  });

  /**
   * Cheap liveness check. Deliberately does not touch the database, so an
   * uptime monitor hitting it every minute costs nothing and a database blip
   * does not read as the whole service being down.
   */
  app.get('/health', (c) => c.json({ ok: true, service: 'ff-api' }));

  /**
   * Readiness check: actually queries the database.
   *
   * This is what confirms a deployment is wired up — that the connection
   * resolves, that credentials work, and whether the query went through a
   * Hyperdrive binding or a plain connection string. Returns 503 rather than
   * 500 on failure so a load balancer or monitor reads it as "not ready".
   */
  app.get('/health/db', async (c) => {
    const started = Date.now();
    try {
      const [row] = await c.get('db')<Array<{ now: Date }>>`SELECT now() AS now`;
      return c.json({
        ok: true,
        latencyMs: Date.now() - started,
        viaHyperdrive: c.get('env').VIA_HYPERDRIVE,
        databaseTime: row?.now ?? null,
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          latencyMs: Date.now() - started,
          viaHyperdrive: c.get('env').VIA_HYPERDRIVE,
          error: scrubConnectionDetails(err),
        },
        503,
      );
    }
  });

  app.route('/api/auth', authRoutes);
  app.route('/api/leagues', leagueRoutes);
  app.route('/api/teams', teamRoutes);
  app.route('/api/players', playerRoutes);
  app.route('/api/trades', tradeRoutes);
  app.route('/api/waivers', waiverRoutes);
  app.route('/api/matchups', matchupRoutes);
  app.route('/api/draft', draftRoutes);
  app.route('/api/valuation', valuationRoutes);

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  return app;
}

/**
 * Connection failures love to quote the connection string back at you, password
 * and all. This endpoint is unauthenticated so that a monitor can reach it,
 * which means the error text has to be safe to hand to anyone.
 */
function scrubConnectionDetails(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/postgres(ql)?:\/\/[^\s]*/gi, '<connection string redacted>')
    .replace(/password[^\s,;]*/gi, '<redacted>')
    .slice(0, 200);
}

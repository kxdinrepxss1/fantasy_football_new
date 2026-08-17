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

  app.use('*', cors({ origin: (origin) => origin ?? '*', credentials: true }));

  app.use('*', async (c, next) => {
    const env = readEnv(options.envSource ?? (c.env as Record<string, unknown>) ?? process.env);
    c.set('env', env);
    c.set('db', options.db ?? createDb(env.DATABASE_URL));

    // Attach the caller if a valid bearer token is present. Routes decide for
    // themselves whether authentication is required.
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    c.set('user', token ? await verifyJwt(token, env.JWT_SECRET) : null);

    await next();
  });

  app.get('/health', (c) => c.json({ ok: true, service: 'ff-api' }));

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

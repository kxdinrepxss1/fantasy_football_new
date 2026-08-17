import { Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from '../app.js';
import {
  generateToken,
  hashPassword,
  hashToken,
  signJwt,
  verifyPassword,
} from '../auth.js';
import type { UserRow } from '../db.js';
import { badRequest, body, requireUser } from '../http.js';

const routes = new Hono<{ Variables: Variables }>();

const MAGIC_LINK_TTL_MINUTES = 15;

const credentials = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(80).optional(),
});

routes.post('/register', async (c) => {
  const { email, password, displayName } = await body(c, credentials);
  const db = c.get('db');
  const env = c.get('env');

  const normalized = email.trim().toLowerCase();
  const [existing] = await db<UserRow[]>`SELECT id FROM users WHERE lower(email) = ${normalized}`;
  if (existing) badRequest('An account with that email already exists');

  const passwordHash = await hashPassword(password);
  const name = displayName ?? normalized.split('@')[0] ?? normalized;

  const [user] = await db<UserRow[]>`
    INSERT INTO users (email, password_hash, display_name)
    VALUES (${normalized}, ${passwordHash}, ${name})
    RETURNING id, email, display_name
  `;
  if (!user) badRequest('Could not create the account');

  return c.json({
    token: await signJwt({ sub: user.id, email: user.email }, env.JWT_SECRET),
    user: { id: user.id, email: user.email, displayName: user.display_name },
  });
});

routes.post('/login', async (c) => {
  const { email, password } = await body(c, credentials.pick({ email: true, password: true }));
  const db = c.get('db');
  const env = c.get('env');

  const [user] = await db<UserRow[]>`
    SELECT id, email, password_hash, display_name FROM users
    WHERE lower(email) = ${email.trim().toLowerCase()}
  `;

  // Same message either way so the endpoint cannot be used to discover which
  // email addresses have accounts.
  const ok = user?.password_hash ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !ok) badRequest('Email or password is incorrect');

  return c.json({
    token: await signJwt({ sub: user.id, email: user.email }, env.JWT_SECRET),
    user: { id: user.id, email: user.email, displayName: user.display_name },
  });
});

/**
 * Request a magic link. Always reports success so the response cannot be used
 * to enumerate accounts; in development the link is logged to the console
 * instead of being emailed, which is enough to self-host without an email
 * provider configured.
 */
routes.post('/magic-link', async (c) => {
  const { email } = await body(c, z.object({ email: z.string().email() }));
  const db = c.get('db');
  const env = c.get('env');
  const normalized = email.trim().toLowerCase();

  const [user] = await db<UserRow[]>`
    SELECT id, email FROM users WHERE lower(email) = ${normalized}
  `;

  if (user) {
    const token = generateToken();
    const expires = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60_000);
    await db`
      INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at)
      VALUES (${user.id}, ${await hashToken(token)}, 'magic_link', ${expires})
    `;
    const link = `${env.APP_URL}/auth/magic?token=${token}`;
    if (env.DEV_EMAIL_TO_CONSOLE) {
      console.log(`\n  Magic link for ${normalized}:\n  ${link}\n`);
    }
  }

  return c.json({ ok: true, message: 'If that email has an account, a sign-in link is on its way.' });
});

routes.post('/magic-link/verify', async (c) => {
  const { token } = await body(c, z.object({ token: z.string().min(10) }));
  const db = c.get('db');
  const env = c.get('env');

  const [row] = await db<Array<{ id: string; user_id: string; email: string; display_name: string }>>`
    SELECT t.id, t.user_id, u.email, u.display_name
    FROM auth_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${await hashToken(token)}
      AND t.purpose = 'magic_link'
      AND t.used_at IS NULL
      AND t.expires_at > now()
  `;
  if (!row) badRequest('That sign-in link is invalid or has expired');

  await db`UPDATE auth_tokens SET used_at = now() WHERE id = ${row.id}`;

  return c.json({
    token: await signJwt({ sub: row.user_id, email: row.email }, env.JWT_SECRET),
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
  });
});

routes.get('/me', async (c) => {
  const user = requireUser(c);
  const db = c.get('db');

  const [row] = await db<UserRow[]>`
    SELECT id, email, display_name FROM users WHERE id = ${user.sub}
  `;
  if (!row) badRequest('Account no longer exists');

  const leagues = await db<Array<{ id: string; name: string; role: string; team_id: string | null }>>`
    SELECT l.id,
           l.name,
           CASE WHEN l.commissioner_id = ${user.sub} THEN 'commissioner' ELSE 'owner' END AS role,
           t.id AS team_id
    FROM leagues l
    LEFT JOIN teams t ON t.league_id = l.id AND t.owner_id = ${user.sub}
    WHERE l.commissioner_id = ${user.sub} OR t.id IS NOT NULL
    ORDER BY l.created_at DESC
  `;

  return c.json({
    user: { id: row.id, email: row.email, displayName: row.display_name },
    leagues,
  });
});

export default routes;

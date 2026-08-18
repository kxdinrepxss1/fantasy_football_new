# Deploying to Supabase + Cloudflare

Three pieces: Postgres on Supabase, the API as a Cloudflare Worker, the web app
on Cloudflare Pages. All three fit inside free tiers at league scale.

Budget about 30 minutes. The one part that reliably trips people up is
connection strings — [read that section](#connection-strings-the-part-that-bites)
before you start.

## 1. Supabase

1. Create a project at <https://supabase.com/dashboard>. Save the database
   password; it is only shown once.
2. **Project Settings → Database → Connection string.** You need two different
   strings from this page, for different jobs — see below.
3. Run the migrations from your machine:

```bash
export DATABASE_URL="<session pooler string>"
npm run db:migrate
```

That is all Supabase needs. No Row Level Security policies, no Supabase client
library, no Edge Functions — the API talks to Postgres directly and does its own
authorisation. RLS is unnecessary here because nothing ever connects to the
database from a browser.

Optionally seed a demo league to confirm it works end to end:

```bash
npm run db:seed
```

Delete it later with `npm run db:migrate -- --reset` followed by
`npm run db:migrate`.

### Connection strings, the part that bites

Supabase offers three, and **which one you want depends on what is connecting**:

| Use | Which string | Port |
| --- | --- | --- |
| Hyperdrive → your database | **Direct connection** | 5432 |
| Migrations from your laptop | **Session pooler** | 5432 |
| GitHub Actions refresh | **Session pooler** | 5432 |

Why they differ:

- **Hyperdrive wants the direct connection.** Hyperdrive does its own pooling,
  and Cloudflare's docs are explicit that stacking it on top of Supavisor
  double-pools and breaks caching. Cloudflare's network speaks IPv6, so the
  IPv6-only direct endpoint is fine from there.
- **Your laptop and GitHub Actions usually cannot reach the direct endpoint.**
  Supabase's direct connection is IPv6-only unless you buy the IPv4 add-on, and
  GitHub Actions runners are IPv4-only. Use the session pooler, which is
  IPv4-compatible.
- **Avoid the transaction pooler (port 6543) for these scripts.** It hands each
  query a different backend connection, so server-side prepared statements fail.
  If you use it anyway the code detects the port and turns prepared statements
  off automatically — but session mode is simpler and faster here.

> If you hit `prepared statement "s1" already exists`, you are on a transaction
> pooler that the detection did not recognise. Set `DATABASE_PREPARE=false` or
> switch to session mode.

## 2. The API on Cloudflare Workers

```bash
cd apps/api

# Hyperdrive in front of the DIRECT connection string:
npx wrangler hyperdrive create ff-db \
  --connection-string="postgres://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres"
```

Copy the returned id into `apps/api/wrangler.toml` and uncomment the block:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "paste-the-id-here"
```

In the same file set `APP_URL` to where the web app will live. It is used to
build invite and magic links, **and it is the CORS allowlist** — get it wrong and
the browser will block every API call.

Then the secret and the deploy:

```bash
# 32+ characters. Generate one:
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
npx wrangler secret put JWT_SECRET

npx wrangler deploy
```

`wrangler.toml` points `main` at `dist/worker.js` and runs `npm run build`
first, so the Worker bundle is the same output that gets typechecked.

Check it:

```bash
curl https://ff-api.<your-subdomain>.workers.dev/health
# {"ok":true,"service":"ff-api"}
```

`DATABASE_URL` is not needed as a Worker secret when Hyperdrive is bound — the
Worker reads the binding's connection string. Setting it is only a fallback for
running without Hyperdrive.

## 3. The web app on Cloudflare Pages

Connect the repo in the Cloudflare dashboard (Workers & Pages → Create → Pages),
or push directly:

| Setting | Value |
| --- | --- |
| Build command | `npm install && npm run build -w @ff/web` |
| Build output directory | `apps/web/dist` |
| Environment variable | `VITE_API_URL` = your Worker URL |

`VITE_API_URL` is baked in at build time, not read at runtime, so **changing it
requires a rebuild**, not just a redeploy.

`apps/web/public/_redirects` sends every path to `index.html`, which is what
stops `/leagues/<id>/trade` returning a 404 when someone refreshes the page or
opens a shared link. It is already there; do not remove it.

### Then close the loop

Once Pages gives you a URL, set it as `APP_URL` in `wrangler.toml` and
`npx wrangler deploy` again. Until you do, CORS will reject the browser's calls.

Serving on your own domain later means listing both origins:

```toml
ALLOWED_ORIGINS = "https://myleague.pages.dev,https://league.example.com"
```

## 4. Keeping data fresh

The refresh does **not** belong in a Worker Cron Trigger. Syncing the player
dictionary pulls several megabytes and writes thousands of rows, which is well
past what a Cron Trigger's CPU budget is for.

`.github/workflows/refresh.yml` runs it on GitHub Actions instead — free,
untimed, and it fails loudly. To enable it:

1. Repo → Settings → Secrets and variables → Actions.
2. Add secret `DATABASE_URL` = your **session pooler** string.
3. Optionally add variable `SEASON`.

It runs hourly on game days and once each morning otherwise, and can be
triggered by hand from the Actions tab. A red run means a league failed
verification — that is the alert that the valuations stopped being trustworthy.

Before the first real run, set the season's bye weeks in `scripts/byeWeeks.ts`.
Sleeper does not supply them.

## Cost

| Piece | Free tier | This app's usage |
| --- | --- | --- |
| Supabase | 500 MB database | A season of a 12-team league is a few tens of MB |
| Workers | 100k requests/day | A league generates a few thousand |
| Hyperdrive | Free since April 2025 | — |
| Pages | Unlimited static requests | — |
| GitHub Actions | 2,000 min/month | Refresh takes a couple of minutes |

The realistic reason to ever pay is Supabase pausing free projects after a week
of inactivity — an in-season league will not hit that, but an off-season one
will, and it needs a click to resume.

## When it does not work

**Browser console shows a CORS error.** `APP_URL` in `wrangler.toml` does not
match the Pages origin exactly. Scheme and host both have to match; no trailing
slash.

**`Cannot find module` on deploy.** Run `npm run build` from the repo root first
— the Worker imports `@ff/core`, which has to be compiled.

**Hyperdrive connection fails.** You almost certainly gave it a pooled string.
It wants the direct one.

**Migrations hang or time out from your laptop.** You are on the IPv6-only
direct endpoint without IPv6. Switch to the session pooler.

**Everything works but there are no players.** You have not run
`npm run sync` yet. That is a separate step from the migrations.

## Sources

- [Cloudflare: Hyperdrive with Supabase](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)
- [Supabase: IPv4 and IPv6 compatibility](https://supabase.com/docs/guides/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP)
- [Supabase: Supavisor FAQ](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI)

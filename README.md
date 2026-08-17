# Fantasy football league app

A self-hosted fantasy football app you run your own league on — not a front end
for ESPN or Yahoo. Everything lives in your database: leagues, scoring rules,
rosters, drafts, trades, waivers.

The differentiated part is the **trade calculator**. It values players on points
over replacement *in your league's actual settings*, applies positional aging
curves, weights positional scarcity, and then re-weighs the whole thing by what
each roster actually needs. See [docs/VALUATION.md](docs/VALUATION.md).

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | React + Vite + Tailwind, mobile-first |
| Backend | Hono — runs on Node for self-hosting, or as a Cloudflare Worker |
| Database | Postgres (Supabase works, so does a local cluster) |
| Auth | Email + password, or magic link. One account per owner. |
| Data | [Sleeper API](docs/DATA_SOURCES.md) — free, no key |

Auth uses PBKDF2 and HS256 through WebCrypto rather than bcrypt, so the same code
runs on Node and on Workers with no native dependency.

## Quick start

```bash
git clone <this repo> && cd fantasy_football_new
npm install

cp .env.example .env
# Set DATABASE_URL and a JWT_SECRET of at least 32 characters.

npm run db:migrate
npm run db:seed      # a full 12-team demo league, no network needed

npm run build
npm run dev          # API on :8787, web on :5173
```

Open <http://localhost:5173> and sign in as `commish@example.com` /
`password123`.

The seed is deterministic — the same league every time — so it doubles as a
fixture for working on the valuation engine.

### Real data

```bash
npm run sync           # players, stats, projections, trending
npm run sync players   # just the player dictionary (large; once a day)
```

Then set the season's bye weeks in `scripts/byeWeeks.ts`. Sleeper does not
provide them. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## Keeping it current

```bash
npm run refresh        # sync, re-value every league, verify, diff, record
```

Put this on a cron — daily in the off-season, hourly on game days:

```cron
0 * * * 0,1,4  cd /srv/fantasy && npm run refresh >> /var/log/ff-refresh.log 2>&1
30 6 * * *     cd /srv/fantasy && npm run refresh >> /var/log/ff-refresh.log 2>&1
```

It exits non-zero if any league fails verification, so cron mail or a CI job will
tell you when the numbers stop being trustworthy rather than leaving you to find
out through a bad trade.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web dev servers together |
| `npm test` | Engine tests (75, no database needed) |
| `npm run typecheck` | Whole workspace |
| `npm run db:migrate` | Apply migrations (`--reset` to start over) |
| `npm run db:seed` | Demo league, offline |
| `npm run db:reset` | Reset and reseed |
| `npm run sync` | Pull data from Sleeper |
| `npm run refresh` | Sync + re-value + verify + record drift |

## Layout

```
packages/core/     Scoring, valuation, trades, waivers, standings.
                   Pure TypeScript, no I/O, fully tested.
apps/api/          Hono server. src/server.ts (Node), src/worker.ts (Workers).
apps/web/          React app, mobile-first.
db/migrations/     Plain Postgres SQL.
scripts/           migrate, seed, sync, refresh.
docs/              Data sources and how valuation works.
```

`packages/core` has no dependency on the database or the network, which is why
the engines can be tested exhaustively without fixtures or mocks. The API's job
is to load data, hand it to the engines, and store the answer.

## Deploying

### Node (simplest)

```bash
npm run build
node apps/api/dist/server.js       # serve apps/web/dist with any static host
```

### Cloudflare Workers + Supabase

`wrangler.toml` is set up. Create a Hyperdrive binding pointing at your Supabase
connection string — postgres.js talks to Hyperdrive with no code change.

```bash
npx wrangler hyperdrive create ff-db --connection-string="postgres://..."
# put the returned id in wrangler.toml
npx wrangler secret put JWT_SECRET
npm run deploy -w @ff/api
```

Then deploy `apps/web/dist` to Cloudflare Pages and point `VITE_API_URL` at the
Worker.

Cost at this size is essentially zero: Workers' free tier covers a league's
traffic many times over, and Supabase's free tier is far more than enough.

## Design notes

**Scoring is computed on read, never stored.** Stats and projections are kept as
raw stat lines and scored against the league's current settings every time. It
costs a little arithmetic per request and buys the thing commissioners actually
want: change a rule and every week, past and present, immediately reflects it.

**League settings are one JSON document.** Any individual stat's point value can
be overridden without a migration, and two leagues can run completely different
rules simultaneously.

**Rosters are guarded by a trigger.** "A player is rostered by at most one team
per league" cannot be expressed as a constraint, because the league id lives on
`teams`, so `enforce_single_roster_per_league()` does it.

**Draft clocks are server-derived.** The timer comes from `pick_started_at`, so
refreshing the page cannot buy anyone more time.

## Status

Working end-to-end: accounts and leagues, invites, rosters and lineups, the
trade calculator, waivers with claims and FAAB, live scoring and matchups,
standings with playoff brackets and seeding tiebreakers, power rankings, weekly
recaps, the draft room, and the valuation health dashboard.

Known gaps:

- **News text is not synced.** Injury *status* is, and that is what the waiver
  engine reads. The feed page will stay empty until you wire up a news source.
- **Auction drafts** accept a price on each pick but there is no live bidding
  loop; snake drafts are complete.
- **No email delivery.** Magic links and invites print to the API console.
  `DEV_EMAIL_TO_CONSOLE=0` plus an email provider is the remaining work.
- **No websockets.** The draft room and scoreboard need a refresh to update.

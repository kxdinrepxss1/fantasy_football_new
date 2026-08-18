# Player data: what to use and why

You asked me to research the options and pick one. **Use the Sleeper API.** It is
what this app ships with.

The rest of this page is the reasoning, and what to switch to if Sleeper ever
stops being a good fit.

## Recommendation: Sleeper

- **Cost:** free. No API key, no account, no approval step.
- **Covers:** the full NFL player dictionary, weekly actual stats, weekly
  projections, and league-wide add/drop trends.
- **Licensing:** read-only and free *for non-commercial use*. A private league
  among friends is squarely inside that. Selling access to this app is not —
  see [Licensing](#licensing-the-part-people-skip) below.
- **Rate limits:** no hard published cap; their guidance is to stay under
  roughly 1000 calls per minute. The sync job here makes a handful of calls per
  run, so this is not a real constraint.
- **Docs:** <https://docs.sleeper.com/>

It is the only free option that carries **both** real stats and projections
without a key, which is what made the decision. Projections matter more than
usual here: the entire valuation engine — replacement level, positional
scarcity, trade values, waiver ranking — is computed from projected points, not
from what already happened.

The adapter lives in `apps/api/src/providers/sleeper.ts`.

### Endpoints used

| What | Endpoint |
| --- | --- |
| Current season and week | `GET https://api.sleeper.app/v1/state/nfl` |
| All players | `GET https://api.sleeper.app/v1/players/nfl` |
| Weekly actual stats | `GET https://api.sleeper.com/stats/nfl/{season}/{week}?season_type=regular` |
| Weekly projections | `GET https://api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular` |
| Trending adds/drops | `GET https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24` |

Note the host changes: the player and state endpoints are on `api.sleeper.app`,
while stats and projections are on `api.sleeper.com`. This trips people up.

### Two things Sleeper does not give you

1. **Bye weeks.** Not present on the player record. They live in
   `scripts/byeWeeks.ts` and need updating once a season when the schedule is
   released. The engines treat a null bye week as "plays every week", so a stale
   table degrades waiver bye-coverage advice rather than breaking anything.

2. **A news feed.** The `player_news` table and the news page exist, but nothing
   populates them from Sleeper. Injury *status* does sync (and that is what the
   waiver engine's injury-opportunity logic actually reads), so the practical gap
   is only the human-readable blurb. If you want real news text, ESPN's
   undocumented endpoints are the usual free source.

### The player dictionary is large

`/v1/players/nfl` returns several megabytes covering every player who has ever
existed. Sleeper asks that you pull it **at most once a day**. `scripts/sync.ts`
treats it as a daily job, separate from the stats and projections pulls, which
are cheap enough to run more often.

## The alternatives, and why not

### nfl_data_py / nflreadpy (nflverse)

- **Cost:** free, open source, no key.
- **Quality:** excellent. Play-by-play back to 1999, weekly and seasonal stats,
  rosters, snap counts, and an ID mapping table across every major fantasy
  platform — that last one is genuinely valuable if you ever run two providers
  at once.
- **Why not:** two reasons. It is **Python**, and this is a TypeScript codebase,
  so it would mean a second runtime in the deployment. More importantly it
  carries **no projections** — it is a historical and actuals dataset. Data lands
  after games are processed, not live, so it cannot drive an in-progress
  scoreboard either.
- **Worth using for:** backfilling historical seasons, or validating the
  projections you get from somewhere else. The ID mapping table is the reason to
  reach for it.
- <https://github.com/nflverse/nfl_data_py>

### SportsData.io

- **Cost: paid, and the free tier is a trap.** They advertise a free trial that
  never expires with access to every endpoint — but **the data in it is
  scrambled**. Player names, scores and stats are realistic-looking and
  deliberately wrong. It is for building an integration against, not for running
  a league. Real data requires a paid plan, and pricing is quote-only.
- **Why not:** for a small side project this is the wrong shape. You would pay a
  commercial data rate to run a twelve-person league.
- **Worth using for:** if this ever became a product with paying users, this is
  the first place to look, because the licensing is unambiguous and the real-time
  feed is genuinely real-time.
- <https://sportsdata.io/nfl-api>

### ESPN's undocumented API

- **Cost:** free, no key for the public endpoints.
- **Why not:** undocumented and unversioned, so it changes without warning, and
  there is no licence granting you use of it. Fine as a secondary source for news
  text; a poor foundation for the numbers your league's trades depend on.

### FantasyPros

- **Cost:** paid API. Consensus rankings and projections, which are the best
  free-ish projections in the hobby when scraped, but the *API* is a commercial
  product.
- **Why not:** cost, and their terms do not permit redistributing the
  projections, which is effectively what a self-hosted app does for its members.

## Summary

| Source | Cost | Stats | Projections | Real-time | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Sleeper** | Free | Yes | **Yes** | Yes | **Recommended** |
| nflverse | Free | Yes | No | No | Great for history and ID mapping |
| SportsData.io | **Paid** (free tier is scrambled) | Yes | Yes | Yes | Only if this becomes commercial |
| ESPN unofficial | Free | Yes | Limited | Yes | Fine for news text only |
| FantasyPros | **Paid** | Yes | Yes | Yes | Licensing rules it out |

## Licensing, the part people skip

Sleeper's terms cover **non-commercial** use. Running a private league is fine.
The moment you charge for access, take advertising, or open it to the public at
scale, you need a commercial agreement — and at that point SportsData.io is the
realistic option. This matters because the switch is not free: budget for it
before you need it, not after.

## Swapping providers

Everything provider-specific is behind one file. To add a source:

1. Write an adapter in `apps/api/src/providers/` exposing the same shape as
   `sleeper.ts` — normalise into the `StatLine` keys from `@ff/core`.
2. Add it to `scripts/sync.ts`.
3. Write rows with your own `source` value. The `players` table is keyed on
   `(source, source_id)`, and `player_projections` includes `source` in its
   primary key, so two providers can coexist without colliding.

The engines never see provider data directly. They consume `StatLine` objects,
which is why scoring, valuation and trades are all provider-agnostic.

## Keeping the data honest

Every sync run is recorded in `sync_runs` with its status, record count and any
error, so stale data is visible rather than silently served.

More importantly, `scripts/refresh.ts` re-values every league after each sync and
runs the verification checks described in [VALUATION.md](./VALUATION.md). A
provider shipping a bad week shows up as a failed invariant or a suspicious
drift entry on the next run, instead of as a trade that quietly graded wrong.

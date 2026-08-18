# How player value and the trade calculator work

Everything here lives in `packages/core`, is pure TypeScript with no database or
network access, and is covered by tests in `packages/core/test`.

The short version: a player's value is **how many points he adds over the
player you could get for free at his position in *this* league**, adjusted for
age and for how steep the drop-off is behind him. A trade then re-weighs that by
what each roster actually needs.

## Step 1: projections become league points

Projections are stored as raw stat lines, never as point totals. Scoring is
applied on read:

```
projection { rec: 5.4, rec_yd: 68, rec_td: 0.45 }
  → PPR league:      5.4 + 6.8 + 2.7 = 14.9 pts/gm
  → standard league: 0   + 6.8 + 2.7 =  9.5 pts/gm
```

This is why the same player is worth different amounts in two of your leagues at
once, and why changing a scoring rule mid-season correctly rewrites past weeks
as well as future value.

## Step 2: replacement level, derived from your settings

For each position, work out how many starters the league actually demands:

- Dedicated slots: `teams × slots at that position`.
- Flex slots are allocated greedily — each flex seat in the league goes to
  whichever eligible position has the best player still unclaimed, which is how
  managers really fill them.

The player just past that cutoff is **replacement level**: the guy on waivers.

This one calculation is where league settings turn into positional value, and it
is why there is no special-case code anywhere for superflex:

| Setting | QB starters demanded | Replacement QB | Effect |
| --- | --- | --- | --- |
| 12-team, 1 QB | 12 | QB13 — still decent | Elite QBs worth modestly more |
| 12-team, superflex | ~22 | QB23 — genuinely bad | Every startable QB gains a lot |

`vorpPerGame = projected − replacement`.

## Step 3: the age curve

Each position has a plateau and a decline rate. Running backs fall off a cliff;
quarterbacks hold value for years.

| Position | Prime | Decline past prime |
| --- | --- | --- |
| QB | 26–33 | 5%/yr |
| RB | 23–26 | **14%/yr** |
| WR | 25–29 | 8%/yr |
| TE | 25–30 | 7%/yr |
| K / DST | — | none |

Below the plateau a player gets a small bonus for having more runway left.

The whole effect is then scaled by the league's `dynastyWeight` slider (League
settings → Valuation). At 0 this is a redraft league and age barely moves the
number; at 1 it applies in full. A 31-year-old and a 23-year-old with identical
projections are **not** the same asset, and this is what stops the calculator
saying they are.

## Step 4: the scarcity premium

Two players can have the same points over replacement while sitting on very
different parts of their position's curve. The engine measures the local
steepness — how much production falls off over the next four spots — and compares
it to the average steepness across that position's starters.

Sitting on a cliff earns up to a ~27% premium; sitting on a flat stretch takes a
discount, because he is easier to replace than his rank suggests. Capped
deliberately: rank should matter, but it should not outweigh the points a player
actually scores.

## Step 5: putting it together

```
value = cushioned(vorpPerGame) × gamesRemaining × ageMultiplier × scarcityMultiplier
```

`cushioned()` handles players below replacement. They are not worthless — they
hold a bench spot and get started on bye weeks — so instead of clamping at zero,
value decays exponentially toward it, joining the linear part smoothly at
replacement level.

> This was a real bug, caught by running the engine against a full seeded
> league. The original version clamped at zero, and in a one-QB league — where
> the replacement QB is genuinely good — every backup landed several points
> below him, hit the clamp, and displayed as exactly `0`. A whole tier of
> players was indistinguishable from each other and from a player with no value
> at all. `packages/core/test/valuation.test.ts` now pins this behaviour.

## The trade calculator

Fairness is judged on **market value** — the number above, which does not depend
on who owns the player. Alongside that, each side gets a **roster-context**
figure answering a different question: how much does this specific team's best
starting lineup actually improve?

That second number comes from running an exact lineup optimiser with and without
each player. It is what stops the calculator telling you your fourth running back
is fair payment for a starting receiver: on an RB-deep roster his lineup swing is
near zero, so his value to that team is well below his market value.

A player's worth to a receiving team is:

```
contextValue = marketValue × (0.6 + 0.4 × fit)
```

60% travels with the player regardless of destination (trade capital, injury
insurance, next season); 40% depends on fit.

The output gives you:

- a **verdict** — fair, or favours one side, with a magnitude and a label from
  `even` through `lopsided`
- **per-side totals**, both market and context-adjusted, plus the starting
  lineup swing in points per game
- a **win-win flag** for when both rosters improve once needs are counted —
  the trades that should get accepted even though one side "wins" on paper
- **plain-language reasons**, written so you can argue with a specific part of
  them rather than just distrusting the number

### The lineup optimiser is exact, not greedy

Slot eligibility forms a laminar family — every eligibility set is either
disjoint from or fully contained in every other (`QB ⊂ SUPERFLEX`,
`WR ⊂ REC_FLEX ⊂ FLEX ⊂ SUPERFLEX`). For a laminar family, filling the most
restrictive slots first and always taking the best eligible player left is
provably optimal. So the optimal lineup comes out without any search.

## Waiver recommendations

Ranked by value added **to one specific roster**, not by raw player quality:

```
score = (lineupGain × 10 + marketValue × 0.35) × needBoost × byeBoost × opportunityBoost
```

- `needBoost` — is this position critical, thin, or already a surplus?
- `byeBoost` — does this add cover a week the roster currently cannot field?
- `opportunityBoost` — is a starter ahead of him on the same NFL team hurt?

Need and bye boosts apply to **as many players as the roster is actually short**,
not to everyone at the position. That was also a bug found against real data: a
single uncovered bye week at defense surfaced five interchangeable defenses at
the top of the list, which is the most common way a waiver page stops being
useful.

One thing that looks wrong but is not: on a settled league, kickers and defenses
often top an *unfiltered* list. Every team rosters exactly one, so the best
available is right at replacement level, while every startable back and receiver
is already owned. That is why streaming defenses is a real strategy. Use the
position tabs.

## Verifying the numbers

The valuations are only useful if you can trust them without checking a
spreadsheet every week. `packages/core/src/valuation/verify.ts` holds properties
that must be true for **any** player pool and **any** league settings, so they can
run unattended after every data refresh.

| Check | Catches |
| --- | --- |
| `finite-values` | A missing or malformed projection reaching the engine |
| `coverage` | Players silently dropped from the valuation |
| `monotonic-base-value` | More projected points producing less value |
| `rank-consistency` | Quoted rank disagreeing with the projections |
| `score-scale` | The 0–100 display scale drifting |
| `replacement-depth` | Too few players at a position to establish replacement level, which inflates everyone there |
| `superflex-sensitivity` | Roster settings not reaching the valuation at all |
| `age-curve-direction` | The aging curve applying backwards |

`superflex-sensitivity` is the best end-to-end check of the lot: it adds a
superflex slot to a copy of your settings and asserts that QB demand rises and
the top QB gains value. If league settings ever stop flowing into the valuation,
that check fails immediately.

### Drift between refreshes

Every refresh writes a snapshot to `valuation_runs`, and the next one diffs
against it:

- **significant** (default ≥20% move) — real football news. Worth reading.
- **suspicious** (default ≥60%) — more likely a data problem than football.
  A healthy starter does not lose most of his value overnight.

Splitting the two means the weekly refresh can show you the interesting movers
*and* separately flag what needs investigating.

### Running it

```bash
# Everything: sync data, re-value every league, verify, diff, record.
npm run refresh

# Re-value and verify without pulling new data.
npm run refresh -- --skip-sync
```

Exit code is non-zero if any league fails verification, so cron or CI can alert
on it. In the app, the same information is on **League → Player values**, which
shows the check results, per-position replacement levels, and what moved.

Thresholds are configurable via `DRIFT_SIGNIFICANT_PCT` and
`DRIFT_SUSPICIOUS_PCT`.

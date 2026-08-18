import { POSITIONS, type LeagueSettings, type Position } from '../types.js';
import {
  buildValuationContext,
  valuePool,
  type PlayerValue,
  type ValuationInput,
} from './value.js';

/**
 * Automated sanity checking for the valuation engine.
 *
 * The valuation numbers are only useful if you can trust them without eyeballing
 * a spreadsheet every week. These checks are properties that must hold for *any*
 * player pool and *any* league settings, so they can run unattended after every
 * data refresh: if a projection feed ships a bad week, or a settings change has
 * an effect nobody intended, a check fails and says which one.
 */

export type CheckSeverity = 'error' | 'warning';

export interface VerificationIssue {
  check: string;
  severity: CheckSeverity;
  message: string;
  /** Players involved, when the issue is about specific players. */
  playerIds?: string[];
}

export interface VerificationReport {
  ok: boolean;
  checkedAt: string;
  poolSize: number;
  errors: VerificationIssue[];
  warnings: VerificationIssue[];
  /** Per-position summary, handy for a dashboard. */
  positionSummary: Array<{
    position: Position;
    count: number;
    starterDemand: number;
    replacementPerGame: number;
    topValue: number;
    medianValue: number;
  }>;
}

/** Numbers a valuation must never produce. */
function checkFinite(values: PlayerValue[], issues: VerificationIssue[]): void {
  const bad = values.filter(
    (v) =>
      !Number.isFinite(v.value) ||
      !Number.isFinite(v.score) ||
      !Number.isFinite(v.vorpPerGame) ||
      !Number.isFinite(v.ageMultiplier) ||
      !Number.isFinite(v.scarcityMultiplier),
  );
  if (bad.length) {
    issues.push({
      check: 'finite-values',
      severity: 'error',
      message: `${bad.length} player(s) produced NaN or Infinity — almost always a missing projection or a zero-length positional curve`,
      playerIds: bad.slice(0, 10).map((b) => b.playerId),
    });
  }
}

/** Everyone in the pool must come back with a value; a silent drop is a bug. */
function checkCoverage(
  pool: ValuationInput[],
  values: PlayerValue[],
  issues: VerificationIssue[],
): void {
  if (values.length !== pool.length) {
    const valued = new Set(values.map((v) => v.playerId));
    const missing = pool.filter((p) => !valued.has(p.player.id));
    issues.push({
      check: 'coverage',
      severity: 'error',
      message: `${missing.length} player(s) in the pool were not valued`,
      playerIds: missing.slice(0, 10).map((m) => m.player.id),
    });
  }
}

/**
 * Within a position, more projected points must never produce a lower base
 * value. Age and scarcity are allowed to reorder the final value — that is the
 * whole point of them — so this checks the pre-adjustment number.
 */
function checkMonotonicity(values: PlayerValue[], issues: VerificationIssue[]): void {
  for (const pos of POSITIONS) {
    const inPos = values
      .filter((v) => v.position === pos)
      .sort((a, b) => b.perGame - a.perGame);
    for (let i = 1; i < inPos.length; i++) {
      const better = inPos[i - 1]!;
      const worse = inPos[i]!;
      if (worse.baseValue > better.baseValue + 0.001) {
        issues.push({
          check: 'monotonic-base-value',
          severity: 'error',
          message: `${pos}: a player projected for fewer points has a higher base value (${worse.perGame} pts/gm → ${worse.baseValue} vs ${better.perGame} pts/gm → ${better.baseValue}). Usually means games-remaining differs wildly between them.`,
          playerIds: [better.playerId, worse.playerId],
        });
        break;
      }
    }
  }
}

/** Quoted positional rank must agree with the projection ordering. */
function checkRankConsistency(values: PlayerValue[], issues: VerificationIssue[]): void {
  for (const pos of POSITIONS) {
    const inPos = values
      .filter((v) => v.position === pos)
      .sort((a, b) => b.perGame - a.perGame);
    for (let i = 1; i < inPos.length; i++) {
      if (inPos[i]!.positionalRank < inPos[i - 1]!.positionalRank) {
        issues.push({
          check: 'rank-consistency',
          severity: 'error',
          message: `${pos}: positional ranks are out of order against projections`,
          playerIds: [inPos[i - 1]!.playerId, inPos[i]!.playerId],
        });
        break;
      }
    }
  }
}

/** The 0-100 display scale must actually span 0-100. */
function checkScoreScale(values: PlayerValue[], issues: VerificationIssue[]): void {
  if (values.length === 0) return;
  const out = values.filter((v) => v.score < 0 || v.score > 100);
  if (out.length) {
    issues.push({
      check: 'score-scale',
      severity: 'error',
      message: `${out.length} player(s) scored outside the 0-100 display range`,
      playerIds: out.slice(0, 10).map((o) => o.playerId),
    });
  }
  const max = Math.max(...values.map((v) => v.score));
  if (Math.abs(max - 100) > 0.5) {
    issues.push({
      check: 'score-scale',
      severity: 'warning',
      message: `top player scored ${max} rather than 100 — normalisation may be running against a stale pool`,
    });
  }
}

/**
 * Every position with a starting requirement needs enough bodies in the pool to
 * establish a replacement level. Without that, replacement falls back to the
 * worst player available and every value at that position inflates.
 */
function checkReplacementDepth(
  pool: ValuationInput[],
  settings: LeagueSettings,
  issues: VerificationIssue[],
): void {
  const ctx = buildValuationContext(pool, settings);
  for (const pos of POSITIONS) {
    const demand = ctx.replacement.demand[pos];
    const supply = ctx.curves[pos].length;
    if (demand > 0 && supply <= demand) {
      issues.push({
        check: 'replacement-depth',
        severity: 'warning',
        message: `${pos}: league needs ${demand} starters but the pool only has ${supply} — replacement level is being read off the bottom of the board, which inflates every ${pos}`,
      });
    }
  }
}

/**
 * Adding a superflex slot must make quarterbacks more valuable. This is the
 * single best end-to-end check that league settings are genuinely flowing
 * through the valuation rather than being ignored.
 */
function checkSuperflexSensitivity(
  pool: ValuationInput[],
  settings: LeagueSettings,
  issues: VerificationIssue[],
): void {
  const qbs = pool.filter((p) => p.player.position === 'QB');
  if (qbs.length < settings.teamCount) return;

  const base = buildValuationContext(pool, settings);
  const sfSettings: LeagueSettings = {
    ...settings,
    roster: {
      ...settings.roster,
      slots: { ...settings.roster.slots, SUPERFLEX: (settings.roster.slots.SUPERFLEX ?? 0) + 1 },
    },
  };
  const sf = buildValuationContext(pool, sfSettings);

  if (sf.replacement.demand.QB <= base.replacement.demand.QB) {
    issues.push({
      check: 'superflex-sensitivity',
      severity: 'error',
      message: `adding a superflex slot did not raise QB starter demand (${base.replacement.demand.QB} → ${sf.replacement.demand.QB}) — roster settings are not reaching the valuation`,
    });
    return;
  }

  const topQb = [...qbs].sort((a, b) => b.perGame - a.perGame)[0]!;
  const baseValue = valuePool(pool, base).find((v) => v.playerId === topQb.player.id)?.value ?? 0;
  const sfValue = valuePool(pool, sf).find((v) => v.playerId === topQb.player.id)?.value ?? 0;
  if (sfValue <= baseValue) {
    issues.push({
      check: 'superflex-sensitivity',
      severity: 'error',
      message: `the top QB did not gain value in superflex (${baseValue} → ${sfValue})`,
      playerIds: [topQb.player.id],
    });
  }
}

/**
 * Two players with identical projections must be separated by the aging curve,
 * in the right direction, whenever the league cares about the future at all.
 */
function checkAgeCurveDirection(
  pool: ValuationInput[],
  settings: LeagueSettings,
  issues: VerificationIssue[],
): void {
  if (settings.dynastyWeight <= 0) return;
  const ctx = buildValuationContext(pool, settings);

  for (const pos of ['RB', 'WR', 'QB', 'TE'] as Position[]) {
    const sample = pool.find((p) => p.player.position === pos);
    if (!sample) continue;

    const young: ValuationInput = {
      ...sample,
      player: { ...sample.player, id: '__probe_young', age: 23 },
    };
    const old: ValuationInput = {
      ...sample,
      player: { ...sample.player, id: '__probe_old', age: 32 },
    };
    const [vy, vo] = valuePool([young, old], ctx);
    if (vy && vo && vy.value <= vo.value) {
      issues.push({
        check: 'age-curve-direction',
        severity: 'error',
        message: `${pos}: a 32-year-old is valued at or above an identical 23-year-old (${vo.value} vs ${vy.value})`,
      });
    }
  }
}

export function verifyValuation(
  pool: ValuationInput[],
  settings: LeagueSettings,
): VerificationReport {
  const issues: VerificationIssue[] = [];
  const ctx = buildValuationContext(pool, settings);
  const values = valuePool(pool, ctx);

  checkFinite(values, issues);
  checkCoverage(pool, values, issues);
  checkMonotonicity(values, issues);
  checkRankConsistency(values, issues);
  checkScoreScale(values, issues);
  checkReplacementDepth(pool, settings, issues);
  checkSuperflexSensitivity(pool, settings, issues);
  checkAgeCurveDirection(pool, settings, issues);

  const positionSummary = POSITIONS.map((pos) => {
    const inPos = values.filter((v) => v.position === pos).sort((a, b) => b.value - a.value);
    return {
      position: pos,
      count: inPos.length,
      starterDemand: ctx.replacement.demand[pos],
      replacementPerGame: round2(ctx.replacement.replacementPoints[pos]),
      topValue: inPos[0]?.value ?? 0,
      medianValue: inPos.length ? (inPos[Math.floor(inPos.length / 2)]?.value ?? 0) : 0,
    };
  });

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  return {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    poolSize: pool.length,
    errors,
    warnings,
    positionSummary,
  };
}

/* -------------------------------------------------------------------------- */
/* Drift detection between refreshes                                          */
/* -------------------------------------------------------------------------- */

export interface ValuationSnapshotEntry {
  playerId: string;
  name?: string;
  position: Position;
  value: number;
  positionalRank: number;
}

export interface DriftEntry {
  playerId: string;
  name: string;
  position: Position;
  previousValue: number;
  currentValue: number;
  changePct: number;
  previousRank: number;
  currentRank: number;
  rankChange: number;
}

export interface DriftReport {
  comparedAt: string;
  added: Array<{ playerId: string; name: string; position: Position; value: number }>;
  removed: Array<{ playerId: string; name: string; position: Position }>;
  /** Moves large enough to be worth a human glance. */
  significant: DriftEntry[];
  /** Moves large enough to look like a data problem rather than football news. */
  suspicious: DriftEntry[];
  medianAbsChangePct: number;
}

export interface DriftOptions {
  /** Percentage move that counts as significant. */
  significantPct?: number;
  /** Percentage move that looks like bad data rather than real news. */
  suspiciousPct?: number;
}

/**
 * Compare two valuation snapshots.
 *
 * Week-to-week movement is normal and expected — injuries, usage changes, a
 * rookie breaking out. What is not normal is a healthy starter losing most of
 * his value overnight, and that is usually a feed problem rather than football.
 * Splitting "significant" from "suspicious" means the weekly refresh can post
 * the interesting movers and separately flag the ones worth investigating.
 */
export function detectValuationDrift(
  previous: ValuationSnapshotEntry[],
  current: ValuationSnapshotEntry[],
  options: DriftOptions = {},
): DriftReport {
  const significantPct = options.significantPct ?? 20;
  const suspiciousPct = options.suspiciousPct ?? 60;

  const prevById = new Map(previous.map((p) => [p.playerId, p]));
  const currById = new Map(current.map((p) => [p.playerId, p]));

  const added = current
    .filter((c) => !prevById.has(c.playerId))
    .map((c) => ({
      playerId: c.playerId,
      name: c.name ?? c.playerId,
      position: c.position,
      value: c.value,
    }));

  const removed = previous
    .filter((p) => !currById.has(p.playerId))
    .map((p) => ({ playerId: p.playerId, name: p.name ?? p.playerId, position: p.position }));

  const significant: DriftEntry[] = [];
  const suspicious: DriftEntry[] = [];
  const changes: number[] = [];

  for (const cur of current) {
    const prev = prevById.get(cur.playerId);
    if (!prev) continue;
    const base = Math.abs(prev.value);
    if (base < 1e-6) continue;

    const changePct = ((cur.value - prev.value) / base) * 100;
    changes.push(Math.abs(changePct));

    const entry: DriftEntry = {
      playerId: cur.playerId,
      name: cur.name ?? prev.name ?? cur.playerId,
      position: cur.position,
      previousValue: prev.value,
      currentValue: cur.value,
      changePct: round1(changePct),
      previousRank: prev.positionalRank,
      currentRank: cur.positionalRank,
      rankChange: prev.positionalRank - cur.positionalRank,
    };

    if (Math.abs(changePct) >= suspiciousPct) suspicious.push(entry);
    else if (Math.abs(changePct) >= significantPct) significant.push(entry);
  }

  significant.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  suspicious.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  changes.sort((a, b) => a - b);

  return {
    comparedAt: new Date().toISOString(),
    added,
    removed,
    significant,
    suspicious,
    medianAbsChangePct: changes.length ? round1(changes[Math.floor(changes.length / 2)]!) : 0,
  };
}

/** Reduce a valuation run to the compact form worth persisting per refresh. */
export function toSnapshot(
  values: PlayerValue[],
  names: Map<string, string> = new Map(),
): ValuationSnapshotEntry[] {
  return values.map((v) => ({
    playerId: v.playerId,
    name: names.get(v.playerId) ?? v.playerId,
    position: v.position,
    value: v.value,
    positionalRank: v.positionalRank,
  }));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

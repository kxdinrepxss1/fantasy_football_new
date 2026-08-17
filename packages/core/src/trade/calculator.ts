import { lineupGainFromAdding, marginalLineupValue, type LineupCandidate } from '../lineup/optimizer.js';
import type { LeagueSettings, Player, Position } from '../types.js';
import type { PlayerValue, ValuationContext, ValuationInput } from '../valuation/value.js';
import { valuePlayer } from '../valuation/value.js';

/**
 * Share of a player's worth that travels with him regardless of who receives
 * him (trade capital, injury insurance, future seasons) versus the share that
 * depends on the receiving roster's actual needs.
 */
const CONTEXT_FREE_SHARE = 0.6;
const CONTEXT_FIT_SHARE = 0.4;

/** Below this percentage gap a trade is called fair rather than lopsided. */
const FAIR_THRESHOLD_PCT = 8;
const LOPSIDED_THRESHOLD_PCT = 25;

export interface TradeTeam {
  id: string;
  name: string;
  /** Every player currently on the roster, with their projection. */
  roster: ValuationInput[];
}

export interface TradeSideInput {
  team: TradeTeam;
  /** Player ids leaving this team. */
  sending: string[];
}

export interface TradeInput {
  a: TradeSideInput;
  b: TradeSideInput;
}

export interface TradePlayerLine {
  playerId: string;
  name: string;
  position: Position;
  positionalRank: number;
  /** Market value, independent of who ends up with him. */
  rawValue: number;
  /** Value once the receiving team's roster shape is taken into account. */
  contextValue: number;
  /** Points per game this add/loss actually swings the receiving lineup. */
  lineupSwingPerGame: number;
  reasons: string[];
}

export interface TradeSideResult {
  teamId: string;
  teamName: string;
  outgoing: TradePlayerLine[];
  incoming: TradePlayerLine[];
  /** Market value shipped out. */
  valueOut: number;
  /** Market value received. */
  valueIn: number;
  /** Received minus shipped, on market value. */
  netRaw: number;
  /** Received minus shipped, adjusted for this roster's needs. */
  netContext: number;
  /** Starting-lineup points per game gained or lost. */
  startingLineupSwing: number;
}

export type TradeVerdict = 'fair' | 'favors_a' | 'favors_b';

export interface TradeResult {
  a: TradeSideResult;
  b: TradeSideResult;
  verdict: TradeVerdict;
  /** How lopsided, as a percentage of the larger side's market value. */
  magnitudePct: number;
  magnitudeLabel: 'even' | 'slight' | 'clear' | 'lopsided';
  /** True when the roster context makes this a sensible deal for both sides. */
  winWin: boolean;
  explanation: string[];
}

function toCandidates(inputs: ValuationInput[]): LineupCandidate[] {
  return inputs.map((i) => ({ player: i.player, points: i.perGame }));
}

function findInput(team: TradeTeam, playerId: string): ValuationInput | undefined {
  return team.roster.find((r) => r.player.id === playerId);
}

/**
 * Value one player from the perspective of a particular receiving roster.
 *
 * The market value comes from the league-wide valuation (points over
 * replacement, age curve, positional scarcity). The context adjustment asks a
 * different question: how much does this specific roster's best starting lineup
 * actually improve? A team already three deep at running back gains very little
 * from a fourth, and this is what stops the calculator from telling someone that
 * their fourth RB2 is a fair price for a starting receiver.
 */
function lineFor(
  input: ValuationInput,
  receivingRoster: ValuationInput[],
  settings: LeagueSettings,
  ctx: ValuationContext,
  mode: 'incoming' | 'outgoing',
): TradePlayerLine {
  const value: PlayerValue = valuePlayer(input, ctx);
  const candidates = toCandidates(receivingRoster);

  const swing =
    mode === 'incoming'
      ? lineupGainFromAdding(candidates, settings.roster, {
          player: input.player,
          points: input.perGame,
        })
      : marginalLineupValue(candidates, settings.roster, input.player.id);

  // What this player would add to a roster with a genuine hole at his position —
  // the yardstick for judging how well he fits here.
  const openingGain = Math.max(value.vorpPerGame, 0.1);
  const fitRatio = clamp(swing / openingGain, 0, 1.25);
  const contextValue = value.value * (CONTEXT_FREE_SHARE + CONTEXT_FIT_SHARE * fitRatio);

  const reasons = [...value.reasons];
  if (mode === 'incoming') {
    if (fitRatio < 0.35) {
      reasons.push(
        `only swings this lineup ${swing.toFixed(1)} pts/gm — the roster is already covered here, so he is worth less to this team than his market value`,
      );
    } else if (fitRatio > 0.9) {
      reasons.push(`fills a real hole — worth ${swing.toFixed(1)} pts/gm to this starting lineup`);
    }
  }

  return {
    playerId: input.player.id,
    name: input.player.name,
    position: input.player.position,
    positionalRank: value.positionalRank,
    rawValue: value.value,
    contextValue: r2(contextValue),
    lineupSwingPerGame: swing,
    reasons,
  };
}

function buildSide(
  side: TradeSideInput,
  other: TradeSideInput,
  settings: LeagueSettings,
  ctx: ValuationContext,
): TradeSideResult {
  const outgoingInputs = side.sending
    .map((id) => findInput(side.team, id))
    .filter((x): x is ValuationInput => Boolean(x));
  const incomingInputs = other.sending
    .map((id) => findInput(other.team, id))
    .filter((x): x is ValuationInput => Boolean(x));

  const outgoing = outgoingInputs.map((i) =>
    lineFor(i, side.team.roster, settings, ctx, 'outgoing'),
  );

  // Incoming players are judged against the roster as it looks after the players
  // being traded away have gone — otherwise a team trading its RB1 for an RB1
  // would look like it was stacking the position.
  const rosterAfterSending = side.team.roster.filter((r) => !side.sending.includes(r.player.id));
  const incoming = incomingInputs.map((i) =>
    lineFor(i, rosterAfterSending, settings, ctx, 'incoming'),
  );

  const valueOut = sum(outgoing.map((o) => o.rawValue));
  const valueIn = sum(incoming.map((o) => o.rawValue));
  const contextOut = sum(outgoing.map((o) => o.contextValue));
  const contextIn = sum(incoming.map((o) => o.contextValue));

  const startingLineupSwing = r2(
    sum(incoming.map((i) => i.lineupSwingPerGame)) - sum(outgoing.map((o) => o.lineupSwingPerGame)),
  );

  return {
    teamId: side.team.id,
    teamName: side.team.name,
    outgoing,
    incoming,
    valueOut: r2(valueOut),
    valueIn: r2(valueIn),
    netRaw: r2(valueIn - valueOut),
    netContext: r2(contextIn - contextOut),
    startingLineupSwing,
  };
}

export function evaluateTrade(
  trade: TradeInput,
  settings: LeagueSettings,
  ctx: ValuationContext,
): TradeResult {
  const a = buildSide(trade.a, trade.b, settings, ctx);
  const b = buildSide(trade.b, trade.a, settings, ctx);

  // Fairness is judged on market value: what each side gives up versus gets back.
  const larger = Math.max(a.valueIn, b.valueIn);
  const magnitudePct = larger > 0 ? r1((Math.abs(a.valueIn - b.valueIn) / larger) * 100) : 0;

  let verdict: TradeVerdict = 'fair';
  if (magnitudePct >= FAIR_THRESHOLD_PCT) verdict = a.valueIn > b.valueIn ? 'favors_a' : 'favors_b';

  const magnitudeLabel =
    magnitudePct < FAIR_THRESHOLD_PCT
      ? 'even'
      : magnitudePct < 15
        ? 'slight'
        : magnitudePct < LOPSIDED_THRESHOLD_PCT
          ? 'clear'
          : 'lopsided';

  const winWin = a.netContext > 0 && b.netContext > 0;

  return {
    a,
    b,
    verdict,
    magnitudePct,
    magnitudeLabel,
    winWin,
    explanation: explain(a, b, verdict, magnitudePct, magnitudeLabel, winWin),
  };
}

/**
 * Turn the numbers into something a league-mate would actually say. The goal is
 * that someone can read this and either accept the verdict or argue with a
 * specific part of it.
 */
function explain(
  a: TradeSideResult,
  b: TradeSideResult,
  verdict: TradeVerdict,
  magnitudePct: number,
  magnitudeLabel: string,
  winWin: boolean,
): string[] {
  const lines: string[] = [];
  const winner = verdict === 'favors_a' ? a : b;
  const loser = verdict === 'favors_a' ? b : a;

  if (verdict === 'fair') {
    lines.push(
      `Close to even — the two sides are within ${magnitudePct.toFixed(1)}% of each other on market value.`,
    );
  } else {
    lines.push(
      `${magnitudeLabel === 'lopsided' ? 'Lopsided' : magnitudeLabel === 'clear' ? 'Clearly favors' : 'Slightly favors'}${magnitudeLabel === 'lopsided' ? ' toward' : ''} ${winner.teamName} — they take back ${magnitudePct.toFixed(1)}% more market value than they send out.`,
    );
  }

  const headline = (side: TradeSideResult) => {
    const best = [...side.incoming].sort((x, y) => y.rawValue - x.rawValue)[0];
    if (!best) return null;
    return `${side.teamName} gets ${best.name} (${best.position}${best.positionalRank})`;
  };
  const ha = headline(a);
  const hb = headline(b);
  if (ha && hb) lines.push(`${ha}; ${hb}.`);

  for (const side of [a, b]) {
    if (side.startingLineupSwing !== 0) {
      lines.push(
        `${side.teamName}'s starting lineup ${side.startingLineupSwing > 0 ? 'gains' : 'loses'} about ${Math.abs(side.startingLineupSwing).toFixed(1)} pts/gm.`,
      );
    }
  }

  // Surface the single most interesting context effect on each side.
  for (const side of [a, b]) {
    const mismatch = side.incoming.find(
      (i) => i.rawValue > 0 && i.contextValue / i.rawValue < CONTEXT_FREE_SHARE + 0.15,
    );
    if (mismatch) {
      lines.push(
        `${side.teamName} is already strong at ${mismatch.position}, so ${mismatch.name} is worth less to them than his raw ranking suggests.`,
      );
    }
  }

  if (winWin) {
    lines.push(
      'Both rosters come out ahead once needs are accounted for — this is the kind of trade that should get accepted even if one side wins on paper.',
    );
  } else if (verdict !== 'fair' && loser.netContext > 0) {
    lines.push(
      `${loser.teamName} loses on market value but still improves their starting lineup, so it may be worth doing anyway.`,
    );
  }

  return lines;
}

function sum(ns: number[]): number {
  return ns.reduce((s, n) => s + n, 0);
}
function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

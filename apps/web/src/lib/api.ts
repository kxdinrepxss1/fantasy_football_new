/**
 * Thin API client.
 *
 * The token lives in localStorage rather than a cookie so the web app can be
 * served from anywhere — a static host, a Worker, a file server — without the
 * API needing to share a domain with it.
 */

const TOKEN_KEY = 'ff.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = import.meta.env.VITE_API_URL ?? '';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${BASE}${path}`, { ...init, headers });

  if (response.status === 401) {
    // The session has expired; drop it so the app falls back to the sign-in
    // screen instead of looping on failed requests.
    setToken(null);
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError(payload?.error ?? response.statusText, response.status);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

export interface LeagueSummary {
  id: string;
  name: string;
  role: 'commissioner' | 'owner';
  team_id: string | null;
}

export interface MeResponse {
  user: SessionUser;
  leagues: LeagueSummary[];
}

export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST';

export interface RosterPlayer {
  id: string;
  name: string;
  position: Position;
  nflTeam: string | null;
  age: number | null;
  byeWeek: number | null;
  injuryStatus: string;
  slot: string;
  projectedPerGame: number;
  value: number;
  score: number;
  positionalRank: number;
  vorpPerGame: number;
  reasons: string[];
}

export interface RosterNeed {
  position: Position;
  depth: number;
  required: number;
  severity: 'critical' | 'thin' | 'ok' | 'surplus';
}

export interface TeamResponse {
  team: { id: string; league_id: string; name: string; faab_remaining: number };
  players: RosterPlayer[];
  needs: RosterNeed[];
  lineup: {
    slots: string[];
    optimal: { total: number; assignments: Array<{ slot: string; playerId: string | null; points: number }> };
    currentProjected: number;
    pointsLeftOnBench: number;
  };
}

export interface TradePlayerLine {
  playerId: string;
  name: string;
  position: Position;
  positionalRank: number;
  rawValue: number;
  contextValue: number;
  lineupSwingPerGame: number;
  reasons: string[];
}

export interface TradeSideResult {
  teamId: string;
  teamName: string;
  outgoing: TradePlayerLine[];
  incoming: TradePlayerLine[];
  valueOut: number;
  valueIn: number;
  netRaw: number;
  netContext: number;
  startingLineupSwing: number;
}

export interface TradeEvaluation {
  a: TradeSideResult;
  b: TradeSideResult;
  verdict: 'fair' | 'favors_a' | 'favors_b';
  magnitudePct: number;
  magnitudeLabel: 'even' | 'slight' | 'clear' | 'lopsided';
  winWin: boolean;
  explanation: string[];
}

export interface WaiverRecommendation {
  playerId: string;
  name: string;
  position: Position;
  positionalRank: number;
  perGame: number;
  rawValue: number;
  lineupGain: number;
  fitScore: number;
  trending: boolean;
  rosteredPctDelta: number;
  opportunity: string | null;
  coversByeWeeks: number[];
  dropCandidate: { playerId: string; name: string; position: string; reason: string } | null;
  reasons: string[];
}

export interface StandingRow {
  teamId: string;
  teamName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  winPct: number;
  streak: string;
  seed: number;
}

export interface PowerRankingRow {
  teamId: string;
  teamName: string;
  rank: number;
  previousRank: number | null;
  power: number;
  record: string;
  pointsPerGame: number;
  luck: number;
  blurb: string;
}

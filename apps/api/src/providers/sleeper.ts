import type { InjuryStatus, Position, StatLine } from '@ff/core';

/**
 * Sleeper data adapter.
 *
 * Sleeper is free, needs no API key, and covers players, weekly stats,
 * projections and league-wide rostership in one place — see docs/DATA_SOURCES.md
 * for why it was chosen over the alternatives.
 *
 * Their informal guidance is to stay under 1000 calls per minute; the sync jobs
 * here make a handful of calls per run, so that is not a constraint in practice.
 */

const PLAYERS_URL = 'https://api.sleeper.app/v1/players/nfl';
const STATE_URL = 'https://api.sleeper.app/v1/state/nfl';
const TRENDING_URL = 'https://api.sleeper.app/v1/players/nfl/trending';
// Stats and projections live on the api.sleeper.com host rather than .app.
const DATA_HOST = 'https://api.sleeper.com';

export interface SleeperPlayer {
  player_id: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  fantasy_positions?: string[];
  team?: string | null;
  age?: number | null;
  birth_date?: string | null;
  injury_status?: string | null;
  injury_notes?: string | null;
  status?: string | null;
  active?: boolean;
}

export interface SleeperState {
  season: string;
  week: number;
  season_type: string;
  display_week?: number;
}

export interface NormalizedPlayer {
  sourceId: string;
  fullName: string;
  position: Position;
  nflTeam: string | null;
  age: number | null;
  birthdate: string | null;
  injuryStatus: InjuryStatus;
  injuryNote: string | null;
  active: boolean;
}

/** Positions the app scores. Sleeper carries IDP and offensive linemen too. */
const SUPPORTED = new Set<Position>(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

/**
 * Sleeper's stat keys to ours.
 *
 * Most offensive keys already match — that was deliberate when the StatLine
 * type was designed — so this table only covers the ones that differ, which is
 * kicking distance bands and team defense.
 */
const STAT_KEY_MAP: Record<string, keyof StatLine> = {
  // Kicking
  fgm_0_19: 'fg_made_0_19',
  fgm_20_29: 'fg_made_20_29',
  fgm_30_39: 'fg_made_30_39',
  fgm_40_49: 'fg_made_40_49',
  fgm_50p: 'fg_made_50_plus',
  fgmiss: 'fg_miss',
  xpm: 'xp_made',
  xpmiss: 'xp_miss',
  // Team defense / special teams
  pts_allow: 'def_pts_allowed',
  yds_allow: 'def_yds_allowed',
  sack: 'def_sack',
  int: 'def_int',
  fum_rec: 'def_fum_rec',
  def_td: 'def_td',
  safe: 'def_safety',
  blk_kick: 'def_blk_kick',
  def_st_td: 'st_td',
};

/** Keys that already carry the same name in both systems. */
const PASSTHROUGH: Array<keyof StatLine> = [
  'pass_yd', 'pass_td', 'pass_int', 'pass_2pt', 'pass_cmp', 'pass_att',
  'rush_yd', 'rush_td', 'rush_att', 'rush_2pt',
  'rec', 'rec_yd', 'rec_td', 'rec_2pt', 'rec_tgt',
  'fum_lost', 'fum',
];

export function normalizeStats(raw: Record<string, unknown>): StatLine {
  const out: StatLine = {};

  for (const key of PASSTHROUGH) {
    const value = raw[key];
    if (typeof value === 'number' && value !== 0) out[key] = value;
  }

  for (const [sleeperKey, ourKey] of Object.entries(STAT_KEY_MAP)) {
    const value = raw[sleeperKey];
    // Points allowed is meaningful at zero — a shutout is the best outcome
    // there is — so it cannot be filtered out with the other falsy values.
    if (typeof value !== 'number') continue;
    if (value === 0 && ourKey !== 'def_pts_allowed' && ourKey !== 'def_yds_allowed') continue;
    out[ourKey] = value;
  }

  return out;
}

export function normalizePlayer(raw: SleeperPlayer): NormalizedPlayer | null {
  const position = pickPosition(raw);
  if (!position) return null;

  const name =
    raw.full_name ??
    [raw.first_name, raw.last_name].filter(Boolean).join(' ') ??
    raw.player_id;
  if (!name) return null;

  return {
    sourceId: raw.player_id,
    fullName: name,
    position,
    nflTeam: raw.team ?? null,
    age: typeof raw.age === 'number' ? raw.age : ageFromBirthdate(raw.birth_date),
    birthdate: raw.birth_date ?? null,
    injuryStatus: mapInjuryStatus(raw.injury_status, raw.status),
    injuryNote: raw.injury_notes ?? null,
    // Sleeper keeps every player who has ever existed; only carry the ones on
    // a roster, plus team defenses which have no active flag.
    active: position === 'DST' ? true : Boolean(raw.active && raw.team),
  };
}

function pickPosition(raw: SleeperPlayer): Position | null {
  const candidates = [raw.position, ...(raw.fantasy_positions ?? [])];
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Sleeper labels team defenses DEF; the app calls them DST throughout.
    const normalized = candidate === 'DEF' ? 'DST' : candidate;
    if (SUPPORTED.has(normalized as Position)) return normalized as Position;
  }
  return null;
}

function mapInjuryStatus(injury?: string | null, status?: string | null): InjuryStatus {
  const value = (injury ?? status ?? '').toUpperCase();
  if (value.includes('QUESTIONABLE')) return 'QUESTIONABLE';
  if (value.includes('DOUBTFUL')) return 'DOUBTFUL';
  if (value.includes('SUS')) return 'SUSPENDED';
  if (value.includes('PUP')) return 'PUP';
  if (value.includes('IR') || value.includes('INJURED RESERVE')) return 'IR';
  if (value.includes('OUT')) return 'OUT';
  return 'ACTIVE';
}

function ageFromBirthdate(birthdate?: string | null): number | null {
  if (!birthdate) return null;
  const born = new Date(birthdate);
  if (Number.isNaN(born.getTime())) return null;
  const ms = Date.now() - born.getTime();
  return Math.round((ms / (365.25 * 24 * 3600 * 1000)) * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

export interface FetchOptions {
  /** Injected so sync jobs can be tested without network access. */
  fetchImpl?: typeof fetch;
}

async function getJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'ff-selfhosted/0.1' },
  });
  if (!response.ok) {
    throw new Error(`Sleeper request failed: ${response.status} ${response.statusText} (${url})`);
  }
  return (await response.json()) as T;
}

export async function fetchState(options?: FetchOptions): Promise<SleeperState> {
  return getJson<SleeperState>(STATE_URL, options);
}

/**
 * The full player dictionary. This is a large document (several megabytes), so
 * Sleeper asks that it be pulled at most once a day — the sync job treats it as
 * a daily refresh rather than something to call per request.
 */
export async function fetchPlayers(options?: FetchOptions): Promise<NormalizedPlayer[]> {
  const raw = await getJson<Record<string, SleeperPlayer>>(PLAYERS_URL, options);
  const out: NormalizedPlayer[] = [];
  for (const player of Object.values(raw)) {
    const normalized = normalizePlayer(player);
    if (normalized) out.push(normalized);
  }
  return out;
}

export interface StatEntry {
  sourceId: string;
  stats: StatLine;
}

interface SleeperStatRow {
  player_id?: string;
  player?: { player_id?: string };
  stats?: Record<string, unknown>;
}

function extractRows(payload: unknown): StatEntry[] {
  const out: StatEntry[] = [];

  // The stats and projections endpoints return an array of rows; older paths
  // returned a map keyed by player id. Handle both so a change on their side
  // does not break the sync silently.
  const rows: SleeperStatRow[] = Array.isArray(payload)
    ? (payload as SleeperStatRow[])
    : Object.entries((payload ?? {}) as Record<string, Record<string, unknown>>).map(
        ([player_id, stats]) => ({ player_id, stats }),
      );

  for (const row of rows) {
    const sourceId = row.player_id ?? row.player?.player_id;
    if (!sourceId || !row.stats) continue;
    out.push({ sourceId, stats: normalizeStats(row.stats) });
  }
  return out;
}

export async function fetchWeeklyStats(
  season: number,
  week: number,
  options?: FetchOptions,
): Promise<StatEntry[]> {
  const url = `${DATA_HOST}/stats/nfl/${season}/${week}?season_type=regular`;
  return extractRows(await getJson<unknown>(url, options));
}

export async function fetchProjections(
  season: number,
  week: number,
  options?: FetchOptions,
): Promise<StatEntry[]> {
  const url = `${DATA_HOST}/projections/nfl/${season}/${week}?season_type=regular`;
  return extractRows(await getJson<unknown>(url, options));
}

export interface TrendingEntry {
  sourceId: string;
  count: number;
}

/** Players being added across Sleeper, which is the trending-adds signal. */
export async function fetchTrending(
  type: 'add' | 'drop' = 'add',
  lookbackHours = 24,
  limit = 50,
  options?: FetchOptions,
): Promise<TrendingEntry[]> {
  const url = `${TRENDING_URL}/${type}?lookback_hours=${lookbackHours}&limit=${limit}`;
  const raw = await getJson<Array<{ player_id: string; count: number }>>(url, options);
  return raw.map((r) => ({ sourceId: r.player_id, count: r.count }));
}

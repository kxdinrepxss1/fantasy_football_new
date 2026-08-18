/**
 * NFL bye weeks by team.
 *
 * Sleeper's player endpoint does not carry bye weeks, so they live here and get
 * updated once a season when the schedule is released. Bye weeks matter to the
 * waiver recommender — it will not tell you that you are covered at tight end
 * when your only tight end is off that week — so leaving this stale degrades
 * those suggestions rather than breaking anything.
 *
 * Set an empty object to disable bye-week handling entirely; the engines treat
 * a null bye week as "plays every week".
 */
export const NFL_BYE_WEEKS: Record<string, number> = {
  // 2025 season byes. Replace each August when the schedule drops.
  PIT: 5,
  CHI: 5,
  GB: 5,
  ATL: 5,
  HOU: 6,
  MIN: 6,
  BAL: 7,
  BUF: 7,
  ARI: 8,
  DET: 8,
  JAX: 8,
  LV: 8,
  LAR: 8,
  SEA: 8,
  CLE: 9,
  NYJ: 9,
  PHI: 9,
  TB: 9,
  CIN: 10,
  DAL: 10,
  KC: 10,
  TEN: 10,
  IND: 11,
  NO: 11,
  DEN: 12,
  LAC: 12,
  MIA: 12,
  WAS: 12,
  CAR: 14,
  NE: 14,
  NYG: 14,
  SF: 14,
};

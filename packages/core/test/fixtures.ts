import type { InjuryStatus, Player, Position } from '../src/types.js';
import type { ValuationInput } from '../src/valuation/value.js';

let seq = 0;

export function player(
  position: Position,
  overrides: Partial<Player> = {},
): Player {
  seq += 1;
  return {
    id: overrides.id ?? `p${seq}`,
    name: overrides.name ?? `${position} Player ${seq}`,
    position,
    nflTeam: overrides.nflTeam ?? 'NE',
    age: overrides.age ?? 26,
    byeWeek: overrides.byeWeek ?? 9,
    injuryStatus: (overrides.injuryStatus ?? 'ACTIVE') as InjuryStatus,
    ...overrides,
  };
}

export function input(
  position: Position,
  perGame: number,
  overrides: Partial<Player> = {},
  gamesRemaining = 14,
): ValuationInput {
  return { player: player(position, overrides), perGame, gamesRemaining };
}

/**
 * A realistic-shaped player pool: steep at the top of each position, flattening
 * out into replacement level, which is what makes VORP and scarcity meaningful.
 */
export function buildPool(teamCount = 12): ValuationInput[] {
  const pool: ValuationInput[] = [];
  const shape: Record<Position, { count: number; top: number; decay: number }> = {
    QB: { count: teamCount * 3, top: 22, decay: 0.55 },
    RB: { count: teamCount * 6, top: 20, decay: 0.75 },
    WR: { count: teamCount * 7, top: 19, decay: 0.6 },
    TE: { count: teamCount * 3, top: 15, decay: 0.85 },
    K: { count: teamCount * 2, top: 9, decay: 0.15 },
    DST: { count: teamCount * 2, top: 9, decay: 0.2 },
  };

  for (const [pos, cfg] of Object.entries(shape) as [Position, (typeof shape)[Position]][]) {
    for (let i = 0; i < cfg.count; i++) {
      // Steep early decline that flattens — the classic fantasy value curve.
      const perGame = Math.max(1, cfg.top - cfg.decay * Math.pow(i, 0.85));
      pool.push(
        input(pos, round2(perGame), {
          id: `${pos}${i + 1}`,
          name: `${pos}${i + 1}`,
          age: 26,
          byeWeek: (i % 14) + 4,
          nflTeam: `T${i % 32}`,
        }),
      );
    }
  }
  return pool;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

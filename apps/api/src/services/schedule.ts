/**
 * Regular-season schedule generation.
 *
 * Uses the circle method for a round robin: fix one team and rotate the rest,
 * which guarantees every team plays exactly once per week and that the pairings
 * are as balanced as possible. When the league has more weeks than a single
 * round robin covers, the cycle repeats with home and away swapped.
 */
export interface ScheduledMatchup {
  week: number;
  homeTeamId: string;
  awayTeamId: string;
}

export function generateSchedule(teamIds: string[], weeks: number): ScheduledMatchup[] {
  if (teamIds.length < 2) return [];

  // An odd number of teams needs a bye, represented by a placeholder that is
  // filtered out afterwards.
  const BYE = '__bye__';
  const teams = [...teamIds];
  if (teams.length % 2 === 1) teams.push(BYE);

  const n = teams.length;
  const rounds = n - 1;
  const half = n / 2;
  const out: ScheduledMatchup[] = [];

  // The rotating portion, excluding the fixed first team.
  let rotation = teams.slice(1);

  for (let week = 1; week <= weeks; week++) {
    const roundIndex = (week - 1) % rounds;
    if (week > 1 && roundIndex === 0) rotation = teams.slice(1);

    const ordered = [teams[0]!, ...rotation];
    // Swap home and away on alternating cycles so nobody hosts the same
    // opponent every time through.
    const flip = Math.floor((week - 1) / rounds) % 2 === 1;

    for (let i = 0; i < half; i++) {
      const a = ordered[i]!;
      const b = ordered[n - 1 - i]!;
      if (a === BYE || b === BYE) continue;

      const homeFirst = (i + week) % 2 === 0;
      const [home, away] = homeFirst !== flip ? [a, b] : [b, a];
      out.push({ week, homeTeamId: home, awayTeamId: away });
    }

    // Rotate everything except the fixed team.
    rotation.unshift(rotation.pop()!);
  }

  return out;
}

/** Weeks of regular season before the playoffs begin. */
export function regularSeasonWeeks(playoffStartWeek: number): number {
  return Math.max(1, playoffStartWeek - 1);
}

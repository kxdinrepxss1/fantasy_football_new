import { Hono } from 'hono';
import { z } from 'zod';
import { computePowerRankings, computeStandings, type MatchupResult } from '@ff/core';
import type { Variables } from '../app.js';
import { num, type MatchupRow, type TeamRow } from '../db.js';
import { body, notFound, requireCommissioner, requireLeagueMember } from '../http.js';
import { persistWeekScores, scoreWeek } from '../services/weeklyScoring.js';

const routes = new Hono<{ Variables: Variables }>();

/** The scoreboard for one week, with live per-player scoring. */
routes.get('/league/:leagueId', async (c) => {
  const leagueId = c.req.param('leagueId');
  const { league } = await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const week = Number(c.req.query('week') ?? league.current_week);
  if (!Number.isInteger(week) || week < 1 || week > 18) notFound('That week is out of range');

  const [matchups, scored] = await Promise.all([
    db<MatchupRow[]>`
      SELECT id, week, home_team_id, away_team_id, home_score, away_score, final, playoff_round
      FROM matchups WHERE league_id = ${leagueId} AND week = ${week}
    `,
    scoreWeek(db, leagueId, league.season, week, league.settings),
  ]);

  return c.json({
    week,
    currentWeek: league.current_week,
    matchups: matchups.map((m) => {
      const home = scored.get(m.home_team_id);
      const away = scored.get(m.away_team_id);
      return {
        id: m.id,
        week: m.week,
        playoffRound: m.playoff_round,
        final: m.final,
        // A finalised week shows what was recorded; a live one shows the score
        // as it stands right now.
        home: m.final
          ? { teamId: m.home_team_id, teamName: home?.teamName ?? '', total: num(m.home_score), players: home?.players ?? [] }
          : home ?? null,
        away: m.final
          ? { teamId: m.away_team_id, teamName: away?.teamName ?? '', total: num(m.away_score), players: away?.players ?? [] }
          : away ?? null,
      };
    }),
  });
});

/** One matchup in detail, for the head-to-head view. */
routes.get('/:id', async (c) => {
  const matchupId = c.req.param('id');
  const db = c.get('db');

  const [matchup] = await db<MatchupRow[]>`
    SELECT id, league_id, week, home_team_id, away_team_id, home_score, away_score, final, playoff_round
    FROM matchups WHERE id = ${matchupId}
  `;
  if (!matchup) notFound('Matchup not found');

  const { league } = await requireLeagueMember(c, matchup.league_id);
  const scored = await scoreWeek(db, matchup.league_id, league.season, matchup.week, league.settings);

  return c.json({
    matchup: {
      id: matchup.id,
      week: matchup.week,
      final: matchup.final,
      home: scored.get(matchup.home_team_id) ?? null,
      away: scored.get(matchup.away_team_id) ?? null,
    },
  });
});

/**
 * Recompute a week's scores. Called on a schedule during games; passing
 * `final` locks the week and freezes each team's lineup.
 */
routes.post('/league/:leagueId/score', async (c) => {
  const leagueId = c.req.param('leagueId');
  const { league } = await requireCommissioner(c, leagueId);
  const input = await body(
    c,
    z.object({ week: z.number().int().min(1).max(18).optional(), final: z.boolean().default(false) }),
  );
  const db = c.get('db');

  const week = input.week ?? league.current_week;
  const updated = await persistWeekScores(db, leagueId, league.season, week, league.settings, input.final);

  return c.json({ week, updated, final: input.final });
});

/**
 * A weekly recap: results, the week's high and low, biggest blowout, closest
 * game, and refreshed power rankings.
 */
routes.get('/league/:leagueId/recap', async (c) => {
  const leagueId = c.req.param('leagueId');
  const { league } = await requireLeagueMember(c, leagueId);
  const db = c.get('db');

  const week = Number(c.req.query('week') ?? Math.max(1, league.current_week - 1));

  const [teams, all] = await Promise.all([
    db<TeamRow[]>`SELECT id, name FROM teams WHERE league_id = ${leagueId}`,
    db<MatchupRow[]>`
      SELECT week, home_team_id, away_team_id, home_score, away_score, final
      FROM matchups WHERE league_id = ${leagueId}
    `,
  ]);

  const results: MatchupResult[] = all.map((m) => ({
    week: m.week,
    homeTeamId: m.home_team_id,
    awayTeamId: m.away_team_id,
    homeScore: num(m.home_score),
    awayScore: num(m.away_score),
    final: m.final,
  }));

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const thisWeek = results.filter((r) => r.week === week && r.final);

  if (thisWeek.length === 0) {
    return c.json({ week, played: false, message: `Week ${week} has not been scored yet.` });
  }

  const sides = thisWeek.flatMap((m) => [
    { teamId: m.homeTeamId, score: m.homeScore, opponent: m.awayTeamId, opponentScore: m.awayScore },
    { teamId: m.awayTeamId, score: m.awayScore, opponent: m.homeTeamId, opponentScore: m.homeScore },
  ]);
  const byScore = [...sides].sort((a, b) => b.score - a.score);
  const byMargin = [...thisWeek].sort(
    (a, b) => Math.abs(b.homeScore - b.awayScore) - Math.abs(a.homeScore - a.awayScore),
  );

  const previous = computeStandings(
    teams.map((t) => ({ id: t.id, name: t.name })),
    results.filter((r) => r.week < week),
    league.settings.playoffs,
  );
  const previousPower = computePowerRankings(
    previous,
    results.filter((r) => r.week < week),
  ).map((p) => ({ teamId: p.teamId, rank: p.rank }));

  const standings = computeStandings(
    teams.map((t) => ({ id: t.id, name: t.name })),
    results.filter((r) => r.week <= week),
    league.settings.playoffs,
  );

  const high = byScore[0]!;
  const low = byScore[byScore.length - 1]!;
  const blowout = byMargin[0]!;
  const nailbiter = byMargin[byMargin.length - 1]!;

  // A side that scored well and still lost is the most fun thing in a recap.
  const unlucky = sides
    .filter((s) => s.score < s.opponentScore)
    .sort((a, b) => b.score - a.score)[0];

  return c.json({
    week,
    played: true,
    standings,
    powerRankings: computePowerRankings(
      standings,
      results.filter((r) => r.week <= week),
      previousPower,
    ),
    highlights: {
      highScore: { team: teamName.get(high.teamId), points: high.score },
      lowScore: { team: teamName.get(low.teamId), points: low.score },
      blowout: {
        winner: teamName.get(
          blowout.homeScore > blowout.awayScore ? blowout.homeTeamId : blowout.awayTeamId,
        ),
        loser: teamName.get(
          blowout.homeScore > blowout.awayScore ? blowout.awayTeamId : blowout.homeTeamId,
        ),
        margin: Math.round(Math.abs(blowout.homeScore - blowout.awayScore) * 100) / 100,
      },
      closest: {
        teams: [teamName.get(nailbiter.homeTeamId), teamName.get(nailbiter.awayTeamId)],
        margin: Math.round(Math.abs(nailbiter.homeScore - nailbiter.awayScore) * 100) / 100,
      },
      unluckiest: unlucky
        ? {
            team: teamName.get(unlucky.teamId),
            points: unlucky.score,
            lostTo: teamName.get(unlucky.opponent),
            opponentPoints: unlucky.opponentScore,
          }
        : null,
    },
  });
});

export default routes;

import { getBoxscores, getGames, getPlayers, getSchedule, getUpcomingSeries } from './wcplData.js';

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function clean(s) {
  return String(s ?? '').trim();
}

function playerKeyFromBoxscore(row, playerBySteam) {
  const sid = clean(row.steam_id);
  if (sid && playerBySteam.has(sid)) return playerBySteam.get(sid).player_key;
  if (sid) return sid;
  return `name:${clean(row.player_name)}`;
}

function displayNameFromBoxscore(row, playerBySteam) {
  const sid = clean(row.steam_id);
  if (sid && playerBySteam.has(sid)) return playerBySteam.get(sid).display_name;
  return clean(row.player_name) || sid || 'Unknown';
}

export async function buildWeekSettlementResults({ seasonId, week }) {
  const seriesResults = await buildSeriesResults({ seasonId, week });
  const propResults = await buildPropResults({ seasonId, week });
  return { seasonId, week: Number(week), seriesResults, propResults };
}

async function buildSeriesResults({ seasonId, week }) {
  const series = await getUpcomingSeries(week, seasonId);
  const out = new Map();

  for (const s of series) {
    const games = await getGames(s.division_id, seasonId);
    const gamesById = new Map(games.map(g => [clean(g.match_id), g]));
    const scheduledIds = s.games.map(g => clean(g.match_id));
    const found = scheduledIds.map(id => gamesById.get(id)).filter(Boolean);

    let complete = found.length === scheduledIds.length && found.length > 0;
    let homeWins = 0;
    let awayWins = 0;
    let homeGoals = 0;
    let awayGoals = 0;
    let totalGoals = 0;

    for (const g of found) {
      const hg = n(g.home_goals);
      const ag = n(g.away_goals);
      homeGoals += hg;
      awayGoals += ag;
      totalGoals += hg + ag;
      if (hg > ag) homeWins += 1;
      else if (ag > hg) awayWins += 1;
      else complete = false;
    }

    const winnerTeamId = homeWins > awayWins ? s.home_team_id : awayWins > homeWins ? s.away_team_id : '';
    const winnerTeamName = winnerTeamId === s.home_team_id ? s.home_team_name : winnerTeamId === s.away_team_id ? s.away_team_name : '';
    const winnerWins = winnerTeamId === s.home_team_id ? homeWins : winnerTeamId === s.away_team_id ? awayWins : 0;
    const loserWins = winnerTeamId === s.home_team_id ? awayWins : winnerTeamId === s.away_team_id ? homeWins : 0;

    if (!winnerTeamId) complete = false;

    out.set(s.series_key, {
      series_key: s.series_key,
      division_id: s.division_id,
      division_name: s.division_name,
      series_id: s.series_id,
      label: `${s.away_team_name} at ${s.home_team_name}`,
      complete,
      scheduled_games: scheduledIds.length,
      found_games: found.length,
      winner_team_id: winnerTeamId,
      winner_team_name: winnerTeamName,
      winner_wins: winnerWins,
      loser_wins: loserWins,
      home_team_id: s.home_team_id,
      away_team_id: s.away_team_id,
      home_goals: homeGoals,
      away_goals: awayGoals,
      total_goals: totalGoals
    });
  }

  return Object.fromEntries(out);
}

async function buildPropResults({ seasonId, week }) {
  const series = await getUpcomingSeries(week, seasonId);
  const divisions = [...new Set(series.map(s => s.division_id))];
  const results = {};

  for (const divisionId of divisions) {
    const schedule = await getSchedule(divisionId, seasonId);
    const matchIds = new Set(schedule
      .filter(r => Number(r.week) === Number(week) && String(r.stage || '').toLowerCase() === 'reg')
      .map(r => clean(r.match_id)));

    const [boxscores, players] = await Promise.all([
      getBoxscores(divisionId, seasonId),
      getPlayers(divisionId, seasonId)
    ]);
    const playerBySteam = new Map(players.filter(p => p.steam_id).map(p => [p.steam_id, p]));
    const rows = boxscores.filter(r => matchIds.has(clean(r.match_id)));

    const scorerMap = new Map();
    const goalieMap = new Map();
    const hatTrickMap = new Map();
    const shutoutMap = new Map();

    for (const r of rows) {
      const position = clean(r.position).toUpperCase();
      const isGoalie = position.includes('G');
      const isSkater = position.includes('S') || !isGoalie;
      const key = playerKeyFromBoxscore(r, playerBySteam);
      const name = displayNameFromBoxscore(r, playerBySteam);
      if (!key) continue;

      // S/G players are eligible for both skater and goalie props.
      if (isSkater) {
        const current = scorerMap.get(key) || { player_key: key, player_name: name, g: 0, a: 0, pts: 0 };
        current.g += n(r.g);
        current.a += n(r.a);
        current.pts = current.g + current.a;
        scorerMap.set(key, current);

        if (n(r.g) >= 3) {
          const ht = hatTrickMap.get(key) || { player_key: key, player_name: name, count: 0 };
          ht.count += 1;
          hatTrickMap.set(key, ht);
        }
      }

      if (isGoalie) {
        const current = goalieMap.get(key) || { player_key: key, player_name: name, sa: 0, ga: 0, sv_pct: 0 };
        current.sa += n(r.sa);
        current.ga += n(r.ga);
        current.sv_pct = current.sa > 0 ? (current.sa - current.ga) / current.sa : 0;
        goalieMap.set(key, current);

        if (n(r.so) >= 1) {
          const so = shutoutMap.get(key) || { player_key: key, player_name: name, count: 0 };
          so.count += 1;
          shutoutMap.set(key, so);
        }
      }
    }

    const scorers = [...scorerMap.values()];
    const maxPts = Math.max(0, ...scorers.map(p => p.pts));
    const topScorers = scorers.filter(p => p.pts === maxPts && maxPts > 0);

    const eligibleGoalies = [...goalieMap.values()].filter(g => g.sa >= 15);
    const maxSv = Math.max(-1, ...eligibleGoalies.map(g => g.sv_pct));
    const topGoalies = eligibleGoalies.filter(g => g.sv_pct === maxSv && maxSv >= 0);

    results[divisionId] = {
      division_id: divisionId,
      top_scorer: {
        winners: topScorers.map(p => p.player_key),
        leaders: topScorers,
        max_points: maxPts
      },
      top_goalie: {
        winners: topGoalies.map(p => p.player_key),
        leaders: topGoalies,
        min_sa: 15,
        max_sv_pct: maxSv < 0 ? null : maxSv
      },
      hat_trick: {
        counts: Object.fromEntries([...hatTrickMap.values()].map(p => [p.player_key, p.count])),
        leaders: [...hatTrickMap.values()].sort((a, b) => b.count - a.count || a.player_name.localeCompare(b.player_name))
      },
      shutout: {
        counts: Object.fromEntries([...shutoutMap.values()].map(p => [p.player_key, p.count])),
        leaders: [...shutoutMap.values()].sort((a, b) => b.count - a.count || a.player_name.localeCompare(b.player_name))
      }
    };
  }

  return results;
}

export function evaluateBetAgainstResults(bet, weekResults) {
  if ((bet.bet_kind || 'series') === 'series') return evaluateSeriesBet(bet, weekResults.seriesResults);
  return evaluatePropBet(bet, weekResults.propResults);
}

function evaluateSeriesBet(bet, seriesResults) {
  const result = seriesResults[bet.series_key];
  if (!result || !result.complete) {
    return { ready: false, won: false, reason: 'Series result incomplete.' };
  }

  let baseWon = false;
  if (bet.market_type === 'series_win') {
    baseWon = bet.team_id === result.winner_team_id;
  } else if (bet.market_type === 'exact_2_1') {
    baseWon = bet.team_id === result.winner_team_id && result.winner_wins === 2 && result.loser_wins === 1;
  } else if (bet.market_type === 'sweep_3_0') {
    baseWon = bet.team_id === result.winner_team_id && result.winner_wins === 3 && result.loser_wins === 0;
  }

  let goalTotalWon = true;
  if (bet.goal_total_side) {
    const line = Number(bet.goal_total_line);
    if (bet.goal_total_side === 'over') goalTotalWon = result.total_goals > line;
    else if (bet.goal_total_side === 'under') goalTotalWon = result.total_goals < line;
    else goalTotalWon = false;
  }

  const won = baseWon && goalTotalWon;
  return {
    ready: true,
    won,
    reason: won ? 'Series bet won.' : 'Series bet lost.',
    result_summary: `${result.winner_team_name} ${result.winner_wins}-${result.loser_wins}, ${result.total_goals} total goals`
  };
}

function evaluatePropBet(bet, propResults) {
  const div = propResults[bet.division_id];
  if (!div) return { ready: false, won: false, reason: 'Division prop results missing.' };

  if (bet.prop_category === 'top_scorer') {
    const won = div.top_scorer.winners.includes(bet.player_key);
    return {
      ready: true,
      won,
      reason: won ? 'Top scorer hit.' : 'Top scorer missed.',
      result_summary: div.top_scorer.leaders.map(p => `${p.player_name} (${p.pts} pts)`).join(', ') || 'No scorer data'
    };
  }

  if (bet.prop_category === 'top_goalie') {
    const won = div.top_goalie.winners.includes(bet.player_key);
    return {
      ready: true,
      won,
      reason: won ? 'Top goalie hit.' : 'Top goalie missed.',
      result_summary: div.top_goalie.leaders.map(p => `${p.player_name} (${p.sa} SA, ${p.ga} GA, ${p.sv_pct.toFixed(3)})`).join(', ') || 'No eligible goalie data'
    };
  }

  if (bet.prop_category === 'hat_trick') {
    const count = Number(div.hat_trick.counts[bet.player_key] || 0);
    const needed = Number(bet.quantity || 1);
    return {
      ready: true,
      won: count >= needed,
      reason: count >= needed ? 'Hat trick prop hit.' : 'Hat trick prop missed.',
      result_summary: `${bet.player_name || bet.player_key}: ${count} hat trick(s)`
    };
  }

  if (bet.prop_category === 'shutout') {
    const count = Number(div.shutout.counts[bet.player_key] || 0);
    const needed = Number(bet.quantity || 1);
    return {
      ready: true,
      won: count >= needed,
      reason: count >= needed ? 'Shutout prop hit.' : 'Shutout prop missed.',
      result_summary: `${bet.player_name || bet.player_key}: ${count} shutout(s)`
    };
  }

  return { ready: false, won: false, reason: 'Unknown prop category.' };
}

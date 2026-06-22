import { getBoxscores, getGames, getPlayers, getSchedule, getUpcomingSeries } from './wcplData.js';

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function clean(s) {
  return String(s ?? '').trim();
}

function seriesIdFromMatchId(matchId) {
  return clean(matchId).replace(/-G\d+$/, '');
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

function fmt1(v) {
  const x = Number(v || 0);
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export async function buildWeekSettlementResults({ seasonId, week }) {
  const seriesResults = await buildSeriesResults({ seasonId, week });
  const propResults = await buildPropResults({ seasonId, week, seriesResults });
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

async function buildPropResults({ seasonId, week, seriesResults }) {
  const series = await getUpcomingSeries(week, seasonId);
  const divisions = [...new Set(series.map(s => s.division_id))];
  const results = {};

  for (const divisionId of divisions) {
    const divisionSeries = series.filter(s => s.division_id === divisionId);
    const scheduledSeriesIds = new Set(divisionSeries.map(s => clean(s.series_id)));
    const divisionSeriesResults = Object.values(seriesResults).filter(s => s.division_id === divisionId);
    const divisionComplete = divisionSeries.length > 0 && divisionSeriesResults.length === divisionSeries.length && divisionSeriesResults.every(s => s.complete);

    const teamScheduledSeriesCount = {};
    const teamCompletedSeriesCount = {};
    const teamSeriesKeys = {};
    for (const s of divisionSeries) {
      for (const teamId of [s.home_team_id, s.away_team_id]) {
        const tid = clean(teamId);
        teamScheduledSeriesCount[tid] = (teamScheduledSeriesCount[tid] || 0) + 1;
        if (!teamSeriesKeys[tid]) teamSeriesKeys[tid] = [];
        teamSeriesKeys[tid].push(s.series_key);
        if (seriesResults[s.series_key]?.complete) teamCompletedSeriesCount[tid] = (teamCompletedSeriesCount[tid] || 0) + 1;
      }
    }

    const [boxscores, players] = await Promise.all([
      getBoxscores(divisionId, seasonId),
      getPlayers(divisionId, seasonId)
    ]);
    const playerBySteam = new Map(players.filter(p => p.steam_id).map(p => [p.steam_id, p]));
    const playerTeamIds = Object.fromEntries(players.map(p => [p.player_key, clean(p.team_id)]));
    const rows = boxscores.filter(r => scheduledSeriesIds.has(seriesIdFromMatchId(r.match_id)));

    const scorerMap = new Map();
    const goalieMap = new Map();
    const goalsBySeries = new Map();
    const hatTrickBySeries = new Map();
    const shutoutBySeries = new Map();

    for (const r of rows) {
      const position = clean(r.position).toUpperCase();
      const isGoalie = position.includes('G');
      const isSkater = position.includes('S') || !isGoalie;
      const key = playerKeyFromBoxscore(r, playerBySteam);
      const name = displayNameFromBoxscore(r, playerBySteam);
      const player = playerBySteam.get(clean(r.steam_id)) || players.find(p => p.player_key === key);
      const teamId = clean(player?.team_id || r.team_id || playerTeamIds[key] || '');
      const seriesId = seriesIdFromMatchId(r.match_id);
      if (!key) continue;
      if (teamId && !playerTeamIds[key]) playerTeamIds[key] = teamId;

      // S/G players are eligible for both skater and goalie props.
      if (isSkater) {
        const scheduledCount = Math.max(1, Number(teamScheduledSeriesCount[teamId] || 1));
        const current = scorerMap.get(key) || { player_key: key, player_name: name, team_id: teamId, g: 0, a: 0, pts: 0, adjusted_pts: 0, scheduled_series: scheduledCount };
        current.g += n(r.g);
        current.a += n(r.a);
        current.pts = current.g + current.a;
        current.scheduled_series = scheduledCount;
        current.adjusted_pts = current.pts / scheduledCount;
        scorerMap.set(key, current);
        if (!goalsBySeries.has(key)) goalsBySeries.set(key, new Map());
        const playerSeriesGoals = goalsBySeries.get(key);
        playerSeriesGoals.set(seriesId, (playerSeriesGoals.get(seriesId) || 0) + n(r.g));

        if (n(r.g) >= 3) {
          if (!hatTrickBySeries.has(key)) hatTrickBySeries.set(key, new Map());
          const bySeries = hatTrickBySeries.get(key);
          bySeries.set(seriesId, (bySeries.get(seriesId) || 0) + 1);
        }
      }

      if (isGoalie) {
        const current = goalieMap.get(key) || { player_key: key, player_name: name, team_id: teamId, sa: 0, ga: 0, sv_pct: 0 };
        current.sa += n(r.sa);
        current.ga += n(r.ga);
        current.sv_pct = current.sa > 0 ? (current.sa - current.ga) / current.sa : 0;
        goalieMap.set(key, current);

        if (n(r.so) >= 1 || (n(r.sa) > 0 && n(r.ga) === 0)) {
          if (!shutoutBySeries.has(key)) shutoutBySeries.set(key, new Map());
          const bySeries = shutoutBySeries.get(key);
          bySeries.set(seriesId, (bySeries.get(seriesId) || 0) + 1);
        }
      }
    }

    const scorers = [...scorerMap.values()];
    const maxAdjustedPts = Math.max(0, ...scorers.map(p => p.adjusted_pts));
    const topScorers = scorers.filter(p => p.adjusted_pts === maxAdjustedPts && maxAdjustedPts > 0);

    const eligibleGoalies = [...goalieMap.values()].filter(g => g.sa >= 15);
    const maxSv = Math.max(-1, ...eligibleGoalies.map(g => g.sv_pct));
    const topGoalies = eligibleGoalies.filter(g => g.sv_pct === maxSv && maxSv >= 0);

    const bestSeriesCounts = (sourceMap) => {
      const out = {};
      const details = {};
      const leaders = [];
      for (const [playerKey, bySeries] of sourceMap.entries()) {
        const counts = [...bySeries.entries()].map(([series_id, count]) => ({ series_id, count }));
        const best = Math.max(0, ...counts.map(c => c.count));
        out[playerKey] = best;
        details[playerKey] = counts;
        const player = players.find(p => p.player_key === playerKey);
        leaders.push({ player_key: playerKey, player_name: player?.display_name || playerKey, count: best, series_counts: counts });
      }
      return { out, details, leaders: leaders.sort((a, b) => b.count - a.count || a.player_name.localeCompare(b.player_name)) };
    };

    const hatTricks = bestSeriesCounts(hatTrickBySeries);
    const shutouts = bestSeriesCounts(shutoutBySeries);
    const seriesGoals = bestSeriesCounts(goalsBySeries);

    results[divisionId] = {
      division_id: divisionId,
      division_complete: divisionComplete,
      team_scheduled_series_count: teamScheduledSeriesCount,
      team_completed_series_count: teamCompletedSeriesCount,
      team_series_keys: teamSeriesKeys,
      player_team_ids: playerTeamIds,
      top_scorer: {
        ready: divisionComplete,
        winners: divisionComplete ? topScorers.map(p => p.player_key) : [],
        leaders: topScorers,
        max_points: maxAdjustedPts,
        uses_adjusted_points: true
      },
      top_goalie: {
        ready: divisionComplete,
        winners: divisionComplete ? topGoalies.map(p => p.player_key) : [],
        leaders: topGoalies,
        min_sa: 15,
        max_sv_pct: maxSv < 0 ? null : maxSv
      },
      hat_trick: {
        best_series_counts: hatTricks.out,
        series_counts: hatTricks.details,
        leaders: hatTricks.leaders
      },
      player_goals: {
        best_series_counts: seriesGoals.out,
        series_counts: seriesGoals.details,
        leaders: seriesGoals.leaders
      },
      shutout: {
        best_series_counts: shutouts.out,
        series_counts: shutouts.details,
        leaders: shutouts.leaders
      }
    };
  }

  return results;
}

export function evaluateBetAgainstResults(bet, weekResults) {
  if ((bet.bet_kind || 'series') === 'series') return evaluateSeriesBet(bet, weekResults.seriesResults);
  return evaluatePropBet(bet, weekResults.propResults, weekResults.seriesResults);
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

function playerTeamComplete(div, playerKey) {
  const teamId = div.player_team_ids?.[playerKey] || '';
  if (!teamId) return false;
  const scheduled = Number(div.team_scheduled_series_count?.[teamId] || 0);
  const completed = Number(div.team_completed_series_count?.[teamId] || 0);
  return scheduled > 0 && completed >= scheduled;
}

function evaluatePropBet(bet, propResults, seriesResults = {}) {
  const div = propResults[bet.division_id];
  if (!div) return { ready: false, won: false, reason: 'Division prop results missing.' };

  if (bet.prop_category === 'top_scorer') {
    const leaderText = div.top_scorer.leaders.map(p => {
      const adjusted = fmt1(p.adjusted_pts);
      return `${p.player_name} (${adjusted} adj pts${Number(p.scheduled_series || 1) > 1 ? `, ${p.pts} raw / ${p.scheduled_series} series` : ''})`;
    }).join(', ') || 'No scorer data yet';

    if (!div.top_scorer.ready) {
      return { ready: false, won: false, reason: 'Top scorer incomplete until all division series are complete.', result_summary: leaderText };
    }

    const won = div.top_scorer.winners.includes(bet.player_key);
    return {
      ready: true,
      won,
      reason: won ? 'Top scorer hit.' : 'Top scorer missed.',
      result_summary: leaderText
    };
  }

  if (bet.prop_category === 'top_goalie') {
    const leaderText = div.top_goalie.leaders.map(p => `${p.player_name} (${p.sa} SA, ${p.ga} GA, ${p.sv_pct.toFixed(3)})`).join(', ') || 'No eligible goalie data yet';

    if (!div.top_goalie.ready) {
      return { ready: false, won: false, reason: 'Top goalie incomplete until all division series are complete.', result_summary: leaderText };
    }

    const won = div.top_goalie.winners.includes(bet.player_key);
    return {
      ready: true,
      won,
      reason: won ? 'Top goalie hit.' : 'Top goalie missed.',
      result_summary: leaderText
    };
  }

  if (bet.prop_category === 'hat_trick') {
    const count = Number(div.hat_trick.best_series_counts?.[bet.player_key] || 0);
    const needed = Number(bet.quantity || 1);
    const won = count >= needed;
    const teamDone = playerTeamComplete(div, bet.player_key);
    const seriesText = (div.hat_trick.series_counts?.[bet.player_key] || [])
      .map(s => `${s.series_id}: ${s.count}`)
      .join(', ');
    return {
      ready: won || teamDone,
      won,
      reason: won ? 'Hat trick prop hit.' : teamDone ? 'Hat trick prop missed.' : 'Player/team series incomplete.',
      result_summary: `${bet.player_name || bet.player_key}: best single-series total ${count} hat trick(s)${seriesText ? ` (${seriesText})` : ''}`
    };
  }

  if (bet.prop_category === 'player_goals') {
    const seriesId = String(bet.series_key || '').replace(`${bet.division_id}-`, '');
    const detail = (div.player_goals.series_counts?.[bet.player_key] || [])
      .find(item => item.series_id === seriesId);
    const result = seriesResults[bet.series_key];
    const goals = Number(detail?.count || 0);
    const line = Number(bet.prop_line ?? 0.5);
    const won = goals > line;
    const ready = won || Boolean(result?.complete);
    return {
      ready,
      won,
      reason: won ? 'Player goals prop hit.' : ready ? 'Player goals prop missed.' : 'Series incomplete.',
      result_summary: `${bet.player_name || bet.player_key}: ${goals} goal(s) in series, line ${line}`
    };
  }

  if (bet.prop_category === 'shutout') {
    const seriesId = String(bet.series_key || '').replace(`${bet.division_id}-`, '');
    const detail = bet.series_key
      ? (div.shutout.series_counts?.[bet.player_key] || []).find(item => item.series_id === seriesId)
      : null;
    const count = Number(detail?.count ?? div.shutout.best_series_counts?.[bet.player_key] ?? 0);
    const needed = Number(bet.quantity || 1);
    const won = count >= needed;
    const seriesResult = seriesResults[bet.series_key];
    const teamDone = bet.series_key ? Boolean(seriesResult?.complete) : playerTeamComplete(div, bet.player_key);
    const seriesText = (div.shutout.series_counts?.[bet.player_key] || [])
      .map(s => `${s.series_id}: ${s.count}`)
      .join(', ');
    return {
      ready: won || teamDone,
      won,
      reason: won ? 'Shutout prop hit.' : teamDone ? 'Shutout prop missed.' : 'Player/team series incomplete.',
      result_summary: `${bet.player_name || bet.player_key}: best single-series total ${count} shutout(s)${seriesText ? ` (${seriesText})` : ''}`
    };
  }

  return { ready: false, won: false, reason: 'Unknown prop category.' };
}

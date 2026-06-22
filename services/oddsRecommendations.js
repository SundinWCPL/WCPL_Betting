import { getSeasonCsv, getUpcomingSeries } from './wcplData.js';

const DEFAULT_SEASON_WEIGHTS = { S1: 0.35, S2: 0.65, S3: 1 };
const SKATER_PRIOR_GAMES = 8;
const GOALIE_PRIOR_SHOTS = 60;
const TEAM_PRIOR_GAMES = 15;
const DEFAULT_PROBABILITY_SHRINKAGE = 0.2;
const DEFAULT_GOAL_CALIBRATION = 0.5;
const SWEEP_CORRECTION_FACTOR = 1.5;

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clean(value) {
  return String(value ?? '').trim();
}

function normalize(value) {
  return clean(value).toLowerCase();
}

function isGoaliePosition(position) {
  return clean(position).toUpperCase().includes('G');
}

function isSkaterPosition(position) {
  return clean(position).toUpperCase() !== 'G';
}

function usableHistoricalSkaterGames(row, seasonId) {
  const games = n(row.gp_s);
  const position = clean(row.position).toUpperCase();
  const flex = position.includes('S') && position.includes('G');
  return seasonId === 'S1' && flex && games < 5 ? 0 : games;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundOdds(value) {
  return Number((Math.round(Number(value) * 10) / 10).toFixed(1));
}

function buildPlayerIndexes(rows) {
  const bySteam = new Map();
  const byKey = new Map();
  const byName = new Map();

  for (const row of rows) {
    const steam = normalize(row.steam_id);
    const key = normalize(row.player_key);
    const name = normalize(row.name);
    if (steam && !bySteam.has(steam)) bySteam.set(steam, row);
    if (key && !byKey.has(key)) byKey.set(key, row);
    if (name && !byName.has(name)) byName.set(name, row);
  }

  return { bySteam, byKey, byName };
}

function matchHistoricalPlayer(player, index) {
  const steam = normalize(player.steam_id);
  if (steam && index.bySteam.has(steam)) {
    return { row: index.bySteam.get(steam), method: 'steam_id' };
  }

  const key = normalize(player.player_key);
  if (key && index.byKey.has(key)) {
    return { row: index.byKey.get(key), method: 'player_key' };
  }

  const name = normalize(player.name);
  if (name && index.byName.has(name)) {
    return { row: index.byName.get(name), method: 'name' };
  }

  return { row: null, method: 'unmatched' };
}

function aggregateLeagueBaselines(seasonRows, seasonWeights) {
  let weightedSkaterGames = 0;
  let weightedPoints = 0;
  let weightedGoals = 0;
  let weightedGoalieShots = 0;
  let weightedGoalieGoalsAllowed = 0;

  for (const [seasonId, rows] of Object.entries(seasonRows)) {
    const weight = seasonWeights[seasonId] || 1;
    for (const row of rows) {
      const skaterGames = usableHistoricalSkaterGames(row, seasonId);
      if (skaterGames > 0) {
        weightedSkaterGames += weight * skaterGames;
        weightedPoints += weight * n(row.pts);
        weightedGoals += weight * n(row.g);
      }
      if (n(row.sa) > 0) {
        weightedGoalieShots += weight * n(row.sa);
        weightedGoalieGoalsAllowed += weight * n(row.ga);
      }
    }
  }

  return {
    ppg: weightedSkaterGames > 0 ? weightedPoints / weightedSkaterGames : 1,
    gpg: weightedSkaterGames > 0 ? weightedGoals / weightedSkaterGames : 0.45,
    savePct: weightedGoalieShots > 0
      ? (weightedGoalieShots - weightedGoalieGoalsAllowed) / weightedGoalieShots
      : 0.8
  };
}

function aggregateBoxscorePlayerRows(boxscores) {
  const out = new Map();

  for (const row of boxscores) {
    const key = normalize(row.steam_id)
      ? `steam:${normalize(row.steam_id)}`
      : `name:${normalize(row.player_name)}`;
    if (!out.has(key)) {
      out.set(key, {
        steam_id: clean(row.steam_id),
        player_key: '',
        name: clean(row.player_name),
        gp_s: 0,
        pts: 0,
        g: 0,
        gp_g: 0,
        sa: 0,
        ga: 0
      });
    }

    const aggregate = out.get(key);
    if (isGoaliePosition(row.position) && n(row.sa) > 0) {
      aggregate.gp_g += 1;
      aggregate.sa += n(row.sa);
      aggregate.ga += n(row.ga);
    } else {
      aggregate.gp_s += 1;
      aggregate.pts += n(row.g) + n(row.a);
      aggregate.g += n(row.g);
    }
  }

  return [...out.values()];
}

function buildPlayerProjection(player, seasonIndexes, baselines, seasonWeights) {
  let weightedGames = 0;
  let weightedPoints = 0;
  let weightedGoals = 0;
  let weightedShotsAgainst = 0;
  let weightedGoalsAllowed = 0;
  let matchedSeasons = 0;
  const matches = {};

  for (const seasonId of Object.keys(seasonIndexes)) {
    const match = matchHistoricalPlayer(player, seasonIndexes[seasonId]);
    matches[seasonId] = match.method;
    if (!match.row) continue;

    matchedSeasons += 1;
    const weight = seasonWeights[seasonId] || 1;
    const skaterGames = usableHistoricalSkaterGames(match.row, seasonId);
    weightedGames += weight * skaterGames;
    weightedPoints += weight * (skaterGames > 0 ? n(match.row.pts) : 0);
    weightedGoals += weight * (skaterGames > 0 ? n(match.row.g) : 0);
    weightedShotsAgainst += weight * n(match.row.sa);
    weightedGoalsAllowed += weight * n(match.row.ga);
  }

  const ppg = (
    weightedPoints + SKATER_PRIOR_GAMES * baselines.ppg
  ) / (
    weightedGames + SKATER_PRIOR_GAMES
  );
  const gpg = (
    weightedGoals + SKATER_PRIOR_GAMES * baselines.gpg
  ) / (
    weightedGames + SKATER_PRIOR_GAMES
  );
  const savePct = (
    (weightedShotsAgainst - weightedGoalsAllowed) + GOALIE_PRIOR_SHOTS * baselines.savePct
  ) / (
    weightedShotsAgainst + GOALIE_PRIOR_SHOTS
  );

  return {
    playerKey: clean(player.player_key || player.steam_id || player.name),
    name: clean(player.name),
    teamId: clean(player.team_id),
    position: clean(player.position),
    ppg,
    gpg,
    savePct,
    weightedGames,
    weightedShotsAgainst,
    matchedSeasons,
    matches
  };
}

function average(values, fallback = 0) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function buildRosterRatings(players, projections, baselines) {
  const teams = new Map();

  for (const player of players) {
    const projection = projections.get(player);
    const teamId = clean(player.team_id);
    if (!teams.has(teamId)) {
      teams.set(teamId, { teamId, players: [], skaters: [], goalies: [] });
    }

    const team = teams.get(teamId);
    team.players.push(projection);
    if (isSkaterPosition(player.position)) team.skaters.push(projection);
    if (isGoaliePosition(player.position)) team.goalies.push(projection);
  }

  for (const team of teams.values()) {
    const skaters = [...team.skaters].sort((a, b) => b.ppg - a.ppg);
    const expectedSkaters = skaters.slice(0, Math.min(5, skaters.length));
    const goalies = team.goalies.length ? team.goalies : team.players;
    const rosterPpg = average(expectedSkaters.map(p => p.ppg), baselines.ppg);
    const rosterGpg = average(expectedSkaters.map(p => p.gpg), baselines.gpg);
    const goalieSavePct = average(goalies.map(p => p.savePct), baselines.savePct);

    team.rosterPpg = rosterPpg;
    team.rosterGpg = rosterGpg;
    team.goalieSavePct = goalieSavePct;
    team.offenseIndex = clamp(
      0.7 * (rosterPpg / baselines.ppg) + 0.3 * (rosterGpg / baselines.gpg),
      0.65,
      1.45
    );
    team.goalieConcessionIndex = clamp(
      (1 - goalieSavePct) / (1 - baselines.savePct),
      0.65,
      1.45
    );
    team.historyCoverage = average(team.players.map(p => p.matchedSeasons > 0 ? 1 : 0), 0);
    team.historyDepth = average(team.players.map(p => p.matchedSeasons), 0);
  }

  return teams;
}

function buildCurrentTeamPerformance(games) {
  const teams = new Map();

  function ensure(teamId) {
    if (!teams.has(teamId)) {
      teams.set(teamId, {
        teamId,
        games: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        xgFor: 0,
        xgAgainst: 0,
        wins: 0
      });
    }
    return teams.get(teamId);
  }

  for (const game of games) {
    const home = ensure(clean(game.home_team_id));
    const away = ensure(clean(game.away_team_id));
    const homeGoals = n(game.home_goals);
    const awayGoals = n(game.away_goals);
    const homeXg = n(game.xg_home) || homeGoals;
    const awayXg = n(game.xg_away) || awayGoals;

    home.games += 1;
    away.games += 1;
    home.goalsFor += homeGoals;
    home.goalsAgainst += awayGoals;
    home.xgFor += homeXg;
    home.xgAgainst += awayXg;
    away.goalsFor += awayGoals;
    away.goalsAgainst += homeGoals;
    away.xgFor += awayXg;
    away.xgAgainst += homeXg;
    if (homeGoals > awayGoals) home.wins += 1;
    if (awayGoals > homeGoals) away.wins += 1;
  }

  return teams;
}

function poissonPmf(lambda, k) {
  let factorial = 1;
  for (let i = 2; i <= k; i += 1) factorial *= i;
  return Math.exp(-lambda) * (lambda ** k) / factorial;
}

function gameWinProbability(lambdaTeam, lambdaOpponent) {
  const maxGoals = 14;
  let win = 0;
  let tie = 0;

  for (let teamGoals = 0; teamGoals <= maxGoals; teamGoals += 1) {
    const teamP = poissonPmf(lambdaTeam, teamGoals);
    for (let opponentGoals = 0; opponentGoals <= maxGoals; opponentGoals += 1) {
      const probability = teamP * poissonPmf(lambdaOpponent, opponentGoals);
      if (teamGoals > opponentGoals) win += probability;
      else if (teamGoals === opponentGoals) tie += probability;
    }
  }

  return clamp(win + tie * 0.5, 0.03, 0.97);
}

function poissonOverProbability(lambda, line) {
  const maxUnder = Math.floor(line);
  let underOrEqual = 0;
  for (let goals = 0; goals <= maxUnder; goals += 1) {
    underOrEqual += poissonPmf(lambda, goals);
  }
  return clamp(1 - underOrEqual, 0, 1);
}

function recommendGoalLine(projectedGoals) {
  const center = Math.floor(projectedGoals);
  const candidates = [center - 0.5, center + 0.5, center + 1.5]
    .filter(line => line >= 4.5);

  return candidates
    .map(line => ({
      line,
      overProbability: poissonOverProbability(projectedGoals, line)
    }))
    .sort((a, b) =>
      Math.abs(a.overProbability - 0.5) - Math.abs(b.overProbability - 0.5) ||
      a.line - b.line
    )[0];
}

function recommendMultiplier(defaultMultiplier, baselineProbability, predictedProbability, min, max) {
  return roundOdds(clamp(
    defaultMultiplier * baselineProbability / Math.max(predictedProbability, 0.001),
    min,
    max
  ));
}

function seriesMarketRecommendations(gameWinP) {
  const seriesWin = gameWinP ** 3 + 3 * (gameWinP ** 2) * (1 - gameWinP);
  const rawSweep = gameWinP ** 3;
  const sweep = Math.min(seriesWin, rawSweep * SWEEP_CORRECTION_FACTOR);
  const exact21 = Math.max(0, seriesWin - sweep);
  const neutralSweep = 0.125 * SWEEP_CORRECTION_FACTOR;
  const neutral21 = 0.5 - neutralSweep;

  return {
    gameWinProbability: gameWinP,
    seriesWinProbability: seriesWin,
    exact21Probability: exact21,
    sweepProbability: sweep,
    seriesWinOdds: recommendMultiplier(2, 0.5, seriesWin, 1.25, 4),
    exact21Odds: recommendMultiplier(3, neutral21, exact21, 2, 8),
    sweepOdds: recommendMultiplier(4, neutralSweep, sweep, 2.5, 15)
  };
}

function confidenceForTeams(teamA, teamB, currentA, currentB) {
  const coverage = average([teamA.historyCoverage, teamB.historyCoverage]);
  const currentGames = Math.min(currentA?.games || 0, currentB?.games || 0);
  if (coverage >= 0.8 && currentGames >= 3) return 'High';
  if (coverage >= 0.6 || currentGames >= 2) return 'Medium';
  return 'Low';
}

async function loadSeasonPlayers(seasonId) {
  return getSeasonCsv(seasonId, 'players.csv');
}

async function loadSeasonDivisionBeforeWeek(seasonId, divisionId, targetWeek) {
  const [players, schedule, games, boxscores] = await Promise.all([
    getSeasonCsv(seasonId, 'players.csv', divisionId),
    getSeasonCsv(seasonId, 'schedule.csv', divisionId),
    getSeasonCsv(seasonId, 'games.csv', divisionId),
    getSeasonCsv(seasonId, 'boxscores.csv', divisionId)
  ]);

  const eligibleMatchIds = new Set(
    schedule
      .filter(row => n(row.week) < n(targetWeek))
      .map(row => clean(row.match_id))
  );

  return {
    players,
    schedule,
    games: games.filter(row => eligibleMatchIds.has(clean(row.match_id))),
    boxscores: boxscores.filter(row => eligibleMatchIds.has(clean(row.match_id)))
  };
}

export async function buildSeriesOddsRecommendations({
  targetWeek = 2,
  seasonId = 'S3',
  xgWeight = 0.2,
  teamPriorGames = TEAM_PRIOR_GAMES,
  probabilityShrinkage = DEFAULT_PROBABILITY_SHRINKAGE,
  goalCalibration = DEFAULT_GOAL_CALIBRATION
} = {}) {
  const seasonNumber = Number(String(seasonId).replace(/\D/g, ''));
  if (!Number.isFinite(seasonNumber) || seasonNumber < 2 || seasonNumber > 3) {
    throw new Error('Series recommendations currently support S2 and S3.');
  }

  const historicalSeasonIds = Array.from(
    { length: seasonNumber - 1 },
    (_, index) => `S${index + 1}`
  );
  const seasonWeights = seasonId === 'S2'
    ? { S1: 0.5, S2: 1 }
    : { ...DEFAULT_SEASON_WEIGHTS };
  const cleanXgWeight = clamp(Number(xgWeight), 0, 1);
  const cleanTeamPriorGames = Math.max(0, Number(teamPriorGames) || 0);
  const cleanProbabilityShrinkage = clamp(Number(probabilityShrinkage), 0, 0.75);
  const cleanGoalCalibration = clamp(Number(goalCalibration), -2, 2);

  const historicalPlayers = Object.fromEntries(
    await Promise.all(
      historicalSeasonIds.map(async id => [id, await loadSeasonPlayers(id)])
    )
  );
  const baselines = aggregateLeagueBaselines(historicalPlayers, seasonWeights);
  const series = await getUpcomingSeries(targetWeek, seasonId);
  const divisionIds = [...new Set(series.map(item => item.division_id))];
  const divisionModels = new Map();

  for (const divisionId of divisionIds) {
    const current = await loadSeasonDivisionBeforeWeek(seasonId, divisionId, targetWeek);
    const currentAggregates = aggregateBoxscorePlayerRows(current.boxscores);
    const seasonRows = { ...historicalPlayers, [seasonId]: currentAggregates };
    const indexes = Object.fromEntries(
      Object.entries(seasonRows).map(([id, rows]) => [id, buildPlayerIndexes(rows)])
    );
    const projections = new Map(
      current.players.map(player => [
        player,
        buildPlayerProjection(player, indexes, baselines, seasonWeights)
      ])
    );
    const rosterRatings = buildRosterRatings(current.players, projections, baselines);
    const currentPerformance = buildCurrentTeamPerformance(current.games);

    divisionModels.set(divisionId, {
      current,
      projections,
      rosterRatings,
      currentPerformance
    });
  }

  const historicalGames = (
    await Promise.all(
      historicalSeasonIds.map(async id =>
        (await getSeasonCsv(id, 'games.csv'))
          .map(row => ({ ...row, weight: seasonWeights[id] || 1 }))
      )
    )
  ).flat();
  const weightedGoals = historicalGames.reduce(
    (sum, game) => sum + game.weight * (n(game.home_goals) + n(game.away_goals)),
    0
  );
  const weightedTeamGames = historicalGames.reduce((sum, game) => sum + game.weight * 2, 0);
  const leagueGoalsPerTeamGame = weightedGoals / weightedTeamGames;

  const recommendations = series.map(matchup => {
    const model = divisionModels.get(matchup.division_id);
    const awayRoster = model.rosterRatings.get(matchup.away_team_id);
    const homeRoster = model.rosterRatings.get(matchup.home_team_id);
    const awayCurrent = model.currentPerformance.get(matchup.away_team_id);
    const homeCurrent = model.currentPerformance.get(matchup.home_team_id);

    const awayRosterAttack = leagueGoalsPerTeamGame * awayRoster.offenseIndex;
    const homeRosterAttack = leagueGoalsPerTeamGame * homeRoster.offenseIndex;
    const awayRosterDefense = leagueGoalsPerTeamGame * awayRoster.goalieConcessionIndex;
    const homeRosterDefense = leagueGoalsPerTeamGame * homeRoster.goalieConcessionIndex;

    const blendPerformance = (current, rosterAttack, rosterDefense) => {
      const games = current?.games || 0;
      const observedAttack = games
        ? (cleanXgWeight * current.xgFor + (1 - cleanXgWeight) * current.goalsFor) / games
        : rosterAttack;
      const observedDefense = games
        ? (cleanXgWeight * current.xgAgainst + (1 - cleanXgWeight) * current.goalsAgainst) / games
        : rosterDefense;
      return {
        games,
        attack: (cleanTeamPriorGames * rosterAttack + games * observedAttack) / (cleanTeamPriorGames + games),
        defense: (cleanTeamPriorGames * rosterDefense + games * observedDefense) / (cleanTeamPriorGames + games)
      };
    };

    const awayStrength = blendPerformance(awayCurrent, awayRosterAttack, awayRosterDefense);
    const homeStrength = blendPerformance(homeCurrent, homeRosterAttack, homeRosterDefense);
    const awayGoalsPerGame = clamp(Math.sqrt(awayStrength.attack * homeStrength.defense), 0.6, 3.5);
    const homeGoalsPerGame = clamp(Math.sqrt(homeStrength.attack * awayStrength.defense), 0.6, 3.5);
    const rawAwayGameWinP = gameWinProbability(awayGoalsPerGame, homeGoalsPerGame);
    const awayGameWinP = 0.5 + (rawAwayGameWinP - 0.5) * (1 - cleanProbabilityShrinkage);
    const homeGameWinP = 1 - awayGameWinP;
    const rawProjectedSeriesGoals = 3 * (awayGoalsPerGame + homeGoalsPerGame);
    const projectedSeriesGoals = rawProjectedSeriesGoals + cleanGoalCalibration;
    const goalLine = recommendGoalLine(projectedSeriesGoals);

    return {
      seriesKey: matchup.series_key,
      divisionId: matchup.division_id,
      awayTeamId: matchup.away_team_id,
      awayTeamName: matchup.away_team_name,
      homeTeamId: matchup.home_team_id,
      homeTeamName: matchup.home_team_name,
      awayExpectedGoalsPerGame: awayGoalsPerGame,
      homeExpectedGoalsPerGame: homeGoalsPerGame,
      rawProjectedSeriesGoals,
      projectedSeriesGoals,
      recommendedGoalLine: goalLine.line,
      projectedOverProbability: goalLine.overProbability,
      goalTotalBoost: 1.5,
      away: seriesMarketRecommendations(awayGameWinP),
      home: seriesMarketRecommendations(homeGameWinP),
      confidence: confidenceForTeams(awayRoster, homeRoster, awayCurrent, homeCurrent),
      evidence: {
        awayHistoryCoverage: awayRoster.historyCoverage,
        homeHistoryCoverage: homeRoster.historyCoverage,
        awayHistoryDepth: awayRoster.historyDepth,
        homeHistoryDepth: homeRoster.historyDepth,
        awayCurrentGames: awayStrength.games,
        homeCurrentGames: homeStrength.games
      }
    };
  });

  return {
    seasonId,
    targetWeek: n(targetWeek),
    modelVersion: 'series-lab-v2',
    weights: { ...seasonWeights },
    xgWeight: cleanXgWeight,
    teamPriorGames: cleanTeamPriorGames,
    probabilityShrinkage: cleanProbabilityShrinkage,
    goalCalibration: cleanGoalCalibration,
    sweepCorrectionFactor: SWEEP_CORRECTION_FACTOR,
    baselines: {
      ...baselines,
      goalsPerTeamGame: leagueGoalsPerTeamGame
    },
    recommendations
  };
}

import {
  getBoxscores,
  getPlayers,
  getSeasonCsv,
  getUpcomingSeries
} from './wcplData.js';

const DIVISION_PRIOR_GAMES = { D1: 6, D2: 2 };
const BASE_ODDS = 5;
const ODDS_RANGE = [2, 8];
const HISTORICAL_SKATER_RATE_GAMES = 8;
const HISTORICAL_GOALIE_RATE_SHOTS = 60;
const LEAGUE_PPG = 1;
const LEAGUE_SAVE_PCT = 0.8;

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

function isGoalie(position) {
  return clean(position).toUpperCase().includes('G');
}

function isSkater(position) {
  const value = clean(position).toUpperCase();
  return value.includes('S') || !value.includes('G');
}

function buildIndexes(rows) {
  const bySteam = new Map();
  const byKey = new Map();
  const byName = new Map();
  for (const row of rows) {
    if (normalize(row.steam_id)) bySteam.set(normalize(row.steam_id), row);
    if (normalize(row.player_key)) byKey.set(normalize(row.player_key), row);
    if (normalize(row.name)) byName.set(normalize(row.name), row);
  }
  return { bySteam, byKey, byName };
}

function findPlayer(player, indexes) {
  return indexes.bySteam.get(normalize(player.steam_id)) ||
    indexes.byKey.get(normalize(player.player_key)) ||
    indexes.byName.get(normalize(player.name)) ||
    null;
}

function aggregateCurrent(rows) {
  const out = new Map();
  for (const row of rows) {
    const key = normalize(row.steam_id)
      ? `steam:${normalize(row.steam_id)}`
      : `name:${normalize(row.player_name)}`;
    if (!out.has(key)) {
      out.set(key, {
        steam_id: clean(row.steam_id),
        name: clean(row.player_name),
        skaterGames: 0,
        points: 0,
        goalieGames: 0,
        shotsAgainst: 0,
        goalsAgainst: 0
      });
    }
    const player = out.get(key);
    if (isGoalie(row.position) && n(row.sa) > 0) {
      player.goalieGames += 1;
      player.shotsAgainst += n(row.sa);
      player.goalsAgainst += n(row.ga);
    }
    if (isSkater(row.position)) {
      player.skaterGames += 1;
      player.points += n(row.g) + n(row.a);
    }
  }
  return buildIndexes([...out.values()]);
}

function aggregateHistoricalPlayers(rows, seasonId) {
  return buildIndexes(rows.map(row => {
    const position = clean(row.position).toUpperCase();
    const flex = position.includes('S') && position.includes('G');
    const rawSkaterGames = n(row.gp_s);
    const skaterGames = seasonId === 'S1' && flex && rawSkaterGames < 5
      ? 0
      : rawSkaterGames;
    const goalieGames = n(row.gp_g);
    return {
      steam_id: clean(row.steam_id),
      player_key: clean(row.player_key),
      name: clean(row.name),
      skaterGames,
      points: skaterGames > 0 ? n(row.pts) : 0,
      goalieGames,
      shotsAgainst: n(row.sa),
      goalsAgainst: n(row.ga)
    };
  }));
}

function softmax(rows, score, temperature) {
  if (!rows.length) return [];
  const values = rows.map(row => score(row) / temperature);
  const max = Math.max(...values);
  const weights = values.map(value => Math.exp(value - max));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return rows.map((row, index) => ({ ...row, probability: weights[index] / total }));
}

function baselineOdds(probability, fieldSize) {
  const referenceProbability = 1 / Math.max(1, fieldSize);
  return Math.max(
    ODDS_RANGE[0],
    Math.min(
      ODDS_RANGE[1],
      Math.round((
        BASE_ODDS * Math.sqrt(referenceProbability / probability)
      ) * 10) / 10
    )
  );
}

export async function buildLeaderPropRecommendations({
  seasonId = 'S3',
  divisionId,
  targetWeek
}) {
  const priorGames = DIVISION_PRIOR_GAMES[divisionId] ?? 6;
  const seasonNumber = Number(String(seasonId).replace(/\D/g, ''));
  const historyIds = Array.from({ length: seasonNumber - 1 }, (_, index) => `S${index + 1}`);
  const [players, boxscores, series, history] = await Promise.all([
    getPlayers(divisionId, seasonId),
    getBoxscores(divisionId, seasonId),
    getUpcomingSeries(targetWeek, seasonId),
    Promise.all(historyIds.map(async id => {
      const [seasonPlayers, seasonBoxscores] = await Promise.all([
        getSeasonCsv(id, 'players.csv'),
        getSeasonCsv(id, 'boxscores.csv')
      ]);
      return {
        id,
        weight: id === 'S1' ? 0.35 : 0.65,
        indexes: buildIndexes(seasonPlayers),
        positionIndexes: seasonBoxscores.length
          ? aggregateCurrent(seasonBoxscores)
          : aggregateHistoricalPlayers(seasonPlayers, id)
      };
    }))
  ]);

  const eligibleTeams = new Set(
    series.filter(item => item.division_id === divisionId)
      .flatMap(item => [item.home_team_id, item.away_team_id])
  );
  const priorMatchIds = new Set(
    boxscores
      .map(row => clean(row.match_id))
      .filter(Boolean)
  );
  const currentIndexes = aggregateCurrent(
    boxscores.filter(row => {
      const match = clean(row.match_id);
      const seriesId = match.replace(/-G\d+$/, '');
      return priorMatchIds.has(match) && !series.some(item =>
        item.division_id === divisionId && item.series_id === seriesId
      );
    })
  );

  const recommendations = players
    .filter(player => eligibleTeams.has(player.team_id))
    .map(player => {
      let historicalSkaterGames = 0;
      let historicalPoints = 0;
      let historicalGoalieGames = 0;
      let historicalShots = 0;
      let historicalGoalsAgainst = 0;
      const matchedSeasons = [];
      for (const season of history) {
        const match = findPlayer(player, season.indexes);
        const positionMatch = findPlayer(player, season.positionIndexes);
        if (!match && !positionMatch) continue;
        matchedSeasons.push(season.id);
        historicalSkaterGames += season.weight * n(positionMatch?.skaterGames);
        historicalPoints += season.weight * n(positionMatch?.points);
        historicalGoalieGames += season.weight * n(positionMatch?.goalieGames);
        historicalShots += season.weight * n(positionMatch?.shotsAgainst);
        historicalGoalsAgainst += season.weight * n(positionMatch?.goalsAgainst);
      }
      const current = findPlayer(player, currentIndexes);
      const historicalPpg = (
        historicalPoints + HISTORICAL_SKATER_RATE_GAMES * LEAGUE_PPG
      ) / (
        historicalSkaterGames + HISTORICAL_SKATER_RATE_GAMES
      );
      const currentSkaterGames = n(current?.skaterGames);
      const projectedPpg = (
        priorGames * historicalPpg + n(current?.points)
      ) / (
        priorGames + currentSkaterGames
      );
      const historicalSavePct = (
        Math.max(0, historicalShots - historicalGoalsAgainst) +
        HISTORICAL_GOALIE_RATE_SHOTS * LEAGUE_SAVE_PCT
      ) / (
        historicalShots + HISTORICAL_GOALIE_RATE_SHOTS
      );
      const currentShots = n(current?.shotsAgainst);
      const projectedSavePct = (
        priorGames * 10 * historicalSavePct +
        Math.max(0, currentShots - n(current?.goalsAgainst))
      ) / (
        priorGames * 10 + currentShots
      );
      return {
        playerKey: player.player_key,
        playerName: player.display_name,
        teamId: player.team_id,
        position: player.position,
        matchedSeasons,
        projectedPpg,
        projectedSavePct,
        currentSkaterGames,
        currentGoalieGames: n(current?.goalieGames),
        historicalSkaterGames,
        historicalGoalieGames,
        currentRosterSkaterGames: n(player.gp_s),
        currentRosterGoalieGames: n(player.gp_g)
      };
    });

  const topScorerProbabilities = softmax(
    recommendations.filter(row =>
      isSkater(row.position) &&
      (row.historicalSkaterGames > 0 || row.currentSkaterGames > 0)
    ),
    row => row.projectedPpg,
    0.55
  );
  const topScorer = topScorerProbabilities
    .map(row => ({
      ...row,
      recommendedOdds: baselineOdds(row.probability, topScorerProbabilities.length)
    }))
    .sort((a, b) => b.probability - a.probability);

  const topGoalieProbabilities = softmax(
    recommendations.filter(row =>
      isGoalie(row.position) &&
      (row.historicalGoalieGames > 0 || row.currentGoalieGames > 0)
    ),
    row => row.projectedSavePct,
    0.035
  );
  const topGoalie = topGoalieProbabilities
    .map(row => ({
      ...row,
      recommendedOdds: baselineOdds(row.probability, topGoalieProbabilities.length)
    }))
    .sort((a, b) => b.probability - a.probability);

  return { divisionId, targetWeek: Number(targetWeek), priorGames, topScorer, topGoalie };
}

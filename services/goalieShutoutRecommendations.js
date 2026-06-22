import { buildSeriesOddsRecommendations } from './oddsRecommendations.js';
import { getSeasonCsv } from './wcplData.js';

const DIVISION_PRIOR_GAMES = {
  D1: 6,
  D2: 2
};
const SHUTOUT_CALIBRATION = { 1: 0.87, 2: 1.34, 3: 2 };
const TIER_BASE_ODDS = { 1: 4, 2: 10, 3: 25 };
const REFERENCE_PROBABILITIES = { 1: 0.2151, 2: 0.0577, 3: 0.0086 };
const ODDS_RANGES = { 1: [2, 8], 2: [5, 25], 3: [10, 50] };
const MATCHUP_ADJUSTMENT_WEIGHT = 0.5;
const HISTORICAL_RATE_PRIOR_APPEARANCES = 6;

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isGoalie(position) {
  return clean(position).toUpperCase().includes('G');
}

function seriesId(matchId) {
  return clean(matchId).replace(/-G\d+$/, '');
}

function factorial(value) {
  let out = 1;
  for (let i = 2; i <= value; i += 1) out *= i;
  return out;
}

function binomialAtLeast(trials, probability, minimum) {
  let below = 0;
  for (let successes = 0; successes < minimum; successes += 1) {
    const combinations = factorial(trials) /
      (factorial(successes) * factorial(trials - successes));
    below += combinations *
      (probability ** successes) *
      ((1 - probability) ** (trials - successes));
  }
  return clamp(1 - below, 0, 1);
}

function buildIndexes(rows, nameField = 'name') {
  const bySteam = new Map();
  const byKey = new Map();
  const byName = new Map();
  for (const row of rows) {
    const steam = normalize(row.steam_id);
    const key = normalize(row.player_key);
    const name = normalize(row[nameField]);
    if (steam && !bySteam.has(steam)) bySteam.set(steam, row);
    if (key && !byKey.has(key)) byKey.set(key, row);
    if (name && !byName.has(name)) byName.set(name, row);
  }
  return { bySteam, byKey, byName };
}

function findPlayer(player, indexes) {
  const steam = normalize(player.steam_id);
  if (steam && indexes.bySteam.has(steam)) return indexes.bySteam.get(steam);
  const key = normalize(player.player_key);
  if (key && indexes.byKey.has(key)) return indexes.byKey.get(key);
  const name = normalize(player.name);
  if (name && indexes.byName.has(name)) return indexes.byName.get(name);
  return null;
}

function teamGameCounts(schedule) {
  const out = new Map();
  for (const row of schedule.filter(item => clean(item.stage).toLowerCase() === 'reg')) {
    out.set(row.home_team_id, (out.get(row.home_team_id) || 0) + 1);
    out.set(row.away_team_id, (out.get(row.away_team_id) || 0) + 1);
  }
  return out;
}

function aggregateCurrentGoalies(boxscores) {
  const out = new Map();
  for (const row of boxscores.filter(item => isGoalie(item.position) && n(item.sa) > 0)) {
    const identity = normalize(row.steam_id)
      ? `steam:${normalize(row.steam_id)}`
      : `name:${normalize(row.player_name)}`;
    if (!out.has(identity)) {
      out.set(identity, {
        steam_id: clean(row.steam_id),
        player_key: '',
        name: clean(row.player_name),
        appearances: 0,
        shutouts: 0,
        seriesIds: new Set()
      });
    }
    const aggregate = out.get(identity);
    aggregate.appearances += 1;
    if (n(row.so) >= 1 || n(row.ga) === 0) aggregate.shutouts += 1;
    aggregate.seriesIds.add(seriesId(row.match_id));
  }
  return [...out.values()].map(goalie => ({
    ...goalie,
    completedSeries: goalie.seriesIds.size
  }));
}

function weightedHistoricalStats(player, historicalSeasons) {
  let appearances = 0;
  let shutouts = 0;
  let rawAppearances = 0;
  let rawShutouts = 0;
  let teamGames = 0;
  const matchedSeasons = [];

  for (const season of historicalSeasons) {
    const match = findPlayer(player, season.indexes);
    if (!match) continue;
    appearances += season.weight * n(match.gp_g);
    shutouts += season.weight * n(match.so);
    rawAppearances += n(match.gp_g);
    rawShutouts += n(match.so);
    teamGames += season.weight * n(season.teamGames.get(match.team_id));
    matchedSeasons.push(season.id);
  }

  return {
    appearances,
    shutouts,
    rawAppearances,
    rawShutouts,
    teamGames,
    matchedSeasons
  };
}

function recommendedOdds(probability, quantity) {
  return clamp(
    Math.round((
      TIER_BASE_ODDS[quantity] *
      Math.sqrt(REFERENCE_PROBABILITIES[quantity] / probability)
    ) * 10) / 10,
    ODDS_RANGES[quantity][0],
    ODDS_RANGES[quantity][1]
  );
}

export async function buildGoalieShutoutRecommendations({
  seasonId = 'S3',
  divisionId,
  targetWeek
}) {
  if (!divisionId) throw new Error('Division is required.');

  const priorGames = DIVISION_PRIOR_GAMES[divisionId] ?? DIVISION_PRIOR_GAMES.D1;
  const seasonNumber = Number(String(seasonId).replace(/\D/g, ''));
  const historicalSeasonIds = Array.from(
    { length: seasonNumber - 1 },
    (_, index) => `S${index + 1}`
  );

  const [players, schedule, boxscores, historicalSeasons, seriesReport] = await Promise.all([
    getSeasonCsv(seasonId, 'players.csv', divisionId),
    getSeasonCsv(seasonId, 'schedule.csv', divisionId),
    getSeasonCsv(seasonId, 'boxscores.csv', divisionId),
    Promise.all(historicalSeasonIds.map(async id => {
      const [seasonPlayers, seasonSchedule] = await Promise.all([
        getSeasonCsv(id, 'players.csv'),
        getSeasonCsv(id, 'schedule.csv')
      ]);
      return {
        id,
        weight: id === 'S1' ? 0.35 : 0.65,
        indexes: buildIndexes(seasonPlayers),
        teamGames: teamGameCounts(seasonSchedule),
        players: seasonPlayers
      };
    })),
    buildSeriesOddsRecommendations({ seasonId, targetWeek })
  ]);

  const priorMatchIds = new Set(
    schedule.filter(row => n(row.week) < n(targetWeek)).map(row => clean(row.match_id))
  );
  const currentGoalies = aggregateCurrentGoalies(
    boxscores.filter(row => priorMatchIds.has(clean(row.match_id)))
  );
  const currentIndexes = buildIndexes(currentGoalies);
  const currentTeamGames = teamGameCounts(
    schedule.filter(row => n(row.week) < n(targetWeek))
  );

  let baselineAppearances = 0;
  let baselineShutouts = 0;
  for (const season of historicalSeasons) {
    for (const player of season.players) {
      baselineAppearances += season.weight * n(player.gp_g);
      baselineShutouts += season.weight * n(player.so);
    }
  }
  const baselineShutoutRate = baselineAppearances
    ? baselineShutouts / baselineAppearances
    : 0.15;

  const matchupsByTeam = new Map();
  for (const matchup of seriesReport.recommendations.filter(item =>
    item.divisionId === divisionId
  )) {
    if (!matchupsByTeam.has(matchup.awayTeamId)) matchupsByTeam.set(matchup.awayTeamId, []);
    if (!matchupsByTeam.has(matchup.homeTeamId)) matchupsByTeam.set(matchup.homeTeamId, []);
    matchupsByTeam.get(matchup.awayTeamId).push({
      seriesKey: matchup.seriesKey,
      opponentTeamId: matchup.homeTeamId,
      opponentTeamName: matchup.homeTeamName,
      opponentExpectedGoals: matchup.homeExpectedGoalsPerGame
    });
    matchupsByTeam.get(matchup.homeTeamId).push({
      seriesKey: matchup.seriesKey,
      opponentTeamId: matchup.awayTeamId,
      opponentTeamName: matchup.awayTeamName,
      opponentExpectedGoals: matchup.awayExpectedGoalsPerGame
    });
  }

  const leagueGoalsPerTeamGame = seriesReport.baselines.goalsPerTeamGame;
  const recommendations = [];
  const excluded = [];

  for (const player of players.filter(item =>
    isGoalie(item.position) && matchupsByTeam.has(item.team_id)
  )) {
    const history = weightedHistoricalStats(player, historicalSeasons);
    const current = findPlayer(player, currentIndexes);
    const currentAppearances = n(current?.appearances);
    const currentShutouts = n(current?.shutouts);
    const completedSeries = n(current?.completedSeries);
    const currentGamesForTeam = n(currentTeamGames.get(player.team_id));
    const hasHistoricalData = history.appearances > 0;
    const eligibility = hasHistoricalData || completedSeries >= 2
        ? 'automatic'
        : completedSeries === 1
          ? 'manual_review'
          : 'excluded';

    if (eligibility === 'excluded') {
      excluded.push({
        playerKey: clean(player.player_key || player.steam_id || player.name),
        playerName: clean(player.name),
        teamId: clean(player.team_id),
        reason: 'No historical goalie data and no completed current-season series.'
      });
      continue;
    }

    const historicalShutoutRate = history.appearances
      ? (
          HISTORICAL_RATE_PRIOR_APPEARANCES * baselineShutoutRate +
          history.shutouts
        ) / (
          HISTORICAL_RATE_PRIOR_APPEARANCES + history.appearances
        )
      : baselineShutoutRate;
    const historicalAppearanceRate = history.teamGames
      ? clamp(history.appearances / history.teamGames, 1 / 3, 1)
      : 0.45;
    const shutoutPerAppearance = (
      priorGames * historicalShutoutRate + currentShutouts
    ) / (
      priorGames + currentAppearances
    );
    const appearanceRate = clamp(
      (
        priorGames * historicalAppearanceRate + currentAppearances
      ) / (
        priorGames + currentGamesForTeam
      ),
      1 / 3,
      1
    );

    for (const matchup of matchupsByTeam.get(player.team_id)) {
      const matchupFactor = clamp(
        Math.exp(
          (leagueGoalsPerTeamGame - matchup.opponentExpectedGoals) *
          MATCHUP_ADJUSTMENT_WEIGHT
        ),
        0.55,
        1.75
      );
      const perScheduledGameProbability = clamp(
        appearanceRate * shutoutPerAppearance * matchupFactor,
        0.001,
        0.8
      );
      const rawProbabilities = {
        1: binomialAtLeast(3, perScheduledGameProbability, 1),
        2: binomialAtLeast(3, perScheduledGameProbability, 2),
        3: binomialAtLeast(3, perScheduledGameProbability, 3)
      };
      const probabilities = {
        1: clamp(rawProbabilities[1] * SHUTOUT_CALIBRATION[1], 0.001, 0.95),
        2: clamp(rawProbabilities[2] * SHUTOUT_CALIBRATION[2], 0.001, 0.95),
        3: clamp(rawProbabilities[3] * SHUTOUT_CALIBRATION[3], 0.001, 0.95)
      };
      probabilities[2] = Math.min(probabilities[1], probabilities[2]);
      probabilities[3] = Math.min(probabilities[2], probabilities[3]);

      recommendations.push({
        seriesKey: matchup.seriesKey,
        playerKey: clean(player.player_key || player.steam_id || player.name),
        playerName: clean(player.name),
        teamId: clean(player.team_id),
        opponentTeamId: matchup.opponentTeamId,
        opponentTeamName: matchup.opponentTeamName,
        historicalSeasons: history.matchedSeasons,
        hasHistoricalData,
        completedSeries,
        eligibility,
        currentAppearances,
        currentShutouts,
        careerAppearances: history.rawAppearances + currentAppearances,
        careerShutouts: history.rawShutouts + currentShutouts,
        careerShutoutRate: history.rawAppearances + currentAppearances > 0
          ? (history.rawShutouts + currentShutouts) / (history.rawAppearances + currentAppearances)
          : baselineShutoutRate,
        currentShutoutRate: currentAppearances > 0
          ? currentShutouts / currentAppearances
          : null,
        appearanceRate,
        shutoutPerAppearance,
        opponentExpectedGoals: matchup.opponentExpectedGoals,
        matchupFactor,
        probabilities,
        recommendedOdds: {
          1: recommendedOdds(probabilities[1], 1),
          2: recommendedOdds(probabilities[2], 2),
          3: recommendedOdds(probabilities[3], 3)
        }
      });
    }
  }

  return {
    seasonId,
    divisionId,
    targetWeek: n(targetWeek),
    modelVersion: 'goalie-shutouts-v1',
    settings: {
      priorGames,
      divisionPriorGames: { ...DIVISION_PRIOR_GAMES },
      shutoutCalibration: { ...SHUTOUT_CALIBRATION },
      tierBaseOdds: { ...TIER_BASE_ODDS },
      oddsRanges: Object.fromEntries(
        Object.entries(ODDS_RANGES).map(([key, range]) => [key, [...range]])
      ),
      matchupAdjustmentWeight: MATCHUP_ADJUSTMENT_WEIGHT,
      historicalRatePriorAppearances: HISTORICAL_RATE_PRIOR_APPEARANCES
    },
    recommendations,
    excluded
  };
}

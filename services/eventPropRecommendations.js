import { getSeasonCsv } from './wcplData.js';

const HAT_PRIOR_GAMES = 10;
const SHUTOUT_PRIOR_APPEARANCES = 6;
const APPEARANCE_PRIOR_TEAM_GAMES = 8;
const SHUTOUT_CALIBRATION = { 1: 0.87, 2: 1.34, 3: 2 };

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

function isSkater(position) {
  const value = clean(position).toUpperCase();
  return value.includes('S') || !value.includes('G');
}

function poissonPmf(lambda, k) {
  let factorial = 1;
  for (let i = 2; i <= k; i += 1) factorial *= i;
  return Math.exp(-lambda) * (lambda ** k) / factorial;
}

function poissonAtLeast(lambda, minimum) {
  let below = 0;
  for (let k = 0; k < minimum; k += 1) below += poissonPmf(lambda, k);
  return clamp(1 - below, 0, 1);
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

function factorial(value) {
  let out = 1;
  for (let i = 2; i <= value; i += 1) out *= i;
  return out;
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

function seriesId(matchId) {
  return clean(matchId).replace(/-G\d+$/, '');
}

function teamGameCounts(schedule) {
  const out = new Map();
  for (const row of schedule.filter(item => clean(item.stage).toLowerCase() === 'reg')) {
    out.set(row.home_team_id, (out.get(row.home_team_id) || 0) + 1);
    out.set(row.away_team_id, (out.get(row.away_team_id) || 0) + 1);
  }
  return out;
}

function aggregateCurrentBoxscores(rows) {
  const out = new Map();
  for (const row of rows) {
    const identity = normalize(row.steam_id)
      ? `steam:${normalize(row.steam_id)}`
      : `name:${normalize(row.player_name)}`;
    if (!out.has(identity)) {
      out.set(identity, {
        steam_id: clean(row.steam_id),
        player_key: '',
        name: clean(row.player_name),
        skaterAppearances: 0,
        goals: 0,
        hatTricks: 0,
        goalieAppearances: 0,
        shutouts: 0
      });
    }
    const aggregate = out.get(identity);
    if (isSkater(row.position)) {
      aggregate.skaterAppearances += 1;
      aggregate.goals += n(row.g);
      if (n(row.g) >= 3) aggregate.hatTricks += 1;
    }
    if (isGoalie(row.position) && n(row.sa) > 0) {
      aggregate.goalieAppearances += 1;
      if (n(row.so) >= 1 || n(row.ga) === 0) aggregate.shutouts += 1;
    }
  }
  return [...out.values()];
}

function leagueBaselines(historicalSeasons) {
  let skaterGames = 0;
  let goals = 0;
  let goalieGames = 0;
  let shutouts = 0;
  for (const season of historicalSeasons) {
    for (const player of season.players) {
      skaterGames += season.weight * n(player.gp_s);
      goals += season.weight * n(player.g);
      goalieGames += season.weight * n(player.gp_g);
      shutouts += season.weight * n(player.so);
    }
  }
  return {
    goalsPerSkaterGame: skaterGames ? goals / skaterGames : 0.4,
    shutoutPerGoalieGame: goalieGames ? shutouts / goalieGames : 0.15
  };
}

function fairPayout(probability, cap = 100) {
  if (probability <= 0) return cap;
  return Math.min(cap, Math.max(1.1, Math.round((0.9 / probability) * 10) / 10));
}

export async function buildEventPropRecommendations({
  seasonId = 'S3',
  divisionId,
  targetWeek
}) {
  const seasonNumber = Number(String(seasonId).replace(/\D/g, ''));
  const currentDivision = divisionId || (seasonId === 'S2' ? 'ALL' : 'D1');
  const historicalSeasonIds = Array.from(
    { length: seasonNumber - 1 },
    (_, index) => `S${index + 1}`
  );

  const [players, schedule, boxscores, historicalSeasons] = await Promise.all([
    getSeasonCsv(seasonId, 'players.csv', currentDivision),
    getSeasonCsv(seasonId, 'schedule.csv', currentDivision),
    getSeasonCsv(seasonId, 'boxscores.csv', currentDivision),
    Promise.all(historicalSeasonIds.map(async id => ({
      id,
      weight: id === 'S1' ? 0.35 : 0.65,
      players: await getSeasonCsv(id, 'players.csv'),
      schedule: await getSeasonCsv(id, 'schedule.csv')
    })))
  ]);

  const priorMatchIds = new Set(
    schedule.filter(row => n(row.week) < n(targetWeek)).map(row => clean(row.match_id))
  );
  const currentRows = aggregateCurrentBoxscores(
    boxscores.filter(row => priorMatchIds.has(clean(row.match_id)))
  );
  const historicalIndexes = historicalSeasons.map(season => ({
    ...season,
    indexes: buildIndexes(season.players),
    teamGames: teamGameCounts(season.schedule)
  }));
  const currentIndexes = buildIndexes(currentRows);
  const currentTeamGames = teamGameCounts(
    schedule.filter(row => n(row.week) < n(targetWeek))
  );
  const baselines = leagueBaselines(historicalSeasons);

  const targetRows = schedule.filter(row =>
    n(row.week) === n(targetWeek) && clean(row.stage).toLowerCase() === 'reg'
  );
  const seriesByTeam = new Map();
  for (const row of targetRows) {
    const id = seriesId(row.match_id);
    for (const teamId of [row.home_team_id, row.away_team_id]) {
      if (!seriesByTeam.has(teamId)) seriesByTeam.set(teamId, new Set());
      seriesByTeam.get(teamId).add(id);
    }
  }

  const recommendations = [];
  for (const player of players.filter(item => seriesByTeam.has(item.team_id))) {
    const current = findPlayer(player, currentIndexes);
    const history = historicalIndexes
      .map(season => ({
        ...season,
        player: findPlayer(player, season.indexes)
      }))
      .filter(item => item.player);
    const weightedHistoricalSkaterGames = history.reduce(
      (sum, item) => sum + item.weight * n(item.player.gp_s),
      0
    );
    const weightedHistoricalGoals = history.reduce(
      (sum, item) => sum + item.weight * n(item.player.g),
      0
    );
    const weightedHistoricalGoalieGames = history.reduce(
      (sum, item) => sum + item.weight * n(item.player.gp_g),
      0
    );
    const weightedHistoricalShutouts = history.reduce(
      (sum, item) => sum + item.weight * n(item.player.so),
      0
    );
    const weightedHistoricalTeamGames = history.reduce(
      (sum, item) =>
        sum + item.weight * n(item.teamGames.get(item.player.team_id)),
      0
    );
    const currentTeamGameCount = n(currentTeamGames.get(player.team_id));

    const historicalSkaterGames = weightedHistoricalSkaterGames;
    const currentSkaterGames = n(current?.skaterAppearances);
    const historicalGoalRate = historicalSkaterGames
      ? weightedHistoricalGoals / historicalSkaterGames
      : baselines.goalsPerSkaterGame;
    const skaterAppearancePrior = weightedHistoricalTeamGames
      ? historicalSkaterGames / weightedHistoricalTeamGames
      : 0.85;
    const skaterAppearanceRate = (
      APPEARANCE_PRIOR_TEAM_GAMES * skaterAppearancePrior + currentSkaterGames
    ) / (
      APPEARANCE_PRIOR_TEAM_GAMES + currentTeamGameCount
    );
    const goalRate = (
      HAT_PRIOR_GAMES * historicalGoalRate + n(current?.goals)
    ) / (
      HAT_PRIOR_GAMES + currentSkaterGames
    );
    const hatPerAppearance = poissonAtLeast(goalRate, 3);
    const hatPerScheduledGame = clamp(skaterAppearanceRate * hatPerAppearance, 0, 0.75);

    const historicalGoalieGames = weightedHistoricalGoalieGames;
    const currentGoalieGames = n(current?.goalieAppearances);
    const historicalShutoutRate = historicalGoalieGames
      ? weightedHistoricalShutouts / historicalGoalieGames
      : baselines.shutoutPerGoalieGame;
    const goalieAppearancePrior = weightedHistoricalTeamGames
      ? historicalGoalieGames / weightedHistoricalTeamGames
      : 0.45;
    const goalieAppearanceRate = (
      APPEARANCE_PRIOR_TEAM_GAMES * goalieAppearancePrior + currentGoalieGames
    ) / (
      APPEARANCE_PRIOR_TEAM_GAMES + currentTeamGameCount
    );
    const shutoutPerAppearance = (
      SHUTOUT_PRIOR_APPEARANCES * historicalShutoutRate + n(current?.shutouts)
    ) / (
      SHUTOUT_PRIOR_APPEARANCES + currentGoalieGames
    );
    const shutoutPerScheduledGame = clamp(
      goalieAppearanceRate * shutoutPerAppearance,
      0,
      0.8
    );

    recommendations.push({
      playerKey: clean(player.player_key || player.steam_id || player.name),
      playerName: clean(player.name),
      teamId: clean(player.team_id),
      position: clean(player.position),
      historicalMatch: history.length > 0,
      historicalSeasons: history.map(item => item.id),
      currentSkaterGames,
      currentGoalieGames,
      hatTrick: isSkater(player.position) ? {
        perAppearanceProbability: hatPerAppearance,
        appearanceRate: skaterAppearanceRate,
        probabilities: {
          1: binomialAtLeast(3, hatPerScheduledGame, 1),
          2: binomialAtLeast(3, hatPerScheduledGame, 2),
          3: binomialAtLeast(3, hatPerScheduledGame, 3)
        }
      } : null,
      shutout: isGoalie(player.position) ? {
        perAppearanceProbability: shutoutPerAppearance,
        appearanceRate: goalieAppearanceRate,
        probabilities: (() => {
          const raw = {
            1: binomialAtLeast(3, shutoutPerScheduledGame, 1),
            2: binomialAtLeast(3, shutoutPerScheduledGame, 2),
            3: binomialAtLeast(3, shutoutPerScheduledGame, 3)
          };
          const calibrated = {
            1: clamp(raw[1] * SHUTOUT_CALIBRATION[1], 0, 1),
            2: clamp(raw[2] * SHUTOUT_CALIBRATION[2], 0, 1),
            3: clamp(raw[3] * SHUTOUT_CALIBRATION[3], 0, 1)
          };
          calibrated[2] = Math.min(calibrated[1], calibrated[2]);
          calibrated[3] = Math.min(calibrated[2], calibrated[3]);
          return calibrated;
        })()
      } : null
    });
  }

  for (const row of recommendations) {
    for (const market of [row.hatTrick, row.shutout].filter(Boolean)) {
      market.recommendedOdds = Object.fromEntries(
        [1, 2, 3].map(quantity => [
          quantity,
          fairPayout(market.probabilities[quantity], quantity === 1 ? 50 : 100)
        ])
      );
    }
  }

  return {
    seasonId,
    divisionId: currentDivision,
    targetWeek: n(targetWeek),
    baselines,
    shutoutCalibration: { ...SHUTOUT_CALIBRATION },
    recommendations
  };
}

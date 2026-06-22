import { buildSeriesOddsRecommendations } from './oddsRecommendations.js';
import { getSeasonCsv } from './wcplData.js';

const DIVISION_PRIOR_GAMES = {
  D1: 6,
  D2: 2
};
const DISPERSION = 1;
const TIER_TARGETS = [0.4, 0.15, 0.07];
const TIER_CALIBRATION = [0.88, 0.75, 0.56];
const TIER_BASE_ODDS = [3, 8, 15];
const TIER_REFERENCE_PROBABILITIES = TIER_TARGETS.map(
  (target, index) => target * TIER_CALIBRATION[index]
);
const ODDS_RANGES = [[2, 5], [4, 12], [8, 20]];
const MAX_LINE_ABOVE_EXPECTED = [1.5, 4.5, 7.5];

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

function isSkater(position) {
  const value = clean(position).toUpperCase();
  return value.includes('S') || !value.includes('G');
}

function usableHistoricalSkaterGames(row, seasonId) {
  const games = n(row.gp_s);
  const flex = clean(row.position).toUpperCase().includes('S') &&
    clean(row.position).toUpperCase().includes('G');
  return seasonId === 'S1' && flex && games < 5 ? 0 : games;
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

function aggregateCurrentSkaters(boxscores) {
  const out = new Map();
  for (const row of boxscores.filter(item => isSkater(item.position))) {
    const identity = normalize(row.steam_id)
      ? `steam:${normalize(row.steam_id)}`
      : `name:${normalize(row.player_name)}`;
    if (!out.has(identity)) {
      out.set(identity, {
        steam_id: clean(row.steam_id),
        player_key: '',
        name: clean(row.player_name),
        appearances: 0,
        goals: 0,
        seriesIds: new Set()
      });
    }
    const aggregate = out.get(identity);
    aggregate.appearances += 1;
    aggregate.goals += n(row.g);
    aggregate.seriesIds.add(clean(row.match_id).replace(/-G\d+$/, ''));
  }
  return [...out.values()].map(player => ({
    ...player,
    completedSeries: player.seriesIds.size
  }));
}

function negativeBinomialAtLeast(mean, dispersion, goals) {
  const successProbability = dispersion / (dispersion + mean);
  const failureProbability = mean / (dispersion + mean);
  let probability = successProbability ** dispersion;
  let below = goals > 0 ? probability : 0;
  for (let k = 1; k < goals; k += 1) {
    probability *= ((k - 1 + dispersion) / k) * failureProbability;
    below += probability;
  }
  return clamp(1 - below, 0, 1);
}

function chooseLines(lambda) {
  const candidates = [];
  for (let requiredGoals = 2; requiredGoals <= 20; requiredGoals += 1) {
    candidates.push({
      requiredGoals,
      line: requiredGoals - 0.5,
      rawProbability: negativeBinomialAtLeast(lambda, DISPERSION, requiredGoals)
    });
  }

  const out = [];
  let minimumGoals = 2;
  TIER_TARGETS.forEach((target, index) => {
    const maximumLine = Math.max(
      index === 0 ? 1.5 : out[index - 1].line + 1,
      Math.floor((lambda + MAX_LINE_ABOVE_EXPECTED[index]) * 2) / 2
    );
    const eligible = candidates.filter(candidate =>
      candidate.requiredGoals >= minimumGoals &&
      candidate.line <= maximumLine
    );
    const choice = (eligible.length ? eligible : candidates.filter(candidate =>
      candidate.requiredGoals >= minimumGoals
    ))
      .filter(candidate => candidate.requiredGoals >= minimumGoals)
      .sort((a, b) =>
        Math.abs(a.rawProbability - target) - Math.abs(b.rawProbability - target) ||
        a.requiredGoals - b.requiredGoals
      )[0];
    const probability = clamp(
      choice.rawProbability * TIER_CALIBRATION[index],
      0.001,
      0.95
    );
    out.push({
      tier: index + 1,
      label: 'Over',
      requiredGoals: choice.requiredGoals,
      line: choice.line,
      rawProbability: choice.rawProbability,
      probability,
      odds: clamp(
        Math.round((
          TIER_BASE_ODDS[index] *
          Math.sqrt(TIER_REFERENCE_PROBABILITIES[index] / probability)
        ) * 10) / 10,
        ODDS_RANGES[index][0],
        ODDS_RANGES[index][1]
      )
    });
    minimumGoals = choice.requiredGoals + 1;
  });

  return out;
}

function weightedHistoricalStats(player, historicalSeasons) {
  let appearances = 0;
  let goals = 0;
  let rawAppearances = 0;
  let rawGoals = 0;
  let teamGames = 0;
  const matchedSeasons = [];

  for (const season of historicalSeasons) {
    const match = findPlayer(player, season.indexes);
    if (!match) continue;
    const skaterGames = usableHistoricalSkaterGames(match, season.id);
    appearances += season.weight * skaterGames;
    goals += season.weight * (skaterGames > 0 ? n(match.g) : 0);
    rawAppearances += skaterGames;
    rawGoals += skaterGames > 0 ? n(match.g) : 0;
    teamGames += season.weight * n(season.teamGames.get(match.team_id));
    if (skaterGames > 0) matchedSeasons.push(season.id);
  }

  return {
    appearances,
    goals,
    rawAppearances,
    rawGoals,
    teamGames,
    matchedSeasons
  };
}

export async function buildPlayerGoalsRecommendations({
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
        teamGames: teamGameCounts(seasonSchedule)
      };
    })),
    buildSeriesOddsRecommendations({ seasonId, targetWeek })
  ]);

  const priorMatchIds = new Set(
    schedule.filter(row => n(row.week) < n(targetWeek)).map(row => clean(row.match_id))
  );
  const currentRows = aggregateCurrentSkaters(
    boxscores.filter(row => priorMatchIds.has(clean(row.match_id)))
  );
  const currentIndexes = buildIndexes(currentRows);
  const currentTeamGames = teamGameCounts(
    schedule.filter(row => n(row.week) < n(targetWeek))
  );
  const historicalPlayersForBaseline = await Promise.all(
    historicalSeasonIds.map(id => getSeasonCsv(id, 'players.csv'))
  );
  let baselineGames = 0;
  let baselineGoals = 0;
  historicalPlayersForBaseline.forEach((rows, index) => {
    const weight = historicalSeasonIds[index] === 'S1' ? 0.35 : 0.65;
    for (const row of rows) {
      const skaterGames = usableHistoricalSkaterGames(row, historicalSeasonIds[index]);
      baselineGames += weight * skaterGames;
      baselineGoals += weight * (skaterGames > 0 ? n(row.g) : 0);
    }
  });
  const baselineGoalRate = baselineGames ? baselineGoals / baselineGames : 0.4;

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
      teamExpectedGoals: matchup.awayExpectedGoalsPerGame
    });
    matchupsByTeam.get(matchup.homeTeamId).push({
      seriesKey: matchup.seriesKey,
      opponentTeamId: matchup.awayTeamId,
      opponentTeamName: matchup.awayTeamName,
      teamExpectedGoals: matchup.homeExpectedGoalsPerGame
    });
  }

  const leagueGoalsPerTeamGame = seriesReport.baselines.goalsPerTeamGame;
  const recommendations = [];
  const excluded = [];

  for (const player of players.filter(item =>
    isSkater(item.position) && matchupsByTeam.has(item.team_id)
  )) {
    const history = weightedHistoricalStats(player, historicalSeasons);
    const current = findPlayer(player, currentIndexes);
    const currentAppearances = n(current?.appearances);
    const currentGoals = n(current?.goals);
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
        reason: 'No historical data and no completed current-season series.'
      });
      continue;
    }

    const historicalGoalRate = history.appearances
      ? history.goals / history.appearances
      : baselineGoalRate;
    const historicalAppearanceRate = history.teamGames
      ? history.appearances / history.teamGames
      : 0.85;
    const goalRate = (
      priorGames * historicalGoalRate + currentGoals
    ) / (
      priorGames + currentAppearances
    );
    const appearanceRate = (
      priorGames * historicalAppearanceRate + currentAppearances
    ) / (
      priorGames + currentGamesForTeam
    );
    const matchups = matchupsByTeam.get(player.team_id);
    for (const matchup of matchups) {
      const teamEnvironment = clamp(
        matchup.teamExpectedGoals / leagueGoalsPerTeamGame,
        0.7,
        1.4
      );
      const expectedGoals = Math.max(
        0.03,
        3 * goalRate * appearanceRate * teamEnvironment
      );

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
        currentGoals,
        careerGames: history.rawAppearances + currentAppearances,
        careerGoals: history.rawGoals + currentGoals,
        careerGoalsPerGame: history.rawAppearances + currentAppearances > 0
          ? (history.rawGoals + currentGoals) / (history.rawAppearances + currentAppearances)
          : baselineGoalRate,
        currentGoalsPerGame: currentAppearances > 0
          ? currentGoals / currentAppearances
          : null,
        expectedAppearances: 3 * appearanceRate,
        expectedGoals,
        tiers: chooseLines(expectedGoals)
      });
    }
  }

  return {
    seasonId,
    divisionId,
    targetWeek: n(targetWeek),
    modelVersion: 'player-goals-v3',
    settings: {
      goalRatePriorGames: priorGames,
      appearancePriorGames: priorGames,
      divisionPriorGames: { ...DIVISION_PRIOR_GAMES },
      dispersion: DISPERSION,
      tierTargets: [...TIER_TARGETS],
      tierCalibration: [...TIER_CALIBRATION],
      tierBaseOdds: [...TIER_BASE_ODDS],
      oddsRanges: ODDS_RANGES.map(range => [...range])
    },
    recommendations,
    excluded
  };
}

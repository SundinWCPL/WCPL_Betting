import { readCsvFile } from '../services/csv.js';

const PRIOR_GAMES = [6, 10, 15, 20];
const APPEARANCE_PRIORS = [6, 10, 15];
const BASE_TARGETS = [0.3, 0.35, 0.4, 0.45, 0.5];
const BIG_TARGETS = [0.08, 0.12, 0.15, 0.2];
const LEGENDARY_TARGETS = [0.01, 0.025, 0.04];
const DISPERSIONS = [1, 1.5, 2, 3, 5, 10, 1000];

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

function isSkater(position) {
  const value = clean(position).toUpperCase();
  return value.includes('S') || !value.includes('G');
}

function factorial(value) {
  let out = 1;
  for (let i = 2; i <= value; i += 1) out *= i;
  return out;
}

function poissonAtLeast(lambda, goals) {
  let below = 0;
  for (let k = 0; k < goals; k += 1) {
    below += Math.exp(-lambda) * (lambda ** k) / factorial(k);
  }
  return Math.max(0, Math.min(1, 1 - below));
}

function negativeBinomialAtLeast(mean, dispersion, goals) {
  if (dispersion >= 1000) return poissonAtLeast(mean, goals);
  const successProbability = dispersion / (dispersion + mean);
  const failureProbability = mean / (dispersion + mean);
  let probability = successProbability ** dispersion;
  let below = goals > 0 ? probability : 0;
  for (let k = 1; k < goals; k += 1) {
    probability *= ((k - 1 + dispersion) / k) * failureProbability;
    below += probability;
  }
  return Math.max(0, Math.min(1, 1 - below));
}

function buildIndexes(rows) {
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

function findPlayer(player, indexes) {
  const steam = normalize(player.steam_id);
  if (steam && indexes.bySteam.has(steam)) return indexes.bySteam.get(steam);
  const key = normalize(player.player_key);
  if (key && indexes.byKey.has(key)) return indexes.byKey.get(key);
  const name = normalize(player.name);
  if (name && indexes.byName.has(name)) return indexes.byName.get(name);
  return null;
}

function playerIdentity(row, nameField = 'name') {
  const steam = normalize(row.steam_id);
  if (steam) return `steam:${steam}`;
  return `name:${normalize(row[nameField])}`;
}

function seriesId(matchId) {
  return clean(matchId).replace(/-G\d+$/, '');
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function teamGameCounts(scheduleRows) {
  const counts = new Map();
  for (const row of scheduleRows) {
    counts.set(row.home_team_id, (counts.get(row.home_team_id) || 0) + 1);
    counts.set(row.away_team_id, (counts.get(row.away_team_id) || 0) + 1);
  }
  return counts;
}

function chooseLines(lambda, targets, dispersion) {
  const candidates = [];
  for (let requiredGoals = 1; requiredGoals <= 18; requiredGoals += 1) {
    candidates.push({
      requiredGoals,
      line: requiredGoals - 0.5,
      probability: negativeBinomialAtLeast(lambda, dispersion, requiredGoals)
    });
  }

  const selected = [];
  let minimumGoals = 1;
  for (const target of targets) {
    const eligible = candidates.filter(candidate => candidate.requiredGoals >= minimumGoals);
    const choice = [...eligible].sort((a, b) =>
      Math.abs(a.probability - target) - Math.abs(b.probability - target) ||
      a.requiredGoals - b.requiredGoals
    )[0];
    selected.push(choice);
    minimumGoals = choice.requiredGoals + 1;
  }
  return selected;
}

async function buildChronologicalDataset() {
  const [s1Players, s1Schedule, s2Players, s2Schedule, s2Boxscores] = await Promise.all([
    readCsvFile('data/S1/players.csv'),
    readCsvFile('data/S1/schedule.csv'),
    readCsvFile('data/S2/players.csv'),
    readCsvFile('data/S2/schedule.csv'),
    readCsvFile('data/S2/boxscores.csv')
  ]);

  const s1Indexes = buildIndexes(s1Players);
  const s1TeamGames = teamGameCounts(
    s1Schedule.filter(row => clean(row.stage).toLowerCase() === 'reg')
  );
  const s1Skaters = s1Players.filter(player => n(player.gp_s) > 0);
  const leagueGoalRate = s1Skaters.reduce((sum, player) => sum + n(player.g), 0) /
    Math.max(1, s1Skaters.reduce((sum, player) => sum + n(player.gp_s), 0));

  const boxscoreByMatch = new Map();
  for (const row of s2Boxscores) {
    if (!boxscoreByMatch.has(row.match_id)) boxscoreByMatch.set(row.match_id, []);
    boxscoreByMatch.get(row.match_id).push(row);
  }

  const cumulative = new Map();
  const cumulativeTeamGames = new Map();
  const observations = [];

  for (let week = 1; week <= 9; week += 1) {
    const weekRows = s2Schedule.filter(row =>
      n(row.week) === week && clean(row.stage).toLowerCase() === 'reg'
    );
    const grouped = new Map();
    for (const row of weekRows) {
      const id = seriesId(row.match_id);
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(row);
    }

    for (const [id, games] of grouped) {
      const teams = [games[0].home_team_id, games[0].away_team_id];
      for (const teamId of teams) {
        const roster = s2Players.filter(player =>
          player.team_id === teamId && isSkater(player.position)
        );
        for (const player of roster) {
          const identity = playerIdentity(player);
          const prior = findPlayer(player, s1Indexes);
          const current = cumulative.get(identity) || { appearances: 0, goals: 0 };
          let actualGoals = 0;
          let actualAppearances = 0;

          for (const game of games) {
            const row = (boxscoreByMatch.get(game.match_id) || []).find(box =>
              box.team_id === teamId &&
              isSkater(box.position) &&
              (
                (normalize(player.steam_id) && normalize(box.steam_id) === normalize(player.steam_id)) ||
                normalize(box.player_name) === normalize(player.name)
              )
            );
            if (!row) continue;
            actualAppearances += 1;
            actualGoals += n(row.g);
          }

          const historicalGames = n(prior?.gp_s);
          const historicalGoals = n(prior?.g);
          const historicalTeamGames = prior
            ? n(s1TeamGames.get(prior.team_id))
            : 0;

          observations.push({
            week,
            seriesId: id,
            player: player.name,
            teamId,
            historicalGames,
            historicalGoals,
            historicalTeamGames,
            currentAppearances: current.appearances,
            currentGoals: current.goals,
            currentTeamGames: n(cumulativeTeamGames.get(teamId)),
            actualGoals,
            actualAppearances,
            leagueGoalRate
          });
        }
      }
    }

    for (const row of weekRows) {
      for (const teamId of [row.home_team_id, row.away_team_id]) {
        cumulativeTeamGames.set(teamId, (cumulativeTeamGames.get(teamId) || 0) + 1);
      }
      for (const box of boxscoreByMatch.get(row.match_id) || []) {
        if (!isSkater(box.position)) continue;
        const identity = playerIdentity(box, 'player_name');
        const current = cumulative.get(identity) || { appearances: 0, goals: 0 };
        current.appearances += 1;
        current.goals += n(box.g);
        cumulative.set(identity, current);
      }
    }
  }

  return observations;
}

function evaluateConfiguration(observations, config) {
  const tierRows = [[], [], []];

  for (const row of observations) {
    const historicalRate = row.historicalGames > 0
      ? row.historicalGoals / row.historicalGames
      : row.leagueGoalRate;
    const appearancePrior = row.historicalTeamGames > 0
      ? row.historicalGames / row.historicalTeamGames
      : 0.85;
    const goalRate = (
      config.priorGames * historicalRate + row.currentGoals
    ) / (
      config.priorGames + row.currentAppearances
    );
    const appearanceRate = (
      config.appearancePrior * appearancePrior + row.currentAppearances
    ) / (
      config.appearancePrior + row.currentTeamGames
    );
    const lambda = Math.max(0.01, 3 * goalRate * appearanceRate);
    const lines = chooseLines(lambda, config.targets, config.dispersion);

    lines.forEach((line, index) => {
      tierRows[index].push({
        probability: line.probability,
        outcome: row.actualGoals >= line.requiredGoals ? 1 : 0,
        line: line.line,
        actualGoals: row.actualGoals
      });
    });
  }

  const tiers = tierRows.map(rows => ({
    count: rows.length,
    predicted: average(rows.map(row => row.probability)),
    actual: average(rows.map(row => row.outcome)),
    brier: average(rows.map(row => (row.probability - row.outcome) ** 2)),
    averageLine: average(rows.map(row => row.line)),
    lineOneOrLower: average(rows.map(row => row.line <= 1.5 ? 1 : 0))
  }));

  const calibrationError = average(tiers.map((tier, index) =>
    Math.abs(tier.actual - config.targets[index])
  ));
  const predictionError = average(tiers.map(tier =>
    Math.abs(tier.actual - tier.predicted)
  ));
  const score = calibrationError + predictionError;
  return { ...config, tiers, score, calibrationError, predictionError };
}

const observations = await buildChronologicalDataset();
const results = [];

for (const priorGames of PRIOR_GAMES) {
  for (const appearancePrior of APPEARANCE_PRIORS) {
    for (const dispersion of DISPERSIONS) {
      for (const base of BASE_TARGETS) {
        for (const big of BIG_TARGETS) {
          for (const legendary of LEGENDARY_TARGETS) {
            if (!(base > big && big > legendary)) continue;
            results.push(evaluateConfiguration(observations, {
              priorGames,
              appearancePrior,
              dispersion,
              targets: [base, big, legendary]
            }));
          }
        }
      }
    }
  }
}

results.sort((a, b) => a.score - b.score);

console.log('WCPL S2 Player Series Goals Calibration');
console.log(`${observations.length} chronological player-series observations.`);
console.log('');
console.log('Rank Prior Appear Disp  Targets             Score  Tier  Predicted Actual  Avg line Brier');
results.slice(0, 20).forEach((result, rank) => {
  result.tiers.forEach((tier, index) => {
    console.log(
      `${index === 0 ? String(rank + 1).padStart(4) : '    '} ` +
      `${index === 0 ? String(result.priorGames).padStart(5) : '     '} ` +
      `${index === 0 ? String(result.appearancePrior).padStart(6) : '      '}  ` +
      `${index === 0 ? String(result.dispersion >= 1000 ? 'Pois' : result.dispersion).padStart(4) : '    '}  ` +
      `${index === 0 ? result.targets.map(value => `${Math.round(value * 100)}%`).join('/').padEnd(18) : '                  '} ` +
      `${index === 0 ? result.score.toFixed(3).padStart(5) : '     '}  ` +
      `${String(index + 1).padStart(4)}  ${String((tier.predicted * 100).toFixed(1) + '%').padStart(9)} ` +
      `${String((tier.actual * 100).toFixed(1) + '%').padStart(6)}  ` +
      `${tier.averageLine.toFixed(2).padStart(8)} ${tier.brier.toFixed(3).padStart(5)}`
    );
  });
});

console.log('');
console.log('Product-oriented ladders');
console.log('Targets             Prior Appear Disp  Tier  Predicted Actual  Avg line Brier');
for (const targets of [
  [0.4, 0.12, 0.025],
  [0.45, 0.15, 0.025],
  [0.5, 0.2, 0.04]
]) {
  const candidates = results
    .filter(result => result.targets.every((target, index) => target === targets[index]))
    .sort((a, b) => a.predictionError - b.predictionError || a.score - b.score);
  const result = candidates[0];
  result.tiers.forEach((tier, index) => {
    console.log(
      `${index === 0 ? targets.map(value => `${Math.round(value * 100)}%`).join('/').padEnd(19) : '                   '} ` +
      `${index === 0 ? String(result.priorGames).padStart(5) : '     '} ` +
      `${index === 0 ? String(result.appearancePrior).padStart(6) : '      '}  ` +
      `${index === 0 ? String(result.dispersion >= 1000 ? 'Pois' : result.dispersion).padStart(4) : '    '}  ` +
      `${String(index + 1).padStart(4)}  ${String((tier.predicted * 100).toFixed(1) + '%').padStart(9)} ` +
      `${String((tier.actual * 100).toFixed(1) + '%').padStart(6)}  ` +
      `${tier.averageLine.toFixed(2).padStart(8)} ${tier.brier.toFixed(3).padStart(5)}`
    );
  });
}

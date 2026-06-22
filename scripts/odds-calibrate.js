import { buildSeriesOddsRecommendations } from '../services/oddsRecommendations.js';
import { buildWeekSettlementResults } from '../services/settlement.js';

const XG_WEIGHTS = [0, 0.1, 0.2, 0.3];
const TEAM_PRIORS = [6, 9, 12, 15];
const PROBABILITY_SHRINKAGE = [0, 0.1, 0.2, 0.3];
const GOAL_CALIBRATIONS = [0, 0.25, 0.5, 0.75, 1];

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function evaluate(rows) {
  const brier = average(rows.map(row => (row.awayProbability - row.awayWon) ** 2));
  const logLoss = average(rows.map(row => {
    const p = Math.max(0.001, Math.min(0.999, row.awayProbability));
    return -(row.awayWon * Math.log(p) + (1 - row.awayWon) * Math.log(1 - p));
  }));
  const goalMae = average(rows.map(row => Math.abs(row.projectedGoals - row.actualGoals)));
  const goalBias = average(rows.map(row => row.actualGoals - row.projectedGoals));
  const overRate = average(rows.map(row => row.actualGoals > row.goalLine ? 1 : 0));
  const favoriteAccuracy = average(rows.map(row => row.favoriteWon ? 1 : 0));
  const favoriteConfidence = average(rows.map(row => row.favoriteProbability));

  // Brier and log loss are the core winner metrics. Goal MAE matters separately.
  // Small penalties discourage systematically one-sided O/U lines and overconfidence.
  const winnerScore =
    brier +
    0.08 * Math.max(0, logLoss - Math.log(2)) +
    0.15 * Math.abs(favoriteConfidence - favoriteAccuracy);
  const totalsScore =
    goalMae +
    0.75 * Math.abs(overRate - 0.5) +
    0.15 * Math.abs(goalBias);

  return {
    brier,
    logLoss,
    goalMae,
    goalBias,
    overRate,
    favoriteAccuracy,
    favoriteConfidence,
    winnerScore,
    totalsScore
  };
}

async function buildActualResults() {
  const byWeek = new Map();
  for (let week = 1; week <= 9; week += 1) {
    byWeek.set(week, await buildWeekSettlementResults({ seasonId: 'S2', week }));
  }
  return byWeek;
}

async function evaluateConfiguration(config, actualByWeek) {
  const rows = [];

  for (let week = 1; week <= 9; week += 1) {
    const report = await buildSeriesOddsRecommendations({
      seasonId: 'S2',
      targetWeek: week,
      ...config
    });
    const actual = actualByWeek.get(week);

    for (const recommendation of report.recommendations) {
      const result = actual.seriesResults[recommendation.seriesKey];
      if (!result?.complete) continue;

      const awayWon = result.winner_team_id === recommendation.awayTeamId ? 1 : 0;
      const awayProbability = recommendation.away.seriesWinProbability;
      const favoriteIsAway = awayProbability >= 0.5;

      rows.push({
        awayProbability,
        awayWon,
        favoriteProbability: Math.max(awayProbability, 1 - awayProbability),
        favoriteWon: favoriteIsAway ? Boolean(awayWon) : !awayWon,
        projectedGoals: recommendation.projectedSeriesGoals,
        actualGoals: result.total_goals,
        goalLine: recommendation.recommendedGoalLine
      });
    }
  }

  return { ...config, rows: rows.length, ...evaluate(rows) };
}

function printTable(title, rows) {
  console.log('');
  console.log(title);
  console.log('Rank  xG   Prior  Shrink  Goal+  Brier  LogLoss  GoalMAE  Bias   Over   FavConf/FavWin');
  rows.forEach((row, index) => {
    console.log(
      `${String(index + 1).padStart(4)}  ` +
      `${String(Math.round(row.xgWeight * 100) + '%').padStart(3)}  ` +
      `${String(row.teamPriorGames).padStart(5)}  ` +
      `${String(Math.round(row.probabilityShrinkage * 100) + '%').padStart(6)}  ` +
      `${row.goalCalibration.toFixed(2).padStart(5)}  ` +
      `${row.brier.toFixed(3).padStart(5)}  ` +
      `${row.logLoss.toFixed(3).padStart(7)}  ` +
      `${row.goalMae.toFixed(2).padStart(7)}  ` +
      `${row.goalBias.toFixed(2).padStart(5)}  ` +
      `${String((row.overRate * 100).toFixed(1) + '%').padStart(6)}  ` +
      `${String((row.favoriteConfidence * 100).toFixed(1) + '%').padStart(7)}/` +
      `${String((row.favoriteAccuracy * 100).toFixed(1) + '%').padStart(5)}`
    );
  });
}

const actualByWeek = await buildActualResults();
const results = [];
let completed = 0;
const total = XG_WEIGHTS.length * TEAM_PRIORS.length *
  PROBABILITY_SHRINKAGE.length * GOAL_CALIBRATIONS.length;

for (const xgWeight of XG_WEIGHTS) {
  for (const teamPriorGames of TEAM_PRIORS) {
    for (const probabilityShrinkage of PROBABILITY_SHRINKAGE) {
      for (const goalCalibration of GOAL_CALIBRATIONS) {
        results.push(await evaluateConfiguration({
          xgWeight,
          teamPriorGames,
          probabilityShrinkage,
          goalCalibration
        }, actualByWeek));
        completed += 1;
        if (completed % 40 === 0 || completed === total) {
          process.stderr.write(`Calibrated ${completed}/${total}\r`);
        }
      }
    }
  }
}
process.stderr.write('\n');

const byWinner = [...results].sort((a, b) =>
  a.winnerScore - b.winnerScore ||
  a.brier - b.brier ||
  a.logLoss - b.logLoss
);
const byTotals = [...results].sort((a, b) =>
  a.totalsScore - b.totalsScore ||
  a.goalMae - b.goalMae ||
  Math.abs(a.overRate - 0.5) - Math.abs(b.overRate - 0.5)
);

const bestWinnerScore = byWinner[0].winnerScore;
const bestTotalsScore = byTotals[0].totalsScore;
const byBalanced = [...results]
  .map(row => ({
    ...row,
    balancedScore:
      (row.winnerScore / bestWinnerScore) +
      (row.totalsScore / bestTotalsScore)
  }))
  .sort((a, b) =>
    a.balancedScore - b.balancedScore ||
    a.winnerScore - b.winnerScore
  );

console.log('WCPL S2 Series Model Calibration');
console.log(`${total} chronological configurations across 36 series.`);
printTable('Best winner-probability configurations', byWinner.slice(0, 10));
printTable('Best goal-total configurations', byTotals.slice(0, 10));
printTable('Best balanced configurations', byBalanced.slice(0, 12));


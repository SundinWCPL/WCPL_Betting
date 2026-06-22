import { buildSeriesOddsRecommendations } from '../services/oddsRecommendations.js';
import { buildWeekSettlementResults } from '../services/settlement.js';

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function brier(rows, probabilityKey, outcomeKey) {
  return average(rows.map(row => (row[probabilityKey] - row[outcomeKey]) ** 2));
}

function logLoss(rows, probabilityKey, outcomeKey) {
  return average(rows.map(row => {
    const probability = Math.max(0.001, Math.min(0.999, row[probabilityKey]));
    const outcome = row[outcomeKey];
    return -(outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability));
  }));
}

function calibration(rows, probabilityKey, outcomeKey, buckets) {
  return buckets.map(([label, min, max]) => {
    const matching = rows.filter(row =>
      row[probabilityKey] >= min && row[probabilityKey] < max
    );
    return {
      label,
      count: matching.length,
      predicted: average(matching.map(row => row[probabilityKey])),
      actual: average(matching.map(row => row[outcomeKey]))
    };
  }).filter(row => row.count);
}

function printCalibration(title, rows) {
  console.log('');
  console.log(title);
  console.log('Bucket       Count  Predicted  Actual');
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(12)} ${String(row.count).padStart(5)}  ` +
      `${pct(row.predicted).padStart(9)}  ${pct(row.actual).padStart(6)}`
    );
  }
}

const seriesRows = [];
const teamRows = [];

for (let week = 1; week <= 9; week += 1) {
  const [report, actual] = await Promise.all([
    buildSeriesOddsRecommendations({ seasonId: 'S2', targetWeek: week }),
    buildWeekSettlementResults({ seasonId: 'S2', week })
  ]);

  for (const recommendation of report.recommendations) {
    const result = actual.seriesResults[recommendation.seriesKey];
    if (!result?.complete) continue;

    const wasSweep = result.winner_wins === 3 && result.loser_wins === 0 ? 1 : 0;
    const was21 = result.winner_wins === 2 && result.loser_wins === 1 ? 1 : 0;
    const awayWon = result.winner_team_id === recommendation.awayTeamId ? 1 : 0;
    const homeWon = 1 - awayWon;

    seriesRows.push({
      week,
      predictedSweep:
        recommendation.away.sweepProbability +
        recommendation.home.sweepProbability,
      predicted21:
        recommendation.away.exact21Probability +
        recommendation.home.exact21Probability,
      wasSweep,
      was21
    });

    teamRows.push({
      week,
      side: recommendation.awayTeamId,
      predictedSweep: recommendation.away.sweepProbability,
      predicted21: recommendation.away.exact21Probability,
      swept: awayWon && wasSweep ? 1 : 0,
      won21: awayWon && was21 ? 1 : 0
    });
    teamRows.push({
      week,
      side: recommendation.homeTeamId,
      predictedSweep: recommendation.home.sweepProbability,
      predicted21: recommendation.home.exact21Probability,
      swept: homeWon && wasSweep ? 1 : 0,
      won21: homeWon && was21 ? 1 : 0
    });
  }
}

const actualSweepRate = average(seriesRows.map(row => row.wasSweep));
const predictedSweepRate = average(seriesRows.map(row => row.predictedSweep));
const actual21Rate = average(seriesRows.map(row => row.was21));
const predicted21Rate = average(seriesRows.map(row => row.predicted21));

console.log('WCPL S2 Scoreline Market Backtest');
console.log('Selected production configuration, evaluated chronologically.');
console.log('');
console.log('Series result distribution');
console.log(`Sweeps: predicted ${pct(predictedSweepRate)} · actual ${pct(actualSweepRate)}`);
console.log(`2–1:    predicted ${pct(predicted21Rate)} · actual ${pct(actual21Rate)}`);
console.log('');
console.log('Team-side market quality');
console.log(
  `Sweep Brier ${brier(teamRows, 'predictedSweep', 'swept').toFixed(3)} · ` +
  `LogLoss ${logLoss(teamRows, 'predictedSweep', 'swept').toFixed(3)}`
);
console.log(
  `2–1 Brier   ${brier(teamRows, 'predicted21', 'won21').toFixed(3)} · ` +
  `LogLoss ${logLoss(teamRows, 'predicted21', 'won21').toFixed(3)}`
);

printCalibration(
  'Sweep calibration by team-side probability',
  calibration(teamRows, 'predictedSweep', 'swept', [
    ['Under 10%', 0, 0.1],
    ['10–15%', 0.1, 0.15],
    ['15–20%', 0.15, 0.2],
    ['20%+', 0.2, 1.01]
  ])
);

printCalibration(
  '2–1 calibration by team-side probability',
  calibration(teamRows, 'predicted21', 'won21', [
    ['Under 30%', 0, 0.3],
    ['30–35%', 0.3, 0.35],
    ['35–40%', 0.35, 0.4],
    ['40%+', 0.4, 1.01]
  ])
);

console.log('');
console.log('Sweep correction-factor search');
console.log('Factor  Sweep Pred  Sweep Brier  2–1 Pred  2–1 Brier');
const factors = [];
for (let factor = 0.6; factor <= 1.8 + 0.0001; factor += 0.05) {
  const corrected = teamRows.map(row => {
    const correctedSweep = Math.max(0, Math.min(row.predictedSweep * factor, 0.95));
    const moved = correctedSweep - row.predictedSweep;
    const corrected21 = Math.max(0, Math.min(row.predicted21 - moved, 0.95));
    return { ...row, correctedSweep, corrected21 };
  });
  factors.push({
    factor,
    sweepPred: average(corrected.map(row => row.correctedSweep)) * 2,
    sweepBrier: brier(corrected, 'correctedSweep', 'swept'),
    pred21: average(corrected.map(row => row.corrected21)) * 2,
    brier21: brier(corrected, 'corrected21', 'won21')
  });
}

factors
  .sort((a, b) =>
    (a.sweepBrier + a.brier21) - (b.sweepBrier + b.brier21)
  )
  .slice(0, 10)
  .forEach(row => {
    console.log(
      `${row.factor.toFixed(2).padStart(6)}  ${pct(row.sweepPred).padStart(10)}  ` +
      `${row.sweepBrier.toFixed(3).padStart(11)}  ${pct(row.pred21).padStart(8)}  ` +
      `${row.brier21.toFixed(3).padStart(9)}`
    );
  });


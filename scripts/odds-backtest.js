import { buildSeriesOddsRecommendations } from '../services/oddsRecommendations.js';
import { buildWeekSettlementResults } from '../services/settlement.js';

const variants = [
  { key: 'goals-only', label: 'Goals only', xgWeight: 0, teamPriorGames: 6, detailed: false },
  { key: 'ten-xg', label: '10% xG / 90% goals', xgWeight: 0.1, teamPriorGames: 6, detailed: false },
  { key: 'low-xg', label: '20% xG / 80% goals', xgWeight: 0.2, teamPriorGames: 6, detailed: true },
  { key: 'forty-xg', label: '40% xG / 60% goals', xgWeight: 0.4, teamPriorGames: 6, detailed: false },
  { key: 'prior-three', label: '20% xG · 3-game prior', xgWeight: 0.2, teamPriorGames: 3, detailed: false },
  { key: 'prior-nine', label: '20% xG · 9-game prior', xgWeight: 0.2, teamPriorGames: 9, detailed: false },
  { key: 'prior-twelve', label: '20% xG · 12-game prior', xgWeight: 0.2, teamPriorGames: 12, detailed: false }
];

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pct(value) {
  return `${(100 * value).toFixed(1)}%`;
}

function evaluateRows(rows) {
  const brier = average(rows.map(row => (row.awayProbability - row.awayWon) ** 2));
  const logLoss = average(rows.map(row => {
    const p = Math.max(0.001, Math.min(0.999, row.awayProbability));
    return -(row.awayWon * Math.log(p) + (1 - row.awayWon) * Math.log(1 - p));
  }));
  const favoriteAccuracy = average(rows.map(row => row.favoriteWon ? 1 : 0));
  const goalMae = average(rows.map(row => Math.abs(row.projectedGoals - row.actualGoals)));
  const goalBias = average(rows.map(row => row.actualGoals - row.projectedGoals));
  const lineOverRate = average(rows.map(row => row.actualGoals > row.goalLine ? 1 : 0));
  const lineDistance = average(rows.map(row => Math.abs(row.actualGoals - row.goalLine)));

  return {
    series: rows.length,
    brier,
    logLoss,
    favoriteAccuracy,
    goalMae,
    goalBias,
    lineOverRate,
    lineDistance
  };
}

function calibrationRows(rows) {
  const buckets = [
    { label: '50–55%', min: 0.5, max: 0.55 },
    { label: '55–60%', min: 0.55, max: 0.6 },
    { label: '60–70%', min: 0.6, max: 0.7 },
    { label: '70%+', min: 0.7, max: 1.01 }
  ];

  return buckets.map(bucket => {
    const matches = rows.filter(row =>
      row.favoriteProbability >= bucket.min && row.favoriteProbability < bucket.max
    );
    return {
      bucket: bucket.label,
      count: matches.length,
      predicted: average(matches.map(row => row.favoriteProbability)),
      actual: average(matches.map(row => row.favoriteWon ? 1 : 0))
    };
  }).filter(row => row.count);
}

async function runVariant(variant) {
  const rows = [];
  const weekly = [];

  for (let week = 1; week <= 9; week += 1) {
    const [report, results] = await Promise.all([
      buildSeriesOddsRecommendations({
        seasonId: 'S2',
        targetWeek: week,
        xgWeight: variant.xgWeight,
        teamPriorGames: variant.teamPriorGames
      }),
      buildWeekSettlementResults({ seasonId: 'S2', week })
    ]);

    const weekRows = [];
    for (const recommendation of report.recommendations) {
      const result = results.seriesResults[recommendation.seriesKey];
      if (!result?.complete) continue;

      const awayWon = result.winner_team_id === recommendation.awayTeamId ? 1 : 0;
      const awayProbability = recommendation.away.seriesWinProbability;
      const favoriteIsAway = awayProbability >= 0.5;
      const favoriteProbability = Math.max(awayProbability, 1 - awayProbability);
      const favoriteWon = favoriteIsAway ? Boolean(awayWon) : !awayWon;

      weekRows.push({
        week,
        seriesKey: recommendation.seriesKey,
        awayProbability,
        awayWon,
        favoriteProbability,
        favoriteWon,
        projectedGoals: recommendation.projectedSeriesGoals,
        actualGoals: result.total_goals,
        goalLine: recommendation.recommendedGoalLine
      });
    }

    rows.push(...weekRows);
    weekly.push({ week, ...evaluateRows(weekRows) });
  }

  return {
    ...variant,
    rows,
    weekly,
    overall: evaluateRows(rows),
    calibration: calibrationRows(rows)
  };
}

const reports = [];
for (const variant of variants) reports.push(await runVariant(variant));

console.log('WCPL S2 Chronological Series Odds Backtest');
console.log('Each week uses only S1 history and S2 results from earlier weeks.');
console.log('');
console.log('Overall');
console.log('Model                    Series  Brier   LogLoss  Fav Win  Goal MAE  Bias   O/U Over');
console.log(
  `${'Neutral 50/50 baseline'.padEnd(24)} ${String(36).padStart(6)}  ` +
  `${'0.250'.padStart(5)}   ${Math.log(2).toFixed(3).padStart(7)}  ` +
  `${'—'.padStart(7)}  ${'—'.padStart(8)}  ${'—'.padStart(5)}  ${'—'.padStart(8)}`
);
for (const report of reports) {
  const m = report.overall;
  console.log(
    `${report.label.padEnd(24)} ${String(m.series).padStart(6)}  ` +
    `${m.brier.toFixed(3).padStart(5)}   ${m.logLoss.toFixed(3).padStart(7)}  ` +
    `${pct(m.favoriteAccuracy).padStart(7)}  ${m.goalMae.toFixed(2).padStart(8)}  ` +
    `${m.goalBias.toFixed(2).padStart(5)}  ${pct(m.lineOverRate).padStart(8)}`
  );
}

for (const report of reports) {
  if (!report.detailed) continue;
  console.log('');
  console.log(`${report.label} · Week by week`);
  console.log('Week  Series  Brier  Fav Win  Goal MAE  O/U Over');
  for (const row of report.weekly) {
    console.log(
      `${String(row.week).padStart(4)}  ${String(row.series).padStart(6)}  ` +
      `${row.brier.toFixed(3).padStart(5)}  ${pct(row.favoriteAccuracy).padStart(7)}  ` +
      `${row.goalMae.toFixed(2).padStart(8)}  ${pct(row.lineOverRate).padStart(8)}`
    );
  }

  console.log('');
  console.log(`${report.label} · Favorite calibration`);
  console.log('Bucket    Count  Predicted  Actual');
  for (const row of report.calibration) {
    console.log(
      `${row.bucket.padEnd(8)} ${String(row.count).padStart(5)}  ` +
      `${pct(row.predicted).padStart(9)}  ${pct(row.actual).padStart(6)}`
    );
  }
}

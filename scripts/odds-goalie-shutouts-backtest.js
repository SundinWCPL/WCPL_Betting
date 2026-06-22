import { buildGoalieShutoutRecommendations } from '../services/goalieShutoutRecommendations.js';
import { buildWeekSettlementResults } from '../services/settlement.js';

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

const rows = [];

for (let week = 1; week <= 9; week += 1) {
  const [report, actual] = await Promise.all([
    buildGoalieShutoutRecommendations({
      seasonId: 'S2',
      divisionId: 'ALL',
      targetWeek: week
    }),
    buildWeekSettlementResults({ seasonId: 'S2', week })
  ]);
  const details = actual.propResults.ALL?.shutout?.series_counts || {};

  for (const goalie of report.recommendations) {
    const targetSeriesId = goalie.seriesKey.replace(/^ALL-/, '');
    const count = Number(
      (details[goalie.playerKey] || [])
        .find(item => item.series_id === targetSeriesId)?.count || 0
    );
    for (const quantity of [1, 2, 3]) {
      rows.push({
        quantity,
        probability: goalie.probabilities[quantity],
        outcome: count >= quantity ? 1 : 0
      });
    }
  }
}

console.log('WCPL S2 Matchup-Specific Goalie Shutout Backtest');
console.log('Quantity  Samples  Predicted  Actual   Brier');
for (const quantity of [1, 2, 3]) {
  const matching = rows.filter(row => row.quantity === quantity);
  const predicted = average(matching.map(row => row.probability));
  const actual = average(matching.map(row => row.outcome));
  const brier = average(matching.map(row =>
    (row.probability - row.outcome) ** 2
  ));
  console.log(
    `${String(quantity).padStart(8)}  ${String(matching.length).padStart(7)}  ` +
    `${`${(predicted * 100).toFixed(2)}%`.padStart(9)}  ` +
    `${`${(actual * 100).toFixed(2)}%`.padStart(7)}  ${brier.toFixed(3).padStart(6)}`
  );
}

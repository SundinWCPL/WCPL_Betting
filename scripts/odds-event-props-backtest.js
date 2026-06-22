import { buildEventPropRecommendations } from '../services/eventPropRecommendations.js';
import { buildWeekSettlementResults } from '../services/settlement.js';

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function pct(value) {
  return `${(100 * value).toFixed(2)}%`;
}

function summarize(rows) {
  return {
    rows: rows.length,
    predicted: average(rows.map(row => row.probability)),
    actual: average(rows.map(row => row.outcome)),
    brier: average(rows.map(row => (row.probability - row.outcome) ** 2))
  };
}

const rows = [];

for (let week = 1; week <= 9; week += 1) {
  const [report, actual] = await Promise.all([
    buildEventPropRecommendations({
      seasonId: 'S2',
      divisionId: 'ALL',
      targetWeek: week
    }),
    buildWeekSettlementResults({ seasonId: 'S2', week })
  ]);
  const division = actual.propResults.ALL;

  for (const player of report.recommendations) {
    if (player.hatTrick) {
      const count = Number(division?.hat_trick?.best_series_counts?.[player.playerKey] || 0);
      for (const quantity of [1, 2, 3]) {
        rows.push({
          week,
          market: 'hat_trick',
          quantity,
          player: player.playerName,
          probability: player.hatTrick.probabilities[quantity],
          outcome: count >= quantity ? 1 : 0
        });
      }
    }

    if (player.shutout) {
      const count = Number(division?.shutout?.best_series_counts?.[player.playerKey] || 0);
      for (const quantity of [1, 2, 3]) {
        rows.push({
          week,
          market: 'shutout',
          quantity,
          player: player.playerName,
          probability: player.shutout.probabilities[quantity],
          outcome: count >= quantity ? 1 : 0
        });
      }
    }
  }
}

console.log('WCPL S2 Individual Event Prop Backtest');
console.log('Chronological: S1 history plus S2 results from prior weeks only.');
console.log('');
console.log('Market       Qty  Player-series  Predicted  Actual   Brier  Current odds  Fair-ish odds');

for (const market of ['hat_trick', 'shutout']) {
  for (const quantity of [1, 2, 3]) {
    const matching = rows.filter(row =>
      row.market === market && row.quantity === quantity
    );
    const summary = summarize(matching);
    const currentOdds = quantity === 1 ? 2 : quantity === 2 ? 8 : 25;
    const fairOdds = summary.actual > 0 ? 0.9 / summary.actual : Infinity;
    console.log(
      `${market.replace('_', ' ').padEnd(12)} ${String(quantity).padStart(3)}  ` +
      `${String(summary.rows).padStart(13)}  ${pct(summary.predicted).padStart(9)}  ` +
      `${pct(summary.actual).padStart(7)}  ${summary.brier.toFixed(3).padStart(6)}  ` +
      `${String(currentOdds.toFixed(1) + 'x').padStart(12)}  ` +
      `${(Number.isFinite(fairOdds) ? fairOdds.toFixed(1) + 'x' : 'N/A').padStart(13)}`
    );
  }
}

console.log('');
console.log('Hat trick probability buckets · quantity 1');
console.log('Bucket       Count  Predicted  Actual');
const hatRows = rows.filter(row => row.market === 'hat_trick' && row.quantity === 1);
for (const [label, min, max] of [
  ['Under 2%', 0, 0.02],
  ['2–5%', 0.02, 0.05],
  ['5–10%', 0.05, 0.1],
  ['10%+', 0.1, 1.01]
]) {
  const matching = hatRows.filter(row => row.probability >= min && row.probability < max);
  if (!matching.length) continue;
  console.log(
    `${label.padEnd(11)} ${String(matching.length).padStart(5)}  ` +
    `${pct(average(matching.map(row => row.probability))).padStart(9)}  ` +
    `${pct(average(matching.map(row => row.outcome))).padStart(7)}`
  );
}

console.log('');
console.log('Shutout probability buckets · quantity 1');
console.log('Bucket       Count  Predicted  Actual');
const shutoutRows = rows.filter(row => row.market === 'shutout' && row.quantity === 1);
for (const [label, min, max] of [
  ['Under 10%', 0, 0.1],
  ['10–20%', 0.1, 0.2],
  ['20–35%', 0.2, 0.35],
  ['35%+', 0.35, 1.01]
]) {
  const matching = shutoutRows.filter(row => row.probability >= min && row.probability < max);
  if (!matching.length) continue;
  console.log(
    `${label.padEnd(11)} ${String(matching.length).padStart(5)}  ` +
    `${pct(average(matching.map(row => row.probability))).padStart(9)}  ` +
    `${pct(average(matching.map(row => row.outcome))).padStart(7)}`
  );
}


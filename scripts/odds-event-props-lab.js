import { buildEventPropRecommendations } from '../services/eventPropRecommendations.js';

const week = Number(process.argv[2] || 2);
const divisions = ['D1', 'D2'];

console.log(`WCPL Individual Event Prop Lab · S3 Week ${week}`);
console.log('');

for (const divisionId of divisions) {
  const report = await buildEventPropRecommendations({
    seasonId: 'S3',
    divisionId,
    targetWeek: week
  });

  console.log(`${divisionId} Hat Tricks`);
  console.log('Player                 Team  Hist  P(1+)   Odds   P(2+)   Odds   P(3)    Odds');
  report.recommendations
    .filter(row => row.hatTrick)
    .sort((a, b) =>
      b.hatTrick.probabilities[1] - a.hatTrick.probabilities[1]
    )
    .forEach(row => {
      const p = row.hatTrick.probabilities;
      const o = row.hatTrick.recommendedOdds;
      console.log(
        `${row.playerName.slice(0, 21).padEnd(22)} ${row.teamId.padEnd(5)} ` +
        `${String(row.historicalSeasons.join('+') || 'none').padEnd(5)} ` +
        `${String((p[1] * 100).toFixed(1) + '%').padStart(6)} ${String(o[1].toFixed(1) + 'x').padStart(6)} ` +
        `${String((p[2] * 100).toFixed(2) + '%').padStart(7)} ${String(o[2].toFixed(1) + 'x').padStart(7)} ` +
        `${String((p[3] * 100).toFixed(3) + '%').padStart(7)} ${String(o[3].toFixed(1) + 'x').padStart(7)}`
      );
    });

  console.log('');
  console.log(`${divisionId} Shutouts`);
  console.log('Player                 Team  Hist  P(1+)   Odds   P(2+)   Odds   P(3)    Odds');
  report.recommendations
    .filter(row => row.shutout)
    .sort((a, b) =>
      b.shutout.probabilities[1] - a.shutout.probabilities[1]
    )
    .forEach(row => {
      const p = row.shutout.probabilities;
      const o = row.shutout.recommendedOdds;
      console.log(
        `${row.playerName.slice(0, 21).padEnd(22)} ${row.teamId.padEnd(5)} ` +
        `${String(row.historicalSeasons.join('+') || 'none').padEnd(5)} ` +
        `${String((p[1] * 100).toFixed(1) + '%').padStart(6)} ${String(o[1].toFixed(1) + 'x').padStart(6)} ` +
        `${String((p[2] * 100).toFixed(2) + '%').padStart(7)} ${String(o[2].toFixed(1) + 'x').padStart(7)} ` +
        `${String((p[3] * 100).toFixed(3) + '%').padStart(7)} ${String(o[3].toFixed(1) + 'x').padStart(7)}`
      );
    });
  console.log('-'.repeat(96));
}


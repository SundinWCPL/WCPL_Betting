import { buildGoalieShutoutRecommendations } from '../services/goalieShutoutRecommendations.js';

const week = Number(process.argv[2] || 2);

console.log(`WCPL Goalie Shutout Lab · S3 Week ${week}`);
console.log('');

for (const divisionId of ['D1', 'D2']) {
  const report = await buildGoalieShutoutRecommendations({
    seasonId: 'S3',
    divisionId,
    targetWeek: week
  });

  console.log(`${divisionId} Goalie Shutouts`);
  console.log('Goalie                 Matchup       Status  OppG  1+ Shutout         2+ Shutouts        3 Shutouts');
  report.recommendations
    .sort((a, b) => b.probabilities[1] - a.probabilities[1])
    .forEach(row => {
      const tier = quantity =>
        `${row.recommendedOdds[quantity].toFixed(1)}x (${(row.probabilities[quantity] * 100).toFixed(quantity === 1 ? 1 : 2)}%)`;
      console.log(
        `${row.playerName.slice(0, 21).padEnd(22)} ` +
        `${`${row.teamId}-${row.opponentTeamId}`.padEnd(13)} ` +
        `${(row.eligibility === 'manual_review' ? 'REVIEW' : 'AUTO').padEnd(7)} ` +
        `${row.opponentExpectedGoals.toFixed(2).padStart(4)}  ` +
        `${tier(1).padEnd(18)} ${tier(2).padEnd(18)} ${tier(3)}`
      );
    });
  console.log(`Excluded newcomers: ${report.excluded.length}`);
  console.log('-'.repeat(108));
}

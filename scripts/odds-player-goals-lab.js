import { buildPlayerGoalsRecommendations } from '../services/playerGoalsRecommendations.js';

const week = Number(process.argv[2] || 2);

console.log(`WCPL Player Goals Lab · S3 Week ${week}`);
console.log('');

for (const divisionId of ['D1', 'D2']) {
  const report = await buildPlayerGoalsRecommendations({
    seasonId: 'S3',
    divisionId,
    targetWeek: week
  });

  console.log(`${divisionId} Player Goals`);
  console.log('Player                 Matchup       Status  xGls  Over 1            Over 2            Over 3');
  report.recommendations
    .sort((a, b) => b.expectedGoals - a.expectedGoals)
    .forEach(row => {
      const [base, big, legendary] = row.tiers;
      const tier = value =>
        `O${value.line.toFixed(1)} ${value.odds.toFixed(1)}x (${(value.probability * 100).toFixed(1)}%)`;
      const matchup = `${row.teamId}-${row.opponentTeamId}`;
      const status = row.eligibility === 'manual_review' ? 'REVIEW' : 'AUTO';
      console.log(
        `${row.playerName.slice(0, 21).padEnd(22)} ` +
        `${matchup.padEnd(13)} ` +
        `${status.padEnd(7)} ` +
        `${row.expectedGoals.toFixed(2).padStart(4)}  ` +
        `${tier(base).padEnd(18)} ${tier(big).padEnd(18)} ${tier(legendary)}`
      );
    });
  console.log(`Excluded newcomers: ${report.excluded.length}`);
  console.log('-'.repeat(116));
}

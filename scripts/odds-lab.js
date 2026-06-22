import { buildSeriesOddsRecommendations } from '../services/oddsRecommendations.js';

const targetWeek = Number(process.argv[2] || 2);
const report = await buildSeriesOddsRecommendations({ targetWeek });

console.log(`WCPL Series Odds Lab · ${report.seasonId} Week ${report.targetWeek}`);
console.log(`Model: ${report.modelVersion}`);
console.log(
  `Baselines: ${report.baselines.goalsPerTeamGame.toFixed(2)} goals/team/game, ` +
  `${report.baselines.ppg.toFixed(3)} PPG, ${(report.baselines.savePct * 100).toFixed(1)} SV%`
);
console.log('');

for (const item of report.recommendations) {
  console.log(`${item.divisionId} · ${item.awayTeamName} at ${item.homeTeamName}`);
  console.log(
    `Projected series: ${item.awayTeamName} ${(item.away.seriesWinProbability * 100).toFixed(1)}% · ` +
    `${item.homeTeamName} ${(item.home.seriesWinProbability * 100).toFixed(1)}%`
  );
  console.log(
    `Expected goals/game: ${item.awayTeamName} ${item.awayExpectedGoalsPerGame.toFixed(2)} · ` +
    `${item.homeTeamName} ${item.homeExpectedGoalsPerGame.toFixed(2)}`
  );
  console.log('');
  console.log('                         Current   Suggested   Probability');
  console.log(
    `${item.awayTeamId.padEnd(8)} series win      2.0x      ${String(item.away.seriesWinOdds.toFixed(1) + 'x').padEnd(10)} ` +
    `${(item.away.seriesWinProbability * 100).toFixed(1)}%`
  );
  console.log(
    `${item.awayTeamId.padEnd(8)} wins 2-1        3.0x      ${String(item.away.exact21Odds.toFixed(1) + 'x').padEnd(10)} ` +
    `${(item.away.exact21Probability * 100).toFixed(1)}%`
  );
  console.log(
    `${item.awayTeamId.padEnd(8)} sweep 3-0       4.0x      ${String(item.away.sweepOdds.toFixed(1) + 'x').padEnd(10)} ` +
    `${(item.away.sweepProbability * 100).toFixed(1)}%`
  );
  console.log(
    `${item.homeTeamId.padEnd(8)} series win      2.0x      ${String(item.home.seriesWinOdds.toFixed(1) + 'x').padEnd(10)} ` +
    `${(item.home.seriesWinProbability * 100).toFixed(1)}%`
  );
  console.log(
    `${item.homeTeamId.padEnd(8)} wins 2-1        3.0x      ${String(item.home.exact21Odds.toFixed(1) + 'x').padEnd(10)} ` +
    `${(item.home.exact21Probability * 100).toFixed(1)}%`
  );
  console.log(
    `${item.homeTeamId.padEnd(8)} sweep 3-0       4.0x      ${String(item.home.sweepOdds.toFixed(1) + 'x').padEnd(10)} ` +
    `${(item.home.sweepProbability * 100).toFixed(1)}%`
  );
  console.log(
    `Goal total: 10.5 → ${item.recommendedGoalLine.toFixed(1)} ` +
    `(projected ${item.projectedSeriesGoals.toFixed(1)}, ` +
    `over ${(item.projectedOverProbability * 100).toFixed(1)}%, boost ${item.goalTotalBoost.toFixed(1)}x)`
  );
  console.log(
    `Confidence: ${item.confidence} · Historical roster coverage: ` +
    `${item.awayTeamId} ${(item.evidence.awayHistoryCoverage * 100).toFixed(0)}%, ` +
    `${item.homeTeamId} ${(item.evidence.homeHistoryCoverage * 100).toFixed(0)}% · ` +
    `S3 games: ${item.evidence.awayCurrentGames}/${item.evidence.homeCurrentGames}`
  );
  console.log('-'.repeat(88));
}

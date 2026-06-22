import { getUpcomingSeries } from './wcplData.js';
import { buildPlayerGoalsRecommendations } from './playerGoalsRecommendations.js';
import { buildGoalieShutoutRecommendations } from './goalieShutoutRecommendations.js';

function marketKey(seriesKey, category, playerKey) {
  return `${seriesKey}|${category}|${playerKey}`;
}

function tierFavoriteScore(tiers, category) {
  const baselines = category === 'shutout' ? [4, 10, 25] : [3, 8, 15];
  const values = (tiers || [])
    .map((tier, index) => Number(tier.multiplier || 0) / baselines[index])
    .filter(value => value > 0);
  return values.length
    ? baselines[0] * (
      values.reduce((product, value) => product * value, 1) ** (1 / values.length)
    )
    : Number.POSITIVE_INFINITY;
}

export async function buildWeeklyPropMarkets({
  seasonId = 'S3',
  week,
  odds = {},
  publishedOnly = false
}) {
  const series = await getUpcomingSeries(week, seasonId);
  const divisionIds = [...new Set(series.map(item => item.division_id))];
  const reports = await Promise.all(divisionIds.map(async divisionId => {
    const [skaters, goalies] = await Promise.all([
      buildPlayerGoalsRecommendations({ seasonId, divisionId, targetWeek: week }),
      buildGoalieShutoutRecommendations({ seasonId, divisionId, targetWeek: week })
    ]);
    return { divisionId, skaters, goalies };
  }));

  const seriesByKey = new Map(series.map(item => [item.series_key, item]));
  const saved = odds.seriesProps || {};
  const markets = [];

  for (const report of reports) {
    for (const recommendation of report.skaters.recommendations) {
      const key = marketKey(
        recommendation.seriesKey,
        'player_goals',
        recommendation.playerKey
      );
      const stored = saved[key];
      if (publishedOnly && (!stored || stored.enabled === false)) continue;
      markets.push({
        marketKey: key,
        seriesKey: recommendation.seriesKey,
        divisionId: report.divisionId,
        category: 'player_goals',
        title: 'Player Goals',
        playerKey: recommendation.playerKey,
        playerName: recommendation.playerName,
        playerTeamId: recommendation.teamId,
        opponentTeamId: recommendation.opponentTeamId,
        eligibility: recommendation.eligibility,
        enabled: stored ? stored.enabled !== false : recommendation.eligibility === 'automatic',
        expectedValue: recommendation.expectedGoals,
        careerRate: recommendation.careerGoalsPerGame,
        currentRate: recommendation.currentGoalsPerGame,
        rateLabel: 'GPG',
        careerSample: recommendation.careerGames,
        currentSample: recommendation.currentAppearances,
        currentTiers: stored?.tiers || null,
        tiers: (publishedOnly && stored?.tiers ? stored.tiers : recommendation.tiers.map(tier => ({
          quantity: tier.tier,
          label: tier.label,
          line: tier.line,
          multiplier: tier.odds
        })))
      });
    }

    for (const recommendation of report.goalies.recommendations) {
      const key = marketKey(
        recommendation.seriesKey,
        'shutout',
        recommendation.playerKey
      );
      const stored = saved[key];
      if (publishedOnly && (!stored || stored.enabled === false)) continue;
      markets.push({
        marketKey: key,
        seriesKey: recommendation.seriesKey,
        divisionId: report.divisionId,
        category: 'shutout',
        title: 'Goalie Shutouts',
        playerKey: recommendation.playerKey,
        playerName: recommendation.playerName,
        playerTeamId: recommendation.teamId,
        opponentTeamId: recommendation.opponentTeamId,
        eligibility: recommendation.eligibility,
        enabled: stored ? stored.enabled !== false : recommendation.eligibility === 'automatic',
        expectedValue: recommendation.probabilities[1],
        careerRate: recommendation.careerShutoutRate,
        currentRate: recommendation.currentShutoutRate,
        rateLabel: 'SO/game',
        careerSample: recommendation.careerAppearances,
        currentSample: recommendation.currentAppearances,
        currentTiers: stored?.tiers || null,
        tiers: (publishedOnly && stored?.tiers ? stored.tiers : [1, 2, 3].map(quantity => ({
          quantity,
          label: quantity === 1 ? '1 Shutout' : `${quantity} Shutouts`,
          line: quantity,
          multiplier: recommendation.recommendedOdds[quantity]
        })))
      });
    }
  }

  return markets.map(market => {
    const matchup = seriesByKey.get(market.seriesKey);
    return {
      ...market,
      divisionName: matchup?.division_name || market.divisionId,
      awayTeamName: matchup?.away_team_name || '',
      homeTeamName: matchup?.home_team_name || '',
      matchupLabel: matchup
        ? `${matchup.away_team_name} at ${matchup.home_team_name}`
        : market.seriesKey
    };
  });
}

export function propMarketsToBettingBoards(markets, divisionBoards, currentBets = {}) {
  const boards = divisionBoards.map(board => ({
    ...board,
    categories: board.categories.filter(category =>
      ['top_scorer', 'top_goalie'].includes(category.category)
    )
  }));
  const boardByDivision = new Map(boards.map(board => [board.division_id, board]));
  const grouped = new Map();

  for (const market of markets) {
    const key = `${market.divisionId}|${market.category}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        prop_key: key,
        series_key: '',
        category: market.category,
        title: market.title,
        description: market.category === 'player_goals'
          ? 'Choose one player–series matchup and goals line.'
          : 'Choose one goalie–series matchup and shutout line.',
        quantity_options: [
          { quantity: 1, label: 'Tier 1', multiplier: 1 },
          { quantity: 2, label: 'Tier 2', multiplier: 1 },
          { quantity: 3, label: 'Tier 3', multiplier: 1 }
        ],
        players: [],
        currentBet: currentBets[key] || null
      });
    }
    const favoriteScore = tierFavoriteScore(market.tiers, market.category);
    grouped.get(key).players.push({
      selection_key: market.marketKey,
      series_key: market.seriesKey,
      player_key: market.playerKey,
      display_name: market.playerName,
      option_label: `${market.playerName} - ${favoriteScore.toFixed(1)}x (vs ${market.opponentTeamId})`,
      favorite_score: favoriteScore,
      player_name: market.playerName,
      team_id: market.playerTeamId,
      prop_quantity_multipliers: Object.fromEntries(
        market.tiers.map(tier => [tier.quantity, tier.multiplier])
      ),
      prop_quantity_labels: Object.fromEntries(
        market.tiers.map(tier => [
          tier.quantity,
          market.category === 'player_goals'
            ? `Over ${Number(tier.line).toFixed(1)} Goals`
            : tier.label
        ])
      ),
      prop_quantity_lines: Object.fromEntries(
        market.tiers.map(tier => [tier.quantity, tier.line])
      )
    });
  }

  for (const category of grouped.values()) {
    category.players.sort((a, b) =>
      Number(a.favorite_score) - Number(b.favorite_score) ||
      String(a.display_name).localeCompare(String(b.display_name))
    );
    const board = boardByDivision.get(category.prop_key.split('|')[0]);
    if (board) board.categories.push(category);
  }
  return boards;
}

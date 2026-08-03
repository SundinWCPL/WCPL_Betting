const WEEKLY_LEADER_PROP_CATEGORIES = new Set(['top_scorer', 'top_goalie']);

const cleanSet = values => new Set(
  (Array.isArray(values) ? values : [values])
    .map(value => String(value || '').trim())
    .filter(Boolean)
);

export function shouldVoidBetForSeries(bet, { seriesKey, teamIds = [], playerKeys = [], weeklyLeaderPlayerKeysWithOtherSeries = [] }) {
  const cleanSeriesKey = String(seriesKey || '').trim();
  const betKind = bet.bet_kind || 'series';

  if (betKind === 'series') {
    return String(bet.series_key || '').trim() === cleanSeriesKey;
  }

  if (betKind !== 'prop') return false;

  const betSeriesKey = String(bet.series_key || '').trim();
  if (betSeriesKey) return betSeriesKey === cleanSeriesKey;

  if (WEEKLY_LEADER_PROP_CATEGORIES.has(String(bet.prop_category || ''))) {
    const protectedPlayers = cleanSet(weeklyLeaderPlayerKeysWithOtherSeries);
    if (protectedPlayers.has(String(bet.player_key || '').trim())) return false;
  }

  const teamSet = cleanSet(teamIds);
  const playerSet = cleanSet(playerKeys);
  return teamSet.has(String(bet.player_team_id || bet.team_id || '').trim()) ||
    playerSet.has(String(bet.player_key || '').trim());
}

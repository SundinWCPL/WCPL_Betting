import { withTransaction } from '../postgres.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';
import { zonedDateKey } from '../../services/zonedTime.js';

const DAILY = {
  score_200: { title: 'Light the Lamp', description: 'Score at least 200 total FP in one completed WUT match.', target: 1 },
  win_no_boost: { title: 'All Natural', description: 'Win a WUT match without using a boost.', target: 1 },
  use_boost: { title: 'Extra Juice', description: 'Use a boost in a completed WUT match.', target: 1 },
  three_seasons: { title: 'Across the Eras', description: 'Complete a WUT match using cards from three different seasons.', target: 1 },
  five_teams: { title: 'League Tour', description: 'Complete a WUT match using five different teams.', target: 1 },
  trigger_trinket: { title: 'Pocket Magic', description: 'Trigger a trinket effect in a completed WUT match.', target: 1 },
  slots_five: { title: 'Five Spins', description: 'Complete five slot spins today.', target: 5 },
  slots_win: { title: 'Winner on the Reels', description: 'Hit any paying slots result today.', target: 1 },
  puckiq_complete: { title: 'Read the Release', description: 'Complete one PuckIQ run today.', target: 1 },
  horse_two: { title: 'At the Track', description: 'Have wagers locked on two horse races today.', target: 2 },
  horse_win: { title: 'Photo Finish', description: 'Win a settled horse-racing wager today.', target: 1 }
};

const WEEKLY = {
  wager_500: { title: 'Action Across the Board', description: 'Have 500 Mushybux committed when sportsbook betting locks.', target: 500, requiresLock: true },
  every_division: { title: 'Division Tour', description: 'Have at least 25 Mushybux wagered in every active division when betting locks.', target: 1, requiresLock: true },
  six_teams: { title: 'No Home Team', description: 'Back six different teams before sportsbook betting locks.', target: 6, requiresLock: true },
  mixed_markets: { title: 'Market Mixer', description: 'Have five series bets and five prop bets locked in.', target: 10, requiresLock: true },
  five_winners: { title: 'Winning Tickets', description: 'Settle five winning sportsbook wagers this week.', target: 5 },
  three_x_winner: { title: 'Long Shot', description: 'Win a sportsbook wager paying at least 3×.', target: 1 },
  puckiq_five: { title: 'PuckIQ Regular', description: 'Complete all five available PuckIQ runs this week.', target: 5 },
  slots_twenty_five: { title: 'Reel Regular', description: 'Complete 25 slot spins this week.', target: 25 }
};

const seededIndex = (text, length) => {
  let hash = 2166136261;
  for (const char of String(text)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return length ? (hash >>> 0) % length : 0;
};

const publicMission = (period, id, title, description, reward, progress, target, claimed, rotating = false) => {
  const cleanProgress = Math.max(0, Number(progress || 0));
  const cleanTarget = Math.max(1, Number(target || 1));
  return { period, id, title, description, reward: Number(reward || 0), progress: Math.min(cleanProgress, cleanTarget), target: cleanTarget,
    percent: Math.min(100, Math.round(cleanProgress / cleanTarget * 100)), complete: cleanProgress >= cleanTarget,
    claimed: Boolean(claimed), rotating };
};

async function ensurePeriod(client, userId, period, key, eligible, now) {
  const result = await client.query(`
    SELECT record_key,data FROM card_records WHERE collection='mission_periods' AND user_id=$1
      AND data->>'period'=$2 AND data->>'key'=$3 ORDER BY source_order LIMIT 1 FOR UPDATE
  `, [Number(userId), period, key]);
  let row = result.rows[0];
  let record = row?.data || null;
  if (!record) {
    const ids = eligible.length ? eligible : period === 'daily' ? ['score_200'] : [];
    record = { user_id: Number(userId), period, key,
      rotating_id: ids.length ? ids[seededIndex(`${userId}|${period}|${key}`, ids.length)] : '',
      claimed_ids: [], created_at: now.toISOString() };
    const recordKey = `mission:${userId}:${period}:${key}`;
    const order = Number((await client.query("SELECT COALESCE(max(source_order),-1)+1 AS value FROM card_records WHERE collection='mission_periods'")).rows[0].value);
    await client.query(`INSERT INTO card_records(collection,record_key,user_id,record_id,source_order,data)
      VALUES('mission_periods',$1,$2,NULL,$3,$4::jsonb)`, [recordKey, Number(userId), order, JSON.stringify(record)]);
    row = { record_key: recordKey };
  }
  record.claimed_ids = Array.isArray(record.claimed_ids) ? record.claimed_ids : [];
  if (!record.rotating_id && eligible.length) record.rotating_id = eligible[seededIndex(`${userId}|${period}|${key}`, eligible.length)];
  if (record.rotating_id && !eligible.includes(record.rotating_id) && !record.claimed_ids.includes(`rotate:${record.rotating_id}`)) {
    record.rotating_id = eligible.length ? eligible[seededIndex(`${userId}|${period}|${key}|eligible`, eligible.length)] : '';
  }
  await client.query("UPDATE card_records SET data=$3::jsonb WHERE collection='mission_periods' AND record_key=$1 AND user_id=$2",
    [row.record_key, Number(userId), JSON.stringify(record)]);
  return record;
}

export async function getWutMissionsForUserWithClient(client, { userId, now = new Date() }) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  await lockWutMembership(client, userId);
  const docs = Object.fromEntries((await client.query(`SELECT document_key,data FROM app_documents
    WHERE document_key IN ('settings','cards_meta','arena_meta')`)).rows.map(row => [row.document_key, row.data || {}]));
  const settings = docs.settings || {};
  const zone = docs.arena_meta?.config?.timeZone || 'America/Los_Angeles';
  const dayKey = zonedDateKey(now, zone);
  const week = Number(settings.currentWeek || 1);
  const weekKey = `${String(settings.seasonId || 'S3')}|${week}`;
  const userRow = await client.query('SELECT balance FROM users WHERE id=$1', [Number(userId)]);
  const cardsRows = await client.query('SELECT data FROM owned_cards WHERE user_id=$1', [Number(userId)]);
  const boostRows = await client.query('SELECT consumed,data FROM owned_boosts WHERE user_id=$1', [Number(userId)]);
  const matchRows = await client.query(`SELECT m.data,COALESCE((SELECT jsonb_agg(p.data ORDER BY p.placement_index) FROM arena_placements p WHERE p.match_key=m.match_key),'[]'::jsonb) placements
    FROM arena_matches m WHERE m.match_kind='arena' AND m.status IN ('ready','completed') AND m.data->'player_ids' @> $1::jsonb`, [JSON.stringify([Number(userId)])]);
  const spinsRows = await client.query('SELECT data FROM casino_spins WHERE user_id=$1', [Number(userId)]);
  const shotRows = await client.query('SELECT week,status,data FROM shot_doctor_runs WHERE user_id=$1', [Number(userId)]);
  const betRows = await client.query("SELECT data FROM bets WHERE user_id=$1 AND week=$2 AND status<>'void'", [Number(userId), week]);
  const opportunityRows = await client.query("SELECT data FROM card_records WHERE collection='mission_opportunities' AND data->>'key'=$1 LIMIT 1", [weekKey]);
  const horseRows = await client.query("SELECT entity_type,data FROM horse_entities WHERE entity_type IN ('race','bet')");
  const cards = cardsRows.rows.map(row => row.data || {});
  const boosts = boostRows.rows.map(row => ({ ...(row.data || {}), consumed: row.consumed }));
  const matches = matchRows.rows.map(row => ({ ...(row.data || {}), placements: row.placements || [] }))
    .filter(match => match.wut_rewards_awarded_at && zonedDateKey(new Date(match.resolved_at || match.completed_at), zone) === dayKey);
  const spins = spinsRows.rows.map(row => row.data || {});
  const shots = shotRows.rows.map(row => ({ ...(row.data || {}), week: row.week, status: row.status }));
  const bets = betRows.rows.map(row => row.data || {});
  const opportunities = opportunityRows.rows[0]?.data?.opportunities || [];
  const horseRaces = horseRows.rows.filter(row => row.entity_type === 'race').map(row => row.data || {});
  const horseBets = horseRows.rows.filter(row => row.entity_type === 'bet').map(row => row.data || {});
  const dailyEligible = ['score_200', 'win_no_boost'];
  if (boosts.some(boost => !boost.consumed)) dailyEligible.push('use_boost');
  if (new Set(cards.map(card => String(card.source_season || card.edition || 'S3'))).size >= 3) dailyEligible.push('three_seasons');
  if (new Set(cards.map(card => String(card.source_team_id || '')).filter(Boolean)).size >= 5) dailyEligible.push('five_teams');
  if (cards.some(card => card.trinket_id != null)) dailyEligible.push('trigger_trinket');
  if (settings.casinoOpen !== false && Number(userRow.rows[0]?.balance || 0) >= 50) dailyEligible.push('slots_five', 'slots_win', 'puckiq_complete');
  if (settings.casinoOpen !== false && Number(userRow.rows[0]?.balance || 0) >= 1 && horseRaces.filter(race => race.race_date === dayKey).length >= 2) dailyEligible.push('horse_two', 'horse_win');
  const weeklyEligible = opportunities.length ? ['wager_500', 'five_winners', 'three_x_winner'] : [];
  if (opportunities.some(item => item.division_id)) weeklyEligible.push('every_division');
  if (opportunities.length >= 6) weeklyEligible.push('six_teams', 'mixed_markets');
  if (settings.casinoOpen !== false) weeklyEligible.push('puckiq_five', 'slots_twenty_five');
  const dailyRecord = await ensurePeriod(client, userId, 'daily', dayKey, dailyEligible, now);
  const weeklyRecord = await ensurePeriod(client, userId, 'weekly', weekKey, weeklyEligible, now);
  const ownRows = match => (match.placements || []).filter(row => Number(row.user_id) === Number(userId));
  const dailyProgress = id => {
    if (id === 'score_200') return matches.filter(match => ownRows(match).reduce((sum, row) => sum + Number(row.fp || 0), 0) >= 200).length;
    if (id === 'win_no_boost') return matches.filter(match => Number(match.winner_user_id) === Number(userId) && ownRows(match).every(row => !row.boost_id)).length;
    if (id === 'use_boost') return matches.filter(match => ownRows(match).some(row => row.boost_id)).length;
    if (id === 'three_seasons') return matches.filter(match => new Set(ownRows(match).map(row => row.card_snapshot?.season).filter(Boolean)).size >= 3).length;
    if (id === 'five_teams') return matches.filter(match => new Set(ownRows(match).map(row => row.card_snapshot?.team_id).filter(Boolean)).size >= 5).length;
    if (id === 'trigger_trinket') return matches.filter(match => ownRows(match).some(row => Boolean(row.journeyman_key_effective) ||
      (row.scoring_effects || []).some(effect => effect.type === 'trinket' && effect.direction !== 'incoming' && (effect.triggered === true || Number(effect.points || 0) !== 0)))).length;
    const todaySpins = spins.filter(spin => zonedDateKey(new Date(spin.created_at), zone) === dayKey);
    if (id === 'slots_five') return todaySpins.length;
    if (id === 'slots_win') return todaySpins.filter(spin => Number(spin.payout || 0) > 0).length;
    if (id === 'puckiq_complete') return shots.filter(run => run.status === 'complete' && zonedDateKey(new Date(run.completed_at), zone) === dayKey).length;
    const raceIds = new Set(horseRaces.filter(race => race.race_date === dayKey).map(race => Number(race.id)));
    const todayHorse = horseBets.filter(bet => Number(bet.user_id) === Number(userId) && raceIds.has(Number(bet.race_id)) && (bet.status === 'settled' || bet.settled));
    if (id === 'horse_two') return new Set(todayHorse.map(bet => bet.race_id)).size;
    if (id === 'horse_win') return todayHorse.filter(bet => Number(bet.payout || 0) > 0).length;
    return 0;
  };
  const locked = (settings.lockedWeeks || []).map(Number).includes(week);
  const weeklyProgress = id => {
    if (id === 'wager_500') return locked ? bets.reduce((sum, bet) => sum + Number(bet.stake || 0), 0) : 0;
    if (id === 'every_division') { const divisions = [...new Set(opportunities.map(item => item.division_id).filter(Boolean))]; return locked && divisions.length && divisions.every(division => bets.filter(bet => String(bet.division_id) === division).reduce((sum, bet) => sum + Number(bet.stake || 0), 0) >= 25) ? 1 : 0; }
    if (id === 'six_teams') return locked ? new Set(bets.map(bet => bet.team_id).filter(Boolean)).size : 0;
    if (id === 'mixed_markets') return locked ? Math.min(5, bets.filter(bet => (bet.bet_kind || 'series') !== 'prop').length) + Math.min(5, bets.filter(bet => bet.bet_kind === 'prop').length) : 0;
    if (id === 'five_winners') return bets.filter(bet => bet.status === 'settled' && bet.won).length;
    if (id === 'three_x_winner') return bets.filter(bet => bet.status === 'settled' && bet.won && Number(bet.multiplier || 0) >= 3).length;
    if (id === 'puckiq_five') return shots.filter(run => Number(run.week) === week && run.status === 'complete').length;
    if (id === 'slots_twenty_five') return spins.filter(spin => Number(spin.week) === week).length;
    return 0;
  };
  const rewards = docs.cards_meta?.config?.wut?.missionRewards || {};
  const claimed = (record, id) => record.claimed_ids.includes(id);
  const dailyRule = DAILY[dailyRecord.rotating_id] || DAILY.score_200;
  const weeklyRule = WEEKLY[weeklyRecord.rotating_id] || null;
  const weekly = [];
  const profit = bets.filter(bet => bet.status === 'settled' && bet.won).reduce((sum, bet) => sum + Math.max(0, Number(bet.payout || 0) - Number(bet.stake || 0)), 0);
  if (opportunities.length || bets.length) weekly.push(publicMission('weekly', 'profit_500', 'Winning Week', 'Earn 500 Mushybux in profit from winning settled sportsbook tickets.', rewards.weekly_profit_500, profit, 500, claimed(weeklyRecord, 'profit_500')));
  if (opportunities.length) {
    const covered = opportunities.filter(opportunity => bets.filter(bet => ((bet.bet_kind || 'series') === 'prop' ? `prop:${bet.prop_key || `${bet.division_id}|${bet.prop_category}`}` : `series:${bet.series_key || ''}`) === opportunity.key).reduce((sum, bet) => sum + Number(bet.stake || 0), 0) >= 50).length;
    const mission = publicMission('weekly', 'category_coverage', 'Cover the Board', `Have at least 50 Mushybux locked on every available betting option (${opportunities.length} this week). Outcomes within an option do not count separately.`, rewards.weekly_category_coverage, covered, opportunities.length, claimed(weeklyRecord, 'category_coverage'));
    if (!locked) mission.complete = false;
    weekly.push(mission);
  }
  if (weeklyRule) weekly.push(publicMission('weekly', `rotate:${weeklyRecord.rotating_id}`, weeklyRule.title, weeklyRule.description, rewards.weekly_rotating, weeklyProgress(weeklyRecord.rotating_id), weeklyRule.target, claimed(weeklyRecord, `rotate:${weeklyRecord.rotating_id}`), true));
  return { dayKey, weekKey, daily: [
    publicMission('daily', 'play_three', 'Three Games a Day', 'Complete three WUT matches today.', rewards.daily_play_three, matches.length, 3, claimed(dailyRecord, 'play_three')),
    publicMission('daily', 'first_win', 'First Win', 'Win your first WUT match of the day.', rewards.daily_first_win, matches.filter(match => Number(match.winner_user_id) === Number(userId)).length, 1, claimed(dailyRecord, 'first_win')),
    publicMission('daily', `rotate:${dailyRecord.rotating_id}`, dailyRule.title, dailyRule.description, rewards.daily_rotating, dailyProgress(dailyRecord.rotating_id), dailyRule.target, claimed(dailyRecord, `rotate:${dailyRecord.rotating_id}`), true)
  ], weekly };
}

export async function claimWutMissionByIdWithClient(client, { userId, period, missionId, now = new Date() }) {
  const missions = await getWutMissionsForUserWithClient(client, { userId, now });
  const cleanPeriod = period === 'weekly' ? 'weekly' : 'daily';
  const mission = missions[cleanPeriod].find(item => item.id === String(missionId || ''));
  if (!mission) throw new Error('That mission is not active.');
  if (!mission.complete) throw new Error('That mission is not complete yet.');
  if (mission.claimed) throw new Error('That mission reward was already claimed.');
  return claimWutMissionWithClient(client, { userId, period: cleanPeriod,
    periodKey: cleanPeriod === 'daily' ? missions.dayKey : missions.weekKey, mission, now });
}

export async function setWutMissionBetOpportunitiesWithClient(client, { week, opportunities = [], locked = false, now = new Date() }) {
  const settings = (await client.query("SELECT data FROM app_documents WHERE document_key='settings'")).rows[0]?.data || {};
  const key = `${String(settings.seasonId || 'S3')}|${Number(week || settings.currentWeek || 1)}`;
  const row = (await client.query("SELECT record_key,data FROM card_records WHERE collection='mission_opportunities' AND data->>'key'=$1 FOR UPDATE", [key])).rows[0];
  if (row?.data?.locked_at) return row.data;
  const unique = new Map();
  for (const item of opportunities || []) if (String(item?.key || '').trim()) unique.set(String(item.key).trim(), {
    key: String(item.key).trim(), kind: item.kind === 'prop' ? 'prop' : 'series',
    division_id: String(item.divisionId || item.division_id || ''), label: String(item.label || item.key)
  });
  const data = { ...(row?.data || {}), key, season_id: String(settings.seasonId || 'S3'), week: Number(week),
    opportunities: [...unique.values()], updated_at: now.toISOString(), locked_at: locked ? now.toISOString() : null };
  if (row) await client.query("UPDATE card_records SET data=$2::jsonb WHERE collection='mission_opportunities' AND record_key=$1", [row.record_key, JSON.stringify(data)]);
  else {
    const order = Number((await client.query("SELECT COALESCE(max(source_order),-1)+1 AS value FROM card_records WHERE collection='mission_opportunities'")).rows[0].value);
    await client.query(`INSERT INTO card_records(collection,record_key,user_id,record_id,source_order,data)
      VALUES('mission_opportunities',$1,NULL,NULL,$2,$3::jsonb)`, [`opportunities:${key}`, order, JSON.stringify(data)]);
  }
  return data;
}

export async function claimWutMissionWithClient(client, {
  userId, period, periodKey, mission, now = new Date()
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId);
  const cleanPeriod = period === 'weekly' ? 'weekly' : 'daily';
  if (!mission || !mission.id) throw new Error('That mission is not active.');
  if (!mission.complete) throw new Error('That mission is not complete yet.');
  const result = await client.query(`
    SELECT record_key,data FROM card_records
    WHERE collection='mission_periods' AND user_id=$1
      AND data->>'period'=$2 AND data->>'key'=$3
    ORDER BY source_order LIMIT 1 FOR UPDATE
  `, [Number(userId), cleanPeriod, String(periodKey)]);
  const row = result.rows[0];
  if (!row) throw new Error('Mission period not found.');
  const record = row.data || {};
  record.claimed_ids = Array.isArray(record.claimed_ids) ? record.claimed_ids : [];
  if (record.claimed_ids.includes(String(mission.id))) throw new Error('That mission reward was already claimed.');
  const reward = Number(mission.reward || 0);
  if (!Number.isInteger(reward) || reward < 0) throw new Error('Invalid mission reward.');
  record.claimed_ids.push(String(mission.id));
  record.updated_at = now.toISOString();
  await client.query(`
    UPDATE card_records SET data=$3::jsonb
    WHERE collection='mission_periods' AND record_key=$1 AND user_id=$2
  `, [row.record_key, Number(userId), JSON.stringify(record)]);
  const { balance } = await changeWutCoins(client, membership, reward, 'mission_reward', {
    mission_period: cleanPeriod,
    mission_key: String(periodKey),
    mission_id: String(mission.id)
  }, now);
  return { mission, wutCoins: balance };
}

export const claimWutMissionPostgres = (pool, input) =>
  withTransaction(pool, client => claimWutMissionWithClient(client, input));
export const getWutMissionsForUserPostgres = (pool, input) =>
  withTransaction(pool, client => getWutMissionsForUserWithClient(client, input));
export const claimWutMissionByIdPostgres = (pool, input) =>
  withTransaction(pool, client => claimWutMissionByIdWithClient(client, input));
export const setWutMissionBetOpportunitiesPostgres = (pool, input) =>
  withTransaction(pool, client => setWutMissionBetOpportunitiesWithClient(client, input));

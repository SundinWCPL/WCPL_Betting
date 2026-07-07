import { withTransaction } from '../postgres.js';
import {
  addBalanceTransaction,
  changeLockedUserBalance,
  lockUser
} from './wallet.js';

const asNumber = value => Number(value || 0);
const lockSportsbook = client => client.query('SELECT pg_advisory_xact_lock($1)', [8242030]);

async function settingsDocument(client) {
  const result = await client.query("SELECT data FROM app_documents WHERE document_key = 'settings'");
  if (!result.rows[0]) throw new Error('Required PostgreSQL document is missing: settings.');
  return result.rows[0].data || {};
}

function assertWeekOpen(settings, week, requestLocked) {
  const target = Number(week);
  const locked = (settings.lockedWeeks || []).some(value => Number(value) === target);
  if (requestLocked || locked) throw new Error('Betting is locked for this week.');
}

async function nextBetId(client) {
  return asNumber((await client.query("SELECT nextval('bets_id_seq') AS id")).rows[0].id);
}

async function saveBet(client, bet, { insert }) {
  if (insert) {
    await client.query(`
      INSERT INTO bets(id, user_id, week, status, bet_kind, series_key, prop_key, stake, payout, created_at, settled_at, source_order, data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    `, [bet.id, bet.user_id, bet.week, bet.status, bet.bet_kind, bet.series_key || null, bet.prop_key || null,
      bet.stake, bet.payout, bet.created_at, bet.settled_at || null, bet.id, JSON.stringify(bet)]);
    return;
  }
  await client.query(`
    UPDATE bets SET week=$2, status=$3, bet_kind=$4, series_key=$5, prop_key=$6,
      stake=$7, payout=$8, created_at=$9, settled_at=$10, data=$11::jsonb
    WHERE id=$1
  `, [bet.id, bet.week, bet.status, bet.bet_kind, bet.series_key || null, bet.prop_key || null,
    bet.stake, bet.payout, bet.created_at, bet.settled_at || null, JSON.stringify(bet)]);
}

export async function placeOrUpdateSeriesBetWithClient(client, input) {
  await lockSportsbook(client);
  const stake = Number(input.stake);
  const maxBet = Number(process.env.MAX_BET || 250);
  if (!Number.isInteger(stake) || stake <= 0) throw new Error('Stake must be a positive whole number.');
  if (stake > maxBet) throw new Error(`Max bet is ${maxBet} Mushybux.`);
  const settings = await settingsDocument(client);
  assertWeekOpen(settings, input.week, input.locked);
  const user = await lockUser(client, input.userId);
  const existingResult = await client.query(`
    SELECT data FROM bets
    WHERE user_id=$1 AND week=$2 AND series_key=$3 AND bet_kind='series' AND status='open'
    FOR UPDATE
  `, [Number(input.userId), Number(input.week), String(input.seriesKey)]);
  const existing = existingResult.rows[0]?.data || null;
  const existingStake = asNumber(existing?.stake);
  if (asNumber(user.balance) + existingStake < stake) throw new Error('Insufficient balance.');
  const createdAt = new Date().toISOString();
  await changeLockedUserBalance(client, user, existingStake - stake);

  const bet = {
    ...(existing || {}),
    id: existing?.id ?? await nextBetId(client),
    user_id: Number(input.userId),
    bet_kind: 'series',
    week: Number(input.week),
    division_id: input.divisionId,
    series_key: String(input.seriesKey),
    market_key: input.marketKey,
    market_type: input.marketType,
    team_id: input.teamId,
    label: input.label,
    stake,
    multiplier: Number(input.multiplier),
    goal_total_side: input.goalTotalSide || '',
    goal_total_line: input.goalTotalLine == null ? null : Number(input.goalTotalLine),
    goal_total_boost: input.goalTotalBoost == null ? null : Number(input.goalTotalBoost),
    status: 'open',
    payout: null,
    ...(existing ? { updated_at: createdAt } : { created_at: createdAt })
  };
  await saveBet(client, bet, { insert: !existing });
  await addBalanceTransaction(client, {
    userId: user.id,
    amount: existingStake - stake,
    kind: existing ? 'bet_change' : 'bet_stake',
    bet_id: bet.id,
    note: bet.label,
    createdAt
  });
  return { id: bet.id, action: existing ? 'updated' : 'placed' };
}

export async function placeOrUpdatePropBetWithClient(client, input) {
  await lockSportsbook(client);
  const stake = Number(input.stake);
  const maxBet = Number(process.env.PROP_MAX_BET || 100);
  if (!Number.isInteger(stake) || stake <= 0) throw new Error('Stake must be a positive whole number.');
  if (stake > maxBet) throw new Error(`Max prop bet is ${maxBet} Mushybux.`);
  const settings = await settingsDocument(client);
  assertWeekOpen(settings, input.week, input.locked);
  const user = await lockUser(client, input.userId);
  const existingResult = await client.query(`
    SELECT data FROM bets
    WHERE user_id=$1 AND week=$2 AND bet_kind='prop' AND status='open'
      AND data->>'division_id'=$3 AND data->>'prop_category'=$4
    FOR UPDATE
  `, [Number(input.userId), Number(input.week), String(input.divisionId), String(input.category)]);
  const existing = existingResult.rows[0]?.data || null;
  const existingStake = asNumber(existing?.stake);
  if (asNumber(user.balance) + existingStake < stake) throw new Error('Insufficient balance.');
  const createdAt = new Date().toISOString();
  await changeLockedUserBalance(client, user, existingStake - stake);

  const bet = {
    ...(existing || {}),
    id: existing?.id ?? await nextBetId(client),
    user_id: Number(input.userId),
    bet_kind: 'prop',
    week: Number(input.week),
    division_id: input.divisionId,
    series_key: String(input.seriesKey || ''),
    prop_key: input.propKey,
    prop_category: input.category,
    market_key: input.marketKey || input.propKey,
    market_type: input.category,
    team_id: '',
    player_key: input.playerKey,
    player_name: input.playerName,
    player_team_id: String(input.playerTeamId || existing?.player_team_id || ''),
    quantity: input.quantity == null ? null : Number(input.quantity),
    prop_line: input.propLine == null ? null : Number(input.propLine),
    label: input.label,
    stake,
    multiplier: Number(input.multiplier),
    goal_total_side: '',
    goal_total_line: null,
    goal_total_boost: null,
    status: 'open',
    payout: null,
    ...(existing ? { updated_at: createdAt } : { created_at: createdAt })
  };
  await saveBet(client, bet, { insert: !existing });
  await addBalanceTransaction(client, {
    userId: user.id,
    amount: existingStake - stake,
    kind: existing ? 'prop_bet_change' : 'prop_bet_stake',
    bet_id: bet.id,
    note: bet.label,
    createdAt
  });
  return { id: bet.id, action: existing ? 'updated' : 'placed' };
}

export async function cancelOpenBetWithClient(client, { userId, betId, locked = false }) {
  await lockSportsbook(client);
  const user = await lockUser(client, userId);
  const result = await client.query('SELECT data FROM bets WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(betId), Number(userId)]);
  const bet = result.rows[0]?.data;
  if (!bet) throw new Error('Bet not found.');
  if (bet.status !== 'open') throw new Error('Only open bets can be cancelled.');
  assertWeekOpen(await settingsDocument(client), bet.week, locked);

  const refunded = asNumber(bet.stake);
  await changeLockedUserBalance(client, user, refunded);
  const stakeKind = (bet.bet_kind || 'series') === 'prop' ? 'prop_bet_stake' : 'bet_stake';
  const changeKind = (bet.bet_kind || 'series') === 'prop' ? 'prop_bet_change' : 'bet_change';
  await client.query(`
    DELETE FROM balance_transactions
    WHERE data->>'bet_id' = $1
       OR (user_id=$2 AND kind=$3 AND created_at=$4)
       OR (user_id=$2 AND kind=$5 AND $6::timestamptz IS NOT NULL AND created_at=$6)
  `, [String(bet.id), Number(userId), stakeKind, bet.created_at, changeKind, bet.updated_at || null]);
  await client.query('DELETE FROM bets WHERE id=$1', [Number(bet.id)]);
  return { id: Number(bet.id), refunded, betKind: bet.bet_kind || 'series' };
}

export async function settleBetsWithClient(client, { week, results }) {
  await lockSportsbook(client);
  const targetWeek = Number(week);
  if (!Number.isFinite(targetWeek) || targetWeek < 1) throw new Error('Invalid week.');
  const result = await client.query(
    "SELECT id, user_id, data FROM bets WHERE week=$1 AND status='open' ORDER BY id FOR UPDATE",
    [targetWeek]
  );
  const ready = result.rows.filter(row => results.evaluations?.[row.id]?.ready);
  const users = new Map();
  for (const userId of [...new Set(ready.map(row => Number(row.user_id)))].sort((a, b) => a - b)) {
    users.set(userId, await lockUser(client, userId));
  }

  let winners = 0;
  let losers = 0;
  let payoutTotal = 0;
  const settledAt = new Date().toISOString();
  for (const row of ready) {
    const bet = row.data || {};
    const evaluation = results.evaluations[row.id];
    const payout = evaluation.won ? Math.ceil(asNumber(bet.stake) * asNumber(bet.multiplier)) : 0;
    const user = users.get(Number(row.user_id));
    if (payout > 0) await changeLockedUserBalance(client, user, payout);
    bet.status = 'settled';
    bet.settled_at = settledAt;
    bet.payout = payout;
    bet.won = Boolean(evaluation.won);
    bet.result_summary = evaluation.result_summary || evaluation.reason || '';
    await saveBet(client, bet, { insert: false });
    await addBalanceTransaction(client, {
      userId: row.user_id,
      week: targetWeek,
      amount: payout,
      kind: evaluation.won ? 'bet_payout' : 'bet_loss',
      note: `${evaluation.won ? 'Won' : 'Lost'}: ${bet.label}${bet.result_summary ? ` (${bet.result_summary})` : ''}`,
      createdAt: settledAt
    });
    if (evaluation.won) winners += 1;
    else losers += 1;
    payoutTotal += payout;
  }
  return {
    settled: ready.length,
    winners,
    losers,
    payoutTotal,
    skipped: result.rows.length - ready.length
  };
}

async function voidLockedBet(client, bet, user, reason, voidedAt) {
  const stake = asNumber(bet.stake);
  if (stake > 0) {
    await changeLockedUserBalance(client, user, stake);
    await addBalanceTransaction(client, {
      userId: user.id,
      week: bet.week,
      amount: stake,
      kind: 'bet_void_refund',
      note: `${reason}: ${bet.label}`,
      bet_id: bet.id,
      createdAt: voidedAt
    });
  }
  bet.status = 'void';
  bet.voided_at = voidedAt;
  bet.void_reason = reason;
  bet.payout = 0;
  await saveBet(client, bet, { insert: false });
  return { count: 1, refunded: stake };
}

export async function voidBetByIdWithClient(client, betId, reason = 'Manual refund') {
  await lockSportsbook(client);
  const lookup = await client.query('SELECT user_id FROM bets WHERE id=$1', [Number(betId)]);
  if (!lookup.rows[0]) throw new Error('Bet not found.');
  const user = await lockUser(client, lookup.rows[0].user_id);
  const result = await client.query('SELECT data FROM bets WHERE id=$1 FOR UPDATE', [Number(betId)]);
  const bet = result.rows[0]?.data;
  if (!bet) throw new Error('Bet not found.');
  if (bet.status !== 'open') throw new Error('Only open bets can be refunded.');
  return voidLockedBet(client, bet, user, reason, new Date().toISOString());
}

async function voidSelectedRows(client, rows, reason) {
  const users = new Map();
  for (const userId of [...new Set(rows.map(row => Number(row.user_id)))].sort((a, b) => a - b)) users.set(userId, await lockUser(client, userId));
  let refunded = 0; let seriesCount = 0; let propCount = 0; const voidedAt = new Date().toISOString();
  for (const row of rows) {
    const result = await voidLockedBet(client, row.data || {}, users.get(Number(row.user_id)), reason, voidedAt);
    refunded += result.refunded;
    if ((row.data?.bet_kind || 'series') === 'prop') propCount++; else seriesCount++;
  }
  return { count: rows.length, seriesCount, propCount, refunded };
}

export async function voidBetsForSeriesWithClient(client, { week, seriesKey, teamIds = [], playerKeys = [], reason = 'Series void' }) {
  await lockSportsbook(client);
  const result = await client.query("SELECT user_id,data FROM bets WHERE week=$1 AND status='open' ORDER BY user_id,id FOR UPDATE", [Number(week)]);
  const teams = new Set(teamIds.map(String)); const players = new Set(playerKeys.map(String));
  const rows = result.rows.filter(row => {
    const bet = row.data || {};
    if ((bet.bet_kind || 'series') === 'series') return String(bet.series_key || '') === String(seriesKey);
    return String(bet.series_key || '') === String(seriesKey) || teams.has(String(bet.player_team_id || bet.team_id || '')) || players.has(String(bet.player_key || ''));
  });
  return voidSelectedRows(client, rows, reason);
}

export async function resetBetsForWeekWithClient(client, week, reason = 'Admin week reset') {
  await lockSportsbook(client);
  const rows = (await client.query("SELECT user_id,data FROM bets WHERE week=$1 AND status='open' ORDER BY user_id,id FOR UPDATE", [Number(week)])).rows;
  return voidSelectedRows(client, rows, reason);
}

export async function voidDeprecatedHatTrickBetsForWeekWithClient(client, week) {
  await lockSportsbook(client);
  const rows = (await client.query("SELECT user_id,data FROM bets WHERE week=$1 AND status='open' AND bet_kind='prop' AND data->>'prop_category'='hat_trick' ORDER BY user_id,id FOR UPDATE", [Number(week)])).rows;
  return voidSelectedRows(client, rows, 'Retired hat-trick market');
}

export const placeOrUpdateSeriesBetPostgres = (pool, input) =>
  withTransaction(pool, client => placeOrUpdateSeriesBetWithClient(client, input));
export const placeOrUpdatePropBetPostgres = (pool, input) =>
  withTransaction(pool, client => placeOrUpdatePropBetWithClient(client, input));
export const cancelOpenBetPostgres = (pool, input) =>
  withTransaction(pool, client => cancelOpenBetWithClient(client, input));
export const settleBetsPostgres = (pool, input) =>
  withTransaction(pool, client => settleBetsWithClient(client, input));
export const voidBetByIdPostgres = (pool, betId, reason) =>
  withTransaction(pool, client => voidBetByIdWithClient(client, betId, reason));
export const voidBetsForSeriesPostgres = (pool, input) =>
  withTransaction(pool, client => voidBetsForSeriesWithClient(client, input));
export const resetBetsForWeekPostgres = (pool, week, reason) =>
  withTransaction(pool, client => resetBetsForWeekWithClient(client, week, reason));
export const voidDeprecatedHatTrickBetsForWeekPostgres = (pool, week) =>
  withTransaction(pool, client => voidDeprecatedHatTrickBetsForWeekWithClient(client, week));

import { withTransaction } from '../postgres.js';
import {
  actHoldem,
  addHoldemChat,
  ensureHoldemTable,
  heartbeatHoldemSeat,
  leaveHoldemSeat,
  processHoldemTable,
  publicHoldemState,
  sitHoldemSeat
} from '../../services/casinoHoldem.js';
import {
  addBalanceTransaction,
  formatBalanceSummary,
  getOpenWagered,
  lockUser,
  setLockedUserBalance
} from './wallet.js';

const asNumber = value => Number(value || 0);

async function document(client, key, { lock = false } = {}) {
  const result = await client.query(
    `SELECT data FROM app_documents WHERE document_key = $1${lock ? ' FOR UPDATE' : ''}`,
    [key]
  );
  if (!result.rows[0]) throw new Error(`Required PostgreSQL document is missing: ${key}.`);
  return result.rows[0].data || {};
}

async function saveCasino(client, casino) {
  await client.query(
    "UPDATE app_documents SET data = $2::jsonb, updated_at = now() WHERE document_key = $1",
    ['casino_meta', JSON.stringify(casino)]
  );
}

async function applyHoldemTransactions(client, transactions, settings) {
  for (const tx of transactions || []) {
    const user = await lockUser(client, tx.userId);
    const nextBalance = asNumber(user.balance) + asNumber(tx.amount);
    await setLockedUserBalance(client, user, nextBalance);
    await addBalanceTransaction(client, {
      userId: tx.userId,
      week: asNumber(settings.currentWeek || 1),
      amount: tx.amount,
      kind: tx.kind,
      category: 'casino',
      game: 'holdem',
      note: tx.note,
      holdem_hand_id: tx.holdemHandId,
      createdAt: new Date().toISOString()
    });
  }
}

async function balanceSummaryForUser(client, userId) {
  const result = await client.query('SELECT balance FROM users WHERE id = $1', [Number(userId)]);
  if (!result.rows[0]) throw new Error('User not found.');
  return formatBalanceSummary(result.rows[0].balance, await getOpenWagered(client, userId));
}

async function loadProcessedTable(client, now = new Date()) {
  const casino = await document(client, 'casino_meta', { lock: true });
  const settings = await document(client, 'settings');
  const processed = processHoldemTable(ensureHoldemTable(casino.holdem), { now });
  casino.holdem = processed.table;
  await applyHoldemTransactions(client, processed.transactions, settings);
  return { casino, settings, table: processed.table };
}

async function publicStateWithClient(client, { userId, now = new Date() }) {
  const { casino, settings, table } = await loadProcessedTable(client, now);
  await saveCasino(client, casino);
  return publicHoldemState(table, {
    userId,
    now,
    isCasinoOpen: settings.casinoOpen !== false && settings.holdemOpen === true,
    balanceSummary: await balanceSummaryForUser(client, userId)
  });
}

export const getHoldemStateForUserPostgres = (pool, input) =>
  withTransaction(pool, client => publicStateWithClient(client, input));

async function mutateHoldemWithClient(client, {
  userId,
  now = new Date(),
  action,
  input = {}
}) {
  const { casino, settings, table } = await loadProcessedTable(client, now);
  let result;

  if (!['leave', 'heartbeat', 'chat'].includes(action)) {
    if (settings.casinoOpen === false) throw new Error('The casino is currently closed.');
    if (settings.holdemOpen !== true) throw new Error('Texas Hold-Em Table is currently closed.');
  }

  if (action === 'sit') {
    result = sitHoldemSeat(table, { userId, displayName: input.displayName, seatIndex: input.seatIndex, now });
  } else if (action === 'leave') {
    result = leaveHoldemSeat(table, { userId, now });
  } else if (action === 'heartbeat') {
    result = heartbeatHoldemSeat(table, { userId, now });
  } else if (action === 'act') {
    result = actHoldem(table, { userId, action: input.playerAction, amount: input.amount, now });
  } else if (action === 'chat') {
    result = addHoldemChat(table, { userId, username: input.username, message: input.message, now });
  } else {
    throw new Error('Unknown holdem action.');
  }

  casino.holdem = result.table;
  await applyHoldemTransactions(client, result.transactions, settings);
  await saveCasino(client, casino);
  return {
    message: result.message || null,
    holdemState: publicHoldemState(result.table, {
      userId,
      now,
      isCasinoOpen: settings.casinoOpen !== false && settings.holdemOpen === true,
      balanceSummary: await balanceSummaryForUser(client, userId)
    })
  };
}

export const sitHoldemSeatPostgres = (pool, input) =>
  withTransaction(pool, client => mutateHoldemWithClient(client, { ...input, action: 'sit' }));

export const leaveHoldemSeatPostgres = (pool, input) =>
  withTransaction(pool, client => mutateHoldemWithClient(client, { ...input, action: 'leave' }));

export const heartbeatHoldemSeatPostgres = (pool, input) =>
  withTransaction(pool, client => mutateHoldemWithClient(client, { ...input, action: 'heartbeat' }));

export const actHoldemPostgres = (pool, input) =>
  withTransaction(pool, client => mutateHoldemWithClient(client, { ...input, action: 'act' }));

export const addHoldemChatPostgres = (pool, input) =>
  withTransaction(pool, client => mutateHoldemWithClient(client, { ...input, action: 'chat' }));

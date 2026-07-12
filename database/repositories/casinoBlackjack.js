import { withTransaction } from '../postgres.js';
import {
  actBlackjack,
  addBlackjackChat,
  betBlackjack,
  ensureBlackjackTable,
  heartbeatBlackjackSeat,
  leaveBlackjackSeat,
  processBlackjackTable,
  publicBlackjackState,
  sitBlackjackSeat
} from '../../services/casinoBlackjack.js';
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

async function applyBlackjackTransactions(client, transactions, settings) {
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
      game: 'blackjack',
      note: tx.note,
      blackjack_hand_id: tx.blackjackHandId,
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
  const processed = processBlackjackTable(ensureBlackjackTable(casino.blackjack), { now });
  casino.blackjack = processed.table;
  await applyBlackjackTransactions(client, processed.transactions, settings);
  return { casino, settings, table: processed.table };
}

async function publicStateWithClient(client, { userId, now = new Date() }) {
  const { casino, settings, table } = await loadProcessedTable(client, now);
  await saveCasino(client, casino);
  return publicBlackjackState(table, {
    userId,
    now,
    isCasinoOpen: settings.casinoOpen !== false,
    balanceSummary: await balanceSummaryForUser(client, userId)
  });
}

export const getBlackjackStateForUserPostgres = (pool, input) =>
  withTransaction(pool, client => publicStateWithClient(client, input));

async function mutateBlackjackWithClient(client, {
  userId,
  now = new Date(),
  action,
  input = {}
}) {
  const { casino, settings, table } = await loadProcessedTable(client, now);
  let result;

  if (!['leave', 'heartbeat', 'chat'].includes(action) && settings.casinoOpen === false) {
    throw new Error('The casino is currently closed.');
  }

  if (action === 'sit') {
    result = sitBlackjackSeat(table, { userId, displayName: input.displayName, seatIndex: input.seatIndex, now });
  } else if (action === 'leave') {
    result = leaveBlackjackSeat(table, { userId, now });
  } else if (action === 'heartbeat') {
    result = heartbeatBlackjackSeat(table, { userId, now });
  } else if (action === 'bet') {
    result = betBlackjack(table, { userId, wager: input.wager, now });
  } else if (action === 'act') {
    result = actBlackjack(table, { userId, action: input.playerAction, now });
  } else if (action === 'chat') {
    result = addBlackjackChat(table, { userId, username: input.username, message: input.message, now });
  } else {
    throw new Error('Unknown blackjack action.');
  }

  casino.blackjack = result.table;
  await applyBlackjackTransactions(client, result.transactions, settings);
  await saveCasino(client, casino);
  return {
    message: result.message || null,
    blackjackState: publicBlackjackState(result.table, {
      userId,
      now,
      isCasinoOpen: settings.casinoOpen !== false,
      balanceSummary: await balanceSummaryForUser(client, userId)
    })
  };
}

export const sitBlackjackSeatPostgres = (pool, input) =>
  withTransaction(pool, client => mutateBlackjackWithClient(client, { ...input, action: 'sit' }));

export const leaveBlackjackSeatPostgres = (pool, input) =>
  withTransaction(pool, client => mutateBlackjackWithClient(client, { ...input, action: 'leave' }));

export const heartbeatBlackjackSeatPostgres = (pool, input) =>
  withTransaction(pool, client => mutateBlackjackWithClient(client, { ...input, action: 'heartbeat' }));

export const betBlackjackPostgres = (pool, input) =>
  withTransaction(pool, client => mutateBlackjackWithClient(client, { ...input, action: 'bet' }));

export const actBlackjackPostgres = (pool, input) =>
  withTransaction(pool, client => mutateBlackjackWithClient(client, { ...input, action: 'act' }));

export const addBlackjackChatPostgres = (pool, input) =>
  withTransaction(pool, client => mutateBlackjackWithClient(client, { ...input, action: 'chat' }));

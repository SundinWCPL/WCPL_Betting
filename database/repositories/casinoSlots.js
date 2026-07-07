import { withTransaction } from '../postgres.js';
import {
  CASINO_ALL_SYMBOLS,
  CASINO_JACKPOT_CONTRIBUTION_RATE,
  CASINO_SLOT_WAGERS,
  resolveSlotSpin
} from '../../services/casinoSlots.js';
import {
  addBalanceTransaction,
  formatBalanceSummary,
  getLockedBalanceSummary,
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

export async function getCasinoStateForUserPostgres(pool, userId = null) {
  const [settingsResult, casinoResult, leaderboardResult, userResult] = await Promise.all([
    pool.query("SELECT data FROM app_documents WHERE document_key = 'settings'"),
    pool.query("SELECT data FROM app_documents WHERE document_key = 'casino_meta'"),
    pool.query(`
      SELECT s.user_id, COALESCE(u.display_name, 'User ' || s.user_id::text) AS user_display_name,
             sum(s.wager)::bigint AS total_wagered, count(*)::bigint AS spins
      FROM casino_spins s
      LEFT JOIN users u ON u.id = s.user_id
      GROUP BY s.user_id, u.display_name
      ORDER BY total_wagered DESC, s.user_id ASC
    `),
    userId
      ? pool.query(`
          SELECT u.balance,
                 COALESCE((SELECT sum(b.stake) FROM bets b WHERE b.user_id = u.id AND b.status = 'open'), 0)::bigint AS open_wagered
          FROM users u WHERE u.id = $1
        `, [userId])
      : Promise.resolve({ rows: [] })
  ]);
  const settings = settingsResult.rows[0]?.data || {};
  const casino = casinoResult.rows[0]?.data || {};
  const slotLeaderboard = leaderboardResult.rows.map(row => ({
    user_id: asNumber(row.user_id),
    user_display_name: row.user_display_name,
    total_wagered: asNumber(row.total_wagered),
    spins: asNumber(row.spins)
  }));
  return {
    isOpen: Boolean(settings.casinoOpen),
    jackpotAmount: Math.floor(asNumber(casino.jackpotAmount)),
    jackpotSeed: Math.floor(asNumber(casino.jackpotSeed)),
    contributionRate: CASINO_JACKPOT_CONTRIBUTION_RATE,
    allowedWagers: [...CASINO_SLOT_WAGERS],
    slotLeaderboard,
    slotSummary: {
      total_wagered: slotLeaderboard.reduce((sum, row) => sum + row.total_wagered, 0),
      total_spins: slotLeaderboard.reduce((sum, row) => sum + row.spins, 0)
    },
    allSymbols: CASINO_ALL_SYMBOLS,
    balanceSummary: userId && userResult.rows[0]
      ? formatBalanceSummary(userResult.rows[0].balance, userResult.rows[0].open_wagered)
      : null
  };
}

export async function spinCasinoSlotsWithClient(client, { userId, wager, now = new Date(), random = Math.random }) {
  const cleanUserId = Number(userId);
  const cleanWager = Number(wager);
  if (!CASINO_SLOT_WAGERS.includes(cleanWager)) throw new Error('Select a valid spin amount.');

  const casino = await document(client, 'casino_meta', { lock: true });
  const settings = await document(client, 'settings');
  if (!settings.casinoOpen) throw new Error('The casino is currently closed.');

  const user = await lockUser(client, cleanUserId);
  if (asNumber(user.balance) < cleanWager) throw new Error('Insufficient balance.');

  const resolved = resolveSlotSpin({
    wager: cleanWager,
    jackpotAmount: casino.jackpotAmount,
    jackpotSeed: casino.jackpotSeed,
    random
  });
  const createdAt = now.toISOString();
  const spinId = asNumber((await client.query("SELECT nextval('casino_spins_id_seq') AS id")).rows[0].id);
  const nextBalance = asNumber(user.balance) + resolved.net;
  const nextCasino = {
    ...casino,
    jackpotAmount: resolved.jackpotAfter,
    totalWagered: asNumber(casino.totalWagered) + cleanWager,
    totalPaid: asNumber(casino.totalPaid) + resolved.payout
  };
  const spin = {
    id: spinId,
    user_id: cleanUserId,
    game: 'slots',
    week: asNumber(settings.currentWeek || 1),
    wager: cleanWager,
    payout: resolved.payout,
    net: resolved.net,
    outcome_key: resolved.outcome.key,
    outcome_label: resolved.outcome.label,
    multiplier: asNumber(resolved.outcome.multiplier),
    jackpot: Boolean(resolved.outcome.jackpot),
    jackpot_before: resolved.jackpotBefore,
    jackpot_after: resolved.jackpotAfter,
    jackpot_contribution: resolved.jackpotContribution,
    reels: resolved.reels,
    created_at: createdAt
  };

  await setLockedUserBalance(client, user, nextBalance);
  await client.query(
    "UPDATE app_documents SET data = $2::jsonb, updated_at = now() WHERE document_key = $1",
    ['casino_meta', JSON.stringify(nextCasino)]
  );
  await client.query(
    'INSERT INTO casino_spins(id, user_id, wager, payout, created_at, source_order, data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [spinId, cleanUserId, cleanWager, resolved.payout, createdAt, spinId, JSON.stringify(spin)]
  );

  const ledgerRows = [{
    amount: -cleanWager,
    kind: 'casino_slots_wager',
    note: `Slots wager (${resolved.outcome.label})`
  }];
  if (resolved.payout > 0) ledgerRows.push({
    amount: resolved.payout,
    kind: resolved.outcome.jackpot ? 'casino_jackpot_payout' : 'casino_slots_payout',
    note: resolved.outcome.jackpot ? `Mushy Jackpot won: ${resolved.payout}` : `Slots payout: ${resolved.outcome.label}`
  });
  for (const ledger of ledgerRows) await addBalanceTransaction(client, {
    userId: cleanUserId,
    week: spin.week,
    amount: ledger.amount,
    kind: ledger.kind,
    category: 'casino',
    game: 'slots',
    note: ledger.note,
    casino_spin_id: spinId,
    createdAt
  });

  return { ...spin, balanceSummary: await getLockedBalanceSummary(client, user), jackpotAmount: resolved.jackpotAfter };
}

export function spinCasinoSlotsPostgres(pool, input) {
  return withTransaction(pool, client => spinCasinoSlotsWithClient(client, input));
}

import { withTransaction } from '../postgres.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';

export async function adjustWutCoinBalanceWithClient(client, { userId, amount, note, adminUserId = null }) {
  const value = Number(amount);
  if (!Number.isInteger(value) || value === 0) throw new Error('WUT Coin adjustment must be a non-zero whole number.');
  const cleanNote = String(note || '').trim().slice(0, 160);
  if (!cleanNote) throw new Error('A reason is required for WUT Coin adjustments.');
  const membership = await lockWutMembership(client, userId, { requireStarter: false });
  const { balance } = await changeWutCoins(client, membership, value, 'admin_wut_coin_adjustment', {
    note: cleanNote,
    admin_user_id: adminUserId == null ? null : Number(adminUserId)
  });
  return { userId: Number(userId), amount: value, balance, note: cleanNote };
}

export const adjustWutCoinBalancePostgres = (pool, input) =>
  withTransaction(pool, client => adjustWutCoinBalanceWithClient(client, input));

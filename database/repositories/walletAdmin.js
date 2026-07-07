import { withTransaction } from '../postgres.js';
import {
  addBalanceTransaction,
  changeLockedUserBalance,
  getLockedBalanceSummary,
  lockUser
} from './wallet.js';

export async function adjustUserBalanceWithClient(client, userId, amount, note = '') {
  const value = Number(amount);
  if (!Number.isInteger(value) || value === 0) throw new Error('Balance adjustment must be a non-zero whole number.');
  const user = await lockUser(client, userId);
  await changeLockedUserBalance(client, user, value, { allowNegative: true });
  await addBalanceTransaction(client, {
    userId: user.id,
    amount: value,
    kind: 'admin_balance_adjustment',
    note: note ? `Admin adjustment: ${note}` : 'Admin balance adjustment'
  });
  return getLockedBalanceSummary(client, user);
}

export async function applyWeeklyAllowanceWithClient(client, week = null) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242031]);
  const settingsResult = await client.query("SELECT data FROM app_documents WHERE document_key='settings'");
  const settings = settingsResult.rows[0]?.data || {};
  const amount = Number(settings.weeklyAllowance || 0);
  const targetWeek = Number(week || settings.currentWeek);
  if (amount <= 0) return { amount, count: 0 };
  const createdAt = new Date().toISOString();
  const result = await client.query(`
    WITH updated AS (
      UPDATE users u
      SET balance = u.balance + $2,
          data = jsonb_set(u.data, '{balance}', to_jsonb(u.balance + $2), true)
      WHERE NOT EXISTS (
        SELECT 1 FROM balance_transactions t
        WHERE t.user_id=u.id AND t.kind='weekly_allowance' AND t.week=$1
      )
      RETURNING u.id
    ), ledger AS MATERIALIZED (
      SELECT nextval('balance_transactions_id_seq') AS id, id AS user_id
      FROM updated
    )
    INSERT INTO balance_transactions(id, user_id, week, amount, kind, category, created_at, source_order, data)
    SELECT id, user_id, $1, $2, 'weekly_allowance', NULL, $3, id,
      jsonb_build_object(
        'id', id, 'user_id', user_id, 'week', $1, 'amount', $2,
        'kind', 'weekly_allowance', 'note', $4::text, 'created_at', $5::text
      )
    FROM ledger
    RETURNING user_id
  `, [targetWeek, amount, createdAt, `Week ${targetWeek} allowance`, createdAt]);
  return { amount, count: result.rowCount };
}

export const adjustUserBalancePostgres = (pool, userId, amount, note) =>
  withTransaction(pool, client => adjustUserBalanceWithClient(client, userId, amount, note));
export const applyWeeklyAllowancePostgres = (pool, week) =>
  withTransaction(pool, client => applyWeeklyAllowanceWithClient(client, week));

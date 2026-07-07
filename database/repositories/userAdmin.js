import bcrypt from 'bcryptjs';
import { withTransaction } from '../postgres.js';
import { addBalanceTransaction, changeLockedUserBalance, lockUser } from './wallet.js';

const cleanRole = value => value === 'admin' ? 'admin' : 'user';

export async function addUserWithClient(client, { username, password, displayName = '', role = 'user', now = new Date() }) {
  const cleanUsername = String(username || '').trim(); const cleanPassword = String(password || '').trim();
  if (cleanUsername.length < 2) throw new Error('Username must be at least 2 characters.');
  if (cleanPassword.length < 6) throw new Error('Password must be at least 6 characters.');
  if ((await client.query('SELECT 1 FROM users WHERE lower(username)=lower($1)', [cleanUsername])).rows[0]) throw new Error('That username is already in use.');
  const id = Number((await client.query("SELECT nextval('users_id_seq') AS id")).rows[0].id);
  const balance = Math.ceil(Number(process.env.STARTING_BALANCE || 1000)); const createdAt = now.toISOString();
  const user = { id, username: cleanUsername, password_hash: await bcrypt.hash(cleanPassword, 10),
    display_name: String(displayName || cleanUsername).trim().slice(0, 80) || cleanUsername,
    role: cleanRole(role), balance, created_at: createdAt };
  await client.query(`INSERT INTO users(id,username,password_hash,display_name,role,balance,created_at,source_order,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [id, user.username, user.password_hash, user.display_name, user.role, balance, createdAt, id, JSON.stringify(user)]);
  await addBalanceTransaction(client, { userId: id, amount: balance, kind: 'starting_balance', note: 'Initial season Mushybux', createdAt });
  const { password_hash, ...safe } = user; return safe;
}

export async function updateUserDetailsWithClient(client, { userId, username, password = '', displayName = '', role = 'user' }) {
  const user = await lockUser(client, userId); const cleanUsername = String(username || '').trim();
  if (cleanUsername.length < 2) throw new Error('Username must be at least 2 characters.');
  if ((await client.query('SELECT 1 FROM users WHERE lower(username)=lower($1) AND id<>$2', [cleanUsername, Number(userId)])).rows[0]) throw new Error('That username is already in use.');
  user.username = cleanUsername; user.display_name = String(displayName || cleanUsername).trim().slice(0, 80) || cleanUsername; user.role = cleanRole(role);
  if (String(password || '').trim()) { if (String(password).trim().length < 6) throw new Error('Password must be at least 6 characters.'); user.password_hash = await bcrypt.hash(String(password).trim(), 10); }
  await client.query(`UPDATE users SET username=$2,password_hash=$3,display_name=$4,role=$5,data=$6::jsonb WHERE id=$1`,
    [user.id, user.username, user.password_hash, user.display_name, user.role, JSON.stringify(user)]);
  const { password_hash, ...safe } = user; return safe;
}

export async function adjustAllUserBalancesWithClient(client, amount, note = '') {
  const value = Number(amount); if (!Number.isInteger(value) || value === 0) throw new Error('Balance adjustment must be a non-zero whole number.');
  const ids = (await client.query('SELECT id FROM users ORDER BY id')).rows.map(row => Number(row.id));
  for (const id of ids) { const user = await lockUser(client, id); await changeLockedUserBalance(client, user, value, { allowNegative: true });
    await addBalanceTransaction(client, { userId: id, amount: value, kind: 'admin_balance_adjustment', note: note ? `Admin adjustment: ${note}` : 'Admin balance adjustment' }); }
  return { count: ids.length, amount: value };
}

export const addUserPostgres = (pool, input) => withTransaction(pool, client => addUserWithClient(client, input));
export const updateUserDetailsPostgres = (pool, input) => withTransaction(pool, client => updateUserDetailsWithClient(client, input));
export const adjustAllUserBalancesPostgres = (pool, amount, note) => withTransaction(pool, client => adjustAllUserBalancesWithClient(client, amount, note));

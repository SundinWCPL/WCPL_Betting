const asNumber = value => Number(value || 0);

export function formatBalanceSummary(available, openWagered = 0) {
  const availableBalance = asNumber(available);
  const open = asNumber(openWagered);
  return {
    available_balance: availableBalance,
    open_wagered: open,
    total_balance: availableBalance + open,
    display: `${availableBalance + open} (${open})`
  };
}

export async function lockUser(client, userId) {
  const result = await client.query(
    'SELECT id, username, display_name, role, balance, data FROM users WHERE id = $1 FOR UPDATE',
    [Number(userId)]
  );
  if (!result.rows[0]) throw new Error('User not found.');
  return result.rows[0];
}

export async function setLockedUserBalance(client, user, nextBalance, { allowNegative = false } = {}) {
  const cleanBalance = asNumber(nextBalance);
  if (!Number.isInteger(cleanBalance)) throw new Error('Balance must be a whole number.');
  if (!allowNegative && cleanBalance < 0) throw new Error('Insufficient balance.');
  const nextData = { ...(user.data || {}), balance: cleanBalance };
  await client.query(
    'UPDATE users SET balance = $2, data = $3::jsonb WHERE id = $1',
    [user.id, cleanBalance, JSON.stringify(nextData)]
  );
  user.balance = cleanBalance;
  user.data = nextData;
  return cleanBalance;
}

export function changeLockedUserBalance(client, user, amount, options) {
  return setLockedUserBalance(client, user, asNumber(user.balance) + asNumber(amount), options);
}

export async function addBalanceTransaction(client, {
  userId,
  amount,
  kind,
  week = null,
  category = null,
  createdAt = new Date().toISOString(),
  ...details
}) {
  const id = asNumber((await client.query("SELECT nextval('balance_transactions_id_seq') AS id")).rows[0].id);
  const data = {
    id,
    user_id: Number(userId),
    ...(week == null ? {} : { week: Number(week) }),
    amount: asNumber(amount),
    kind: String(kind),
    ...(category == null ? {} : { category }),
    ...details,
    created_at: createdAt
  };
  await client.query(`
    INSERT INTO balance_transactions(id, user_id, week, amount, kind, category, created_at, source_order, data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
  `, [id, Number(userId), week == null ? null : Number(week), asNumber(amount), String(kind), category, createdAt, id, JSON.stringify(data)]);
  return data;
}

export async function getOpenWagered(client, userId) {
  const result = await client.query(
    "SELECT COALESCE(sum(stake), 0)::bigint AS total FROM bets WHERE user_id = $1 AND status = 'open'",
    [Number(userId)]
  );
  return asNumber(result.rows[0]?.total);
}

export async function getLockedBalanceSummary(client, user) {
  return formatBalanceSummary(user.balance, await getOpenWagered(client, user.id));
}

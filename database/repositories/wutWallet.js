const asNumber = value => Number(value || 0);

export async function lockWutMembership(client, userId, { requireStarter = true } = {}) {
  const result = await client.query(
    'SELECT user_id, wut_coins, data FROM wut_memberships WHERE user_id=$1 FOR UPDATE',
    [Number(userId)]
  );
  const membership = result.rows[0];
  if (!membership) throw new Error('That user has not joined WUT yet.');
  if (requireStarter && !membership.data?.starter_opened_at) throw new Error('Open your WUT starter pack first.');
  return membership;
}

export async function changeWutCoins(client, membership, amount, kind, details = {}, now = new Date()) {
  const value = asNumber(amount);
  const next = asNumber(membership.wut_coins) + value;
  if (next < 0) throw new Error('Insufficient WUT Coins.');
  const nextData = { ...(membership.data || {}), wut_coins: next };
  await client.query(
    'UPDATE wut_memberships SET wut_coins=$2, data=$3::jsonb WHERE user_id=$1',
    [membership.user_id, next, JSON.stringify(nextData)]
  );
  membership.wut_coins = next;
  membership.data = nextData;
  const id = asNumber((await client.query("SELECT nextval('wut_transactions_id_seq') AS id")).rows[0].id);
  const transaction = {
    id,
    user_id: Number(membership.user_id),
    amount: value,
    balance_after: next,
    kind: String(kind),
    ...details,
    created_at: now.toISOString()
  };
  await client.query(`
    INSERT INTO wut_transactions(id,user_id,amount,kind,created_at,source_order,data)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
  `, [id, membership.user_id, value, String(kind), transaction.created_at, id, JSON.stringify(transaction)]);
  return { balance: next, transaction };
}

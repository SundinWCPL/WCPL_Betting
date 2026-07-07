const cloneRows = rows => rows.map(row => structuredClone(row.data || {}));

export async function getUserBetsPostgres(pool, userId, limit = 20) {
  const result = await pool.query(`
    SELECT data FROM bets WHERE user_id=$1
    ORDER BY created_at DESC, id DESC LIMIT $2
  `, [Number(userId), Math.max(1, Number(limit) || 20)]);
  return cloneRows(result.rows);
}

export async function getUserBetsForWeekPostgres(pool, userId, week) {
  const result = await pool.query(`
    SELECT data FROM bets WHERE user_id=$1 AND week=$2
    ORDER BY COALESCE(series_key, prop_key, ''), id
  `, [Number(userId), Number(week)]);
  return cloneRows(result.rows);
}

function preferredVisibleBets(bets, kind, keyFor) {
  const map = new Map();
  for (const bet of bets) {
    if (!['open', 'settled'].includes(String(bet.status || 'open')) || (bet.bet_kind || 'series') !== kind) continue;
    const key = keyFor(bet);
    const existing = map.get(key);
    if (!existing || existing.status !== 'open' || bet.status === 'open') map.set(key, bet);
  }
  return Object.fromEntries(map);
}

export async function getUserBetsBySeriesPostgres(pool, userId, week) {
  return preferredVisibleBets(await getUserBetsForWeekPostgres(pool, userId, week), 'series', bet => bet.series_key);
}

export async function getUserPropBetsByCategoryPostgres(pool, userId, week) {
  return preferredVisibleBets(await getUserBetsForWeekPostgres(pool, userId, week), 'prop', bet => `${bet.division_id}|${bet.prop_category}`);
}

export async function getBalanceSummaryForUserPostgres(pool, userId) {
  const row = (await pool.query(`
    SELECT u.balance, COALESCE(sum(b.stake) FILTER (WHERE b.status='open'), 0) AS open_wagered
    FROM users u LEFT JOIN bets b ON b.user_id=u.id
    WHERE u.id=$1 GROUP BY u.id
  `, [Number(userId)])).rows[0];
  if (!row) return { available_balance: 0, open_wagered: 0, total_balance: 0, display: '0 (0)' };
  const available = Number(row.balance || 0);
  const open = Number(row.open_wagered || 0);
  return { available_balance: available, open_wagered: open, total_balance: available + open, display: `${available + open} (${open})` };
}

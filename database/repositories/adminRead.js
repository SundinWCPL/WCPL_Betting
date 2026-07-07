const clone = value => structuredClone(value || {});

export async function getAdminBetsForWeekPostgres(pool, week, statuses = ['open']) {
  const visible = (Array.isArray(statuses) ? statuses : [statuses]).map(String);
  const result = await pool.query(`
    SELECT b.*,u.display_name FROM bets b JOIN users u ON u.id=b.user_id
    WHERE b.week=$1 AND b.status=ANY($2::text[])
  `, [Number(week), visible]);
  return result.rows.map(row => {
    const bet = { ...clone(row.data), id: Number(row.id), user_id: Number(row.user_id), week: Number(row.week),
      status: row.status, bet_kind: row.bet_kind, stake: Number(row.stake), payout: row.payout == null ? null : Number(row.payout),
      user_display_name: row.display_name || `User ${row.user_id}` };
    bet.potential_return = Math.ceil(Number(bet.stake || 0) * Number(bet.multiplier || 0));
    return bet;
  }).sort((a, b) => String(a.bet_kind || '').localeCompare(String(b.bet_kind || '')) ||
    String(a.division_id || '').localeCompare(String(b.division_id || '')) || String(a.label || '').localeCompare(String(b.label || '')) ||
    String(a.user_display_name || '').localeCompare(String(b.user_display_name || '')));
}

export async function getUserSummariesPostgres(pool) {
  const result = await pool.query(`
    SELECT u.id,u.username,u.display_name,u.role,u.balance,COALESCE(sum(b.stake) FILTER (WHERE b.status='open'),0) AS open_wagered
    FROM users u LEFT JOIN bets b ON b.user_id=u.id GROUP BY u.id ORDER BY lower(u.display_name),u.id
  `);
  return result.rows.map(row => {
    const available = Number(row.balance || 0); const open = Number(row.open_wagered || 0); const total = available + open;
    return { id: Number(row.id), username: row.username, display_name: row.display_name, role: row.role,
      available_balance: available, open_wagered: open, total_balance: total, balance_display: `${total} (${open})` };
  });
}

export async function getVoidRefundsForWeekPostgres(pool, week, limit = 100) {
  const result = await pool.query(`
    SELECT t.*,u.display_name FROM balance_transactions t JOIN users u ON u.id=t.user_id
    WHERE t.kind='bet_void_refund' AND t.week=$1 ORDER BY t.created_at DESC NULLS LAST,t.id DESC LIMIT $2
  `, [Number(week), Math.max(1, Number(limit) || 100)]);
  return result.rows.map(row => ({ ...clone(row.data), id: Number(row.id), user_id: Number(row.user_id), week: Number(row.week),
    amount: Number(row.amount), kind: row.kind, category: row.category, created_at: row.created_at,
    user_display_name: row.display_name || `User ${row.user_id}` }));
}

export async function getOpenBetCountForWeekPostgres(pool, week) {
  return Number((await pool.query("SELECT count(*)::int AS count FROM bets WHERE week=$1 AND status='open'", [Number(week)])).rows[0].count);
}

export async function getCasinoSummaryPostgres(pool) {
  const [slots, puck, horses, config] = await Promise.all([
    pool.query('SELECT count(*)::int AS count,COALESCE(sum(wager),0) AS wagered,COALESCE(sum(payout),0) AS paid FROM casino_spins'),
    pool.query(`SELECT count(*)::int AS count,COALESCE(sum((data->>'wager')::numeric),0) AS wagered,COALESCE(sum((data->>'payout')::numeric),0) AS paid FROM shot_doctor_runs`),
    pool.query(`SELECT
      count(*) FILTER (WHERE entity_type='bet')::int AS bets,
      COALESCE(sum((data->>'stake')::numeric) FILTER (WHERE entity_type='bet'),0) AS wagered,
      COALESCE(sum((data->>'payout')::numeric) FILTER (WHERE entity_type='bet'),0) AS paid,
      COALESCE(sum((data->>'amount')::numeric) FILTER (WHERE entity_type='owner_reward' AND data->>'claimed_at' IS NOT NULL),0) AS owner_paid
      FROM horse_entities`),
    pool.query("SELECT data FROM app_documents WHERE document_key='horse_meta'")
  ]);
  const totalWagered = Number(slots.rows[0].wagered) + Number(puck.rows[0].wagered) + Number(horses.rows[0].wagered);
  const totalPaid = Number(slots.rows[0].paid) + Number(puck.rows[0].paid) + Number(horses.rows[0].paid) + Number(horses.rows[0].owner_paid);
  return { totalWagered, totalPaid, netProfit: totalPaid - totalWagered, slotSpins: slots.rows[0].count,
    puckIqRuns: puck.rows[0].count, horseRacingBets: horses.rows[0].bets,
    horseRacingConfig: config.rows[0]?.data?.config || {} };
}

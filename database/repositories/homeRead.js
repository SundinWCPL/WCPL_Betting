const clone = value => structuredClone(value || {});

export async function getLeaderboardsPostgres(pool, currentWeek) {
  const week = Number(currentWeek || 1);
  const rows = (await pool.query(`
    WITH bet_totals AS (
      SELECT user_id,
        COALESCE(sum(stake) FILTER (WHERE status='open'),0) AS open_wagered,
        COALESCE(sum(COALESCE(payout,0)-stake) FILTER (WHERE status IN ('open','settled')),0) AS sportsbook_net,
        COALESCE(sum(COALESCE(payout,0)-stake) FILTER (WHERE status IN ('open','settled') AND week=$1),0) AS sportsbook_current,
        COALESCE(sum(COALESCE(payout,0)-stake) FILTER (WHERE status IN ('open','settled') AND week=$2),0) AS sportsbook_last
      FROM bets GROUP BY user_id
    ), transaction_totals AS (
      SELECT user_id,
        COALESCE(sum(amount) FILTER (WHERE category IN ('casino','cards') AND week=$1),0) AS extras_current,
        COALESCE(sum(amount) FILTER (WHERE category IN ('casino','cards') AND week=$2),0) AS extras_last,
        COALESCE(sum(amount) FILTER (WHERE category='casino'),0) AS casino_net,
        COALESCE(sum(amount) FILTER (WHERE category='cards'),0) AS cards_net
      FROM balance_transactions GROUP BY user_id
    )
    SELECT u.id,u.username,u.display_name,u.balance,
      COALESCE(b.open_wagered,0) AS open_wagered,COALESCE(b.sportsbook_net,0) AS sportsbook_net,
      COALESCE(b.sportsbook_current,0) AS sportsbook_current,COALESCE(b.sportsbook_last,0) AS sportsbook_last,
      COALESCE(t.extras_current,0) AS extras_current,COALESCE(t.extras_last,0) AS extras_last,
      COALESCE(t.casino_net,0) AS casino_net,COALESCE(t.cards_net,0) AS cards_net
    FROM users u LEFT JOIN bet_totals b ON b.user_id=u.id LEFT JOIN transaction_totals t ON t.user_id=u.id ORDER BY u.id
  `, [week, week - 1])).rows.map(row => ({ ...row, id:Number(row.id), balance:Number(row.balance), open_wagered:Number(row.open_wagered), sportsbook_net:Number(row.sportsbook_net),
    sportsbook_current:Number(row.sportsbook_current), sportsbook_last:Number(row.sportsbook_last), extras_current:Number(row.extras_current), extras_last:Number(row.extras_last), casino_net:Number(row.casino_net), cards_net:Number(row.cards_net) }));
  const betting = rows.map(row => ({ id:row.id,display_name:row.display_name,username:row.username,balance:row.balance,open_wagered:row.open_wagered,casino_net:row.casino_net,cards_net:row.cards_net,
    total_balance:row.sportsbook_net,balance_display:String(row.sportsbook_net),last_week_change:row.sportsbook_last,current_week_change:row.sportsbook_current }))
    .sort((a,b) => b.total_balance-a.total_balance || a.display_name.localeCompare(b.display_name));
  const overall = rows.map(row => { const total=row.balance+row.open_wagered; return { id:row.id,display_name:row.display_name,username:row.username,balance:row.balance,open_wagered:row.open_wagered,casino_net:row.casino_net,cards_net:row.cards_net,
    total_balance:total,balance_display:`${total} (${row.open_wagered})`,last_week_change:row.sportsbook_last+row.extras_last,current_week_change:row.sportsbook_current+row.extras_current }; })
    .sort((a,b) => b.total_balance-a.total_balance || a.display_name.localeCompare(b.display_name));
  return { betting, overall };
}

export async function getWeeklyBetTotalByTeamPostgres(pool, week) {
  const rows = await pool.query(`SELECT data FROM bets WHERE week=$1 AND status IN ('open','settled') AND bet_kind='series'`, [Number(week)]); const totals = new Map();
  for (const row of rows.rows) { const bet=clone(row.data); const current=totals.get(bet.team_id)||{team_id:bet.team_id,total_stake:0,bet_count:0}; current.total_stake+=Number(bet.stake||0); current.bet_count++; totals.set(bet.team_id,current); }
  return [...totals.values()].sort((a,b)=>b.total_stake-a.total_stake);
}

export async function getTopWeeklyBetsPostgres(pool, week, limit = 5) {
  const rows = await pool.query(`SELECT data FROM bets WHERE week=$1 AND status IN ('open','settled')`, [Number(week)]); const totals=new Map();
  for (const row of rows.rows) { const bet=clone(row.data); const key=bet.market_key||bet.label; const current=totals.get(key)||{market_key:key,label:bet.label,team_id:bet.team_id,total_stake:0,bet_count:0}; current.total_stake+=Number(bet.stake||0); current.bet_count++; totals.set(key,current); }
  return [...totals.values()].sort((a,b)=>b.total_stake-a.total_stake||b.bet_count-a.bet_count).slice(0,limit);
}

export async function getUserSettledBetHistoryPostgres(pool, userId, limit = 200) {
  const rows = await pool.query(`SELECT data FROM bets WHERE user_id=$1 AND status='settled' ORDER BY settled_at DESC NULLS LAST,id DESC LIMIT $2`, [Number(userId),Math.max(1,Number(limit)||200)]);
  return rows.rows.map(row => { const bet=clone(row.data); const stake=Number(bet.stake||0); const payout=Number(bet.payout||0); const net=payout-stake; return { id:bet.id,week:Number(bet.week||0),label:bet.label,bet_kind:bet.bet_kind||'series',stake,multiplier:Number(bet.multiplier||0),payout,net,net_display:net>0?`+${net}`:String(net),result:bet.won?'Win':'Loss',won:Boolean(bet.won),result_summary:bet.result_summary||'',settled_at:bet.settled_at||'' }; });
}

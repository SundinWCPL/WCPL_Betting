import { withTransaction } from '../postgres.js';

const clone = value => structuredClone(value || {});
const cleanMultiplier = (value, label = 'Odds') => {
  const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than 0.`);
  return Number(number.toFixed(2));
};
const ensure = data => ({ series: {}, goalTotals: {}, propDefaults: {}, propPlayerOverrides: {}, seriesProps: {}, ...clone(data) });

async function lockOdds(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242042]);
  const row = (await client.query("SELECT data FROM app_documents WHERE document_key='odds_adjustments' FOR UPDATE")).rows[0];
  if (!row) throw new Error('Required PostgreSQL document is missing: odds_adjustments.');
  return ensure(row.data);
}
async function saveOdds(client, odds) {
  await client.query("UPDATE app_documents SET data=$1::jsonb,updated_at=now() WHERE document_key='odds_adjustments'", [JSON.stringify(odds)]);
}
export async function getOddsAdjustmentsForWeekPostgres(pool, week) {
  const row = (await pool.query("SELECT data FROM app_documents WHERE document_key='odds_adjustments'")).rows[0]; const all = ensure(row?.data); const key = String(Number(week));
  return { week: Number(week), series: clone(all.series[key]), goalTotals: clone(all.goalTotals[key]),
    propDefaults: clone(all.propDefaults[key]), propPlayerOverrides: clone(all.propPlayerOverrides[key]), seriesProps: clone(all.seriesProps[key]) };
}
async function updateBetData(client, id, data) { await client.query('UPDATE bets SET data=$2::jsonb WHERE id=$1', [id, JSON.stringify(data)]); }

export async function saveSeriesOddsForWeekWithClient(client, { week, marketKeys = [], multipliers = [], seriesKey, goalTotalLine, goalTotalBoost }) {
  const odds = await lockOdds(client); const wk = String(Number(week)); odds.series[wk] ||= {}; odds.goalTotals[wk] ||= {};
  const keys = Array.isArray(marketKeys) ? marketKeys : [marketKeys]; const values = Array.isArray(multipliers) ? multipliers : [multipliers];
  keys.forEach((raw, index) => { const key = String(raw || '').trim(); if (key) odds.series[wk][key] = cleanMultiplier(values[index], 'Series odds'); });
  const cleanSeriesKey = String(seriesKey || '').trim();
  if (cleanSeriesKey) {
    const line = cleanMultiplier(goalTotalLine, 'O/U line'); const boost = cleanMultiplier(goalTotalBoost, 'O/U boost');
    odds.goalTotals[wk][cleanSeriesKey] = { line, boost };
    const bets = await client.query("SELECT id,data FROM bets WHERE week=$1 AND status='open' AND bet_kind='series' AND series_key=$2 FOR UPDATE", [Number(week), cleanSeriesKey]);
    for (const row of bets.rows) { const data = clone(row.data); const base = odds.series[wk][data.market_key]; if (base == null) continue;
      data.multiplier = Number((Number(base) * (data.goal_total_side ? boost : 1)).toFixed(2));
      if (data.goal_total_side) { data.goal_total_line = line; data.goal_total_boost = boost; const side = data.goal_total_side === 'over' ? 'Over' : 'Under'; data.label = String(data.label || '').replace(/ \+ (Over|Under) [\d.]+$/, ` + ${side} ${line}`); }
      data.odds_updated_at = new Date().toISOString(); await updateBetData(client, row.id, data); }
  }
  await saveOdds(client, odds); return getOddsAdjustmentsForWeekPostgres(client, week);
}

const normalizeSeriesProp = market => {
  const tiers = (market.tiers || []).map((tier, index) => ({ quantity: index + 1, label: String(tier.label || '').trim(),
    line: cleanMultiplier(tier.line, 'Prop line'), multiplier: cleanMultiplier(tier.multiplier, 'Prop odds') }));
  if (tiers.length !== 3) throw new Error('All three prop tiers are required.');
  return { seriesKey: String(market.seriesKey || '').trim(), divisionId: String(market.divisionId || '').trim(), category: String(market.category || '').trim(),
    playerKey: String(market.playerKey || '').trim(), playerName: String(market.playerName || '').trim(), playerTeamId: String(market.playerTeamId || '').trim(),
    opponentTeamId: String(market.opponentTeamId || '').trim(), eligibility: String(market.eligibility || 'automatic').trim(), enabled: market.enabled !== false, tiers };
};
async function repriceSeriesProp(client, week, marketKey, market) {
  const rows = await client.query("SELECT id,data FROM bets WHERE week=$1 AND status='open' AND bet_kind='prop' AND data->>'market_key'=$2 FOR UPDATE", [Number(week), marketKey]);
  for (const row of rows.rows) { const data = clone(row.data); const tier = market.tiers.find(item => Number(item.quantity) === Number(data.quantity || 1)); if (!tier) continue;
    data.multiplier = tier.multiplier; data.prop_line = tier.line; data.label = `${market.divisionId} ${market.category === 'player_goals' ? 'Player Goals' : 'Goalie Shutouts'}: ${market.playerName} vs ${market.opponentTeamId} · ${tier.label}`;
    data.odds_updated_at = new Date().toISOString(); await updateBetData(client, row.id, data); }
}
export async function saveSeriesPropsForWeekWithClient(client, { week, markets }) {
  const odds = await lockOdds(client); const wk = String(Number(week)); odds.seriesProps[wk] ||= {};
  for (const market of markets || []) { const key = String(market.marketKey || '').trim(); if (!key) continue; const clean = normalizeSeriesProp(market); odds.seriesProps[wk][key] = clean; await repriceSeriesProp(client, week, key, clean); }
  const legacy = await client.query("SELECT id,data FROM bets WHERE week=$1 AND status='open' AND bet_kind='prop' AND COALESCE(series_key,'')='' AND data->>'prop_category'='shutout' FOR UPDATE", [Number(week)]);
  for (const row of legacy.rows) { const data=clone(row.data); const matching=Object.entries(odds.seriesProps[wk]).filter(([,market])=>market.category==='shutout'&&market.enabled!==false&&market.playerKey===data.player_key); if(matching.length!==1) continue;
    const [key,market]=matching[0]; const tier=market.tiers.find(item=>Number(item.quantity)===Number(data.quantity||1)); if(!tier) continue; data.series_key=market.seriesKey; data.market_key=key; data.multiplier=tier.multiplier; data.prop_line=tier.line; data.label=`${market.divisionId} Goalie Shutouts: ${market.playerName} vs ${market.opponentTeamId} · ${tier.label}`; data.odds_updated_at=new Date().toISOString();
    await client.query('UPDATE bets SET series_key=$2,data=$3::jsonb WHERE id=$1',[row.id,market.seriesKey,JSON.stringify(data)]); }
  await saveOdds(client, odds); return getOddsAdjustmentsForWeekPostgres(client, week);
}
export const saveSeriesPropForWeekWithClient = (client, { week, marketKey, config }) => saveSeriesPropsForWeekWithClient(client, { week, markets: [{ ...config, marketKey }] });

export async function savePropDefaultOddsForWeekWithClient(client, { week, divisionId, category, multiplier, quantity1, quantity2, quantity3 }) {
  const odds = await lockOdds(client); const wk = String(Number(week)); odds.propDefaults[wk] ||= {}; odds.propPlayerOverrides[wk] ||= {}; const prefix = `${divisionId}|${category}`;
  if (['top_scorer','top_goalie'].includes(category)) odds.propDefaults[wk][prefix] = cleanMultiplier(multiplier, 'Prop odds');
  else for (const [quantity, value] of [[1,quantity1],[2,quantity2],[3,quantity3]]) odds.propDefaults[wk][`${prefix}|${quantity}`] = cleanMultiplier(value, `${quantity}-result odds`);
  const rows = await client.query("SELECT id,data FROM bets WHERE week=$1 AND status='open' AND bet_kind='prop' AND data->>'division_id'=$2 AND data->>'prop_category'=$3 FOR UPDATE", [Number(week), divisionId, category]);
  for (const row of rows.rows) { const data = clone(row.data); const quantity = Number(data.quantity || 0); const key = quantity ? `${prefix}|${quantity}` : prefix; const override = quantity ? `${prefix}|${data.player_key}|${quantity}` : `${prefix}|${data.player_key}`;
    const value = odds.propPlayerOverrides[wk][override] ?? odds.propDefaults[wk][key]; if (value == null) continue; data.multiplier = value; data.odds_updated_at = new Date().toISOString(); await updateBetData(client, row.id, data); }
  await saveOdds(client, odds); return getOddsAdjustmentsForWeekPostgres(client, week);
}
export async function savePropPlayerOverrideForWeekWithClient(client, { week, divisionId, category, playerKey, multiplier, quantity = null }) {
  const odds = await lockOdds(client); const wk = String(Number(week)); odds.propPlayerOverrides[wk] ||= {}; const base = `${divisionId}|${category}|${playerKey}`; const key = quantity == null || quantity === '' ? base : `${base}|${Number(quantity)}`;
  const raw = String(multiplier ?? '').trim(); if (!raw) delete odds.propPlayerOverrides[wk][key]; else odds.propPlayerOverrides[wk][key] = cleanMultiplier(raw, 'Player override odds');
  if (raw) { const rows = await client.query("SELECT id,data FROM bets WHERE week=$1 AND status='open' AND bet_kind='prop' AND data->>'division_id'=$2 AND data->>'prop_category'=$3 AND data->>'player_key'=$4 FOR UPDATE", [Number(week), divisionId, category, playerKey]);
    for (const row of rows.rows) { const data = clone(row.data); if (quantity != null && quantity !== '' && Number(data.quantity) !== Number(quantity)) continue; data.multiplier = odds.propPlayerOverrides[wk][key]; data.odds_updated_at = new Date().toISOString(); await updateBetData(client, row.id, data); } }
  await saveOdds(client, odds); return getOddsAdjustmentsForWeekPostgres(client, week);
}
export async function clearPropPlayerOverrideForWeekWithClient(client, input) {
  const { week, divisionId, category, playerKey, quantity = null } = input; const odds = await lockOdds(client); const wk = String(Number(week)); const base = `${divisionId}|${category}|${playerKey}`; odds.propPlayerOverrides[wk] ||= {};
  if (quantity == null || quantity === '') { delete odds.propPlayerOverrides[wk][base]; for (const q of [1,2,3]) delete odds.propPlayerOverrides[wk][`${base}|${q}`]; } else delete odds.propPlayerOverrides[wk][`${base}|${Number(quantity)}`];
  await saveOdds(client, odds); return getOddsAdjustmentsForWeekPostgres(client, week);
}

export const saveSeriesOddsForWeekPostgres = (pool, input) => withTransaction(pool, client => saveSeriesOddsForWeekWithClient(client, input));
export const saveSeriesPropsForWeekPostgres = (pool, input) => withTransaction(pool, client => saveSeriesPropsForWeekWithClient(client, input));
export const saveSeriesPropForWeekPostgres = (pool, input) => withTransaction(pool, client => saveSeriesPropForWeekWithClient(client, input));
export const savePropDefaultOddsForWeekPostgres = (pool, input) => withTransaction(pool, client => savePropDefaultOddsForWeekWithClient(client, input));
export const savePropPlayerOverrideForWeekPostgres = (pool, input) => withTransaction(pool, client => savePropPlayerOverrideForWeekWithClient(client, input));
export const clearPropPlayerOverrideForWeekPostgres = (pool, input) => withTransaction(pool, client => clearPropPlayerOverrideForWeekWithClient(client, input));

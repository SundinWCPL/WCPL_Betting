import { withTransaction } from '../postgres.js';
import { WUT_LAUNCH_TRINKET_EFFECTS, WUT_TRINKET_ADMIN_FIELDS, normalizeWutTrinketEffect } from '../../services/wutBalanceRules.js';
import { DEFAULT_BOOST_PACK_CONFIG, DEFAULT_RARITY_THRESHOLDS, normalizeRarityThresholds } from '../../services/cards.js';
import { buildOwnedCardData } from './wutPacks.js';
import { addBalanceTransaction, changeLockedUserBalance, lockUser } from './wallet.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';

const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const packRarities = [...rarities, 'mythic'];
const packTypes = ['standard', 'premium', 'prestige'];
const families = Object.keys(WUT_LAUNCH_TRINKET_EFFECTS);
const missionKeys = ['daily_play_three', 'daily_first_win', 'daily_rotating', 'weekly_profit_500', 'weekly_category_coverage', 'weekly_rotating'];
const clone = value => JSON.parse(JSON.stringify(value));
const number = (value, label) => { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be 0 or more.`); return parsed; };

async function lockDocuments(client) {
  const rows = await client.query("SELECT document_key,data FROM app_documents WHERE document_key IN ('cards_meta','arena_meta') FOR UPDATE");
  return Object.fromEntries(rows.rows.map(row => [row.document_key, row.data || {}]));
}

const group = (input, name, keys, current) => Object.fromEntries(keys.map(key => [key,
  number(input?.[name]?.[key] ?? input?.[name]?.[`slot${key}`] ?? current?.[name]?.[key], `${name} ${key}`)]));

export async function saveCardsConfigWithClient(client, input) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const docs = await lockDocuments(client); const cardsMeta = docs.cards_meta || {}; const arenaMeta = docs.arena_meta || {};
  const current = cardsMeta.config || {}; const currentWut = current.wut || {};
  const playerPackPrices = group(input, 'playerPackPrices', packTypes, current);
  const currentBoostPack = {
    ...DEFAULT_BOOST_PACK_CONFIG,
    ...(current.boostPack || {}),
    commonRareOdds: { ...DEFAULT_BOOST_PACK_CONFIG.commonRareOdds, ...(current.boostPack?.commonRareOdds || {}) },
    guaranteedHighOdds: { ...DEFAULT_BOOST_PACK_CONFIG.guaranteedHighOdds, ...(current.boostPack?.guaranteedHighOdds || {}) }
  };
  const boostPackCommonRareRolls = Math.round(number(input?.boostPack?.commonRareRolls ?? currentBoostPack.commonRareRolls, 'Boost Pack common-rare rolls'));
  const boostPackGuaranteedHighRolls = Math.round(number(input?.boostPack?.guaranteedHighRolls ?? currentBoostPack.guaranteedHighRolls, 'Boost Pack guaranteed high rolls'));
  const boostPackOdds = (name, keys, rollCount) => {
    const values = Object.fromEntries(keys.map(key => [key,
      number(input?.boostPack?.[name]?.[key] ?? currentBoostPack[name]?.[key], `Boost Pack ${name} ${key}`)]));
    if (rollCount > 0 && Object.values(values).reduce((sum, value) => sum + value, 0) <= 0) throw new Error(`Boost Pack ${name} needs a positive weight.`);
    return values;
  };
  const boostPack = {
    price: Math.ceil(number(input?.boostPack?.price ?? currentBoostPack.price, 'Boost Pack price')),
    commonRareRolls: boostPackCommonRareRolls,
    guaranteedHighRolls: boostPackGuaranteedHighRolls,
    commonRareOdds: boostPackOdds('commonRareOdds', ['common', 'uncommon', 'rare'], boostPackCommonRareRolls),
    guaranteedHighOdds: boostPackOdds('guaranteedHighOdds', ['epic', 'legendary'], boostPackGuaranteedHighRolls)
  };
  if (boostPack.commonRareRolls + boostPack.guaranteedHighRolls <= 0) throw new Error('Boost Pack needs at least one boost.');
  const odds = name => Object.fromEntries(packTypes.map(pack => {
    const values = Object.fromEntries(packRarities.map(rarity => [rarity,
      number(input?.[name]?.[pack]?.[rarity] ?? current?.[name]?.[pack]?.[rarity], `${name} ${pack} ${rarity}`)]));
    if (Object.values(values).reduce((sum, value) => sum + value, 0) <= 0) throw new Error(`${name} ${pack} needs a positive weight.`);
    return [pack, values];
  }));
  const boostEffects = Object.fromEntries(['goal','assist','shot','grit','save','shutout'].map(type => [type,
    Object.fromEntries(rarities.map(rarity => [rarity, {
      per: Math.max(1, number(input?.boostEffects?.[type]?.[rarity]?.per ?? current.boostEffects?.[type]?.[rarity]?.per, `${type} ${rarity} interval`)),
      bonus: number(input?.boostEffects?.[type]?.[rarity]?.bonus ?? current.boostEffects?.[type]?.[rarity]?.bonus, `${type} ${rarity} bonus`)
    }]))]));
  const rarityThresholds = normalizeRarityThresholds(Object.fromEntries(['F','D','G'].map(position => {
    let previous = 0;
    const values = {};
    for (const rarity of ['uncommon','rare','epic','legendary']) {
      const value = number(input?.rarityThresholds?.[position]?.[rarity] ?? current.rarityThresholds?.[position]?.[rarity] ?? DEFAULT_RARITY_THRESHOLDS[position][rarity], `${position} ${rarity} rarity threshold`);
      if (value < previous) throw new Error(`${position} rarity thresholds must increase from Uncommon through Legendary.`);
      values[rarity] = value;
      previous = value;
    }
    return [position, values];
  })));
  const statPoints = Object.fromEntries(['goal','assist','shot','hit','block','save','shutout'].map(type => [type,
    number(input?.scoring?.statPoints?.[type] ?? current.scoring?.statPoints?.[type], `${type} fantasy points`)]));
  const rawSave = input?.scoring?.savePctBonuses;
  const saveRows = Array.isArray(rawSave) ? rawSave : rawSave && typeof rawSave === 'object'
    ? Object.keys(rawSave).sort((a, b) => Number(a) - Number(b)).map(key => rawSave[key]) : current.scoring?.savePctBonuses || [];
  if (!saveRows.length) throw new Error('At least one save percentage threshold is required.');
  const savePctBonuses = saveRows.map((row, index) => ({ threshold: number(row?.threshold, `Save threshold ${index + 1}`), multiplier: number(row?.multiplier, `Save multiplier ${index + 1}`) }))
    .sort((a, b) => a.threshold - b.threshold);
  if (savePctBonuses.some((row, index) => row.threshold > 1 || (index && row.threshold <= savePctBonuses[index - 1].threshold))) throw new Error('Save percentage thresholds must be unique and no greater than 1.');
  const submittedChemistry = input?.scoring?.chemistryBonuses;
  const chemistryBonuses = Object.fromEntries(['2','3','4','5'].map(count => [count, number(
    (Array.isArray(submittedChemistry) ? submittedChemistry[Number(count) - 2] : submittedChemistry?.[`players${count}`] ?? submittedChemistry?.[count]) ?? current.scoring?.chemistryBonuses?.[count],
    `${count}-player chemistry bonus`)]));
  const trinketShopOdds = Object.fromEntries(['1','2','3'].map(slot => {
    const values = Object.fromEntries(rarities.map(rarity => [rarity, number(
      input?.wut?.trinketShopOdds?.[`slot${slot}`]?.[rarity] ?? input?.wut?.trinketShopOdds?.[slot]?.[rarity] ?? currentWut.trinketShopOdds?.[slot]?.[rarity],
      `Trinket Shop slot ${slot} ${rarity}`)]));
    if (Object.values(values).reduce((sum, value) => sum + value, 0) <= 0) throw new Error(`Trinket Shop slot ${slot} needs a positive weight.`);
    return [slot, values];
  }));
  const trinketEffects = clone(currentWut.trinketEffects || WUT_LAUNCH_TRINKET_EFFECTS);
  for (const family of families) for (const rarity of rarities) {
    let effect = clone(normalizeWutTrinketEffect(family, rarity, trinketEffects[family]?.[rarity] ?? WUT_LAUNCH_TRINKET_EFFECTS[family][rarity]));
    for (const field of WUT_TRINKET_ADMIN_FIELDS[family] || []) {
      const currentValue = field.key === 'value'
        ? (effect && typeof effect === 'object' && Object.prototype.hasOwnProperty.call(effect, 'value') ? effect.value : effect)
        : effect?.[field.key];
      const submittedFields = input?.wut?.trinketEffects?.[family]?.[rarity];
      const submitted = submittedFields?.[/^\d+$/.test(field.key) ? `value${field.key}` : field.key] ?? submittedFields?.[field.key];
      let value = number(submitted ?? (field.kind === 'percent' ? Number(currentValue) * 100 : currentValue), `${family} ${rarity} ${field.label}`);
      if (field.kind === 'percent') value /= 100; if (field.kind === 'integer') value = Math.round(value);
      if (field.key === 'value' && effect && typeof effect === 'object' && Object.prototype.hasOwnProperty.call(effect, 'value')) effect.value = value;
      else if (field.key === 'value') effect = value;
      else effect[field.key] = value;
    }
    trinketEffects[family] ||= {}; trinketEffects[family][rarity] = effect;
  }
  const wut = { ...clone(currentWut),
    deckSize: Math.max(1, Math.round(number(input?.wut?.deckSize ?? currentWut.deckSize, 'Deck size'))),
    topLineupMaxPower: number(input?.wut?.topLineupMaxPower ?? currentWut.topLineupMaxPower, 'Top lineup Power cap'),
    slotPowerAllowance: Math.round(number(input?.wut?.slotPowerAllowance ?? currentWut.slotPowerAllowance, 'Slot Power allowance')),
    boostLoadCap: Math.round(number(input?.wut?.boostLoadCap ?? currentWut.boostLoadCap, 'Base Boost Load')),
    rewards: group(input?.wut, 'rewards', ['winner','loser','forfeitLoser'], currentWut),
    deckSlotCosts: group(input?.wut, 'deckSlotCosts', ['4','5','6','7','8'], currentWut),
    trinketPrices: group(input?.wut, 'trinketPrices', rarities, currentWut),
    trinketPowerValues: group(input?.wut, 'trinketPowerValues', rarities, currentWut),
    trinketRemovalWut: group(input?.wut, 'trinketRemovalWut', rarities, currentWut),
    trinketRemovalMushy: group(input?.wut, 'trinketRemovalMushy', rarities, currentWut),
    shopReroll: group(input?.wut, 'shopReroll', ['wut','mushy'], currentWut), trinketShopOdds, trinketEffects,
    missionRewards: group(input?.wut, 'missionRewards', missionKeys, currentWut) };
  const next = { playerPackPrices, playerTierOdds: odds('playerTierOdds'), boostRarityOdds: odds('boostRarityOdds'), rarityThresholds, boostPack,
    boostEffects, scoring: { statPoints, savePctBonuses, chemistryBonuses }, wut };
  const arenaInput = input?.arena || {}; const arena = { ...(arenaMeta.config || {}),
    turnHours: number(arenaInput.turnHours ?? arenaMeta.config?.turnHours, 'Turn hours'),
    pauseStartHour: Math.round(number(arenaInput.pauseStartHour ?? arenaMeta.config?.pauseStartHour, 'Pause start hour')),
    pauseEndHour: Math.round(number(arenaInput.pauseEndHour ?? arenaMeta.config?.pauseEndHour, 'Pause end hour')),
    maxActiveMatches: Math.max(1, Math.round(number(arenaInput.maxActiveMatches ?? arenaMeta.config?.maxActiveMatches, 'Maximum active matches'))),
    recentOpponentMatchCount: Math.round(number(arenaInput.recentOpponentMatchCount ?? arenaMeta.config?.recentOpponentMatchCount ?? 2, 'Recent opponent match count')),
    draftRewards: group(arenaInput, 'draftRewards', ['winner','loser','forfeitLoser'], { draftRewards: arenaMeta.config?.draftRewards || wut.rewards }),
    constructedRewards: group(arenaInput, 'constructedRewards', ['winner','loser','forfeitLoser'], { constructedRewards: arenaMeta.config?.constructedRewards || wut.rewards }),
    draftArena: {
      packCount: Math.max(1, Math.round(number(arenaInput.draftArena?.packCount ?? arenaMeta.config?.draftArena?.packCount ?? 10, 'Draft Arena pack count'))),
      playersPerPack: Math.round(number(arenaInput.draftArena?.playersPerPack ?? arenaMeta.config?.draftArena?.playersPerPack ?? 1, 'Draft Arena players per pack')),
      trinketsPerPack: Math.round(number(arenaInput.draftArena?.trinketsPerPack ?? arenaMeta.config?.draftArena?.trinketsPerPack ?? 1, 'Draft Arena trinkets per pack')),
      boostsPerPack: Math.round(number(arenaInput.draftArena?.boostsPerPack ?? arenaMeta.config?.draftArena?.boostsPerPack ?? 1, 'Draft Arena boosts per pack')),
      rarityWeights: Object.fromEntries(rarities.map(rarity => [rarity, number(arenaInput.draftArena?.rarityWeights?.[rarity] ?? arenaMeta.config?.draftArena?.rarityWeights?.[rarity] ?? { common: 30, uncommon: 30, rare: 25, epic: 10, legendary: 5 }[rarity], `Draft Arena ${rarity} rarity weight`)])),
      maxPacks: Object.fromEntries(rarities.map(rarity => [rarity, Math.round(number(arenaInput.draftArena?.maxPacks?.[rarity] ?? arenaMeta.config?.draftArena?.maxPacks?.[rarity] ?? { common: 4, uncommon: 4, rare: 3, epic: 2, legendary: 2 }[rarity], `Draft Arena ${rarity} max packs`))]))
    },
    winnerPrize: Number(wut.rewards.winner) };
  if (arena.draftArena.playersPerPack + arena.draftArena.trinketsPerPack + arena.draftArena.boostsPerPack <= 0) throw new Error('Draft Arena packs need at least one player, trinket, or boost choice.');
  if (Object.values(arena.draftArena.rarityWeights).reduce((sum, value) => sum + value, 0) <= 0) throw new Error('Draft Arena rarity weights need at least one positive value.');
  if (arena.turnHours <= 0 || arena.pauseStartHour > 23 || arena.pauseEndHour > 23) throw new Error('Arena timing values are invalid.');
  cardsMeta.config = next; arenaMeta.config = arena;
  await client.query("UPDATE app_documents SET data=$2::jsonb WHERE document_key=$1", ['cards_meta', JSON.stringify(cardsMeta)]);
  await client.query("UPDATE app_documents SET data=$2::jsonb WHERE document_key=$1", ['arena_meta', JSON.stringify(arenaMeta)]);
  const owned = await client.query('SELECT id,family,rarity,data FROM owned_trinkets FOR UPDATE');
  for (const row of owned.rows) { const data = row.data || {}; data.effect = clone(trinketEffects[row.family]?.[row.rarity] ?? data.effect);
    await client.query('UPDATE owned_trinkets SET data=$2::jsonb WHERE id=$1', [row.id, JSON.stringify(data)]); }
  const shops = await client.query("SELECT record_key,data FROM card_records WHERE collection='trinket_shops' FOR UPDATE");
  for (const row of shops.rows) { const data = row.data || {}; for (const offer of data.offers || []) if (!offer.sold_at) {
    offer.effect = clone(trinketEffects[offer.family]?.[offer.rarity]); offer.price = Number(wut.trinketPrices[offer.rarity]); offer.power_cost = Number(wut.trinketPowerValues[offer.rarity]); }
    await client.query("UPDATE card_records SET data=$2::jsonb WHERE collection='trinket_shops' AND record_key=$1", [row.record_key, JSON.stringify(data)]); }
  return { config: next, arena };
}

export async function patchCardsMetaWithClient(client, mutator) {
  const docs = await lockDocuments(client); const meta = clone(docs.cards_meta || {}); mutator(meta);
  await client.query("UPDATE app_documents SET data=$2::jsonb WHERE document_key=$1", ['cards_meta', JSON.stringify(meta)]); return meta;
}

export const saveCardsConfigPostgres = (pool, input) => withTransaction(pool, client => saveCardsConfigWithClient(client, input));
export const setWutFreeShopPurchasesPostgres = (pool, enabled) => withTransaction(pool, client => patchCardsMetaWithClient(client, meta => { meta.config.wut.freeShopPurchases = Boolean(enabled); }));

export async function voidActiveWutMatchesForAdminWithClient(client, { adminUserId = null, rewardAmount = 30, now = new Date() } = {}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const admin = await client.query('SELECT role FROM users WHERE id=$1', [Number(adminUserId)]);
  if (admin.rows[0]?.role !== 'admin') throw new Error('Admin access is required.');
  const docs = await lockDocuments(client);
  const cardsMeta = clone(docs.cards_meta || {});
  cardsMeta.rolloutActions ||= {};
  const amount = Math.max(0, Math.round(Number(rewardAmount || 30)));
  const voidedAt = now.toISOString();
  let arenaMatchesVoided = 0;
  let draftEventMatchesVoided = 0;
  let rewardTransactions = 0;
  let releasedBoosts = 0;
  let skippedAwarded = 0;

  const arenaRows = (await client.query(`
    SELECT match_key,numeric_id,data,status FROM arena_matches
    WHERE match_kind='arena' AND status IN ('drafting','choosing_first','active','scoring')
    FOR UPDATE
  `)).rows;
  for (const row of arenaRows) {
    const match = clone(row.data || {});
    if (match.wut_rewards_awarded_at || match.elo_updated_at) {
      skippedAwarded += 1;
      continue;
    }
    const placements = (await client.query('SELECT data FROM arena_placements WHERE match_key=$1 FOR UPDATE', [row.match_key])).rows.map(item => item.data || {});
    for (const placement of placements) {
      if (!placement.boost_id) continue;
      const boostRow = (await client.query('SELECT id,data FROM owned_boosts WHERE id=$1 FOR UPDATE', [Number(placement.boost_id)])).rows[0];
      const boost = boostRow?.data;
      if (!boost || (boost.used_match_id != null && Number(boost.used_match_id) !== Number(match.id))) continue;
      boost.consumed = false;
      delete boost.used_match_id;
      delete boost.used_slot;
      delete boost.consumed_at;
      await client.query('UPDATE owned_boosts SET consumed=false,data=$2::jsonb WHERE id=$1', [Number(boostRow.id), JSON.stringify(boost)]);
      releasedBoosts += 1;
    }
    const playerIds = [...new Set((match.player_ids || []).map(Number).filter(Number.isFinite))];
    for (const userId of playerIds) {
      if (!amount) continue;
      const membership = await lockWutMembership(client, userId, { requireStarter: false });
      await changeWutCoins(client, membership, amount, 'wut_active_match_void_compensation', {
        admin_user_id: Number(adminUserId),
        arena_match_id: Number(match.id),
        draft_event_id: null,
        draft_match_id: null,
        reason: 'Active WUT match voided by administrator'
      }, now);
      rewardTransactions += 1;
    }
    for (const entryId of match.entry_ids || []) {
      const entryRow = (await client.query('SELECT data FROM arena_entries WHERE id=$1 FOR UPDATE', [Number(entryId)])).rows[0];
      if (!entryRow) continue;
      const entry = clone(entryRow.data || {});
      entry.status = 'cancelled';
      entry.cancel_reason = 'admin_active_match_void';
      entry.cancelled_at = voidedAt;
      await client.query("UPDATE arena_entries SET status='cancelled',data=$2::jsonb WHERE id=$1", [Number(entryId), JSON.stringify(entry)]);
    }
    Object.assign(match, {
      status: 'cancelled',
      cancel_reason: 'admin_active_match_void',
      cancel_note: 'Voided by an administrator.',
      cancelled_at: voidedAt,
      voided_at: voidedAt,
      voided_by: Number(adminUserId),
      turn_deadline: null,
      current_player_id: null,
      scores: null,
      winner_user_id: null,
      forfeit_user_id: null
    });
    await client.query(`
      UPDATE arena_matches SET status='cancelled',current_player_id=NULL,turn_deadline=NULL,data=$2::jsonb WHERE match_key=$1
    `, [row.match_key, JSON.stringify(match)]);
    arenaMatchesVoided += 1;
  }

  const draftRows = (await client.query(`
    SELECT event_id,match_key,data,status FROM draft_matches
    WHERE status IN ('active','scoring')
    FOR UPDATE
  `)).rows;
  const touchedDraftEvents = new Set();
  for (const row of draftRows) {
    const match = clone(row.data || {});
    if (match.wut_rewards_awarded_at || match.elo_updated_at) {
      skippedAwarded += 1;
      continue;
    }
    const playerIds = [...new Set((match.player_ids || []).map(Number).filter(Number.isFinite))];
    for (const userId of playerIds) {
      if (!amount) continue;
      const membership = await lockWutMembership(client, userId, { requireStarter: false });
      await changeWutCoins(client, membership, amount, 'wut_active_match_void_compensation', {
        admin_user_id: Number(adminUserId),
        arena_match_id: null,
        draft_event_id: Number(row.event_id),
        draft_match_id: Number(match.id || row.match_key),
        reason: 'Active WUT match voided by administrator'
      }, now);
      rewardTransactions += 1;
    }
    Object.assign(match, {
      status: 'voided',
      voided_at: voidedAt,
      voided_by: Number(adminUserId),
      void_reason: 'Voided by an administrator.',
      turn_deadline: null,
      current_player_id: null,
      scores: null,
      winner_user_id: null,
      forfeit_user_id: null
    });
    await client.query(`
      UPDATE draft_matches SET status='voided',current_player_id=NULL,turn_deadline=NULL,data=$3::jsonb
      WHERE event_id=$1 AND match_key=$2
    `, [Number(row.event_id), row.match_key, JSON.stringify(match)]);
    touchedDraftEvents.add(Number(row.event_id));
    draftEventMatchesVoided += 1;
  }
  for (const eventId of touchedDraftEvents) {
    await client.query('UPDATE draft_events SET updated_at=$2 WHERE id=$1', [eventId, voidedAt]);
  }

  const result = {
    completed_at: voidedAt,
    admin_user_id: Number(adminUserId),
    reward_amount: amount,
    arena_matches_voided: arenaMatchesVoided,
    draft_event_matches_voided: draftEventMatchesVoided,
    reward_transactions: rewardTransactions,
    released_boosts: releasedBoosts,
    skipped_awarded_matches: skippedAwarded
  };
  cardsMeta.rolloutActions.lastActiveMatchVoid = result;
  await client.query("UPDATE app_documents SET data=$2::jsonb WHERE document_key=$1", ['cards_meta', JSON.stringify(cardsMeta)]);
  return result;
}

export const voidActiveWutMatchesForAdminPostgres = (pool, input) =>
  withTransaction(pool, client => voidActiveWutMatchesForAdminWithClient(client, input));

export const voidOngoingWutMatchesForRulesUpdatePostgres = voidActiveWutMatchesForAdminPostgres;

export async function refundWutTrinketRemovalFeesWithClient(client, { adminUserId = null, now = new Date() } = {}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const wutRows = await client.query(`
    SELECT id,user_id,amount,data FROM wut_transactions
    WHERE kind='trinket_removal' AND amount < 0
    ORDER BY id
  `);
  const wutRefunds = new Set((await client.query(`
    SELECT (data->>'source_transaction_id')::bigint AS id FROM wut_transactions
    WHERE kind='trinket_removal_refund' AND data ? 'source_transaction_id'
  `)).rows.map(row => Number(row.id)));
  const mushyRows = await client.query(`
    SELECT id,user_id,week,amount,data FROM balance_transactions
    WHERE kind='wut_trinket_removal' AND amount < 0
    ORDER BY id
  `);
  const mushyRefunds = new Set((await client.query(`
    SELECT (data->>'source_transaction_id')::bigint AS id FROM balance_transactions
    WHERE kind='wut_trinket_removal_refund' AND data ? 'source_transaction_id'
  `)).rows.map(row => Number(row.id)));
  let wutCount = 0; let wutAmount = 0; let mushyCount = 0; let mushyAmount = 0;
  for (const row of wutRows.rows) {
    if (wutRefunds.has(Number(row.id))) continue;
    const membership = await lockWutMembership(client, row.user_id, { requireStarter: false });
    const amount = Math.abs(Number(row.amount || 0));
    await changeWutCoins(client, membership, amount, 'trinket_removal_refund', {
      source_transaction_id: Number(row.id),
      source_trinket_id: row.data?.trinket_id == null ? null : Number(row.data.trinket_id),
      source_card_id: row.data?.card_id == null ? null : Number(row.data.card_id),
      admin_user_id: adminUserId == null ? null : Number(adminUserId)
    }, now);
    wutRefunds.add(Number(row.id)); wutCount += 1; wutAmount += amount;
  }
  for (const row of mushyRows.rows) {
    if (mushyRefunds.has(Number(row.id))) continue;
    const user = await lockUser(client, row.user_id);
    const amount = Math.abs(Number(row.amount || 0));
    await changeLockedUserBalance(client, user, amount);
    await addBalanceTransaction(client, {
      userId: row.user_id,
      week: row.week,
      amount,
      kind: 'wut_trinket_removal_refund',
      category: 'cards_convenience',
      note: `Refunded trinket removal transaction #${row.id}`,
      source_transaction_id: Number(row.id),
      source_trinket_id: row.data?.trinket_id == null ? null : Number(row.data.trinket_id),
      source_card_id: row.data?.card_id == null ? null : Number(row.data.card_id),
      admin_user_id: adminUserId == null ? null : Number(adminUserId),
      createdAt: now.toISOString()
    });
    mushyRefunds.add(Number(row.id)); mushyCount += 1; mushyAmount += amount;
  }
  const cardRows = await client.query(`
    SELECT id,data FROM owned_cards
    WHERE data ? 'trinket_id' AND data->>'trinket_id' IS NOT NULL AND data->>'trinket_id' <> 'null'
    FOR UPDATE
  `);
  for (const row of cardRows.rows) {
    const data = { ...(row.data || {}), trinket_id: null };
    await client.query('UPDATE owned_cards SET data=$2::jsonb WHERE id=$1', [row.id, JSON.stringify(data)]);
  }
  const trinketRows = await client.query(`
    SELECT id,data FROM owned_trinkets
    WHERE attached_card_id IS NOT NULL OR (data ? 'attached_card_id' AND data->>'attached_card_id' IS NOT NULL AND data->>'attached_card_id' <> 'null')
    FOR UPDATE
  `);
  for (const row of trinketRows.rows) {
    const data = { ...(row.data || {}), attached_card_id: null, detached_at: now.toISOString(), detach_reason: 'trinket_assignment_migration' };
    await client.query('UPDATE owned_trinkets SET attached_card_id=NULL,data=$2::jsonb WHERE id=$1', [row.id, JSON.stringify(data)]);
  }
  const deckRows = await client.query('DELETE FROM wut_decks RETURNING id');
  return {
    wutCount,
    wutAmount,
    mushyCount,
    mushyAmount,
    detachedCards: cardRows.rows.length,
    detachedTrinkets: trinketRows.rows.length,
    clearedDecks: deckRows.rows.length
  };
}

export const refundWutTrinketRemovalFeesPostgres = (pool, input) =>
  withTransaction(pool, client => refundWutTrinketRemovalFeesWithClient(client, input));
export const setCardsPositionOverridePostgres = (pool, key, position) => withTransaction(pool, client => patchCardsMetaWithClient(client, meta => {
  const clean = String(position || '').toUpperCase(); if (!['F','D','G'].includes(clean)) throw new Error('Position must be F, D, or G.'); meta.positionOverrides ||= {}; meta.positionOverrides[String(key)] = clean;
}));
export const setCardsTierOverridePostgres = (pool, key, tier) => withTransaction(pool, client => patchCardsMetaWithClient(client, meta => {
  const clean = String(tier || '').toLowerCase(); if (![...packRarities].includes(clean)) throw new Error('Invalid rarity.'); meta.tierOverrides ||= {}; meta.tierOverrides[String(key)] = clean;
}));

export const setCardsPlayerOverridesPostgres = (pool, { positions = {}, tiers = {} }) => withTransaction(pool, client => patchCardsMetaWithClient(client, meta => {
  const nextPositions = {}; const nextTiers = {};
  for (const [key, raw] of Object.entries(positions || {})) { const value = String(Array.isArray(raw) ? raw.at(-1) : raw || '').trim().toUpperCase(); if (!['','F','D','G'].includes(value)) throw new Error('Invalid card position override.'); if (value) nextPositions[String(key)] = value; }
  for (const [key, raw] of Object.entries(tiers || {})) { const value = String(Array.isArray(raw) ? raw.at(-1) : raw || '').trim().toLowerCase(); if (!['',...packRarities].includes(value)) throw new Error('Invalid card rarity override.'); if (value) nextTiers[String(key)] = value; }
  meta.positionOverrides = nextPositions; meta.tierOverrides = nextTiers;
}));

export const saveCalculatedCardTiersPostgres = (pool, catalog, now = new Date()) => withTransaction(pool, client => patchCardsMetaWithClient(client, meta => {
  meta.calculatedTiers = Object.fromEntries((catalog || []).map(player => [player.catalogKey, { tier: player.tier, position: player.position,
    weightedFpPerGame: Number(player.weightedFpPerGame || 0), expectedWutFpPerMatch: Number(player.expectedWutFpPerMatch || 0),
    rarityGamesPlayed: Number(player.rarityGamesPlayed || 0), rarityEligible: Boolean(player.rarityEligible), rarityProvisional: Boolean(player.rarityProvisional), updatedAt: now.toISOString() }]));
}));

export async function grantCardsTestItemWithClient(client, { userId, item, now = new Date() }) {
  const playerId = Number(userId); const membership = (await client.query('SELECT 1 FROM wut_memberships WHERE user_id=$1', [playerId])).rows[0]; if (!membership) throw new Error('That user has not joined WUT yet.');
  if (item.itemType === 'trinket') { const family = String(item.family || ''); const rarity = String(item.rarity || '').toLowerCase(); if (!families.includes(family) || !rarities.includes(rarity)) throw new Error('Choose a valid trinket and rarity.');
    const meta = (await client.query("SELECT data FROM app_documents WHERE document_key='cards_meta'")).rows[0]?.data || {}; const id = Number((await client.query("SELECT nextval('owned_trinkets_id_seq') AS id")).rows[0].id);
    const trinket = {
      id, user_id: playerId, family, rarity,
      effect: clone(normalizeWutTrinketEffect(family, rarity, meta.config?.wut?.trinketEffects?.[family]?.[rarity] ?? WUT_LAUNCH_TRINKET_EFFECTS[family][rarity])),
      attached_card_id: null, source: 'admin_grant', created_at: now.toISOString()
    };
    await client.query(`INSERT INTO owned_trinkets(id,user_id,family,rarity,attached_card_id,source_order,data) VALUES($1,$2,$3,$4,NULL,$5,$6::jsonb)`, [id,playerId,family,rarity,id,JSON.stringify(trinket)]); return trinket; }
  if (item.itemType === 'player') { const id = Number((await client.query("SELECT nextval('owned_cards_id_seq') AS id")).rows[0].id); const settings = (await client.query("SELECT data FROM app_documents WHERE document_key='settings'")).rows[0]?.data || {};
    const card = buildOwnedCardData(item, { id, userId: playerId, week: settings.currentWeek, createdAt: now.toISOString() }); await client.query(`INSERT INTO owned_cards(id,user_id,card_identity,edition,source_order,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [id,playerId,card.card_identity,card.edition,id,JSON.stringify(card)]); return card; }
  if (item.itemType === 'boost') { const id = Number((await client.query("SELECT nextval('owned_boosts_id_seq') AS id")).rows[0].id); const boost = { id,user_id:playerId,boost_type:item.boostType,rarity:item.rarity,effect:clone(item.effect),used_week:null,used_slot:'',consumed:false,created_at:now.toISOString() };
    await client.query(`INSERT INTO owned_boosts(id,user_id,consumed,source_order,data) VALUES($1,$2,false,$3,$4::jsonb)`, [id,playerId,id,JSON.stringify(boost)]); return boost; }
  throw new Error('Choose a valid item type.');
}
export const grantCardsTestItemPostgres = (pool, input) => withTransaction(pool, client => grantCardsTestItemWithClient(client, input));

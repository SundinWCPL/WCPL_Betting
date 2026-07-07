import { withTransaction } from '../postgres.js';
import { WUT_LAUNCH_TRINKET_EFFECTS, WUT_TRINKET_ADMIN_FIELDS } from '../../services/wutBalanceRules.js';
import { buildOwnedCardData } from './wutPacks.js';

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
    let effect = clone(trinketEffects[family]?.[rarity] ?? WUT_LAUNCH_TRINKET_EFFECTS[family][rarity]);
    for (const field of WUT_TRINKET_ADMIN_FIELDS[family] || []) {
      const currentValue = field.key === 'value' ? effect : effect?.[field.key];
      const submittedFields = input?.wut?.trinketEffects?.[family]?.[rarity];
      const submitted = submittedFields?.[/^\d+$/.test(field.key) ? `value${field.key}` : field.key] ?? submittedFields?.[field.key];
      let value = number(submitted ?? (field.kind === 'percent' ? Number(currentValue) * 100 : currentValue), `${family} ${rarity} ${field.label}`);
      if (field.kind === 'percent') value /= 100; if (field.kind === 'integer') value = Math.round(value);
      if (field.key === 'value') effect = value; else effect[field.key] = value;
    }
    trinketEffects[family] ||= {}; trinketEffects[family][rarity] = effect;
  }
  const wut = { ...clone(currentWut),
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
  const next = { playerPackPrices, playerTierOdds: odds('playerTierOdds'), boostRarityOdds: odds('boostRarityOdds'),
    boostEffects, scoring: { statPoints, savePctBonuses, chemistryBonuses }, wut };
  const arenaInput = input?.arena || {}; const arena = { ...(arenaMeta.config || {}),
    turnHours: number(arenaInput.turnHours ?? arenaMeta.config?.turnHours, 'Turn hours'),
    pauseStartHour: Math.round(number(arenaInput.pauseStartHour ?? arenaMeta.config?.pauseStartHour, 'Pause start hour')),
    pauseEndHour: Math.round(number(arenaInput.pauseEndHour ?? arenaMeta.config?.pauseEndHour, 'Pause end hour')),
    maxActiveMatches: Math.max(1, Math.round(number(arenaInput.maxActiveMatches ?? arenaMeta.config?.maxActiveMatches, 'Maximum active matches'))),
    winnerPrize: Number(wut.rewards.winner) };
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
    const trinket = { id, user_id: playerId, family, rarity, effect: clone(meta.config?.wut?.trinketEffects?.[family]?.[rarity] ?? WUT_LAUNCH_TRINKET_EFFECTS[family][rarity]), attached_card_id: null, source: 'admin_grant', created_at: now.toISOString() };
    await client.query(`INSERT INTO owned_trinkets(id,user_id,family,rarity,attached_card_id,source_order,data) VALUES($1,$2,$3,$4,NULL,$5,$6::jsonb)`, [id,playerId,family,rarity,id,JSON.stringify(trinket)]); return trinket; }
  if (item.itemType === 'player') { const id = Number((await client.query("SELECT nextval('owned_cards_id_seq') AS id")).rows[0].id); const settings = (await client.query("SELECT data FROM app_documents WHERE document_key='settings'")).rows[0]?.data || {};
    const card = buildOwnedCardData(item, { id, userId: playerId, week: settings.currentWeek, createdAt: now.toISOString() }); await client.query(`INSERT INTO owned_cards(id,user_id,card_identity,edition,source_order,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [id,playerId,card.card_identity,card.edition,id,JSON.stringify(card)]); return card; }
  if (item.itemType === 'boost') { const id = Number((await client.query("SELECT nextval('owned_boosts_id_seq') AS id")).rows[0].id); const boost = { id,user_id:playerId,boost_type:item.boostType,rarity:item.rarity,effect:clone(item.effect),used_week:null,used_slot:'',consumed:false,created_at:now.toISOString() };
    await client.query(`INSERT INTO owned_boosts(id,user_id,consumed,source_order,data) VALUES($1,$2,false,$3,$4::jsonb)`, [id,playerId,id,JSON.stringify(boost)]); return boost; }
  throw new Error('Choose a valid item type.');
}
export const grantCardsTestItemPostgres = (pool, input) => withTransaction(pool, client => grantCardsTestItemWithClient(client, input));

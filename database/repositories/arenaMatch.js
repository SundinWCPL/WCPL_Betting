import { withTransaction } from '../postgres.js';
import {
  arenaCurrentPlayerId,
  arenaRewards,
  arenaTurnCap,
  chooseAutomaticWutPlacements,
  markWutCaptainPatchRole,
  maxWutLegalPlacements,
  nextArenaDeadline,
  nextWutActivePlayer,
  skipWutNoLegalPlayers,
  WUT_CAPTAIN_PATCH_LIMIT,
  wutCaptainPatchCount
} from '../../services/arenaRuntime.js';
import { journeymanCandidateIdentity, journeymanCandidates, lockWardingChoices, resolveZebraStripes, trinketFitsWutPosition } from '../../services/wutBalanceRules.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';
import { addBalanceTransaction, changeLockedUserBalance, lockUser } from './wallet.js';

const SLOTS = ['F1', 'F2', 'D1', 'D2', 'G'];
const asNumber = value => Number(value || 0);
const currentPlayer = arenaCurrentPlayerId;
const CONSTRUCTED_SERIES_TARGET_WINS = 2;
const CONSTRUCTED_SERIES_MAX_GAMES = 3;
const firstPlayerDeciderId = match => Number(match?.first_player_decider_user_id ?? match?.coin_flip_winner_user_id);

async function cardsConfig(client) {
  const docs = await client.query(`
    SELECT document_key,data FROM app_documents
    WHERE document_key IN ('cards_meta','arena_meta')
  `);
  const map = Object.fromEntries(docs.rows.map(row => [row.document_key, row.data || {}]));
  return { wut: map.cards_meta?.config?.wut || {}, arena: map.arena_meta?.config || {} };
}

function startConstructedGame(match, firstPlayerId, now, arenaConfig) {
  match.first_player_id = Number(firstPlayerId);
  match.current_player_id = Number(firstPlayerId);
  match.status = 'active';
  match.turn_index = 0;
  match.turn_deadline = nextArenaDeadline(now, arenaConfig);
  match.placements = [];
  match.scores = null;
  match.winner_user_id = null;
  match.exhausted_user_ids = [];
  match.started_at ||= now.toISOString();
}

function prepareNextConstructedGame(match, now, arenaConfig) {
  const nextGameNumber = Number(match.series_games?.length || 0) + 1;
  if (nextGameNumber === 2) {
    const gameOneStarter = Number(match.series_games?.[0]?.first_player_id);
    const gameTwoStarter = Number(match.player_ids.find(id => Number(id) !== gameOneStarter) ?? match.player_ids[0]);
    match.series_game_number = 2;
    startConstructedGame(match, gameTwoStarter, now, arenaConfig);
    match.first_player_decider_user_id = null;
    match.first_player_decider_reason = 'game_two_reverse';
    return;
  }
  const ids = match.player_ids.map(Number);
  const fp = match.series_total_fp || {};
  const firstFp = asNumber(fp[String(ids[0])]);
  const secondFp = asNumber(fp[String(ids[1])]);
  const tied = firstFp === secondFp;
  const decider = tied ? Number(Math.random() < 0.5 ? ids[0] : ids[1]) : firstFp > secondFp ? ids[0] : ids[1];
  match.series_game_number = nextGameNumber;
  match.coin_flip_winner_user_id = tied ? decider : null;
  match.first_player_decider_user_id = decider;
  match.first_player_decider_reason = tied ? 'game_three_tied_differential_coin_flip' : 'game_three_fp_differential';
  match.first_player_id = null;
  match.current_player_id = null;
  match.status = 'choosing_first';
  match.turn_index = 0;
  match.turn_deadline = nextArenaDeadline(now, arenaConfig);
  match.placements = [];
  match.scores = null;
  match.winner_user_id = null;
  match.exhausted_user_ids = [];
}

function resolveConstructedSeriesWinner(match) {
  const ids = match.player_ids.map(Number);
  const wins = match.series_wins || {};
  const firstWins = asNumber(wins[String(ids[0])]);
  const secondWins = asNumber(wins[String(ids[1])]);
  if (firstWins !== secondWins) return firstWins > secondWins ? ids[0] : ids[1];
  const fp = match.series_total_fp || {};
  const firstFp = asNumber(fp[String(ids[0])]);
  const secondFp = asNumber(fp[String(ids[1])]);
  if (firstFp !== secondFp) {
    match.series_tiebreak = 'aggregate_fp';
    return firstFp > secondFp ? ids[0] : ids[1];
  }
  match.series_tiebreak = 'draw';
  return null;
}

function lockJourneyman(existing, added, effects) {
  const all = [...existing, ...added].map(row => ({
    row, userId: Number(row.user_id), slot: row.slot,
    printedChemistryKey: row.card_snapshot?.chemistry_key || '',
    trinket: row.card_snapshot?.trinket || null
  }));
  for (const entry of all.filter(item => added.includes(item.row) && item.trinket?.family === 'journeyman')) {
    const preexistingZebra = all.some(candidate => existing.includes(candidate.row) && candidate.userId !== entry.userId &&
      candidate.slot === entry.slot && candidate.trinket?.family === 'zebra_stripes');
    entry.row.journeyman_zebra_preexisting = preexistingZebra;
    const effective = preexistingZebra ? resolveZebraStripes(all, effects).find(item => item.row === entry.row) || entry : entry;
    if (effective.trinket?.family !== 'journeyman') {
      entry.row.journeyman_key = '';
      continue;
    }
    const allowed = new Set(journeymanCandidates(effective, all).map(journeymanCandidateIdentity));
    if (!String(effective.trinket.effect?.mode || '').startsWith('random_')) {
      const chosen = String(entry.row.journeyman_key || '').trim();
      if (allowed.size && !allowed.has(chosen)) throw new Error('Choose an eligible team for Journeyman before locking this card.');
      entry.row.journeyman_key = chosen;
    }
  }
}

function draftItemById(match, itemId) {
  for (const pack of match.mini_draft?.packs || []) {
    const groups = [
      ['player', pack.players || (pack.player ? [pack.player] : [])],
      ['trinket', pack.trinkets || (pack.trinket ? [pack.trinket] : [])],
      ['boost', pack.boosts || (pack.boost ? [pack.boost] : [])]
    ];
    for (const [type, items] of groups) {
      const item = (items || []).find(candidate => Number(candidate?.id) === Number(itemId));
      if (item) return { pack, type, item };
    }
  }
  return null;
}

function draftItemByPackAndId(match, packIndex, itemId) {
  const found = draftItemById(match, itemId);
  return found && Number(found.pack?.index) === Number(packIndex) ? found : null;
}

function lockedDraftProgress(match, userId) {
  match.draft_progress ||= {};
  const key = String(Number(userId));
  match.draft_progress[key] ||= { picks: {}, updated_at: null };
  match.draft_progress[key].picks ||= {};
  return match.draft_progress[key];
}

function draftCardSnapshot(item, trinket, wutConfig) {
  const player = item?.player_snapshot;
  const rarity = player?.tier || item?.rarity || 'common';
  return {
    card_id: Number(item.id), card_identity: player.cardIdentity || player.catalogKey || String(item.id),
    position: player.position, rarity, team_id: player.teamId || '', team_name: player.teamName || player.teamId || '',
    season: player.season || player.edition || '', chemistry_key: player.chemistryKey || `${player.season || player.edition || ''}|${player.teamId || ''}`,
    display_name: player.displayName || player.name || '', base_power: asNumber(wutConfig.rarityCosts?.[rarity] || 1),
    power: asNumber(wutConfig.rarityCosts?.[rarity] || 1) + asNumber(wutConfig.trinketPowerValues?.[trinket?.rarity] || 0),
    player: JSON.parse(JSON.stringify(player)), trinket: trinket ? JSON.parse(JSON.stringify(trinket)) : null
  };
}

export async function submitArenaDraftPrepWithClient(client, { userId, matchId, picks, trinketAttachments = {}, now = new Date() }) {
  const result = await client.query("SELECT match_key,data,status FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena' FOR UPDATE", [Number(matchId)]);
  const row = result.rows[0];
  const match = row?.data;
  if (!match || match.mode !== 'draft' || !(match.player_ids || []).map(Number).includes(Number(userId))) throw new Error('Draft Arena match not found.');
  if (row.status !== 'drafting') throw new Error('This draft is no longer accepting picks.');
  const userKey = String(Number(userId));
  if (match.draft_loadouts?.[userKey]?.submitted_at) throw new Error('Your Draft Arena picks are already locked.');
  const packs = match.mini_draft?.packs || [];
  const lockedPicks = match.draft_progress?.[userKey]?.picks || {};
  if (packs.length && packs.some(pack => !lockedPicks[String(pack.index)])) throw new Error('Draft Arena packs must be picked in order before locking prep.');
  const picked = new Map();
  for (const [rawPackIndex, rawItemId] of Object.entries(lockedPicks)) {
    const packIndex = Number(rawPackIndex);
    if (String(picks?.[String(rawPackIndex)] || '') !== String(rawItemId)) throw new Error('Draft Arena picks changed after they were locked.');
    const found = draftItemByPackAndId(match, packIndex, rawItemId);
    if (!found || Number(found.pack.index) !== packIndex) throw new Error('Each pack must be picked from its own three choices.');
    picked.set(packIndex, found);
  }
  if (picked.size !== packs.length || packs.some(pack => !picked.has(Number(pack.index)))) throw new Error('Pick exactly one item from each Draft Arena pack.');
  const config = await cardsConfig(client);
  const selected = [...picked.values()].map(item => item.item);
  const players = selected.filter(item => item.item_type === 'player');
  const trinkets = new Map(selected.filter(item => item.item_type === 'trinket').map(item => [Number(item.id), item]));
  const boosts = selected.filter(item => item.item_type === 'boost');
  const playerIds = new Set(players.map(item => Number(item.id)));
  const trinketForPlayer = new Map();
  for (const [rawTrinketId, rawPlayerId] of Object.entries(trinketAttachments || {})) {
    const trinketId = Number(rawTrinketId); const playerId = Number(rawPlayerId);
    if (!playerId) continue;
    const trinket = trinkets.get(trinketId); const player = players.find(item => Number(item.id) === playerId);
    if (!trinket || !playerIds.has(playerId)) throw new Error('Trinket attachments must use drafted trinkets and drafted players.');
    if (trinketForPlayer.has(playerId)) throw new Error('Only one trinket can be attached to a drafted player.');
    if (!trinketFitsWutPosition(trinket.family, player?.player_snapshot?.position)) throw new Error('That trinket is not legal for that player position.');
    trinketForPlayer.set(playerId, trinket);
  }
  const active = players.map(item => draftCardSnapshot(item, trinketForPlayer.get(Number(item.id)) || null, config.wut));
  match.deck_snapshots ||= {};
  match.deck_snapshots[userKey] = { active, snapshot_at: now.toISOString(), source: 'draft_arena' };
  match.draft_loadouts ||= {};
  match.draft_loadouts[userKey] = {
    submitted_at: now.toISOString(),
    picks: Object.fromEntries([...picked.entries()].map(([index, found]) => [String(index), Number(found.item.id)])),
    counts: { F: active.filter(card => card.position === 'F').length, D: active.filter(card => card.position === 'D').length, G: active.filter(card => card.position === 'G').length },
    boosts: boosts.map(boost => ({ ...boost, effect: config.boostEffects?.[boost.boost_type]?.[boost.rarity] || boost.effect || null })),
    trinket_attachments: Object.fromEntries([...trinketForPlayer.entries()].map(([playerId, trinket]) => [String(trinket.id), Number(playerId)]))
  };
  const ready = match.player_ids.map(id => String(id)).every(key => match.draft_loadouts?.[key]?.submitted_at);
  if (ready) {
    match.status = 'active';
    match.current_player_id = Number(match.first_player_id);
    match.turn_deadline = nextArenaDeadline(now, config.arena);
    match.draft_locked_at = now.toISOString();
  }
  await client.query('UPDATE arena_matches SET status=$2,current_player_id=$3,turn_deadline=$4,data=$5::jsonb WHERE match_key=$1',
    [row.match_key, match.status, match.current_player_id || null, match.turn_deadline || null, JSON.stringify(match)]);
  return match;
}

export async function recordArenaDraftPickProgressWithClient(client, { userId, matchId, packIndex, itemId, now = new Date() }) {
  const result = await client.query("SELECT match_key,data,status FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena' FOR UPDATE", [Number(matchId)]);
  const row = result.rows[0];
  const match = row?.data;
  if (!match || match.mode !== 'draft' || !(match.player_ids || []).map(Number).includes(Number(userId))) throw new Error('Draft Arena match not found.');
  if (row.status !== 'drafting') throw new Error('This draft is no longer accepting picks.');
  const userKey = String(Number(userId));
  if (match.draft_loadouts?.[userKey]?.submitted_at) throw new Error('Your Draft Arena picks are already locked.');
  const packs = match.mini_draft?.packs || [];
  const cleanPackIndex = Number(packIndex);
  if (!packs.some(pack => Number(pack.index) === cleanPackIndex)) throw new Error('Draft Arena pack not found.');
  const progress = lockedDraftProgress(match, userId);
  const existing = progress.picks[String(cleanPackIndex)];
  if (existing != null) {
    if (Number(existing) !== Number(itemId)) throw new Error('That Draft Arena pack pick is already locked.');
    return { packIndex: cleanPackIndex, itemId: Number(existing), alreadyLocked: true };
  }
  const expectedPackIndex = Number(packs[Object.keys(progress.picks).length]?.index);
  if (cleanPackIndex !== expectedPackIndex) throw new Error('Draft Arena packs must be picked in order.');
  if (!draftItemByPackAndId(match, cleanPackIndex, itemId)) throw new Error('That item is not in this Draft Arena pack.');
  progress.picks[String(cleanPackIndex)] = Number(itemId);
  progress.updated_at = now.toISOString();
  await client.query('UPDATE arena_matches SET data=$2::jsonb WHERE match_key=$1', [row.match_key, JSON.stringify(match)]);
  return { packIndex: cleanPackIndex, itemId: Number(itemId), alreadyLocked: false };
}

export const recordArenaDraftPickProgressPostgres = (pool, input) => withTransaction(pool, client => recordArenaDraftPickProgressWithClient(client, input));

export const submitArenaDraftPrepPostgres = (pool, input) => withTransaction(pool, client => submitArenaDraftPrepWithClient(client, input));

export async function chooseArenaFirstPlayerWithClient(client, { userId, matchId, choice = 'self', now = new Date() }) {
  const result = await client.query(
    "SELECT match_key,data,status FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena' FOR UPDATE",
    [Number(matchId)]
  );
  const row = result.rows[0];
  const match = row?.data;
  if (!match || match.mode !== 'constructed' || !(match.player_ids || []).map(Number).includes(Number(userId))) {
    throw new Error('Constructed Arena match not found.');
  }
  if (row.status !== 'choosing_first') throw new Error('This match is not waiting on first-player selection.');
  if (firstPlayerDeciderId(match) !== Number(userId)) throw new Error('Only the first-player decider can choose who plays first.');
  const config = await cardsConfig(client);
  const opponentId = Number(match.player_ids.find(id => Number(id) !== Number(userId)));
  const firstPlayerId = String(choice) === 'opponent' ? opponentId : Number(userId);
  startConstructedGame(match, firstPlayerId, now, config.arena);
  await client.query('UPDATE arena_matches SET status=$2,current_player_id=$3,turn_deadline=$4,data=$5::jsonb WHERE match_key=$1',
    [row.match_key, match.status, match.current_player_id || null, match.turn_deadline || null, JSON.stringify(match)]);
  return match;
}

export const chooseArenaFirstPlayerPostgres = (pool, input) => withTransaction(pool, client => chooseArenaFirstPlayerWithClient(client, input));

export async function commitArenaTurnWithClient(client, {
  userId, matchId, placements, now = new Date(), automatic = false
}) {
  const matchResult = await client.query(
    "SELECT match_key,data,status FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena' FOR UPDATE",
    [Number(matchId)]
  );
  const matchRow = matchResult.rows[0];
  const match = matchRow?.data;
  if (!match || !(match.player_ids || []).map(Number).includes(Number(userId))) throw new Error('WUT match not found.');
  if (matchRow.status !== 'active') throw new Error('This WUT match is already resolved.');
  const existing = (await client.query(
    'SELECT placement_index,data FROM arena_placements WHERE match_key=$1 ORDER BY placement_index FOR UPDATE',
    [matchRow.match_key]
  )).rows.map(row => row.data || {});
  const config = await cardsConfig(client);
  if (currentPlayer(match) !== Number(userId)) throw new Error('It is not your turn.');
  const deckCards = new Map([
    ...(match.deck_snapshots?.[String(userId)]?.active || [])
  ].map(card => [Number(card.card_id), card]));
  const draftMode = match.mode === 'draft';
  const draftBoosts = new Map((match.draft_loadouts?.[String(userId)]?.boosts || []).map(boost => [Number(boost.id), boost]));
  const turnCap = arenaTurnCap(match);
  const legalAtStart = maxWutLegalPlacements({
    cards: [...deckCards.values()], placements: existing, userId,
    slotPowerAllowance: config.wut.slotPowerAllowance || 1, trinketFits: trinketFitsWutPosition
  }, turnCap);
  const required = legalAtStart;
  if (required <= 0) {
    skipWutNoLegalPlayers(match, existing, {
      slotPowerAllowance: config.wut.slotPowerAllowance || 1,
      trinketFits: trinketFitsWutPosition,
      cardsForUser: id => match.deck_snapshots?.[String(id)]?.active || []
    });
    const status = match.status === 'scoring' ? 'scoring' : 'active';
    const deadline = status === 'active' ? nextArenaDeadline(now, config.arena) : null;
    match.status = status;
    match.turn_deadline = deadline;
    await client.query(`
      UPDATE arena_matches SET status=$2,current_player_id=$3,turn_deadline=$4,data=$5::jsonb
      WHERE match_key=$1
    `, [matchRow.match_key, status, match.current_player_id || null, deadline, JSON.stringify(match)]);
    return { ...match, placements: existing, current_player_id: match.current_player_id || null };
  }
  if (!Array.isArray(placements) || placements.length !== required) {
    throw new Error(`This turn requires ${required} legal card${required === 1 ? '' : 's'}.`);
  }
  const occupiedSlots = new Set(existing.filter(row => Number(row.user_id) === Number(userId)).map(row => row.slot));
  const committedIds = new Set(existing.filter(row => Number(row.user_id) === Number(userId)).map(row => Number(row.card_id)));
  const identities = new Set(existing.filter(row => Number(row.user_id) === Number(userId)).map(row => row.card_snapshot?.card_identity).filter(Boolean));
  const turnSlots = new Set();
  const turnCards = new Set();
  const turnIdentities = new Set();
  const turnBoosts = new Set();
  const added = [];
  let captainCount = wutCaptainPatchCount(existing, userId);
  for (const input of placements) {
    const slot = String(input.slot || '').toUpperCase();
    if (!SLOTS.includes(slot) || occupiedSlots.has(slot) || turnSlots.has(slot)) throw new Error('Choose each open lineup slot only once.');
    turnSlots.add(slot);
    const cardId = Number(input.cardId);
    const snapshot = deckCards.get(cardId);
    if (!snapshot) throw new Error('That card is not in this match deck snapshot.');
    let placedSnapshot = snapshot;
    const owned = draftMode ? { rows: [{ data: { card_identity: snapshot.card_identity } }] } : await client.query('SELECT data FROM owned_cards WHERE id=$1 AND user_id=$2', [cardId, Number(userId)]);
    if (!owned.rows[0]) throw new Error('Card not found in your collection.');
    if (committedIds.has(cardId) || turnCards.has(cardId)) throw new Error('That card is already committed to this WUT match.');
    turnCards.add(cardId);
    const identity = String(snapshot.card_identity || owned.rows[0].data?.card_identity || '');
    if (identity && (identities.has(identity) || turnIdentities.has(identity))) throw new Error('That player card is already in this lineup.');
    if (identity) turnIdentities.add(identity);
    const requiredPosition = slot === 'G' ? 'G' : slot[0];
    if (snapshot.position !== requiredPosition) throw new Error(`That card is not eligible for ${slot}.`);
    if (!trinketFitsWutPosition(snapshot.trinket?.family, snapshot.position)) throw new Error('That trinket is not legal for this card position.');
    if (snapshot.trinket?.family === 'team_crest') {
      if (captainCount >= WUT_CAPTAIN_PATCH_LIMIT) throw new Error(`Only ${WUT_CAPTAIN_PATCH_LIMIT} Captain's Patches can be active in a lineup.`);
      placedSnapshot = markWutCaptainPatchRole(snapshot, captainCount);
      captainCount += 1;
    }
    const opposing = existing.find(row => Number(row.user_id) !== Number(userId) && row.slot === slot);
    if (opposing && asNumber(snapshot.power) > asNumber(opposing.power) + asNumber(config.wut.slotPowerAllowance || 1)) {
      throw new Error(`${slot} exceeds the opposing card's Power +${config.wut.slotPowerAllowance || 1}.`);
    }
    let boost = null;
    let boostLoad = 0;
    if (input.boostId) {
      const boostResult = draftMode ? { rows: [] } : await client.query('SELECT id,consumed,data FROM owned_boosts WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(input.boostId), Number(userId)]);
      boost = draftMode ? { id: Number(input.boostId), consumed: false, data: draftBoosts.get(Number(input.boostId)) } : boostResult.rows[0];
      const usedElsewhere = draftMode ? { rows: existing.some(row => Number(row.user_id) === Number(userId) && Number(row.boost_id) === Number(input.boostId)) ? [1] : [] } : await client.query(`
        SELECT 1 FROM arena_placements p JOIN arena_matches m ON m.match_key=p.match_key
        WHERE p.data->>'boost_id'=$1 AND m.status IN ('active','scoring') LIMIT 1
      `, [String(input.boostId)]);
      if (!boost || !boost.data || boost.consumed || turnBoosts.has(Number(boost.id)) || usedElsewhere.rows[0]) throw new Error('That boost is unavailable.');
      const goalieBoost = ['save', 'shutout'].includes(boost.data?.boost_type);
      if ((snapshot.position === 'G') !== goalieBoost) throw new Error('That boost does not fit this position.');
      boostLoad = asNumber(config.wut.rarityCosts?.[boost.data?.rarity] || 1);
      turnBoosts.add(Number(boost.id));
    }
    added.push({
      user_id: Number(userId), slot, card_id: cardId, boost_id: boost?.id ? Number(boost.id) : null,
      boost_load: boostLoad, power: asNumber(placedSnapshot.power), card_snapshot: JSON.parse(JSON.stringify(placedSnapshot)),
      journeyman_key: String(input.journeymanKey || ''), ward_target_slot: String(input.wardTargetSlot || '').toUpperCase(),
      automatic: Boolean(automatic), committed_at: now.toISOString()
    });
  }
  const snapshots = [...existing.filter(row => Number(row.user_id) === Number(userId)).map(row => row.card_snapshot), ...added.map(row => row.card_snapshot)].filter(Boolean);
  const loadBonus = Math.max(0, ...snapshots.filter(snapshot => snapshot.trinket?.family === 'booster_cable')
    .map(snapshot => asNumber(snapshot.trinket?.effect?.loadBonus)));
  const usedLoad = existing.filter(row => Number(row.user_id) === Number(userId)).reduce((sum, row) => sum + asNumber(row.boost_load), 0);
  const newLoad = added.reduce((sum, row) => sum + asNumber(row.boost_load), 0);
  if (usedLoad + newLoad > asNumber(config.wut.boostLoadCap || 5) + loadBonus) {
    throw new Error(`That boost exceeds your ${asNumber(config.wut.boostLoadCap || 5) + loadBonus} Boost Load for this match.`);
  }
  lockJourneyman(existing, added, config.wut.trinketEffects || {});
  lockWardingChoices(existing, added, { automatic });
  let placementIndex = existing.length;
  for (const row of added) {
    await client.query(`
      INSERT INTO arena_placements(match_key,placement_index,user_id,slot,card_id,data)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)
    `, [matchRow.match_key, placementIndex++, row.user_id, row.slot, row.card_id, JSON.stringify(row)]);
    if (row.boost_id && !draftMode) {
      const boost = (await client.query('SELECT data FROM owned_boosts WHERE id=$1', [row.boost_id])).rows[0].data;
      Object.assign(boost, { consumed: true, used_match_id: match.id, used_slot: row.slot, consumed_at: now.toISOString() });
      await client.query('UPDATE owned_boosts SET consumed=true,data=$2::jsonb WHERE id=$1', [row.boost_id, JSON.stringify(boost)]);
    }
  }
  const allPlacements = [...existing, ...added];
  match.turn_index = asNumber(match.turn_index) + 1;
  match.exhausted_user_ids = (match.exhausted_user_ids || []).map(Number);
  const legalAfter = maxWutLegalPlacements({
    cards: [...deckCards.values()], placements: allPlacements, userId,
    slotPowerAllowance: config.wut.slotPowerAllowance || 1, trinketFits: trinketFitsWutPosition
  }, arenaTurnCap(match));
  if (legalAfter <= 0 || allPlacements.filter(row => Number(row.user_id) === Number(userId)).length >= SLOTS.length) {
    match.exhausted_user_ids = [...new Set([...match.exhausted_user_ids, Number(userId)])];
  }
  const nextPlayer = nextWutActivePlayer(match, allPlacements, {
    previousUserId: userId,
    slotPowerAllowance: config.wut.slotPowerAllowance || 1,
    trinketFits: trinketFitsWutPosition,
    cardsForUser: id => match.deck_snapshots?.[String(id)]?.active || []
  });
  const status = nextPlayer == null ? 'scoring' : 'active';
  const deadline = status === 'active' ? nextArenaDeadline(now, config.arena) : null;
  match.status = status;
  match.turn_deadline = deadline;
  match.current_player_id = nextPlayer;
  await client.query(`
    UPDATE arena_matches SET status=$2,current_player_id=$3,turn_deadline=$4,data=$5::jsonb
    WHERE match_key=$1
  `, [matchRow.match_key, status, nextPlayer, deadline, JSON.stringify(match)]);
  return { ...match, placements: allPlacements, current_player_id: nextPlayer };
}

export const commitArenaTurnPostgres = (pool, input) => withTransaction(pool, client => commitArenaTurnWithClient(client, input));

export async function skipArenaNoLegalTurnsWithClient(client, { matchId, now = new Date() }) {
  const matchResult = await client.query(
    "SELECT match_key,data,status FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena' FOR UPDATE",
    [Number(matchId)]
  );
  const matchRow = matchResult.rows[0];
  const match = matchRow?.data;
  if (!match || matchRow.status !== 'active') return match || null;
  const placements = (await client.query(
    'SELECT data FROM arena_placements WHERE match_key=$1 ORDER BY placement_index',
    [matchRow.match_key]
  )).rows.map(row => row.data || {});
  const config = await cardsConfig(client);
  const skipped = skipWutNoLegalPlayers(match, placements, {
    slotPowerAllowance: config.wut.slotPowerAllowance || 1,
    trinketFits: trinketFitsWutPosition,
    cardsForUser: id => match.deck_snapshots?.[String(id)]?.active || []
  });
  if (!skipped.length) return { ...match, placements };
  const status = match.status === 'scoring' ? 'scoring' : 'active';
  const deadline = status === 'active' ? nextArenaDeadline(now, config.arena) : null;
  match.status = status;
  match.turn_deadline = deadline;
  await client.query(`
    UPDATE arena_matches SET status=$2,current_player_id=$3,turn_deadline=$4,data=$5::jsonb
    WHERE match_key=$1
  `, [matchRow.match_key, status, match.current_player_id || null, deadline, JSON.stringify(match)]);
  return { ...match, placements };
}

export const skipArenaNoLegalTurnsPostgres = (pool, input) => withTransaction(pool, client => skipArenaNoLegalTurnsWithClient(client, input));

export async function completeArenaMatchWithClient(client, { matchId, scoredPlacements, now = new Date() }) {
  const matchResult = await client.query(
    "SELECT match_key,data,status FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena' FOR UPDATE",
    [Number(matchId)]
  );
  const matchRow = matchResult.rows[0];
  const match = matchRow?.data;
  if (!match) return null;
  if (matchRow.status !== 'scoring') return { ...match, placements: [] };
  const existingRows = (await client.query(
    'SELECT placement_index,data FROM arena_placements WHERE match_key=$1 ORDER BY placement_index FOR UPDATE',
    [matchRow.match_key]
  )).rows;
  if (!Array.isArray(scoredPlacements) || scoredPlacements.length !== existingRows.length) {
    throw new Error('Scored placements do not match the committed lineup.');
  }
  const keyed = new Map(scoredPlacements.map(row => [`${Number(row.user_id)}|${row.slot}|${Number(row.card_id)}`, row]));
  const scored = [];
  for (const existingRow of existingRows) {
    const committed = existingRow.data || {};
    const row = keyed.get(`${Number(committed.user_id)}|${committed.slot}|${Number(committed.card_id)}`);
    if (!row) throw new Error('Scored placements cannot replace a committed card or slot.');
    const merged = { ...committed, ...JSON.parse(JSON.stringify(row)) };
    scored.push(merged);
    await client.query('UPDATE arena_placements SET data=$3::jsonb WHERE match_key=$1 AND placement_index=$2',
      [matchRow.match_key, existingRow.placement_index, JSON.stringify(merged)]);
  }
  const totals = Object.fromEntries((match.player_ids || []).map(userId => [String(userId),
    scored.filter(row => Number(row.user_id) === Number(userId)).reduce((sum, row) => sum + asNumber(row.fp), 0)
  ]));
  const [first, second] = match.player_ids.map(Number);
  match.scores = totals;
  match.winner_user_id = totals[String(first)] === totals[String(second)] ? null :
    totals[String(first)] > totals[String(second)] ? first : second;
  const config = await cardsConfig(client);
  if (match.mode === 'constructed' && match.series_format === 'bo3') {
    const gameNumber = asNumber(match.series_game_number || ((match.series_games || []).length + 1));
    match.series_games = Array.isArray(match.series_games) ? match.series_games : [];
    match.series_wins = { ...Object.fromEntries(match.player_ids.map(id => [String(id), 0])), ...(match.series_wins || {}) };
    match.series_total_fp = { ...Object.fromEntries(match.player_ids.map(id => [String(id), 0])), ...(match.series_total_fp || {}) };
    match.series_games.push({
      game_number: gameNumber,
      first_player_id: match.first_player_id == null ? null : Number(match.first_player_id),
      coin_flip_winner_user_id: match.coin_flip_winner_user_id == null ? null : Number(match.coin_flip_winner_user_id),
      placements: JSON.parse(JSON.stringify(scored)),
      scores: { ...totals },
      winner_user_id: match.winner_user_id,
      resolved_at: now.toISOString()
    });
    for (const id of match.player_ids.map(Number)) {
      match.series_total_fp[String(id)] = asNumber(match.series_total_fp[String(id)]) + asNumber(totals[String(id)]);
    }
    if (match.winner_user_id != null) {
      const key = String(match.winner_user_id);
      match.series_wins[key] = asNumber(match.series_wins[key]) + 1;
    }
    for (const row of scored) {
      const cardResult = await client.query('SELECT data FROM owned_cards WHERE id=$1 FOR UPDATE', [Number(row.card_id)]);
      const card = cardResult.rows[0]?.data;
      if (card) {
        card.cooldown_remaining = 0;
        card.total_fp_for_user = asNumber(card.total_fp_for_user) + asNumber(row.fp);
        card.best_week_fp = Math.max(asNumber(card.best_week_fp), asNumber(row.fp));
        card.last_week_fp = asNumber(row.fp);
        card.fantasy_stats = card.fantasy_stats || {};
        card.fantasy_stats[`arena-${match.id}-game-${gameNumber}`] = {
          fp: row.fp, gamesPlayed: row.games_played, stats: row.stats,
          sampleMatchIds: row.sample_match_ids, syntheticGames: row.synthetic_games,
          scoreBreakdown: row.score_breakdown, boostId: row.boost_id || null
        };
        await client.query('UPDATE owned_cards SET data=$2::jsonb WHERE id=$1', [Number(row.card_id), JSON.stringify(card)]);
      }
    }
    const seriesWon = Object.values(match.series_wins).some(value => asNumber(value) >= asNumber(match.series_target_wins || CONSTRUCTED_SERIES_TARGET_WINS));
    const seriesComplete = seriesWon || match.series_games.length >= asNumber(match.series_max_games || CONSTRUCTED_SERIES_MAX_GAMES);
    if (!seriesComplete) {
      match.status = 'ready';
      match.resolved_at = now.toISOString();
      match.turn_deadline = null;
      match.current_player_id = null;
      match.revealed_by = [];
      match.series_pending_next_game = true;
      match.series_can_advance = false;
      match.series_game_result = {
        game_number: gameNumber,
        scores: { ...totals },
        winner_user_id: match.winner_user_id,
        series_wins: { ...match.series_wins },
        series_total_fp: { ...match.series_total_fp }
      };
      await client.query(`
        UPDATE arena_matches SET status=$2,current_player_id=$3,turn_deadline=$4,data=$5::jsonb
        WHERE match_key=$1
      `, [matchRow.match_key, match.status, null, null, JSON.stringify(match)]);
      return { ...match, placements: scored };
    }
    match.series_pending_next_game = false;
    match.series_can_advance = false;
    match.scores = { ...match.series_wins };
    match.winner_user_id = resolveConstructedSeriesWinner(match);
    match.status = 'ready';
    match.resolved_at = now.toISOString();
    match.turn_deadline = null;
    match.current_player_id = null;
    const rewards = arenaRewards(config.arena, 'constructed');
    match.wut_rewards = {};
    for (const userId of [...match.player_ids].map(Number).sort((a, b) => a - b)) {
      const membership = await lockWutMembership(client, userId);
      const amount = Number(match.winner_user_id === userId ? rewards.winner : rewards.loser);
      await changeWutCoins(client, membership, amount, 'arena_reward', { arena_match_id: match.id }, now);
      match.wut_rewards[String(userId)] = amount;
    }
    match.wut_rewards_awarded_at = now.toISOString();
    await client.query(`
      UPDATE arena_matches SET status='ready',current_player_id=NULL,turn_deadline=NULL,data=$2::jsonb
      WHERE match_key=$1
    `, [matchRow.match_key, JSON.stringify(match)]);
    return { ...match, placements: scored };
  }
  match.status = 'ready';
  match.resolved_at = now.toISOString();
  const rewards = arenaRewards(config.arena, match.mode === 'constructed' ? 'constructed' : 'draft');
  match.wut_rewards = {};
  for (const userId of [...match.player_ids].map(Number).sort((a, b) => a - b)) {
    const membership = await lockWutMembership(client, userId);
    const amount = Number(match.winner_user_id === userId ? rewards.winner : rewards.loser);
    await changeWutCoins(client, membership, amount, 'arena_reward', { arena_match_id: match.id }, now);
    match.wut_rewards[String(userId)] = amount;
  }
  match.wut_rewards_awarded_at = now.toISOString();
  if (match.mode !== 'draft') for (const row of scored) {
    const cardResult = await client.query('SELECT data FROM owned_cards WHERE id=$1 FOR UPDATE', [Number(row.card_id)]);
    const card = cardResult.rows[0]?.data;
    if (card) {
      card.cooldown_remaining = 0;
      card.total_fp_for_user = asNumber(card.total_fp_for_user) + asNumber(row.fp);
      card.best_week_fp = Math.max(asNumber(card.best_week_fp), asNumber(row.fp));
      card.last_week_fp = asNumber(row.fp);
      card.fantasy_stats = card.fantasy_stats || {};
      card.fantasy_stats[`arena-${match.id}`] = {
        fp: row.fp, gamesPlayed: row.games_played, stats: row.stats,
        sampleMatchIds: row.sample_match_ids, syntheticGames: row.synthetic_games,
        scoreBreakdown: row.score_breakdown, boostId: row.boost_id || null
      };
      await client.query('UPDATE owned_cards SET data=$2::jsonb WHERE id=$1', [Number(row.card_id), JSON.stringify(card)]);
    }
  }
  await client.query(`
    UPDATE arena_matches SET status='ready',current_player_id=NULL,turn_deadline=NULL,data=$2::jsonb
    WHERE match_key=$1
  `, [matchRow.match_key, JSON.stringify(match)]);
  return { ...match, placements: scored };
}

async function applyElo(client, match, now) {
  if (match.elo_updated_at) return;
  const ids = [...match.player_ids].map(Number);
  const ratings = new Map();
  for (const id of [...ids].sort((a, b) => a - b)) {
    const result = await client.query('SELECT rating FROM arena_ratings WHERE user_id=$1 FOR UPDATE', [id]);
    ratings.set(id, Number(result.rows[0]?.rating ?? 1000));
  }
  const [first, second] = ids;
  const firstBefore = ratings.get(first);
  const secondBefore = ratings.get(second);
  const expected = 1 / (1 + Math.pow(10, (secondBefore - firstBefore) / 400));
  const score = match.winner_user_id == null ? 0.5 : Number(match.winner_user_id) === first ? 1 : 0;
  const firstAfter = Math.max(100, Math.round(firstBefore + 32 * (score - expected)));
  const secondAfter = Math.max(100, secondBefore - (firstAfter - firstBefore));
  for (const [id, rating] of [[first, firstAfter], [second, secondAfter]]) {
    await client.query(`
      INSERT INTO arena_ratings(user_id,rating,data) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(user_id) DO UPDATE SET rating=EXCLUDED.rating,data=EXCLUDED.data
    `, [id, rating, JSON.stringify(rating)]);
  }
  match.elo = {
    [String(first)]: { before: firstBefore, after: firstAfter, change: firstAfter - firstBefore },
    [String(second)]: { before: secondBefore, after: secondAfter, change: secondAfter - secondBefore }
  };
  match.elo_updated_at = now.toISOString();
}

async function resolveDraftPrepTimeout(client, row, match, now, config) {
  const submitted = Object.keys(match.draft_loadouts || {}).map(Number).filter(userId => (match.player_ids || []).map(Number).includes(userId));
  if (submitted.length === 1) {
    const winner = submitted[0];
    const loser = match.player_ids.map(Number).find(id => id !== winner);
    match.status = 'completed'; match.winner_user_id = winner; match.forfeit_user_id = loser;
    match.scores = { [String(winner)]: 1, [String(loser)]: 0 };
    match.resolved_at = now.toISOString(); match.completed_at = now.toISOString();
    match.turn_deadline = null; match.current_player_id = null;
    const rewards = arenaRewards(config.arena, 'draft');
    match.wut_rewards = {};
    for (const userId of match.player_ids.map(Number).sort((a, b) => a - b)) {
      const membership = await lockWutMembership(client, userId);
      const amount = Number(userId === loser ? rewards.forfeitLoser : userId === winner ? rewards.winner : rewards.loser);
      await changeWutCoins(client, membership, amount, 'arena_forfeit_reward', { arena_match_id: match.id }, now);
      match.wut_rewards[String(userId)] = amount;
    }
    match.wut_rewards_awarded_at = now.toISOString();
    await applyElo(client, match, now);
  } else {
    match.status = 'cancelled'; match.cancel_reason = 'draft_timeout_both';
    match.cancelled_at = now.toISOString(); match.turn_deadline = null; match.current_player_id = null;
  }
  await client.query('UPDATE arena_matches SET status=$2,current_player_id=NULL,turn_deadline=NULL,data=$3::jsonb WHERE match_key=$1',
    [row.match_key, match.status, JSON.stringify(match)]);
}

export async function completeArenaRevealWithClient(client, { userId, matchId, now = new Date() }) {
  const result = await client.query(
    "SELECT match_key,data,status FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena' FOR UPDATE",
    [Number(matchId)]
  );
  const row = result.rows[0];
  const match = row?.data;
  if (!match || !(match.player_ids || []).map(Number).includes(Number(userId)) || !['ready', 'completed'].includes(row.status)) {
    throw new Error('WUT result is not ready.');
  }
  match.revealed_by = Array.isArray(match.revealed_by) ? match.revealed_by : [];
  if (!match.revealed_by.map(Number).includes(Number(userId))) match.revealed_by.push(Number(userId));
  if (match.revealed_by.length >= match.player_ids.length) {
    if (match.mode === 'constructed' && match.series_format === 'bo3' && match.series_pending_next_game) {
      match.series_can_advance = true;
    } else {
      match.status = 'completed';
      match.completed_at ||= now.toISOString();
      await applyElo(client, match, now);
    }
  }
  await client.query('UPDATE arena_matches SET status=$2,data=$3::jsonb WHERE match_key=$1',
    [row.match_key, match.status, JSON.stringify(match)]);
  return match;
}

export async function advanceArenaConstructedSeriesWithClient(client, { userId, matchId, now = new Date() }) {
  const result = await client.query(
    "SELECT match_key,data,status FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena' FOR UPDATE",
    [Number(matchId)]
  );
  const row = result.rows[0];
  const match = row?.data;
  if (!match || match.mode !== 'constructed' || match.series_format !== 'bo3' || !(match.player_ids || []).map(Number).includes(Number(userId))) {
    throw new Error('Constructed Arena match not found.');
  }
  if (row.status !== 'ready' || !match.series_pending_next_game) throw new Error('This series is not waiting on the next game.');
  const revealed = new Set((match.revealed_by || []).map(Number));
  if (!match.player_ids.map(Number).every(id => revealed.has(id))) throw new Error('Both players must reveal this game before the next game can begin.');
  const config = await cardsConfig(client);
  prepareNextConstructedGame(match, now, config.arena);
  match.revealed_by = [];
  match.series_pending_next_game = false;
  match.series_can_advance = false;
  await client.query('DELETE FROM arena_placements WHERE match_key=$1', [row.match_key]);
  await client.query(`
    UPDATE arena_matches SET status=$2,current_player_id=$3,turn_deadline=$4,data=$5::jsonb
    WHERE match_key=$1
  `, [row.match_key, match.status, match.current_player_id || null, match.turn_deadline || null, JSON.stringify(match)]);
  return match;
}

export const advanceArenaConstructedSeriesPostgres = (pool, input) =>
  withTransaction(pool, client => advanceArenaConstructedSeriesWithClient(client, input));

export async function recalculateArenaEloFromHistoryWithClient(client, now = new Date()) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242038]);
  const rows = (await client.query("SELECT match_key,status,data FROM arena_matches WHERE match_kind='arena' ORDER BY COALESCE((data->>'resolved_at')::timestamptz,(data->>'completed_at')::timestamptz,created_at),numeric_id FOR UPDATE")).rows;
  const completed = rows.filter(row => row.status === 'completed' && row.data?.scores && Array.isArray(row.data?.player_ids) && row.data.player_ids.length === 2);
  const ratings = new Map(); const participantIds = new Set();
  for (const row of rows) { const match = row.data || {}; delete match.elo; delete match.elo_updated_at; await client.query('UPDATE arena_matches SET data=$2::jsonb WHERE match_key=$1', [row.match_key,JSON.stringify(match)]); }
  for (const row of completed) { const match=row.data; const [first,second]=match.player_ids.map(Number); participantIds.add(first); participantIds.add(second); const firstBefore=ratings.get(first)??1000; const secondBefore=ratings.get(second)??1000;
    const expected=1/(1+Math.pow(10,(secondBefore-firstBefore)/400)); const score=match.winner_user_id==null?.5:Number(match.winner_user_id)===first?1:0; const firstAfter=Math.max(100,Math.round(firstBefore+32*(score-expected))); const secondAfter=Math.max(100,secondBefore-(firstAfter-firstBefore)); ratings.set(first,firstAfter); ratings.set(second,secondAfter);
    match.elo={ [String(first)]:{before:firstBefore,after:firstAfter,change:firstAfter-firstBefore}, [String(second)]:{before:secondBefore,after:secondAfter,change:secondAfter-secondBefore} }; match.elo_updated_at=now.toISOString(); await client.query('UPDATE arena_matches SET data=$2::jsonb WHERE match_key=$1',[row.match_key,JSON.stringify(match)]); }
  await client.query('DELETE FROM arena_ratings');
  for (const [userId,rating] of ratings) await client.query('INSERT INTO arena_ratings(user_id,rating,data) VALUES($1,$2,$3::jsonb)',[userId,rating,JSON.stringify(rating)]);
  const meta=(await client.query("SELECT data FROM app_documents WHERE document_key='arena_meta' FOR UPDATE")).rows[0]?.data||{}; meta.elo_recalculated_at=now.toISOString(); await client.query("UPDATE app_documents SET data=$1::jsonb WHERE document_key='arena_meta'",[JSON.stringify(meta)]);
  return { matchesReplayed:completed.length,playersRanked:participantIds.size,recalculatedAt:meta.elo_recalculated_at };
}

export async function adminVoidArenaMatchWithClient(client, {
  matchId, adminUserId, reason = '', now = new Date()
}) {
  const admin = await client.query('SELECT role FROM users WHERE id=$1', [Number(adminUserId)]);
  if (admin.rows[0]?.role !== 'admin') throw new Error('Admin access is required.');
  const result = await client.query(
    "SELECT match_key,data,status FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena' FOR UPDATE",
    [Number(matchId)]
  );
  const row = result.rows[0];
  const match = row?.data;
  if (!match) throw new Error('WUT match not found.');
  if (!['choosing_first', 'active', 'scoring'].includes(row.status)) throw new Error('Only active or scoring WUT matches can be voided.');
  if (match.wut_rewards_awarded_at || match.elo_updated_at) throw new Error('This match already awarded results and cannot be voided safely.');
  const placements = (await client.query('SELECT data FROM arena_placements WHERE match_key=$1 FOR UPDATE', [row.match_key])).rows.map(item => item.data || {});
  const releasedBoostIds = [];
  for (const placement of placements) {
    if (!placement.boost_id) continue;
    const boostResult = await client.query('SELECT data FROM owned_boosts WHERE id=$1 FOR UPDATE', [Number(placement.boost_id)]);
    const boost = boostResult.rows[0]?.data;
    if (!boost || (boost.used_match_id != null && Number(boost.used_match_id) !== Number(match.id))) continue;
    boost.consumed = false;
    delete boost.used_match_id;
    delete boost.used_slot;
    delete boost.consumed_at;
    await client.query('UPDATE owned_boosts SET consumed=false,data=$2::jsonb WHERE id=$1', [Number(placement.boost_id), JSON.stringify(boost)]);
    releasedBoostIds.push(Number(placement.boost_id));
  }
  let refundedMushybux = 0;
  const settings = (await client.query("SELECT data FROM app_documents WHERE document_key='settings'")).rows[0]?.data || {};
  for (const entryId of match.entry_ids || []) {
    const entryResult = await client.query('SELECT user_id,data FROM arena_entries WHERE id=$1 FOR UPDATE', [Number(entryId)]);
    const entry = entryResult.rows[0]?.data;
    if (!entry) continue;
    entry.status = 'cancelled';
    entry.cancel_reason = 'admin_void';
    entry.cancelled_at = now.toISOString();
    if (!entry.void_refunded_at && asNumber(entry.paid_amount) > 0) {
      const user = await lockUser(client, entryResult.rows[0].user_id);
      const refund = asNumber(entry.paid_amount);
      await changeLockedUserBalance(client, user, refund);
      await addBalanceTransaction(client, {
        userId: user.id, week: asNumber(settings.currentWeek || 1), amount: refund,
        kind: 'arena_void_refund', category: 'cards', note: `Voided WUT match #${match.id}`,
        arena_match_id: match.id, createdAt: now.toISOString()
      });
      refundedMushybux += refund;
      entry.void_refunded_at = now.toISOString();
    }
    await client.query("UPDATE arena_entries SET status='cancelled',data=$2::jsonb WHERE id=$1", [Number(entryId), JSON.stringify(entry)]);
  }
  Object.assign(match, {
    status: 'cancelled', cancel_reason: 'admin_void',
    cancel_note: String(reason || '').trim().slice(0, 180) || 'Cancelled by an administrator due to a match issue.',
    cancelled_at: now.toISOString(), voided_at: now.toISOString(), voided_by: Number(adminUserId),
    turn_deadline: null, scores: null, winner_user_id: null, forfeit_user_id: null
  });
  await client.query(`
    UPDATE arena_matches SET status='cancelled',current_player_id=NULL,turn_deadline=NULL,data=$2::jsonb WHERE match_key=$1
  `, [row.match_key, JSON.stringify(match)]);
  return { match, releasedBoostIds, refundedMushybux };
}

export async function autoAssignExpiredArenaTurnsWithClient(client, { now = new Date() } = {}) {
  const config = await cardsConfig(client);
  const expiredDrafts = (await client.query(`
    SELECT match_key,numeric_id,data,status FROM arena_matches
    WHERE match_kind='arena' AND status='drafting' AND turn_deadline IS NOT NULL AND turn_deadline <= $1
    ORDER BY turn_deadline,numeric_id FOR UPDATE
  `, [now.toISOString()])).rows;
  const completed = [];
  for (const row of expiredDrafts) {
    await resolveDraftPrepTimeout(client, row, row.data || {}, now, config);
    completed.push(Number(row.numeric_id));
  }
  const expiredChoices = (await client.query(`
    SELECT match_key,numeric_id,data,status FROM arena_matches
    WHERE match_kind='arena' AND status='choosing_first' AND turn_deadline IS NOT NULL AND turn_deadline <= $1
    ORDER BY turn_deadline,numeric_id FOR UPDATE
  `, [now.toISOString()])).rows;
  for (const row of expiredChoices) {
    const match = row.data || {};
    startConstructedGame(match, firstPlayerDeciderId(match), now, config.arena);
    await client.query('UPDATE arena_matches SET status=$2,current_player_id=$3,turn_deadline=$4,data=$5::jsonb WHERE match_key=$1',
      [row.match_key, match.status, match.current_player_id || null, match.turn_deadline || null, JSON.stringify(match)]);
    completed.push(Number(row.numeric_id));
  }
  const expired = (await client.query(`
    SELECT numeric_id FROM arena_matches
    WHERE match_kind='arena' AND status='active' AND turn_deadline IS NOT NULL AND turn_deadline <= $1
    ORDER BY turn_deadline,numeric_id FOR UPDATE
  `, [now.toISOString()])).rows;
  for (const row of expired) {
    let match = (await client.query("SELECT data FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena'", [Number(row.numeric_id)])).rows[0]?.data;
    if (!match || match.status !== 'active') continue;
    const userId = currentPlayer(match); const required = arenaTurnCap(match);
    const placements = (await client.query('SELECT data FROM arena_placements WHERE match_key=$1 ORDER BY placement_index', [String(match.id)])).rows.map(item => item.data || {});
    const cards = [...(match.deck_snapshots?.[String(userId)]?.active || [])];
    const legalCount = maxWutLegalPlacements({
      cards, placements, userId,
      slotPowerAllowance: config.wut.slotPowerAllowance || 1,
      trinketFits: trinketFitsWutPosition
    }, required);
    const chosen = chooseAutomaticWutPlacements({
      cards, placements, userId,
      slotPowerAllowance: config.wut.slotPowerAllowance || 1,
      trinketFits: trinketFitsWutPosition
    }, legalCount);
    match = await commitArenaTurnWithClient(client, { userId, matchId: match.id,
      placements: chosen.map(({ slot, cardId }) => ({ slot, cardId })), now, automatic: true });
    completed.push(Number(match.id));
  }
  return completed;
}

export const completeArenaMatchPostgres = (pool, input) => withTransaction(pool, client => completeArenaMatchWithClient(client, input));
export const completeArenaRevealPostgres = (pool, input) => withTransaction(pool, client => completeArenaRevealWithClient(client, input));
export const recalculateArenaEloFromHistoryPostgres = (pool, now) => withTransaction(pool, client => recalculateArenaEloFromHistoryWithClient(client, now));
export const adminVoidArenaMatchPostgres = (pool, input) => withTransaction(pool, client => adminVoidArenaMatchWithClient(client, input));
export const autoAssignExpiredArenaTurnsPostgres = (pool, input) => withTransaction(pool, client => autoAssignExpiredArenaTurnsWithClient(client, input));

import { withTransaction } from '../postgres.js';
import { ARENA_TURN_SEQUENCE, nextArenaDeadline } from '../../services/arenaRuntime.js';
import { journeymanCandidates, resolveZebraStripes, trinketFitsWutPosition } from '../../services/wutBalanceRules.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';
import { addBalanceTransaction, changeLockedUserBalance, lockUser } from './wallet.js';

const SLOTS = ['F1', 'F2', 'D1', 'D2', 'G'];
const asNumber = value => Number(value || 0);
const currentPlayer = match => {
  const first = Number(match.first_player_id);
  const second = Number((match.player_ids || []).find(id => Number(id) !== first));
  return Number(match.turn_index || 0) % 2 === 0 ? first : second;
};

async function cardsConfig(client) {
  const docs = await client.query(`
    SELECT document_key,data FROM app_documents
    WHERE document_key IN ('cards_meta','arena_meta')
  `);
  const map = Object.fromEntries(docs.rows.map(row => [row.document_key, row.data || {}]));
  return { wut: map.cards_meta?.config?.wut || {}, arena: map.arena_meta?.config || {} };
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
    const allowed = new Set(journeymanCandidates(effective, all).map(item => item.printedChemistryKey));
    if (!String(effective.trinket.effect?.mode || '').startsWith('random_')) {
      const chosen = String(entry.row.journeyman_key || '').trim();
      if (allowed.size && !allowed.has(chosen)) throw new Error('Choose an eligible team for Journeyman before locking this card.');
      entry.row.journeyman_key = chosen;
    }
  }
}

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
  if (currentPlayer(match) !== Number(userId)) throw new Error('It is not your turn.');
  const required = ARENA_TURN_SEQUENCE[asNumber(match.turn_index)];
  if (!Array.isArray(placements) || placements.length !== required) {
    throw new Error(`This turn requires exactly ${required} card${required === 1 ? '' : 's'}.`);
  }
  const existing = (await client.query(
    'SELECT placement_index,data FROM arena_placements WHERE match_key=$1 ORDER BY placement_index FOR UPDATE',
    [matchRow.match_key]
  )).rows.map(row => row.data || {});
  const config = await cardsConfig(client);
  const deckCards = new Map([
    ...(match.deck_snapshots?.[String(userId)]?.active || []),
    ...(match.deck_snapshots?.[String(userId)]?.bench || [])
  ].map(card => [Number(card.card_id), card]));
  const occupiedSlots = new Set(existing.filter(row => Number(row.user_id) === Number(userId)).map(row => row.slot));
  const committedIds = new Set(existing.filter(row => Number(row.user_id) === Number(userId)).map(row => Number(row.card_id)));
  const identities = new Set(existing.filter(row => Number(row.user_id) === Number(userId)).map(row => row.card_snapshot?.card_identity).filter(Boolean));
  const turnSlots = new Set();
  const turnCards = new Set();
  const turnIdentities = new Set();
  const turnBoosts = new Set();
  const added = [];
  let captain = existing.some(row => Number(row.user_id) === Number(userId) && row.card_snapshot?.trinket?.family === 'team_crest');
  for (const input of placements) {
    const slot = String(input.slot || '').toUpperCase();
    if (!SLOTS.includes(slot) || occupiedSlots.has(slot) || turnSlots.has(slot)) throw new Error('Choose each open lineup slot only once.');
    turnSlots.add(slot);
    const cardId = Number(input.cardId);
    const snapshot = deckCards.get(cardId);
    if (!snapshot) throw new Error('That card is not in this match deck snapshot.');
    const owned = await client.query('SELECT data FROM owned_cards WHERE id=$1 AND user_id=$2', [cardId, Number(userId)]);
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
      if (captain) throw new Error("Only one Captain's Patch can be active in a lineup.");
      captain = true;
    }
    const opposing = existing.find(row => Number(row.user_id) !== Number(userId) && row.slot === slot);
    if (opposing && asNumber(snapshot.power) > asNumber(opposing.power) + asNumber(config.wut.slotPowerAllowance || 1)) {
      throw new Error(`${slot} exceeds the opposing card's Power +${config.wut.slotPowerAllowance || 1}.`);
    }
    let boost = null;
    let boostLoad = 0;
    if (input.boostId) {
      const boostResult = await client.query('SELECT id,consumed,data FROM owned_boosts WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(input.boostId), Number(userId)]);
      boost = boostResult.rows[0];
      const usedElsewhere = await client.query(`
        SELECT 1 FROM arena_placements p JOIN arena_matches m ON m.match_key=p.match_key
        WHERE p.data->>'boost_id'=$1 AND m.status IN ('active','scoring') LIMIT 1
      `, [String(input.boostId)]);
      if (!boost || boost.consumed || turnBoosts.has(Number(boost.id)) || usedElsewhere.rows[0]) throw new Error('That boost is unavailable.');
      const goalieBoost = ['save', 'shutout'].includes(boost.data?.boost_type);
      if ((snapshot.position === 'G') !== goalieBoost) throw new Error('That boost does not fit this position.');
      boostLoad = asNumber(config.wut.rarityCosts?.[boost.data?.rarity] || 1);
      turnBoosts.add(Number(boost.id));
    }
    added.push({
      user_id: Number(userId), slot, card_id: cardId, boost_id: boost?.id ? Number(boost.id) : null,
      boost_load: boostLoad, power: asNumber(snapshot.power), card_snapshot: JSON.parse(JSON.stringify(snapshot)),
      journeyman_key: String(input.journeymanKey || ''), automatic: Boolean(automatic), committed_at: now.toISOString()
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
  let placementIndex = existing.length;
  for (const row of added) {
    await client.query(`
      INSERT INTO arena_placements(match_key,placement_index,user_id,slot,card_id,data)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)
    `, [matchRow.match_key, placementIndex++, row.user_id, row.slot, row.card_id, JSON.stringify(row)]);
    if (row.boost_id) {
      const boost = (await client.query('SELECT data FROM owned_boosts WHERE id=$1', [row.boost_id])).rows[0].data;
      Object.assign(boost, { consumed: true, used_match_id: match.id, used_slot: row.slot, consumed_at: now.toISOString() });
      await client.query('UPDATE owned_boosts SET consumed=true,data=$2::jsonb WHERE id=$1', [row.boost_id, JSON.stringify(boost)]);
    }
  }
  match.turn_index = asNumber(match.turn_index) + 1;
  const status = match.turn_index >= ARENA_TURN_SEQUENCE.length ? 'scoring' : 'active';
  const deadline = status === 'active' ? nextArenaDeadline(now, config.arena) : null;
  match.status = status;
  match.turn_deadline = deadline;
  const nextPlayer = status === 'active' ? currentPlayer(match) : null;
  await client.query(`
    UPDATE arena_matches SET status=$2,current_player_id=$3,turn_deadline=$4,data=$5::jsonb
    WHERE match_key=$1
  `, [matchRow.match_key, status, nextPlayer, deadline, JSON.stringify(match)]);
  return { ...match, placements: [...existing, ...added], current_player_id: nextPlayer };
}

export const commitArenaTurnPostgres = (pool, input) => withTransaction(pool, client => commitArenaTurnWithClient(client, input));

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
  match.status = 'ready';
  match.resolved_at = now.toISOString();
  const config = await cardsConfig(client);
  match.wut_rewards = {};
  for (const userId of [...match.player_ids].map(Number).sort((a, b) => a - b)) {
    const membership = await lockWutMembership(client, userId);
    const amount = Number(match.winner_user_id === userId ? config.wut.rewards?.winner ?? 60 : config.wut.rewards?.loser ?? 25);
    await changeWutCoins(client, membership, amount, 'arena_reward', { arena_match_id: match.id }, now);
    match.wut_rewards[String(userId)] = amount;
  }
  match.wut_rewards_awarded_at = now.toISOString();
  for (const row of scored) {
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
    match.status = 'completed';
    match.completed_at ||= now.toISOString();
    await applyElo(client, match, now);
  }
  await client.query('UPDATE arena_matches SET status=$2,data=$3::jsonb WHERE match_key=$1',
    [row.match_key, match.status, JSON.stringify(match)]);
  return match;
}

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
  if (!['active', 'scoring'].includes(row.status)) throw new Error('Only active or scoring WUT matches can be voided.');
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
  const expired = (await client.query(`
    SELECT numeric_id FROM arena_matches
    WHERE match_kind='arena' AND status='active' AND turn_deadline IS NOT NULL AND turn_deadline <= $1
    ORDER BY turn_deadline,numeric_id FOR UPDATE
  `, [now.toISOString()])).rows;
  const completed = [];
  for (const row of expired) {
    let match = (await client.query("SELECT data FROM arena_matches WHERE numeric_id=$1 AND match_kind='arena'", [Number(row.numeric_id)])).rows[0]?.data;
    if (!match || match.status !== 'active') continue;
    const userId = currentPlayer(match); const required = ARENA_TURN_SEQUENCE[asNumber(match.turn_index)];
    const placements = (await client.query('SELECT data FROM arena_placements WHERE match_key=$1 ORDER BY placement_index', [String(match.id)])).rows.map(item => item.data || {});
    const own = placements.filter(item => Number(item.user_id) === Number(userId)); const occupied = new Set(own.map(item => item.slot));
    const usedIds = new Set(own.map(item => Number(item.card_id))); const identities = new Set(own.map(item => item.card_snapshot?.card_identity));
    const cards = [...(match.deck_snapshots?.[String(userId)]?.active || []), ...(match.deck_snapshots?.[String(userId)]?.bench || [])];
    const chosen = [];
    for (const slot of SLOTS) {
      if (occupied.has(slot) || chosen.length >= required) continue;
      const position = slot === 'G' ? 'G' : slot[0];
      const opponent = placements.find(item => Number(item.user_id) !== Number(userId) && item.slot === slot);
      const card = cards.filter(item => item.position === position && !usedIds.has(Number(item.card_id)) &&
        !identities.has(item.card_identity) && !chosen.some(choice => Number(choice.cardId) === Number(item.card_id) || choice.identity === item.card_identity) &&
        (!opponent || asNumber(item.power) <= asNumber(opponent.power) + asNumber(config.wut.slotPowerAllowance || 1)))
        .sort((a, b) => asNumber(a.power) - asNumber(b.power) || Number(a.card_id) - Number(b.card_id))[0];
      if (card) chosen.push({ slot, cardId: card.card_id, identity: card.card_identity });
    }
    if (chosen.length !== required) throw new Error(`Expired WUT match #${match.id} could not make a legal automatic play.`);
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

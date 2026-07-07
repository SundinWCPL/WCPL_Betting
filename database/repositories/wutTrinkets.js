import { withTransaction } from '../postgres.js';
import { trinketFitsWutPosition } from '../../services/wutBalanceRules.js';
import { addBalanceTransaction, changeLockedUserBalance, lockUser } from './wallet.js';
import { changeWutCoins, lockWutMembership } from './wutWallet.js';

async function cardsMeta(client) {
  const result = await client.query("SELECT data FROM app_documents WHERE document_key='cards_meta'");
  if (!result.rows[0]) throw new Error('Required PostgreSQL document is missing: cards_meta.');
  return result.rows[0].data || {};
}

async function lockedCardAndTrinket(client, { userId, cardId, trinketId = null }) {
  const cardResult = await client.query('SELECT data FROM owned_cards WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(cardId), Number(userId)]);
  const card = cardResult.rows[0]?.data;
  if (!card) throw new Error('Card or trinket not found.');
  const targetTrinketId = trinketId ?? card.trinket_id;
  const trinketResult = targetTrinketId == null
    ? { rows: [] }
    : await client.query('SELECT data FROM owned_trinkets WHERE id=$1 AND user_id=$2 FOR UPDATE', [Number(targetTrinketId), Number(userId)]);
  return { card, trinket: trinketResult.rows[0]?.data || null };
}

async function saveAttachment(client, card, trinket) {
  await client.query('UPDATE owned_cards SET data=$2::jsonb WHERE id=$1', [card.id, JSON.stringify(card)]);
  await client.query(
    'UPDATE owned_trinkets SET attached_card_id=$2, data=$3::jsonb WHERE id=$1',
    [trinket.id, trinket.attached_card_id, JSON.stringify(trinket)]
  );
}

export async function attachWutTrinketWithClient(client, {
  userId, cardId, trinketId, cardPosition = '', catalogByIdentity = null, now = new Date()
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  await lockWutMembership(client, userId);
  const { card, trinket } = await lockedCardAndTrinket(client, { userId, cardId, trinketId });
  if (!trinket) throw new Error('Card or trinket not found.');
  if (card.trinket_id) throw new Error('That card already has a trinket.');
  if (trinket.attached_card_id) throw new Error('That trinket is already attached.');
  const resolvedPosition = cardPosition || catalogByIdentity?.[card.card_identity]?.position ||
    catalogByIdentity?.[`${card.edition || 'S3'}|${card.division_id}|${card.player_key}`]?.position || '';
  if (resolvedPosition && !trinketFitsWutPosition(trinket.family, resolvedPosition)) {
    throw new Error(`${trinket.family === 'generalist' ? 'Generalist' : 'Specialist'} can only be attached to skaters.`);
  }
  card.trinket_id = trinket.id;
  trinket.attached_card_id = card.id;
  trinket.attached_at = now.toISOString();
  await saveAttachment(client, card, trinket);
  return { card, trinket };
}

export async function removeWutTrinketWithClient(client, {
  userId, cardId, currency, now = new Date()
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  const membership = await lockWutMembership(client, userId);
  const { card, trinket } = await lockedCardAndTrinket(client, { userId, cardId });
  if (!trinket) throw new Error('That card has no trinket.');
  const kind = currency === 'mushy' ? 'mushy' : 'wut';
  const meta = await cardsMeta(client);
  const costs = kind === 'mushy'
    ? meta.config?.wut?.trinketRemovalMushy
    : meta.config?.wut?.trinketRemovalWut;
  const cost = Number(costs?.[trinket.rarity]);
  if (!Number.isFinite(cost) || cost < 0) throw new Error('Invalid trinket removal cost.');
  if (kind === 'wut') {
    await changeWutCoins(client, membership, -cost, 'trinket_removal', {
      trinket_id: trinket.id,
      card_id: card.id
    }, now);
  } else {
    const user = await lockUser(client, userId);
    await changeLockedUserBalance(client, user, -cost);
    await addBalanceTransaction(client, {
      userId,
      week: Number((await client.query("SELECT data->>'currentWeek' AS week FROM app_documents WHERE document_key='settings'")).rows[0]?.week || 1),
      amount: -cost,
      kind: 'wut_trinket_removal',
      category: 'cards_convenience',
      note: `Removed trinket #${trinket.id}`,
      createdAt: now.toISOString()
    });
  }
  card.trinket_id = null;
  trinket.attached_card_id = null;
  trinket.detached_at = now.toISOString();
  await saveAttachment(client, card, trinket);
  return { cost, currency: kind };
}

export const attachWutTrinketPostgres = (pool, input) =>
  withTransaction(pool, client => attachWutTrinketWithClient(client, input));
export const removeWutTrinketPostgres = (pool, input) =>
  withTransaction(pool, client => removeWutTrinketWithClient(client, input));

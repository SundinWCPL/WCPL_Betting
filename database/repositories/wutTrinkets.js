import { withTransaction } from '../postgres.js';
import { lockWutMembership } from './wutWallet.js';

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
  throw new Error('Trinkets are assigned inside the deck builder now.');
}

export async function removeWutTrinketWithClient(client, {
  userId, cardId, currency, now = new Date()
}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242040]);
  await lockWutMembership(client, userId);
  const { card, trinket } = await lockedCardAndTrinket(client, { userId, cardId });
  if (!trinket) throw new Error('That card has no trinket.');
  card.trinket_id = null;
  trinket.attached_card_id = null;
  trinket.detached_at = now.toISOString();
  await saveAttachment(client, card, trinket);
  return { cost: 0, currency: 'free' };
}

export const attachWutTrinketPostgres = (pool, input) =>
  withTransaction(pool, client => attachWutTrinketWithClient(client, input));
export const removeWutTrinketPostgres = (pool, input) =>
  withTransaction(pool, client => removeWutTrinketWithClient(client, input));

import { insertStateRows } from '../stateStore.js';

const clone = value => JSON.parse(JSON.stringify(value));
const without = (value, keys) => {
  const copy = clone(value || {});
  for (const key of keys) delete copy[key];
  return copy;
};

export async function lockAndLoadHorseStore(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [8242050]);
  const documents = await client.query(`
    SELECT document_key, data FROM app_documents
    WHERE document_key IN ('horse_meta','horse_chat_meta','settings')
    FOR UPDATE
  `);
  const docs = Object.fromEntries(documents.rows.map(row => [row.document_key, row.data || {}]));
  if (!docs.horse_meta || !docs.horse_chat_meta || !docs.settings) {
    throw new Error('Required PostgreSQL horse-racing documents are missing.');
  }
  const entities = await client.query('SELECT * FROM horse_entities ORDER BY entity_type, source_order FOR UPDATE');
  const byType = new Map();
  for (const row of entities.rows) {
    if (!byType.has(row.entity_type)) byType.set(row.entity_type, []);
    byType.get(row.entity_type).push(clone(row.data));
  }
  return {
    settings: clone(docs.settings),
    store: {
      ...clone(docs.horse_meta),
      horses: byType.get('horse') || [],
      ownerRewards: byType.get('owner_reward') || [],
      races: byType.get('race') || [],
      bets: byType.get('bet') || [],
      chat: { ...clone(docs.horse_chat_meta), messages: byType.get('chat_message') || [] }
    }
  };
}

const entityKey = (data, index) => `${String(data?.id ?? data?.key ?? data?.user_id ?? 'row')}:${index}`;

export async function saveHorseStore(client, store) {
  await client.query(
    "UPDATE app_documents SET data=$2::jsonb, updated_at=now() WHERE document_key=$1",
    ['horse_meta', JSON.stringify(without(store, ['horses', 'ownerRewards', 'races', 'bets', 'chat']))]
  );
  await client.query(
    "UPDATE app_documents SET data=$2::jsonb, updated_at=now() WHERE document_key=$1",
    ['horse_chat_meta', JSON.stringify(without(store.chat || {}, ['messages']))]
  );
  const rows = [];
  for (const [entity_type, values] of Object.entries({
    horse: store.horses || [],
    owner_reward: store.ownerRewards || [],
    race: store.races || [],
    bet: store.bets || [],
    chat_message: store.chat?.messages || []
  })) {
    values.forEach((data, source_order) => rows.push({
      entity_type,
      entity_key: entityKey(data, source_order),
      user_id: data.user_id ?? data.owner_user_id ?? null,
      source_order,
      data: clone(data)
    }));
  }
  await client.query('DELETE FROM horse_entities');
  await insertStateRows(client, 'horse_entities', rows);
}

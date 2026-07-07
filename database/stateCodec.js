const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const without = (value, keys) => {
  const copy = clone(value || {});
  for (const key of keys) delete copy[key];
  return copy;
};
const ordered = rows => [...(rows || [])].sort((a, b) => Number(a.source_order || 0) - Number(b.source_order || 0));
const keyed = (row, index) => String(row?.id ?? row?.key ?? row?.user_id ?? row?.userId ?? `row-${index}`) + `:${index}`;
const timestamp = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const currentDraftPlayer = match => {
  if (match?.status !== 'active') return null;
  const first = Number(match.first_player_id);
  const second = Number((match.player_ids || []).find(id => Number(id) !== first));
  return Number(match.turn_index || 0) % 2 === 0 ? first : second;
};

export const IMPORT_TABLES = [
  'app_documents', 'users', 'bets', 'balance_transactions', 'casino_spins', 'shot_doctor_runs',
  'horse_entities', 'wut_memberships', 'owned_cards', 'owned_boosts', 'owned_trinkets',
  'wut_decks', 'pack_purchases', 'card_records', 'wut_transactions', 'arena_ratings',
  'arena_entries', 'arena_matches', 'arena_placements', 'draft_presets', 'draft_events',
  'draft_entrants', 'draft_boosters', 'draft_picks', 'draft_inventories', 'draft_decks',
  'draft_rounds', 'draft_matches', 'draft_match_placements', 'draft_logs'
];

export function encodeJsonState(state) {
  const cards = state.cards || {};
  const casino = state.casino || {};
  const horse = casino.horseRacing || {};
  const arena = cards.arena || {};
  const drafts = cards.draftEvents || {};
  const rows = Object.fromEntries(IMPORT_TABLES.map(table => [table, []]));

  const root = without(state, ['settings', 'users', 'bets', 'transactions', 'oddsAdjustments', 'casino', 'cards']);
  rows.app_documents.push(
    { document_key: 'root', data: root },
    { document_key: 'settings', data: clone(state.settings || {}) },
    { document_key: 'odds_adjustments', data: clone(state.oddsAdjustments || {}) },
    { document_key: 'casino_meta', data: without(casino, ['spins', 'shotDoctorRuns', 'horseRacing']) },
    { document_key: 'horse_meta', data: without(horse, ['horses', 'ownerRewards', 'races', 'bets', 'chat']) },
    { document_key: 'horse_chat_meta', data: without(horse.chat || {}, ['messages']) },
    { document_key: 'cards_meta', data: without(cards, ['ownedCards', 'ownedBoosts', 'lineups', 'packPurchases', 'weekReviews', 'wutMemberships', 'trinkets', 'decks', 'trinketShops', 'wutTransactions', 'missionPeriods', 'missionBetOpportunities', 'draftEvents', 'arena']) },
    { document_key: 'arena_meta', data: without(arena, ['ratings', 'entries', 'matches', 'debugMatches']) },
    { document_key: 'draft_meta', data: without(drafts, ['presets', 'events']) }
  );

  (state.users || []).forEach((data, source_order) => rows.users.push({
    id: Number(data.id), username: String(data.username), password_hash: String(data.password_hash),
    display_name: String(data.display_name || data.username), role: String(data.role || 'user'),
    balance: Number(data.balance || 0), created_at: timestamp(data.created_at), source_order, data: clone(data)
  }));
  (state.bets || []).forEach((data, source_order) => rows.bets.push({
    id: Number(data.id), user_id: Number(data.user_id), week: Number(data.week || 0), status: String(data.status || 'open'),
    bet_kind: String(data.bet_kind || 'series'), series_key: data.series_key || null, prop_key: data.prop_key || null,
    stake: Number(data.stake || 0), payout: data.payout == null ? null : Number(data.payout),
    created_at: timestamp(data.created_at), settled_at: timestamp(data.settled_at), source_order, data: clone(data)
  }));
  (state.transactions || []).forEach((data, source_order) => rows.balance_transactions.push({
    id: Number(data.id), user_id: Number(data.user_id), week: data.week == null ? null : Number(data.week),
    amount: Number(data.amount || 0), kind: String(data.kind || 'unknown'), category: data.category || null,
    created_at: timestamp(data.created_at), source_order, data: clone(data)
  }));
  (casino.spins || []).forEach((data, source_order) => rows.casino_spins.push({
    id: Number(data.id), user_id: Number(data.user_id), wager: Number(data.wager || 0), payout: Number(data.payout || 0),
    created_at: timestamp(data.created_at), source_order, data: clone(data)
  }));
  (casino.shotDoctorRuns || []).forEach((data, source_order) => rows.shot_doctor_runs.push({
    id: Number(data.id), user_id: Number(data.user_id), week: Number(data.week || state.settings?.currentWeek || 1), status: data.status || null,
    created_at: timestamp(data.created_at), source_order, data: clone(data)
  }));
  for (const [entity_type, collection] of Object.entries({
    horse: horse.horses || [], owner_reward: horse.ownerRewards || [], race: horse.races || [],
    bet: horse.bets || [], chat_message: horse.chat?.messages || []
  })) collection.forEach((data, source_order) => rows.horse_entities.push({
    entity_type, entity_key: keyed(data, source_order), user_id: data.user_id ?? data.owner_user_id ?? null,
    source_order, data: clone(data)
  }));

  (cards.wutMemberships || []).forEach((data, source_order) => rows.wut_memberships.push({
    user_id: Number(data.user_id), wut_coins: Number(data.wut_coins ?? data.wutCoins ?? 0), source_order, data: clone(data)
  }));
  (cards.ownedCards || []).forEach((data, source_order) => rows.owned_cards.push({
    id: Number(data.id), user_id: Number(data.user_id), card_identity: String(data.card_identity || ''),
    edition: data.edition || null, source_order, data: clone(data)
  }));
  (cards.ownedBoosts || []).forEach((data, source_order) => rows.owned_boosts.push({
    id: Number(data.id), user_id: Number(data.user_id), consumed: Boolean(data.consumed), source_order, data: clone(data)
  }));
  (cards.trinkets || []).forEach((data, source_order) => rows.owned_trinkets.push({
    id: Number(data.id), user_id: Number(data.user_id), family: String(data.family || ''), rarity: String(data.rarity || 'common'),
    attached_card_id: data.attached_card_id == null ? null : Number(data.attached_card_id), source_order, data: clone(data)
  }));
  (cards.decks || []).forEach((data, source_order) => rows.wut_decks.push({
    id: Number(data.id), user_id: Number(data.user_id), name: String(data.name || `Deck ${data.id}`), source_order, data: clone(data)
  }));
  (cards.packPurchases || []).forEach((data, source_order) => rows.pack_purchases.push({
    id: Number(data.id), user_id: Number(data.user_id), status: String(data.status || 'pending'), pack_kind: data.pack_kind || null,
    pack_type: data.pack_type || null, created_at: timestamp(data.created_at), source_order, data: clone(data)
  }));
  for (const [collection, values] of Object.entries({
    lineups: cards.lineups || [], week_reviews: cards.weekReviews || [], trinket_shops: cards.trinketShops || [],
    mission_periods: cards.missionPeriods || [], mission_opportunities: cards.missionBetOpportunities || []
  })) values.forEach((data, source_order) => rows.card_records.push({
    collection, record_key: keyed(data, source_order), user_id: data.user_id == null ? null : Number(data.user_id),
    record_id: data.id == null ? null : Number(data.id), source_order, data: clone(data)
  }));
  (cards.wutTransactions || []).forEach((data, source_order) => rows.wut_transactions.push({
    id: Number(data.id), user_id: Number(data.user_id), amount: Number(data.amount || 0), kind: String(data.kind || 'unknown'),
    created_at: timestamp(data.created_at), source_order, data: clone(data)
  }));

  for (const [userId, data] of Object.entries(arena.ratings || {})) rows.arena_ratings.push({
    user_id: Number(userId), rating: Number(typeof data === 'object' ? data.rating : data), data: clone(data)
  });
  (arena.entries || []).forEach((data, source_order) => rows.arena_entries.push({
    id: Number(data.id), user_id: Number(data.user_id), status: String(data.status || 'queued'),
    joined_at: timestamp(data.joined_at || data.created_at), source_order, data: clone(data)
  }));
  const encodeArenaMatch = (data, source_order, match_kind) => {
    const match_key = String(data.id);
    rows.arena_matches.push({
      match_key, numeric_id: Number.isFinite(Number(data.id)) ? Number(data.id) : null, match_kind,
      status: String(data.status || 'active'), current_player_id: currentDraftPlayer(data),
      turn_deadline: timestamp(data.turn_deadline), created_at: timestamp(data.created_at), source_order,
      data: without(data, ['placements'])
    });
    (data.placements || []).forEach((placement, placement_index) => rows.arena_placements.push({
      match_key, placement_index, user_id: placement.user_id == null ? null : Number(placement.user_id),
      slot: placement.slot || null, card_id: placement.card_id == null ? null : Number(placement.card_id), data: clone(placement)
    }));
  };
  (arena.matches || []).forEach((data, index) => encodeArenaMatch(data, index, 'arena'));
  (arena.debugMatches || []).forEach((data, index) => encodeArenaMatch(data, index, 'debug'));

  (drafts.presets || []).forEach((data, source_order) => rows.draft_presets.push({
    id: Number(data.id), preset_key: data.key || null, source_order, data: clone(data)
  }));
  (drafts.events || []).forEach((event, source_order) => {
    const draft = without(event.draft || {}, ['boosters', 'picks']);
    const tournament = without(event.tournament || {}, ['rounds', 'matches']);
    const eventData = without(event, ['entrants', 'logs', 'inventories', 'archived_inventories', 'decks', 'archived_decks', 'draft', 'tournament']);
    eventData.draft = draft;
    eventData.tournament = tournament;
    rows.draft_events.push({
      id: Number(event.id), phase: String(event.phase || 'scheduled'), visibility: event.config?.basic?.visibility || null,
      starts_at: timestamp(event.config?.scheduling?.startsAt), paused_at: timestamp(event.paused_at),
      updated_at: timestamp(event.updated_at), source_order, data: eventData
    });
    (event.entrants || []).forEach((data, entrantOrder) => rows.draft_entrants.push({
      event_id: Number(event.id), entrant_index: entrantOrder, user_id: Number(data.user_id), status: String(data.status || 'active'), source_order: entrantOrder, data: clone(data)
    }));
    (event.draft?.boosters || []).forEach((data, boosterOrder) => rows.draft_boosters.push({
      event_id: Number(event.id), booster_key: keyed(data, boosterOrder), current_owner_user_id: data.current_owner_user_id == null ? null : Number(data.current_owner_user_id),
      booster_number: data.booster_number == null ? null : Number(data.booster_number), awaiting_pass: Boolean(data.awaiting_pass), source_order: boosterOrder, data: clone(data)
    }));
    (event.draft?.picks || []).forEach((data, pickOrder) => rows.draft_picks.push({
      event_id: Number(event.id), pick_key: keyed(data, pickOrder), user_id: data.user_id == null ? null : Number(data.user_id),
      booster_number: data.booster_number == null ? null : Number(data.booster_number), source_order: pickOrder, data: clone(data)
    }));
    for (const [userId, data] of Object.entries(event.inventories || {})) rows.draft_inventories.push({ event_id: Number(event.id), user_id: Number(userId), archived: false, data: clone(data) });
    for (const [userId, data] of Object.entries(event.archived_inventories || {})) rows.draft_inventories.push({ event_id: Number(event.id), user_id: Number(userId), archived: true, data: clone(data) });
    for (const [userId, data] of Object.entries(event.decks || {})) rows.draft_decks.push({ event_id: Number(event.id), user_id: Number(userId), archived: false, data: clone(data) });
    for (const [userId, data] of Object.entries(event.archived_decks || {})) rows.draft_decks.push({ event_id: Number(event.id), user_id: Number(userId), archived: true, data: clone(data) });
    (event.tournament?.rounds || []).forEach((data, roundOrder) => rows.draft_rounds.push({
      event_id: Number(event.id), round_number: Number(data.number ?? roundOrder + 1), source_order: roundOrder, data: clone(data)
    }));
    (event.tournament?.matches || []).forEach((data, matchOrder) => {
      const match_key = String(data.id);
      rows.draft_matches.push({
        event_id: Number(event.id), match_key, status: String(data.status || 'pending'), current_player_id: currentDraftPlayer(data),
        turn_deadline: timestamp(data.turn_deadline), round_number: data.round == null ? null : Number(data.round),
        source_order: matchOrder, data: without(data, ['placements'])
      });
      (data.placements || []).forEach((placement, placement_index) => rows.draft_match_placements.push({
        event_id: Number(event.id), match_key, placement_index,
        user_id: placement.user_id == null ? null : Number(placement.user_id), slot: placement.slot || null,
        card_id: placement.card_id == null ? null : Number(placement.card_id), data: clone(placement)
      }));
    });
    (event.logs || []).forEach((data, log_index) => rows.draft_logs.push({
      event_id: Number(event.id), log_index, log_type: data.type || null, created_at: timestamp(data.created_at), data: clone(data)
    }));
  });
  return rows;
}

export function decodeJsonState(rows) {
  const documents = Object.fromEntries((rows.app_documents || []).map(row => [row.document_key, clone(row.data)]));
  const state = { ...(documents.root || {}) };
  state.settings = documents.settings || {};
  state.users = ordered(rows.users).map(row => clone(row.data));
  state.bets = ordered(rows.bets).map(row => clone(row.data));
  state.transactions = ordered(rows.balance_transactions).map(row => clone(row.data));
  state.oddsAdjustments = documents.odds_adjustments || {};
  state.casino = {
    ...(documents.casino_meta || {}),
    spins: ordered(rows.casino_spins).map(row => clone(row.data)),
    shotDoctorRuns: ordered(rows.shot_doctor_runs).map(row => clone(row.data))
  };
  const horseRows = type => ordered((rows.horse_entities || []).filter(row => row.entity_type === type)).map(row => clone(row.data));
  state.casino.horseRacing = {
    ...(documents.horse_meta || {}), horses: horseRows('horse'), ownerRewards: horseRows('owner_reward'),
    races: horseRows('race'), bets: horseRows('bet'), chat: { ...(documents.horse_chat_meta || {}), messages: horseRows('chat_message') }
  };
  const cardRows = collection => ordered((rows.card_records || []).filter(row => row.collection === collection)).map(row => clone(row.data));
  state.cards = {
    ...(documents.cards_meta || {}),
    ownedCards: ordered(rows.owned_cards).map(row => clone(row.data)),
    ownedBoosts: ordered(rows.owned_boosts).map(row => clone(row.data)),
    lineups: cardRows('lineups'), packPurchases: ordered(rows.pack_purchases).map(row => clone(row.data)),
    weekReviews: cardRows('week_reviews'), wutMemberships: ordered(rows.wut_memberships).map(row => clone(row.data)),
    trinkets: ordered(rows.owned_trinkets).map(row => clone(row.data)), decks: ordered(rows.wut_decks).map(row => clone(row.data)),
    trinketShops: cardRows('trinket_shops'), wutTransactions: ordered(rows.wut_transactions).map(row => clone(row.data)),
    missionPeriods: cardRows('mission_periods'), missionBetOpportunities: cardRows('mission_opportunities')
  };
  const arenaMatches = kind => ordered((rows.arena_matches || []).filter(row => row.match_kind === kind)).map(row => ({
    ...clone(row.data), placements: (rows.arena_placements || []).filter(item => item.match_key === row.match_key).sort((a, b) => a.placement_index - b.placement_index).map(item => clone(item.data))
  }));
  state.cards.arena = {
    ...(documents.arena_meta || {}),
    ratings: Object.fromEntries((rows.arena_ratings || []).map(row => [String(row.user_id), clone(row.data)])),
    entries: ordered(rows.arena_entries).map(row => clone(row.data)), matches: arenaMatches('arena'), debugMatches: arenaMatches('debug')
  };
  const eventRows = ordered(rows.draft_events);
  const events = eventRows.map(row => {
    const id = Number(row.id);
    const event = clone(row.data);
    event.entrants = ordered((rows.draft_entrants || []).filter(item => Number(item.event_id) === id)).map(item => clone(item.data));
    event.draft ||= {};
    event.draft.boosters = ordered((rows.draft_boosters || []).filter(item => Number(item.event_id) === id)).map(item => clone(item.data));
    event.draft.picks = ordered((rows.draft_picks || []).filter(item => Number(item.event_id) === id)).map(item => clone(item.data));
    const objectRows = (values, archived) => Object.fromEntries(values.filter(item => Number(item.event_id) === id && Boolean(item.archived) === archived).map(item => [String(item.user_id), clone(item.data)]));
    event.inventories = objectRows(rows.draft_inventories || [], false);
    event.archived_inventories = objectRows(rows.draft_inventories || [], true);
    event.decks = objectRows(rows.draft_decks || [], false);
    event.archived_decks = objectRows(rows.draft_decks || [], true);
    event.tournament ||= {};
    event.tournament.rounds = ordered((rows.draft_rounds || []).filter(item => Number(item.event_id) === id)).map(item => clone(item.data));
    event.tournament.matches = ordered((rows.draft_matches || []).filter(item => Number(item.event_id) === id)).map(item => ({
      ...clone(item.data), placements: (rows.draft_match_placements || []).filter(p => Number(p.event_id) === id && p.match_key === item.match_key).sort((a, b) => a.placement_index - b.placement_index).map(p => clone(p.data))
    }));
    event.logs = (rows.draft_logs || []).filter(item => Number(item.event_id) === id).sort((a, b) => a.log_index - b.log_index).map(item => clone(item.data));
    return event;
  });
  state.cards.draftEvents = { ...(documents.draft_meta || {}), presets: ordered(rows.draft_presets).map(row => clone(row.data)), events };
  return state;
}

export function stateManifest(state, rows = encodeJsonState(state)) {
  const sum = (values, field) => values.reduce((total, row) => total + Number(row[field] || 0), 0);
  return {
    counts: Object.fromEntries(Object.entries(rows).map(([table, values]) => [table, values.length])),
    money: {
      mushybuxBalances: sum(state.users || [], 'balance'),
      transactionNet: sum(state.transactions || [], 'amount'),
      wutCoinBalances: (state.cards?.wutMemberships || []).reduce((total, row) => total + Number(row.wut_coins ?? row.wutCoins ?? 0), 0),
      wutTransactionNet: sum(state.cards?.wutTransactions || [], 'amount'),
      sportsbookStake: sum(state.bets || [], 'stake'),
      sportsbookPayout: sum(state.bets || [], 'payout')
    },
    nextIds: Object.fromEntries(Object.entries(state).filter(([key]) => /^next[A-Z]/.test(key)))
  };
}

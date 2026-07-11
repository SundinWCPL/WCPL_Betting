export const ARENA_DEFAULT_ELO = 1000;
export const ARENA_TURN_SEQUENCE = Object.freeze([1, 2, 2, 2, 2, 1]);
export const WUT_LINEUP_SLOTS = Object.freeze(['F1', 'F2', 'D1', 'D2', 'G']);
export const WUT_RARITIES = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary']);
export const WUT_CAPTAIN_PATCH_LIMIT = 2;
export const WUT_ASSISTANT_CAPTAIN_MULTIPLIER = 0.5;

const asNumber = value => Number(value || 0);

export function wutCaptainPatchCount(placements = [], userId = null) {
  return (placements || []).filter(row =>
    (userId == null || Number(row.user_id) === Number(userId)) &&
    row.card_snapshot?.trinket?.family === 'team_crest'
  ).length;
}

export function wutCaptainPatchRoleForIndex(index) {
  return Number(index || 0) <= 0 ? 'captain' : 'assistant_captain';
}

export function wutCaptainPatchMultiplier(trinket = null) {
  const role = String(trinket?.captain_role || trinket?.captainRole || '').toLowerCase();
  return role === 'assistant_captain' ? WUT_ASSISTANT_CAPTAIN_MULTIPLIER : 1;
}

export function markWutCaptainPatchRole(snapshot, index) {
  const next = JSON.parse(JSON.stringify(snapshot || {}));
  if (next.trinket?.family === 'team_crest') {
    const role = wutCaptainPatchRoleForIndex(index);
    next.trinket.captain_role = role;
    next.trinket.captainRole = role;
    next.trinket.effect_multiplier = wutCaptainPatchMultiplier(next.trinket);
  }
  return next;
}

export function arenaRewards(config = {}, mode = 'draft') {
  const key = mode === 'constructed' ? 'constructedRewards' : 'draftRewards';
  const fallback = config.rewards || {};
  return {
    winner: Number(config[key]?.winner ?? fallback.winner ?? 60),
    loser: Number(config[key]?.loser ?? fallback.loser ?? 25),
    forfeitLoser: Number(config[key]?.forfeitLoser ?? fallback.forfeitLoser ?? 0)
  };
}

export function normalizeArenaDraftConfig(config = {}) {
  const source = config.draftArena || {};
  const weights = Object.fromEntries(WUT_RARITIES.map(rarity => [rarity, Math.max(0, Number(source.rarityWeights?.[rarity] ?? {
    common: 30, uncommon: 30, rare: 25, epic: 10, legendary: 5
  }[rarity]))]));
  const maxPacks = Object.fromEntries(WUT_RARITIES.map(rarity => [rarity, Math.max(0, Math.round(Number(source.maxPacks?.[rarity] ?? {
    common: 4, uncommon: 4, rare: 3, epic: 2, legendary: 2
  }[rarity])))]));
  if (Object.values(weights).reduce((sum, value) => sum + value, 0) <= 0) weights.common = 1;
  const playersPerPack = Math.max(0, Math.round(Number(source.playersPerPack ?? 1) || 0));
  const trinketsPerPack = Math.max(0, Math.round(Number(source.trinketsPerPack ?? 1) || 0));
  const boostsPerPack = Math.max(0, Math.round(Number(source.boostsPerPack ?? 1) || 0));
  if (playersPerPack + trinketsPerPack + boostsPerPack <= 0) throw new Error('Draft Arena packs need at least one player, trinket, or boost choice.');
  return {
    packCount: Math.max(1, Math.round(Number(source.packCount ?? 10) || 10)),
    playersPerPack,
    trinketsPerPack,
    boostsPerPack,
    rarityWeights: weights,
    maxPacks
  };
}

const choice = (items, random = Math.random) => items[Math.floor(Math.max(0, Math.min(.999999, Number(random()))) * items.length)];

export function arenaDraftPlayerSnapshot(player, wutConfig = {}) {
  if (!player) throw new Error('Draft Arena could not find enough eligible player cards.');
  const season = player.cardType === 'mythic' ? player.sourceSeason : player.edition;
  return {
    cardIdentity: player.cardIdentity,
    catalogKey: player.catalogKey,
    displayName: player.name || player.displayName || '',
    name: player.name || player.displayName || '',
    tier: player.tier,
    position: player.position,
    teamId: player.teamId || '',
    teamName: player.teamName || player.teamId || '',
    teamDisplayName: player.teamDisplayName || player.teamName || player.teamId || '',
    teamLogo: player.teamLogo || '',
    teamBgColor: player.teamBgColor || '',
    edition: player.edition,
    cardType: player.cardType || 'player',
    sourceSeason: player.sourceSeason || '',
    cardArt: player.cardArt || player.edition || 'S3',
    season,
    chemistryKey: `${season || ''}|${player.teamId || ''}`,
    power: Number(wutConfig.rarityCosts?.[player.tier] || 1)
  };
}

export function buildArenaDraftPacks({
  catalog = [], config = {}, wutConfig = {}, trinketFamilies = [], boostTypes = [], trinketEffect = () => null, random = Math.random
} = {}) {
  const draftConfig = normalizeArenaDraftConfig(config);
  const counts = Object.fromEntries(WUT_RARITIES.map(rarity => [rarity, 0]));
  const usedPlayers = new Set();
  const availableRarities = () => WUT_RARITIES.filter(rarity =>
    Number(draftConfig.rarityWeights[rarity] || 0) > 0 &&
    counts[rarity] < Number(draftConfig.maxPacks[rarity] ?? Infinity) &&
    (draftConfig.playersPerPack <= 0 || catalog.filter(player =>
      player?.tier === rarity && player?.position && !usedPlayers.has(player.cardIdentity || player.catalogKey)
    ).length >= draftConfig.playersPerPack)
  );
  const rollRarity = () => {
    const rarities = availableRarities();
    if (!rarities.length) throw new Error('Not enough unique player cards to build Draft Arena packs.');
    const total = rarities.reduce((sum, rarity) => sum + Number(draftConfig.rarityWeights[rarity] || 0), 0);
    if (total <= 0) return choice(rarities, random);
    let roll = Number(random()) * total;
    for (const rarity of rarities) {
      roll -= Number(draftConfig.rarityWeights[rarity] || 0);
      if (roll <= 0) return rarity;
    }
    return rarities.at(-1);
  };
  const packs = [];
  const families = trinketFamilies.length ? trinketFamilies : ['lucky_charm'];
  const boosts = boostTypes.length ? boostTypes : ['goal', 'assist', 'shot', 'grit', 'save', 'shutout'];
  for (let index = 0; index < draftConfig.packCount; index += 1) {
    const rarity = rollRarity();
    counts[rarity] += 1;
    const baseId = 1000000 + ((index + 1) * 1000);
    const playerPool = catalog.filter(player => player?.tier === rarity && player?.position && !usedPlayers.has(player.cardIdentity || player.catalogKey));
    const players = [];
    for (let itemIndex = 0; itemIndex < draftConfig.playersPerPack; itemIndex += 1) {
      const player = choice(playerPool, random);
      if (!player) throw new Error('Not enough unique player cards to build Draft Arena packs.');
      playerPool.splice(playerPool.indexOf(player), 1);
      usedPlayers.add(player.cardIdentity || player.catalogKey);
      players.push({ id: baseId + 100 + itemIndex, item_type: 'player', rarity, player_snapshot: arenaDraftPlayerSnapshot(player, wutConfig) });
    }
    const trinkets = Array.from({ length: draftConfig.trinketsPerPack }, (_, itemIndex) => {
      const family = choice(families, random);
      return { id: baseId + 200 + itemIndex, item_type: 'trinket', rarity, family, effect: trinketEffect(family, rarity) };
    });
    const packBoosts = Array.from({ length: draftConfig.boostsPerPack }, (_, itemIndex) => {
      const boostType = choice(boosts, random);
      return { id: baseId + 300 + itemIndex, item_type: 'boost', rarity, boost_type: boostType };
    });
    packs.push({ index, rarity, players, trinkets, boosts: packBoosts, player: players[0] || null, trinket: trinkets[0] || null, boost: packBoosts[0] || null });
  }
  return packs;
}

export function arenaRecentOpponentPairs(matches = [], recentMatchCount = 2) {
  const recent = Math.max(0, Math.round(Number(recentMatchCount || 0)));
  const byUser = new Map();
  const add = (userId, opponentId) => {
    const list = byUser.get(Number(userId)) || [];
    if (!list.includes(Number(opponentId))) list.push(Number(opponentId));
    byUser.set(Number(userId), list.slice(0, recent));
  };
  const ordered = [...matches].sort((a, b) =>
    new Date(b.resolved_at || b.completed_at || b.created_at || 0).getTime() -
    new Date(a.resolved_at || a.completed_at || a.created_at || 0).getTime()
  );
  for (const match of ordered) {
    if (!recent) break;
    const [a, b] = (match.player_ids || []).map(Number);
    if (!a || !b) continue;
    if ((byUser.get(a) || []).length < recent) add(a, b);
    if ((byUser.get(b) || []).length < recent) add(b, a);
  }
  const pairs = new Set();
  for (const [userId, opponents] of byUser) for (const opponentId of opponents) {
    pairs.add([userId, opponentId].sort((a, b) => a - b).join(':'));
  }
  return pairs;
}

export function wutDeckRules(config = {}) {
  return {
    deckSize: Math.max(1, Math.round(Number(config.deckSize ?? 8) || 8)),
    topLineupMaxPower: Number(config.topLineupMaxPower ?? 15) || 15,
    requirePositions: config.requirePositions !== false
  };
}

export function validateWutDeckSnapshots(snapshots, config = {}, label = 'Deck') {
  const rules = wutDeckRules(config);
  const cards = snapshots || [];
  if (cards.length !== rules.deckSize) throw new Error(`${label} must contain exactly ${rules.deckSize} unique cards.`);
  const identities = cards.map(card => String(card.card_identity || '').trim()).filter(Boolean);
  if (new Set(identities).size !== identities.length) throw new Error(`${label} cannot contain two copies of the same player card.`);
  const counts = { F: 0, D: 0, G: 0 };
  for (const card of cards) if (counts[card.position] != null) counts[card.position] += 1;
  if (rules.requirePositions && (counts.F < 2 || counts.D < 2 || counts.G < 1)) throw new Error(`${label} must include at least 2F / 2D / 1G.`);
  const topPower = ['F', 'D', 'G'].reduce((sum, position) => {
    const needed = position === 'G' ? 1 : 2;
    return sum + cards.filter(card => card.position === position)
      .map(card => asNumber(card.power))
      .sort((a, b) => b - a)
      .slice(0, needed)
      .reduce((part, power) => part + power, 0);
  }, 0);
  if (topPower > rules.topLineupMaxPower) {
    throw new Error(`${label}'s strongest 2F / 2D / 1G lineup is Power ${topPower}, above the ${rules.topLineupMaxPower} limit.`);
  }
  const captainPatchCount = cards.filter(card => card.trinket?.family === 'team_crest').length;
  if (captainPatchCount > WUT_CAPTAIN_PATCH_LIMIT) {
    throw new Error(`${label} can include at most ${WUT_CAPTAIN_PATCH_LIMIT} Captain's Patch trinkets.`);
  }
  return { ...rules, topLineupPower: topPower };
}

export function arenaCurrentPlayerId(match) {
  if (match?.current_player_id != null) return Number(match.current_player_id);
  const first = Number(match?.first_player_id);
  const second = Number((match?.player_ids || []).find(id => Number(id) !== first));
  return Number(match?.turn_index || 0) % 2 === 0 ? first : second;
}

export function arenaTurnCap(match) {
  return ARENA_TURN_SEQUENCE[Math.min(Number(match?.turn_index || 0), ARENA_TURN_SEQUENCE.length - 1)] || 2;
}

export function wutLegalPlayOptions({
  cards = [], placements = [], userId, slotPowerAllowance = 1, trinketFits = () => true
} = {}) {
  const playerId = Number(userId);
  const own = (placements || []).filter(row => Number(row.user_id) === playerId);
  const occupied = new Set(own.map(row => row.slot));
  const usedIds = new Set(own.map(row => Number(row.card_id)));
  const usedIdentities = new Set(own.map(row => String(row.card_snapshot?.card_identity || '').trim()).filter(Boolean));
  const captainCount = wutCaptainPatchCount(own);
  const options = [];
  for (const slot of WUT_LINEUP_SLOTS) {
    if (occupied.has(slot)) continue;
    const position = slot === 'G' ? 'G' : slot[0];
    const opponent = (placements || []).find(row => Number(row.user_id) !== playerId && row.slot === slot);
    for (const card of cards || []) {
      const cardId = Number(card.card_id ?? card.id);
      const identity = String(card.card_identity || '').trim();
      if (usedIds.has(cardId) || (identity && usedIdentities.has(identity))) continue;
      if (card.position !== position) continue;
      if (!trinketFits(card.trinket?.family, card.position)) continue;
      if (captainCount >= WUT_CAPTAIN_PATCH_LIMIT && card.trinket?.family === 'team_crest') continue;
      if (opponent && asNumber(card.power) > asNumber(opponent.power) + asNumber(slotPowerAllowance || 1)) continue;
      options.push({ slot, card });
    }
  }
  return options;
}

export function maxWutLegalPlacements(args = {}, limit = 2) {
  const capped = Math.max(0, Number(limit || 0));
  if (!capped) return 0;
  const options = wutLegalPlayOptions(args);
  const own = (args.placements || []).filter(row => Number(row.user_id) === Number(args.userId));
  const captainAlreadyActive = wutCaptainPatchCount(own);
  let best = 0;
  const walk = (index, usedSlots, usedCards, usedIdentities, captainCount, count) => {
    best = Math.max(best, count);
    if (best >= capped || index >= options.length) return;
    for (let i = index; i < options.length; i += 1) {
      const { slot, card } = options[i];
      const cardId = Number(card.card_id ?? card.id);
      const identity = String(card.card_identity || '').trim();
      if (usedSlots.has(slot) || usedCards.has(cardId) || (identity && usedIdentities.has(identity))) continue;
      const usesCaptain = card.trinket?.family === 'team_crest';
      if (usesCaptain && captainCount >= WUT_CAPTAIN_PATCH_LIMIT) continue;
      usedSlots.add(slot); usedCards.add(cardId); if (identity) usedIdentities.add(identity);
      walk(i + 1, usedSlots, usedCards, usedIdentities, captainCount + (usesCaptain ? 1 : 0), count + 1);
      usedSlots.delete(slot); usedCards.delete(cardId); if (identity) usedIdentities.delete(identity);
    }
  };
  walk(0, new Set(), new Set(), new Set(), captainAlreadyActive, 0);
  return Math.min(best, capped);
}

export function chooseAutomaticWutPlacements(args = {}, limit = 2) {
  const capped = Math.max(0, Number(limit || 0));
  if (!capped) return [];
  const options = wutLegalPlayOptions(args).sort((a, b) =>
    asNumber(a.card.power) - asNumber(b.card.power) ||
    Number(a.card.card_id ?? a.card.id) - Number(b.card.card_id ?? b.card.id) ||
    String(a.slot).localeCompare(String(b.slot))
  );
  const own = (args.placements || []).filter(row => Number(row.user_id) === Number(args.userId));
  const captainAlreadyActive = wutCaptainPatchCount(own);
  let best = [];
  let bestPower = Infinity;
  const walk = (index, usedSlots, usedCards, usedIdentities, captainCount, chosen, power) => {
    if (chosen.length > best.length || (chosen.length === best.length && power < bestPower)) {
      best = [...chosen];
      bestPower = power;
    }
    if (best.length >= capped || index >= options.length) return;
    for (let i = index; i < options.length; i += 1) {
      const { slot, card } = options[i];
      const cardId = Number(card.card_id ?? card.id);
      const identity = String(card.card_identity || '').trim();
      const usesCaptain = card.trinket?.family === 'team_crest';
      if (usedSlots.has(slot) || usedCards.has(cardId) || (identity && usedIdentities.has(identity)) || (usesCaptain && captainCount >= WUT_CAPTAIN_PATCH_LIMIT)) continue;
      usedSlots.add(slot); usedCards.add(cardId); if (identity) usedIdentities.add(identity); chosen.push({ slot, card });
      walk(i + 1, usedSlots, usedCards, usedIdentities, captainCount + (usesCaptain ? 1 : 0), chosen, power + asNumber(card.power));
      chosen.pop(); usedSlots.delete(slot); usedCards.delete(cardId); if (identity) usedIdentities.delete(identity);
    }
  };
  walk(0, new Set(), new Set(), new Set(), captainAlreadyActive, [], 0);
  return best.slice(0, capped).map(({ slot, card }) => ({ slot, cardId: Number(card.card_id ?? card.id), identity: card.card_identity }));
}

export function nextWutActivePlayer(match, placements, {
  cardsForUser, slotPowerAllowance = 1, trinketFits = () => true, previousUserId = null
} = {}) {
  const exhausted = new Set((match.exhausted_user_ids || []).map(Number));
  const ids = (match.player_ids || []).map(Number);
  const previous = Number(previousUserId || arenaCurrentPlayerId(match));
  const ordered = [...ids.filter(id => id !== previous), ...ids.filter(id => id === previous)];
  for (const userId of ordered) {
    if (exhausted.has(userId)) continue;
    if ((placements || []).filter(row => Number(row.user_id) === userId).length >= WUT_LINEUP_SLOTS.length) continue;
    const legal = maxWutLegalPlacements({
      cards: cardsForUser(userId), placements, userId, slotPowerAllowance, trinketFits
    }, arenaTurnCap(match));
    if (legal > 0) return userId;
    exhausted.add(userId);
  }
  match.exhausted_user_ids = [...exhausted];
  return null;
}

export function skipWutNoLegalPlayers(match, placements, {
  cardsForUser, slotPowerAllowance = 1, trinketFits = () => true
} = {}) {
  if (!match || match.status !== 'active') return [];
  const skipped = [];
  const playerIds = (match.player_ids || []).map(Number);
  const exhausted = new Set((match.exhausted_user_ids || []).map(Number));
  for (let guard = 0; guard <= playerIds.length; guard += 1) {
    const current = arenaCurrentPlayerId(match);
    if (!playerIds.includes(current)) break;
    const ownCount = (placements || []).filter(row => Number(row.user_id) === current).length;
    const legal = exhausted.has(current) || ownCount >= WUT_LINEUP_SLOTS.length ? 0 : maxWutLegalPlacements({
      cards: cardsForUser(current),
      placements,
      userId: current,
      slotPowerAllowance,
      trinketFits
    }, arenaTurnCap(match));
    if (legal > 0) break;
    exhausted.add(current);
    skipped.push(current);
    match.exhausted_user_ids = [...exhausted];
    const nextPlayer = nextWutActivePlayer(match, placements, {
      cardsForUser,
      slotPowerAllowance,
      trinketFits,
      previousUserId: current
    });
    if (nextPlayer == null) {
      match.status = 'scoring';
      match.current_player_id = null;
      break;
    }
    match.current_player_id = nextPlayer;
  }
  match.exhausted_user_ids = [...new Set([...(match.exhausted_user_ids || []).map(Number), ...skipped])];
  return skipped;
}

export function pairArenaEntries(entries, ratingForEntry = entry => Number(entry.elo || ARENA_DEFAULT_ELO), havePlayed = () => false) {
  const waiting = [...entries];
  let unmatched = null;
  if (waiting.length % 2 === 1) {
    waiting.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || Number(a.id) - Number(b.id));
    const index = Math.max(0, waiting.map(entry => Boolean(entry.priority)).lastIndexOf(false));
    unmatched = waiting.splice(index, 1)[0];
  }
  waiting.sort((a, b) => Number(ratingForEntry(a)) - Number(ratingForEntry(b)) ||
    new Date(a.created_at) - new Date(b.created_at) || Number(a.id) - Number(b.id));
  const pairKey = (a, b) => [Number(a.id), Number(b.id)].sort((x, y) => x - y).join('-');
  const better = (candidate, best) => !best || candidate.rematches < best.rematches ||
    (candidate.rematches === best.rematches && candidate.eloDifference < best.eloDifference) ||
    (candidate.rematches === best.rematches && candidate.eloDifference === best.eloDifference && candidate.key < best.key);
  let pairs;
  if (waiting.length <= 16) {
    const memo = new Map();
    const solve = mask => {
      if (!mask) return { pairs: [], rematches: 0, eloDifference: 0, key: '' };
      if (memo.has(mask)) return memo.get(mask);
      let firstIndex = 0;
      while ((mask & (1 << firstIndex)) === 0) firstIndex += 1;
      let best = null;
      for (let secondIndex = firstIndex + 1; secondIndex < waiting.length; secondIndex += 1) {
        if ((mask & (1 << secondIndex)) === 0) continue;
        const first = waiting[firstIndex];
        const second = waiting[secondIndex];
        const rest = solve(mask & ~(1 << firstIndex) & ~(1 << secondIndex));
        const candidate = {
          pairs: [[first, second], ...rest.pairs],
          rematches: Number(Boolean(havePlayed(first, second))) + rest.rematches,
          eloDifference: Math.abs(Number(ratingForEntry(first)) - Number(ratingForEntry(second))) + rest.eloDifference,
          key: `${pairKey(first, second)}|${rest.key}`
        };
        if (better(candidate, best)) best = candidate;
      }
      memo.set(mask, best);
      return best;
    };
    pairs = solve((1 << waiting.length) - 1)?.pairs || [];
  } else {
    const remaining = [...waiting];
    pairs = [];
    while (remaining.length) {
      const first = remaining.shift();
      const fresh = remaining.filter(candidate => !havePlayed(first, candidate));
      const candidates = fresh.length ? fresh : remaining;
      candidates.sort((a, b) => Math.abs(Number(ratingForEntry(first)) - Number(ratingForEntry(a))) -
        Math.abs(Number(ratingForEntry(first)) - Number(ratingForEntry(b))) || new Date(a.created_at) - new Date(b.created_at));
      const second = candidates[0];
      remaining.splice(remaining.indexOf(second), 1);
      pairs.push([first, second]);
    }
  }
  return { pairs, unmatched };
}

const localHour = (date, timeZone) => Number(new Intl.DateTimeFormat('en-CA', {
  timeZone, hour: '2-digit', hourCycle: 'h23'
}).formatToParts(date).find(part => part.type === 'hour')?.value || 0);

export function nextArenaDeadline(now, config) {
  const zone = config.timeZone || 'America/Los_Angeles';
  const paused = date => {
    const hour = localHour(date, zone);
    const start = Number(config.pauseStartHour ?? 0);
    const end = Number(config.pauseEndHour ?? 8);
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  };
  let cursor = new Date(now);
  let remaining = Number(config.turnHours || 2) * 3600000;
  while (remaining > 0) {
    const step = Math.min(60000, remaining);
    cursor = new Date(cursor.getTime() + step);
    if (!paused(new Date(cursor.getTime() - 1))) remaining -= step;
  }
  return cursor.toISOString();
}

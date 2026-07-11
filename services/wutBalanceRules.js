export const WUT_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const LEGACY_CAPTAIN_PATCH_EFFECTS = { common: .05, uncommon: .08, rare: .12, epic: .16, legendary: .2 };
const LEGACY_GENERALIST_EFFECTS = {
  common: { 3: .03, 4: .05, 5: .07 },
  uncommon: { 3: .04, 4: .07, 5: .1 },
  rare: { 3: .06, 4: .09, 5: .13 },
  epic: { 3: .08, 4: .12, 5: .17 },
  legendary: { 3: .1, 4: .16, 5: .22 }
};
const HEX_CAP_MULTIPLIERS = { common: 1, uncommon: 1.25, rare: 1.5, epic: 1.75, legendary: 2 };
const LEGACY_WARDING_CHARM_EFFECTS = { common: .2, uncommon: .35, rare: .5, epic: .65, legendary: .8 };
const REDIRECT_WARDING_CHARM_EFFECTS = { common: .25, uncommon: .4, rare: .55, epic: .7, legendary: .85 };

// Launch defaults. Live values are copied into persisted WUT configuration so
// admins can tune future shops and match snapshots without changing source.
export const WUT_LAUNCH_TRINKET_EFFECTS = {
  lucky_charm: { common: { rolls: 1, threshold: 1.25 }, uncommon: { rolls: 1, threshold: 1.1 }, rare: { rolls: 1, threshold: 1 }, epic: { rolls: 2, threshold: 1 }, legendary: { rolls: 3, threshold: 1 } },
  safety_net: { common: .25, uncommon: .35, rare: .45, epic: .6, legendary: .75 },
  glass_skates: {
    common: { threshold: .8, bonus: .25, penalty: .07 },
    uncommon: { threshold: .7, bonus: .3, penalty: .07 },
    rare: { threshold: .6, bonus: .35, penalty: .07 },
    epic: { threshold: .5, bonus: .4, penalty: .07 },
    legendary: { threshold: .4, bonus: .5, penalty: .07 }
  },
  hex_bag: { common: [3, .4, 1], uncommon: [2.75, .5, 1.25], rare: [2.5, .6, 1.5], epic: [2.25, .7, 1.75], legendary: [2, .8, 2] },
  warding_charm: { common: 80, uncommon: 65, rare: 50, epic: 38, legendary: 28 },
  specialist_tape: { common: .08, uncommon: .12, rare: .18, epic: .25, legendary: .35 },
  first_strike_tape: { common: .05, uncommon: .08, rare: .12, epic: .17, legendary: .23 },
  counterpunch_gloves: { common: .05, uncommon: .08, rare: .12, epic: .17, legendary: .23 },
  underdog_patch: { common: [.05, .15], uncommon: [.07, .22], rare: [.09, .3], epic: [.12, .4], legendary: [.15, .5] },
  team_crest: { common: .02, uncommon: .03, rare: .04, epic: .05, legendary: .06 },
  siphon_stone: {
    common: { threshold: .5, steal: .04 },
    uncommon: { threshold: .4, steal: .06 },
    rare: { threshold: .3, steal: .08 },
    epic: { threshold: .25, steal: .11 },
    legendary: { threshold: .2, steal: .14 }
  },
  journeyman: {
    common: { mode: 'random_all', crossSide: false },
    uncommon: { mode: 'random_own', crossSide: false },
    rare: { mode: 'choose_own', crossSide: false },
    epic: { mode: 'choose_own_or_opposite', crossSide: true },
    legendary: { mode: 'choose_any', crossSide: true }
  },
  booster_cable: {
    common: { own: .15, adjacent: 0, adjacentMode: 'none', loadBonus: 0 },
    uncommon: { own: .22, adjacent: 0, adjacentMode: 'none', loadBonus: 0 },
    rare: { own: .3, adjacent: .05, adjacentMode: 'strongest', loadBonus: 0 },
    epic: { own: .32, adjacent: .06, adjacentMode: 'all', loadBonus: 1 },
    legendary: { own: .42, adjacent: .1, adjacentMode: 'all', loadBonus: 1 }
  },
  generalist: {
    common: { minCategories: 3, maxBonus: .08 },
    uncommon: { minCategories: 3, maxBonus: .11 },
    rare: { minCategories: 3, maxBonus: .15 },
    epic: { minCategories: 3, maxBonus: .2 },
    legendary: { minCategories: 3, maxBonus: .26 }
  },
  zebra_stripes: { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 }
};

// Drives the adaptive Admin editor and its server-side validation. Percent
// fields are shown as human percentages but stored as decimal rates.
export const WUT_TRINKET_ADMIN_FIELDS = Object.freeze({
  lucky_charm: [
    { key: 'rolls', label: 'Unused bonus games rolled', kind: 'integer', min: 1, step: 1 },
    { key: 'threshold', label: 'Required roll ratio (1.25 = 25% higher)', kind: 'number', min: 1, step: .01 }
  ],
  safety_net: [{ key: 'value', label: 'Floor vs. other-roll average', kind: 'percent', min: 0, step: .1 }],
  glass_skates: [
    { key: 'threshold', label: 'Required highest-roll lead', kind: 'percent', min: 0, step: .1 },
    { key: 'bonus', label: 'Total FP bonus on hit', kind: 'percent', min: 0, step: .1 },
    { key: 'penalty', label: 'Total FP penalty on miss', kind: 'percent', min: 0, step: .1 }
  ],
  hex_bag: [
    { key: '0', label: 'Required opposing FP multiple', kind: 'number', min: 0, step: .01 },
    { key: '1', label: 'Opposing FP reduction', kind: 'percent', min: 0, step: .1 },
    { key: '2', label: 'Maximum drain as own FP multiple', kind: 'number', min: 0, step: .01 }
  ],
  warding_charm: [{ key: 'value', label: 'FP lead needed for full prevention', kind: 'number', min: 1, step: 1 }],
  specialist_tape: [{ key: 'value', label: 'Top stat-category FP bonus', kind: 'percent', min: 0, step: .1 }],
  first_strike_tape: [{ key: 'value', label: 'Base FP bonus', kind: 'percent', min: 0, step: .1 }],
  counterpunch_gloves: [{ key: 'value', label: 'Base FP bonus', kind: 'percent', min: 0, step: .1 }],
  underdog_patch: [
    { key: '0', label: 'Base FP per rarity tier', kind: 'percent', min: 0, step: .1 },
    { key: '1', label: 'Maximum base FP bonus', kind: 'percent', min: 0, step: .1 }
  ],
  team_crest: [{ key: 'value', label: 'Base FP bonus per same-team teammate', kind: 'percent', min: 0, step: .1 }],
  siphon_stone: [
    { key: 'threshold', label: 'Required win margin', kind: 'percent', min: 0, step: .1 },
    { key: 'steal', label: 'Opposing FP stolen', kind: 'percent', min: 0, step: .1 }
  ],
  journeyman: [],
  booster_cable: [
    { key: 'own', label: 'Own boost FP copied', kind: 'percent', min: 0, step: .1 },
    { key: 'adjacent', label: 'Adjacent boost FP copied', kind: 'percent', min: 0, step: .1 },
    { key: 'loadBonus', label: 'Additional lineup Boost Load', kind: 'integer', min: 0, step: 1 }
  ],
  generalist: [
    { key: 'minCategories', label: 'Minimum scoring categories', kind: 'integer', min: 1, step: 1 },
    { key: 'maxBonus', label: 'Max base FP bonus at perfect balance', kind: 'percent', min: 0, step: .1 }
  ],
  zebra_stripes: [{ key: 'value', label: 'Rarity tiers removed', kind: 'integer', min: 0, step: 1 }]
});

export const WUT_LINEUP_SLOTS = ['F1', 'F2', 'D1', 'D2', 'G'];
export const WUT_TRINKET_POSITION_RULES = {
  specialist_tape: ['F', 'D'],
  generalist: ['F', 'D']
};

export function trinketFitsWutPosition(family, position) {
  const allowed = WUT_TRINKET_POSITION_RULES[String(family || '')];
  return !allowed || allowed.includes(String(position || '').toUpperCase());
}

export function normalizeWutTrinketEffect(family, rarity, effect) {
  const cleanRarity = String(rarity || '').toLowerCase();
  if (String(family || '') === 'hex_bag') {
    const defaults = WUT_LAUNCH_TRINKET_EFFECTS.hex_bag[cleanRarity] || WUT_LAUNCH_TRINKET_EFFECTS.hex_bag.common;
    const values = Array.isArray(effect) ? effect : [effect?.[0], effect?.[1], effect?.[2]];
    return [
      Math.max(0, Number(values?.[0] ?? defaults[0]) || 0),
      Math.max(0, Number(values?.[1] ?? defaults[1]) || 0),
      Math.max(0, Number(values?.[2] ?? HEX_CAP_MULTIPLIERS[cleanRarity] ?? defaults[2]) || 0)
    ];
  }
  if (String(family || '') === 'warding_charm') {
    const legacyValue = Number(effect);
    const value = effect && typeof effect === 'object'
      ? Number(effect.value ?? 0)
      : (Number.isFinite(legacyValue) ? legacyValue : 0);
    const oldValues = [LEGACY_WARDING_CHARM_EFFECTS[cleanRarity], REDIRECT_WARDING_CHARM_EFFECTS[cleanRarity]];
    if (Number.isFinite(value) && (value <= 1 || oldValues.some(old => Math.abs(value - Number(old)) < 1e-9))) {
      return WUT_LAUNCH_TRINKET_EFFECTS.warding_charm[cleanRarity] ?? value;
    }
    return Number.isFinite(value) ? Math.max(1, value) : WUT_LAUNCH_TRINKET_EFFECTS.warding_charm[cleanRarity];
  }
  if (String(family || '') === 'siphon_stone') {
    const defaults = WUT_LAUNCH_TRINKET_EFFECTS.siphon_stone[cleanRarity] || WUT_LAUNCH_TRINKET_EFFECTS.siphon_stone.common;
    if (effect && typeof effect === 'object' && Object.prototype.hasOwnProperty.call(effect, 'steal')) {
      return {
        threshold: Math.max(0, Number(effect.threshold ?? defaults.threshold) || 0),
        steal: Math.max(0, Number(effect.steal ?? defaults.steal) || 0)
      };
    }
    return { ...defaults };
  }
  if (String(family || '') === 'team_crest') {
    if (effect && typeof effect === 'object' && Object.prototype.hasOwnProperty.call(effect, 'countBonus')) {
      return WUT_LAUNCH_TRINKET_EFFECTS.team_crest[cleanRarity] ?? 0;
    }
    const legacyValue = Number(effect);
    const value = effect && typeof effect === 'object'
      ? Number(effect.value ?? 0)
      : (Number.isFinite(legacyValue) ? legacyValue : 0);
    if (Number.isFinite(value) && Math.abs(value - Number(LEGACY_CAPTAIN_PATCH_EFFECTS[cleanRarity])) < 1e-9) {
      return WUT_LAUNCH_TRINKET_EFFECTS.team_crest[cleanRarity] ?? value;
    }
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }
  if (String(family || '') === 'generalist') {
    const defaults = WUT_LAUNCH_TRINKET_EFFECTS.generalist[cleanRarity] || WUT_LAUNCH_TRINKET_EFFECTS.generalist.common;
    if (effect && typeof effect === 'object' && Object.prototype.hasOwnProperty.call(effect, 'maxBonus')) {
      return {
        minCategories: Math.max(1, Math.round(Number(effect.minCategories ?? defaults.minCategories))),
        maxBonus: Math.max(0, Number(effect.maxBonus ?? defaults.maxBonus) || 0)
      };
    }
    if (effect && typeof effect === 'object') {
      const legacy = LEGACY_GENERALIST_EFFECTS[cleanRarity];
      const matchesLegacy = legacy && ['3', '4', '5'].every(key => Math.abs(Number(effect[key] ?? effect[Number(key)]) - Number(legacy[key])) < 1e-9);
      if (matchesLegacy) return { ...defaults };
      const maxBonus = Number(effect[5] ?? effect['5'] ?? effect[4] ?? effect['4'] ?? effect[3] ?? effect['3'] ?? defaults.maxBonus);
      return { minCategories: 3, maxBonus: Math.max(0, Number.isFinite(maxBonus) ? maxBonus : defaults.maxBonus) };
    }
    const scalar = Number(effect);
    return { minCategories: defaults.minCategories, maxBonus: Math.max(0, Number.isFinite(scalar) ? scalar : defaults.maxBonus) };
  }
  return effect;
}

// "Adjacent" follows the visible top-to-bottom lineup order. This gives every
// slot at most two neighbours and makes the rule legible in both match columns.
export function adjacentWutSlots(slot) {
  const index = WUT_LINEUP_SLOTS.indexOf(String(slot || '').toUpperCase());
  if (index < 0) return [];
  return [WUT_LINEUP_SLOTS[index - 1], WUT_LINEUP_SLOTS[index + 1]].filter(Boolean);
}

export function rarityIndex(rarity) {
  return WUT_RARITIES.indexOf(String(rarity || '').toLowerCase());
}

export function resolveZebraStripes(entries = [], effectTable = WUT_LAUNCH_TRINKET_EFFECTS) {
  return entries.map(entry => {
    const originalTrinket = entry.trinket ? structuredClone(entry.trinket) : null;
    if (!originalTrinket || originalTrinket.family === 'zebra_stripes') return { ...entry, originalTrinket, trinket: originalTrinket };
    const opposing = entries.find(other =>
      Number(other.userId ?? other.placement?.user_id) !== Number(entry.userId ?? entry.placement?.user_id) &&
      String(other.slot ?? other.placement?.slot) === String(entry.slot ?? entry.placement?.slot)
    );
    if (opposing?.trinket?.family !== 'zebra_stripes') return { ...entry, originalTrinket, trinket: originalTrinket };
    const reduction = Math.max(0, Number(opposing.trinket.effect ?? effectTable.zebra_stripes?.[opposing.trinket.rarity] ?? 0));
    const effectiveIndex = rarityIndex(originalTrinket.rarity) - reduction;
    if (effectiveIndex < 0) return { ...entry, originalTrinket, trinket: null, zebraReduction: reduction, zebraRarity: opposing.trinket.rarity };
    const rarity = WUT_RARITIES[effectiveIndex];
    return {
      ...entry,
      originalTrinket,
      zebraReduction: reduction,
      zebraRarity: opposing.trinket.rarity,
      trinket: { ...originalTrinket, rarity, effect: structuredClone(effectTable[originalTrinket.family]?.[rarity]) }
    };
  });
}

export function lockWardingChoices(existingPlacements = [], newPlacements = [], { automatic = false } = {}) {
  const all = [...existingPlacements, ...newPlacements];
  const targetKeys = new Set();
  for (const row of all.filter(item => item.card_snapshot?.trinket?.family === 'warding_charm')) {
    const target = String(row.ward_target_slot || '').toUpperCase();
    if (!target) continue;
    const key = `${Number(row.user_id)}|${target}`;
    if (targetKeys.has(key)) throw new Error('Only one Warding Charm can protect a card.');
    targetKeys.add(key);
  }
  for (const row of newPlacements.filter(item => item.card_snapshot?.trinket?.family === 'warding_charm')) {
    const candidates = all.filter(item =>
      item !== row &&
      Number(item.user_id) === Number(row.user_id) &&
      item.card_snapshot &&
      String(item.slot || '').toUpperCase() !== String(row.slot || '').toUpperCase()
    );
    let target = String(row.ward_target_slot || '').toUpperCase();
    if (!candidates.length) {
      row.ward_target_slot = '';
      continue;
    }
    if (!target && automatic) target = String(candidates[0].slot || '').toUpperCase();
    if (!candidates.some(item => String(item.slot || '').toUpperCase() === target)) {
      throw new Error('Choose another committed card for Warding Charm to protect.');
    }
    const duplicate = all.some(item =>
      item !== row &&
      Number(item.user_id) === Number(row.user_id) &&
      item.card_snapshot?.trinket?.family === 'warding_charm' &&
      String(item.ward_target_slot || '').toUpperCase() === target
    );
    if (duplicate) throw new Error('Only one Warding Charm can protect a card.');
    row.ward_target_slot = target;
  }
}

function printedIdentity(entry) {
  return String(entry.printedChemistryKey || entry.chemistryKey || '').trim();
}

export function journeymanCandidateIdentity(entry) {
  const committed = String(
    entry?.placement?.journeyman_key_effective || entry?.placement?.journeyman_key ||
    entry?.row?.journeyman_key_effective || entry?.row?.journeyman_key ||
    entry?.journeymanKey || ''
  ).trim();
  const isJourneyman = entry?.trinket?.family === 'journeyman' || entry?.originalTrinket?.family === 'journeyman';
  if (isJourneyman && committed) return committed;
  return String(entry?.chemistryKey || printedIdentity(entry)).trim();
}

function uniqueCandidates(entries) {
  return entries.filter(entry => journeymanCandidateIdentity(entry));
}

export function journeymanCandidates(entry, entries = []) {
  if (entry.trinket?.family !== 'journeyman') return [];
  const mode = entry.trinket.effect?.mode;
  const userId = Number(entry.userId ?? entry.placement?.user_id);
  const slot = String(entry.slot ?? entry.placement?.slot);
  const ownIdentity = printedIdentity(entry);
  const ownSeason = ownIdentity.split('|')[0];
  const otherCard = candidate => candidate !== entry && journeymanCandidateIdentity(candidate) !== ownIdentity;
  const allowedSeason = candidate => mode === 'choose_any' || journeymanCandidateIdentity(candidate).split('|')[0] === ownSeason;
  const ownSide = candidate => Number(candidate.userId ?? candidate.placement?.user_id) === userId;
  const adjacent = candidate => ownSide(candidate) && adjacentWutSlots(slot).includes(String(candidate.slot ?? candidate.placement?.slot));
  const opposite = candidate => !ownSide(candidate) && String(candidate.slot ?? candidate.placement?.slot) === slot;
  const pool = uniqueCandidates(entries).filter(candidate => otherCard(candidate) && allowedSeason(candidate));
  if (mode === 'random_all') return pool;
  if (mode === 'random_own') return pool.filter(ownSide);
  if (mode === 'choose_own') return pool.filter(ownSide);
  if (mode === 'choose_adjacent') return pool.filter(adjacent);
  if (mode === 'choose_own_or_opposite') return pool.filter(candidate => ownSide(candidate) || opposite(candidate));
  if (mode === 'choose_adjacent_or_opposite') return pool.filter(candidate => adjacent(candidate) || opposite(candidate));
  if (mode === 'choose_any') return pool;
  return [];
}

export function chooseJourneymanIdentity(entry, entries = [], random = Math.random) {
  const candidates = journeymanCandidates(entry, entries);
  if (!candidates.length) return '';
  if (String(entry.trinket?.effect?.mode || '').startsWith('random_')) {
    return journeymanCandidateIdentity(candidates[Math.floor(random() * candidates.length)]);
  }
  const userId = Number(entry.userId ?? entry.placement?.user_id);
  const crossSide = Boolean(entry.trinket?.effect?.crossSide);
  const ownSide = entries.filter(candidate => Number(candidate.userId ?? candidate.placement?.user_id) === userId);
  const chemistryRate = count => count >= 5 ? .25 : count === 4 ? .2 : count === 3 ? .15 : count === 2 ? .1 : 0;
  const teamValue = identity => ownSide.reduce((sum, candidate) => {
    const candidateIdentity = candidate === entry ? identity : journeymanCandidateIdentity(candidate);
    const count = candidate === entry && crossSide
      ? entries.filter(other => (other === entry ? identity : journeymanCandidateIdentity(other)) === candidateIdentity).length
      : ownSide.filter(other => (other === entry ? identity : journeymanCandidateIdentity(other)) === candidateIdentity).length;
    return sum + Math.max(1, Number(candidate.baseExactFp || candidate.weight || 1)) * chemistryRate(count);
  }, 0);
  return journeymanCandidateIdentity([...candidates].sort((a, b) => teamValue(journeymanCandidateIdentity(b)) - teamValue(journeymanCandidateIdentity(a)))[0]);
}

// Team selection is committed before Zebra Stripes resolves. A choice that was
// legal at commit remains locked even if Zebra later lowers Journeyman into a
// rarity that could not normally make that choice. The downgraded trinket still
// controls scoring behavior such as whether opposing cards count for chemistry.
export function resolveJourneymanIdentity(entry, entries = [], lockedIdentity = '', random = Math.random) {
  if (entry.trinket?.family !== 'journeyman') return printedIdentity(entry);
  const locked = String(lockedIdentity || '').trim();
  if (locked) {
    const explicitPreexisting = entry.placement?.journeyman_zebra_preexisting ?? entry.row?.journeyman_zebra_preexisting;
    const opponentZebra = entries.find(other =>
      Number(other.userId ?? other.placement?.user_id ?? other.row?.user_id) !== Number(entry.userId ?? entry.placement?.user_id ?? entry.row?.user_id) &&
      String(other.slot ?? other.placement?.slot ?? other.row?.slot) === String(entry.slot ?? entry.placement?.slot ?? entry.row?.slot) &&
      (other.originalTrinket?.family === 'zebra_stripes' || other.trinket?.family === 'zebra_stripes')
    );
    const entryTime = new Date(entry.placement?.committed_at ?? entry.row?.committed_at ?? entry.committedAt ?? '').getTime();
    const zebraTime = new Date(opponentZebra?.placement?.committed_at ?? opponentZebra?.row?.committed_at ?? opponentZebra?.committedAt ?? '').getTime();
    const zebraPreexisting = typeof explicitPreexisting === 'boolean'
      ? explicitPreexisting
      : Number.isFinite(entryTime) && Number.isFinite(zebraTime) && zebraTime < entryTime;
    const selectionTrinket = zebraPreexisting
      ? entry.trinket
      : entry.originalTrinket?.family === 'journeyman' ? entry.originalTrinket : entry.trinket;
    const selectionEntry = { ...entry, trinket: selectionTrinket };
    const allowed = new Set(journeymanCandidates(selectionEntry, entries).map(journeymanCandidateIdentity));
    if (allowed.has(locked)) return locked;
  }
  return chooseJourneymanIdentity(entry, entries, random) || printedIdentity(entry);
}

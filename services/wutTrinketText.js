export const WUT_TRINKET_NAMES = Object.freeze({
  lucky_charm: 'Lucky Charm',
  safety_net: 'Safety Net',
  glass_skates: 'Glass Skates',
  hex_bag: 'Hex Charm',
  warding_charm: 'Warding Charm',
  specialist_tape: 'Specialist',
  first_strike_tape: 'First Strike',
  counterpunch_gloves: 'Counterpunch Gloves',
  underdog_patch: 'Underdog Patch',
  team_crest: "Captain's Patch",
  siphon_stone: 'Siphon Stone',
  journeyman: 'Journeyman',
  booster_cable: 'Booster Cable',
  generalist: 'Generalist',
  zebra_stripes: 'Zebra Stripes'
});

export const WUT_TRINKET_ICONS = Object.freeze({
  lucky_charm: '🍀', safety_net: '🕸️', glass_skates: '⛸️', hex_bag: '🌀',
  warding_charm: '🛡️', specialist_tape: '🎯', first_strike_tape: '⚡',
  counterpunch_gloves: '🥊', underdog_patch: '🐕', team_crest: 'C',
  siphon_stone: '🩸', journeyman: '🧳', booster_cable: '🔌',
  generalist: '🧰', zebra_stripes: '🦓'
});

export function wutTitleCase(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

export function wutTrinketName(family) {
  return WUT_TRINKET_NAMES[String(family || '')] || wutTitleCase(family);
}

export function wutTrinketIcon(itemOrFamily) {
  const item = typeof itemOrFamily === 'object' && itemOrFamily !== null ? itemOrFamily : { family: itemOrFamily };
  const family = String(item.family || '');
  const role = String(item.captain_role || item.captainRole || '').toLowerCase();
  if (family === 'team_crest' && role === 'assistant_captain') return 'A';
  return WUT_TRINKET_ICONS[family] || '◆';
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

export function wutTrinketDescription(item = {}) {
  const effect = item.effect;
  switch (item.family) {
    case 'lucky_charm': {
      const threshold = Number(effect?.threshold || 1);
      const hurdle = threshold > 1 ? ` by ${percent(threshold - 1)}` : '';
      return `Roll ${effect?.rolls || 1} unused bonus game${Number(effect?.rolls || 1) === 1 ? '' : 's'}. If the best beats the current highest${hurdle}, it replaces the lowest roll.`;
    }
    case 'safety_net':
      return `Raise the lowest roll to ${percent(effect)} of the other two rolls' average, if that would improve it.`;
    case 'glass_skates':
      return `If the highest roll beats the second-highest by ${percent(effect?.threshold)}, gain ${percent(effect?.bonus)} total base FP. Otherwise lose ${percent(effect?.penalty)}.`;
    case 'hex_bag':
      return `If the matching opponent has at least ${effect?.[0]}x this card's pre-counter FP (10 FP minimum), reduce their FP by ${percent(effect?.[1])}, capped at ${effect?.[2]}x this card's FP.`;
      return `If the matching opponent has at least ${effect?.[0]}× this card's pre-counter FP (10 FP minimum), reduce their FP by ${percent(effect?.[1])}.`;
    case 'warding_charm':
      return `When committed, choose another friendly card. If an opposing trinket would reduce that card's FP, prevent up to 100% of the loss based on how much this card outscored the attacker. Full prevention requires a ${Number(effect || 0)} FP lead.`;
    case 'specialist_tape':
      return `Skaters only. Add ${percent(effect)} of this card's highest-scoring stat category to its total FP.`;
    case 'first_strike_tape':
      return `Gain ${percent(effect)} base FP when this card is committed before its matching opponent.`;
    case 'counterpunch_gloves':
      return `Gain ${percent(effect)} base FP when this card is committed after its matching opponent.`;
    case 'underdog_patch':
      return `Gain ${percent(effect?.[0])} base FP for each card-rarity tier the matching opponent is above this card, up to ${percent(effect?.[1])}. Trinket rarity does not count.`;
    case 'team_crest': {
      const value = effect && typeof effect === 'object' ? effect.value : effect;
      const role = String(item.captain_role || item.captainRole || '').toLowerCase();
      const base = `This card gains ${percent(value)} base FP for each other same-team, same-season player in your lineup.`;
      if (role === 'assistant_captain') return `Assistant Captain: ${base} Assistant Captains receive 50% of this benefit.`;
      return `${base} Up to two Captain's Patches can be active; the second one played becomes an Assistant Captain and receives 50% of this benefit.`;
    }
    case 'siphon_stone':
      return `If this card outscores the opposing card by ${percent(effect?.threshold)} or more, steal ${percent(effect?.steal)} of their FP.`;
    case 'journeyman':
      return ({
        random_all: 'Randomly copy another same-season team in either lineup for chemistry.',
        random_own: 'Randomly copy another same-season team in your lineup for chemistry.',
        choose_own: 'Choose another same-season team in your lineup to copy for chemistry.',
        choose_own_or_opposite: 'Choose a same-season team from your lineup or the matching opponent. Journeyman counts matching cards on both sides.',
        choose_any: 'Choose any team in play, from any season. Journeyman counts matching cards on both sides.'
      })[effect?.mode] || 'Copy another team identity for chemistry this match.';
    case 'booster_cable': {
      const own = `Gain ${percent(effect?.own)} of the FP produced by this card's boost`;
      const adjacent = Number(effect?.adjacent || 0) > 0
        ? `, plus ${percent(effect.adjacent)} of ${effect.adjacentMode === 'strongest' ? 'the strongest adjacent boost' : 'each adjacent boost'}`
        : '';
      return `${own}${adjacent}.${effect?.loadBonus ? ` Lineup Boost Load +${effect.loadBonus}.` : ''}`;
    }
    case 'generalist':
      return `Skaters only. If this card scores FP in at least ${effect?.minCategories || 3} skater categories, gain up to ${percent(effect?.maxBonus)} base FP based on how evenly its FP is spread across goals, assists, shots, hits, and blocks.`;
    case 'zebra_stripes':
      return `Downgrade the trinket in the opposing slot by ${effect} rarit${Number(effect) === 1 ? 'y' : 'ies'}. A trinket pushed below Common is nullified.`;
    default:
      return '';
  }
}

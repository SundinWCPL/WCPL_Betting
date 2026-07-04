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
      return `If the matching opponent has at least ${effect?.[0]}× this card's pre-counter FP (10 FP minimum), reduce their FP by ${percent(effect?.[1])}.`;
    case 'warding_charm':
      return `Block ${percent(effect)} of incoming Hex Charm and Siphon Stone effects in the matching slot.`;
    case 'specialist_tape':
      return `Skaters only. Add ${percent(effect)} of this card's highest-scoring stat category to its total FP.`;
    case 'first_strike_tape':
      return `Gain ${percent(effect)} base FP when this card is committed before its matching opponent.`;
    case 'counterpunch_gloves':
      return `Gain ${percent(effect)} base FP when this card is committed after its matching opponent.`;
    case 'underdog_patch':
      return `Gain ${percent(effect?.[0])} base FP for each card-rarity tier the matching opponent is above this card, up to ${percent(effect?.[1])}. Trinket rarity does not count.`;
    case 'team_crest':
      return `Increase this lineup's same-team, same-season chemistry bonus by ${percent(effect)}. Only one Captain's Patch can be active per lineup.`;
    case 'siphon_stone':
      return `Steal ${percent(effect)} of the pre-counter FP lead held by the matching opponent.`;
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
      return `Skaters only. Gain ${percent(effect?.[3])}, ${percent(effect?.[4])}, or ${percent(effect?.[5])} total base FP for recording 3, 4, or 5 of: goals, assists, shots, hits, and blocks.`;
    case 'zebra_stripes':
      return `Downgrade the trinket in the opposing slot by ${effect} rarit${Number(effect) === 1 ? 'y' : 'ies'}. A trinket pushed below Common is nullified.`;
    default:
      return '';
  }
}

import fs from 'fs/promises';
import path from 'path';
import { buildCardPlayerCatalog } from '../services/cards.js';
import { WUT_LAUNCH_TRINKET_EFFECTS, trinketFitsWutPosition } from '../services/wutBalanceRules.js';

const dbPath = path.resolve(process.env.JSON_DB_PATH || './betting.json');
const state = JSON.parse(await fs.readFile(dbPath, 'utf8'));
const catalog = await buildCardPlayerCatalog({ seasonId: state.settings?.seasonId || 'S3', scoringConfig: state.cards?.config?.scoring || {} });
const catalogByIdentity = new Map(catalog.flatMap(player => [
  [player.cardIdentity, player],
  [player.catalogKey, player],
  [`${player.edition || 'S3'}|${player.divisionId}|${player.playerKey}`, player]
]));
const cards = new Map((state.cards?.ownedCards || []).map(card => [Number(card.id), card]));
const trinkets = new Map((state.cards?.trinkets || []).map(trinket => [Number(trinket.id), trinket]));
const issues = [];
const issue = message => issues.push(message);
const playerFor = card => catalogByIdentity.get(card?.card_identity) || catalogByIdentity.get(`${card?.edition || 'S3'}|${card?.division_id}|${card?.player_key}`);
const rarityPower = rarity => Number(state.cards?.config?.wut?.rarityCosts?.[rarity] || ({ common:1, uncommon:2, rare:3, epic:4, legendary:5, mythic:6 })[rarity] || 0);

for (const card of cards.values()) {
  const player = playerFor(card);
  if (!player) issue(`Card #${card.id} (${card.card_identity}) is missing from the catalog.`);
  if (player?.edition === 'S3' && !player.rarityEligible) issue(`Card #${card.id} owns provisional S3 player ${player.name} with fewer than 6 GP.`);
  if (card.trinket_id != null) {
    const trinket = trinkets.get(Number(card.trinket_id));
    if (!trinket) issue(`Card #${card.id} references missing trinket #${card.trinket_id}.`);
    else {
      if (Number(trinket.user_id) !== Number(card.user_id)) issue(`Card #${card.id} and trinket #${trinket.id} have different owners.`);
      if (Number(trinket.attached_card_id) !== Number(card.id)) issue(`Card #${card.id} and trinket #${trinket.id} attachment links disagree.`);
      if (player && !trinketFitsWutPosition(trinket.family, player.position)) issue(`${trinket.family} #${trinket.id} is illegal on ${player.position} card #${card.id}.`);
      if (JSON.stringify(trinket.effect) !== JSON.stringify(WUT_LAUNCH_TRINKET_EFFECTS[trinket.family]?.[trinket.rarity])) issue(`Trinket #${trinket.id} has stale effect data.`);
    }
  }
}

for (const trinket of trinkets.values()) {
  if (trinket.attached_card_id == null) continue;
  const card = cards.get(Number(trinket.attached_card_id));
  if (!card) issue(`Trinket #${trinket.id} references missing card #${trinket.attached_card_id}.`);
  else if (Number(card.trinket_id) !== Number(trinket.id)) issue(`Trinket #${trinket.id} and card #${card.id} attachment links disagree.`);
}

for (const deck of state.cards?.decks || []) {
  const active = (deck.active_card_ids || []).map(Number);
  const bench = (deck.bench_card_ids || []).map(Number);
  if (active.length < 5 || active.length > 8 || new Set(active).size !== active.length) issue(`Deck #${deck.id} Active Deck must contain 5-8 unique cards.`);
  if (bench.length !== 5 || new Set(bench).size !== 5) issue(`Deck #${deck.id} Safety Bench must contain 5 unique cards.`);
  const deckCards = [...active, ...bench].map(id => cards.get(id));
  if (deckCards.some(card => !card || Number(card.user_id) !== Number(deck.user_id))) issue(`Deck #${deck.id} references a missing or foreign-owned card.`);
  const benchPlayers = bench.map(id => playerFor(cards.get(id))).filter(Boolean);
  if (benchPlayers.length === 5 && benchPlayers.map(player => player.position).sort().join('') !== 'DDFFG') issue(`Deck #${deck.id} Safety Bench is not 2F / 2D / 1G.`);
  bench.forEach(id => {
    const card = cards.get(id);
    const player = playerFor(card);
    const trinket = trinkets.get(Number(card?.trinket_id));
    if (player && rarityPower(player.tier) + rarityPower(trinket?.rarity) > 2) issue(`Deck #${deck.id} Safety Bench card #${id} exceeds Power 2.`);
  });
}

for (const match of [...(state.cards?.arena?.matches || []), ...(state.cards?.arena?.debugMatches || [])]) {
  for (const userId of match.player_ids || []) {
    const rows = (match.placements || []).filter(row => Number(row.user_id) === Number(userId));
    if (new Set(rows.map(row => row.slot)).size !== rows.length) issue(`Match ${match.id} has duplicate slots for side/user ${userId}.`);
    if (new Set(rows.map(row => Number(row.card_id))).size !== rows.length) issue(`Match ${match.id} has duplicate cards for side/user ${userId}.`);
  }
}

for (const membership of state.cards?.wutMemberships || []) {
  if (Number(membership.wut_coins || 0) < 0) issue(`User #${membership.user_id} has negative WUT Coins.`);
}

console.log(`WUT state audit: ${cards.size} cards, ${trinkets.size} trinkets, ${(state.cards?.decks || []).length} decks, ${issues.length} issue(s).`);
for (const message of issues) console.log(`- ${message}`);
if (issues.length) process.exitCode = 1;

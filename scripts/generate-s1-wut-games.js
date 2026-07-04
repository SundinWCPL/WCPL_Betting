import fs from 'node:fs';
import path from 'node:path';
import { buildCardPlayerCatalog } from '../services/cards.js';

const destination = path.resolve('data/S1/s1_wut_synthetic_games.csv');
const players = (await buildCardPlayerCatalog()).filter(player => player.edition === 'S1');
const sampleSize = 10;
const number = value => Number(value || 0) || 0;
const csv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const hash = value => [...String(value)].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
const distribute = (total, count, seed) => {
  const output = Array(count).fill(Math.floor(total / count));
  for (let index = 0; index < total % count; index += 1) output[(index + seed) % count] += 1;
  return output;
};

const rows = ['match_id,player_name,steam_id,position,g,a,shots,hits,blocks,sa,ga,so'];
for (const player of players) {
  const goalie = player.position === 'G';
  const stats = player.editionStats || {};
  const games = Math.max(1, number(stats.games));
  const seed = hash(player.sourcePlayerKey || player.baseName) % sampleSize;
  const scaled = key => Math.max(0, Math.round(number(stats[key]) / games * sampleSize));
  const values = goalie
    ? { sa: distribute(scaled('shotsAgainst'), sampleSize, seed), ga: distribute(scaled('goalsAgainst'), sampleSize, seed + 1), so: distribute(Math.min(sampleSize, scaled('shutouts')), sampleSize, seed + 2) }
    : { g: distribute(scaled('goals'), sampleSize, seed), a: distribute(scaled('assists'), sampleSize, seed + 1), shots: distribute(scaled('shots'), sampleSize, seed + 2), hits: distribute(scaled('hits'), sampleSize, seed), blocks: distribute(scaled('blocks'), sampleSize, seed + 1) };
  for (let index = 0; index < sampleSize; index += 1) {
    rows.push([`S1-WUT-${player.sourcePlayerKey || player.baseName}-${index + 1}`, player.baseName, player.sourceSteamId, player.position, values.g?.[index] || 0, values.a?.[index] || 0, values.shots?.[index] || 0, values.hits?.[index] || 0, values.blocks?.[index] || 0, values.sa?.[index] || 0, values.ga?.[index] || 0, values.so?.[index] || 0].map(csv).join(','));
  }
}
fs.writeFileSync(destination, `${rows.join('\n')}\n`);
console.log(`Wrote ${rows.length - 1} permanent S1 WUT game rows to ${destination}`);

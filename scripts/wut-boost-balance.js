import fs from 'fs/promises';
import path from 'path';
import {
  BOOST_TYPES,
  DEFAULT_BOOST_EFFECTS,
  boostFantasyBonus,
  buildCardPlayerCatalog,
  isPlayerPackEligible,
  scoreHistoricalCardSample
} from '../services/cards.js';

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const SAMPLES = Math.max(1, Number(process.argv.find(arg => arg.startsWith('--samples='))?.split('=')[1] || 5));
const SEED = Number(process.argv.find(arg => arg.startsWith('--seed='))?.split('=')[1] || 20260703);
const OUTPUT = path.resolve(process.argv.find(arg => arg.startsWith('--output='))?.split('=')[1] || 'data/wut-boost-balance.json');

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(values, pct) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)))] || 0;
}

const originalRandom = Math.random;
Math.random = mulberry32(SEED);
try {
  const catalog = (await buildCardPlayerCatalog()).filter(player => player.position && isPlayerPackEligible(player));
  const observations = [];
  for (const player of catalog) {
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const score = await scoreHistoricalCardSample({ player, position: player.position });
      if (!score.gamesPlayed || !Number.isFinite(score.exactFp)) continue;
      observations.push({ player: player.catalogKey, position: player.position, baseFp: score.exactFp, stats: score.stats });
    }
  }

  const results = {};
  for (const type of BOOST_TYPES) {
    results[type] = {};
    const eligible = observations.filter(row => row.position === 'G' ? ['save', 'shutout'].includes(type) : !['save', 'shutout'].includes(type));
    for (const rarity of RARITIES) {
      const gains = eligible.map(row => boostFantasyBonus(row.stats, { boost_type: type, rarity, effect: DEFAULT_BOOST_EFFECTS[type][rarity] }));
      const percentages = gains.map((gain, index) => eligible[index].baseFp > 0 ? gain / eligible[index].baseFp * 100 : 0);
      results[type][rarity] = {
        observations: gains.length,
        averageGain: Number(mean(gains).toFixed(2)),
        medianGain: Number(percentile(gains, .5).toFixed(2)),
        p90Gain: Number(percentile(gains, .9).toFixed(2)),
        averagePercentOfBase: Number(mean(percentages).toFixed(2)),
        triggerRate: Number((gains.filter(value => value > 0).length / Math.max(1, gains.length) * 100).toFixed(2))
      };
    }
  }

  const payload = { generatedAt: new Date().toISOString(), seed: SEED, samplesPerCard: SAMPLES, eligibleCards: catalog.length, observations: observations.length, results };
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  const header = `| Boost | ${RARITIES.map(rarity => rarity[0].toUpperCase() + rarity.slice(1)).join(' | ')} |`;
  const divider = `|---|${RARITIES.map(() => '---:').join('|')}|`;
  const rows = BOOST_TYPES.map(type => `| ${type[0].toUpperCase() + type.slice(1)} | ${RARITIES.map(rarity => `${results[type][rarity].averageGain} FP (${results[type][rarity].averagePercentOfBase}%)`).join(' | ')} |`);
  const report = [
    '# WUT boost balance snapshot', '',
    `Generated from ${catalog.length} eligible S1-S3/Mythic cards with ${SAMPLES} three-game samples per card. Values are average added FP and average share of base FP; they do not include Booster Cable or chemistry.`, '',
    header, divider, ...rows, '',
    'Grit applies its listed bonus independently to Hits and Blocks.', ''
  ].join('\n');
  await fs.writeFile(OUTPUT.replace(/\.json$/i, '-report.md'), report);
  console.log(report);
} finally {
  Math.random = originalRandom;
}

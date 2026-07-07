export const CASINO_SLOT_WAGERS = Object.freeze([10, 20, 30, 40, 50]);
export const CASINO_MAX_SLOT_WAGER = 50;
export const CASINO_JACKPOT_CONTRIBUTION_RATE = 0.10;

export const CASINO_SLOT_OUTCOMES = Object.freeze([
  { key: 'loss', label: 'Loss', weight: 62200, multiplier: 0, kind: 'loss' },
  { key: 'd3_pair', label: 'D3 Logo Pair', weight: 18000, multiplier: 1.0, tier: 'd3', matchCount: 2 },
  { key: 'd2_pair', label: 'D2 Logo Pair', weight: 6867, multiplier: 1.5, tier: 'd2', matchCount: 2 },
  { key: 'd1_pair', label: 'D1 Logo Pair', weight: 5100, multiplier: 2, tier: 'd1', matchCount: 2 },
  { key: 'wcpl_pair', label: 'WCPL Pair', weight: 2083, multiplier: 3, tier: 'wcpl', matchCount: 2 },
  { key: 'mushy_pair', label: 'Mushy Pair', weight: 1000, multiplier: 5, tier: 'mushy', matchCount: 2 },
  { key: 'd3_triple', label: 'D3 Logo Triple', weight: 2400, multiplier: 2.5, tier: 'd3', matchCount: 3 },
  { key: 'd2_triple', label: 'D2 Logo Triple', weight: 1500, multiplier: 5, tier: 'd2', matchCount: 3 },
  { key: 'd1_triple', label: 'D1 Logo Triple', weight: 600, multiplier: 10, tier: 'd1', matchCount: 3 },
  { key: 'wcpl_triple', label: 'WCPL Triple', weight: 150, multiplier: 25, tier: 'wcpl', matchCount: 3 },
  { key: 'mushy_jackpot', label: 'Mushy Jackpot', weight: 100, multiplier: 10, tier: 'mushy', matchCount: 3, jackpot: true }
]);

export const CASINO_SYMBOL_POOLS = Object.freeze({
  mushy: [{ id: 'mushy', label: 'Mushy', image: '/images/casino/mushy.png', tier: 'mushy' }],
  wcpl: [{ id: 'wcpl', label: 'WCPL', image: '/images/casino/wcpl.png', tier: 'wcpl' }],
  d3: [
    { id: '206', label: 'Seattle Thunderbirds', image: '/images/casino/D3/206.png', tier: 'd3' },
    { id: 'cgy', label: 'Calgary Hitmen', image: '/images/casino/D3/CGY.png', tier: 'd3' },
    { id: 'evt', label: 'Everett Silvertips', image: '/images/casino/D3/EVT.png', tier: 'd3' },
    { id: 'kln', label: 'Kelowna Rockets', image: '/images/casino/D3/KLN.png', tier: 'd3' },
    { id: 'van', label: 'Vancouver Giants', image: '/images/casino/D3/VAN.png', tier: 'd3' },
    { id: 'vic', label: 'Victoria Royals', image: '/images/casino/D3/VIC.png', tier: 'd3' }
  ],
  d1: [
    { id: 'bcl', label: 'BC Legless', image: '/images/casino/D1/BCL.png', tier: 'd1' },
    { id: 'll', label: 'Little St. James Lot Lizards', image: '/images/casino/D1/LL.png', tier: 'd1' },
    { id: 'nk', label: 'Niagra Nicks', image: '/images/casino/D1/NK.png', tier: 'd1' },
    { id: 'pkn', label: 'Puckin Penguins', image: '/images/casino/D1/PKN.png', tier: 'd1' },
    { id: 'sea', label: 'Summer Seals', image: '/images/casino/D1/SEA.png', tier: 'd1' },
    { id: 'tor', label: 'Toronto Badgers', image: '/images/casino/D1/TOR.png', tier: 'd1' }
  ],
  d2: [
    { id: 'bck', label: 'Bucktown', image: '/images/casino/D2/BCK.png', tier: 'd2' },
    { id: 'bld', label: 'San Jose Blades', image: '/images/casino/D2/BLD.png', tier: 'd2' },
    { id: 'blm', label: 'Bloomin Onions', image: '/images/casino/D2/BLM.png', tier: 'd2' },
    { id: 'cle', label: 'Cleveland Spiders', image: '/images/casino/D2/CLE.png', tier: 'd2' },
    { id: 'lgt', label: 'Lethbridge Light-Weights', image: '/images/casino/D2/LGT.png', tier: 'd2' },
    { id: 'rch', label: 'Richmond Drivers', image: '/images/casino/D2/RCH.png', tier: 'd2' }
  ]
});

export const CASINO_ALL_SYMBOLS = Object.freeze(Object.values(CASINO_SYMBOL_POOLS).flat());

const randomItem = (items, random) => items[Math.floor(random() * items.length)];

export function pickSlotOutcome(wager = CASINO_MAX_SLOT_WAGER, random = Math.random) {
  const wagerScale = Math.max(0, Math.min(1, Number(wager || 0) / CASINO_MAX_SLOT_WAGER));
  const baseJackpotWeight = CASINO_SLOT_OUTCOMES.filter(outcome => outcome.jackpot)
    .reduce((sum, outcome) => sum + Number(outcome.weight || 0), 0);
  const scaledJackpotWeight = Math.round(baseJackpotWeight * wagerScale);
  const removedJackpotWeight = baseJackpotWeight - scaledJackpotWeight;
  const adjusted = CASINO_SLOT_OUTCOMES.map(outcome => {
    if (outcome.jackpot) return { ...outcome, weight: Math.round(Number(outcome.weight || 0) * wagerScale) };
    if (outcome.kind === 'loss') return { ...outcome, weight: Number(outcome.weight || 0) + removedJackpotWeight };
    return outcome;
  });
  const totalWeight = adjusted.reduce((sum, outcome) => sum + Number(outcome.weight || 0), 0);
  let roll = Math.floor(random() * totalWeight) + 1;
  for (const outcome of adjusted) {
    roll -= Number(outcome.weight || 0);
    if (roll <= 0) return outcome;
  }
  return adjusted[0];
}

export function buildSlotReels(outcome, random = Math.random) {
  if (outcome.kind === 'loss') {
    const symbols = [...CASINO_ALL_SYMBOLS];
    const reels = [];
    while (reels.length < 3 && symbols.length) {
      reels.push(symbols.splice(Math.floor(random() * symbols.length), 1)[0]);
    }
    return reels;
  }

  const match = randomItem(CASINO_SYMBOL_POOLS[outcome.tier] || CASINO_SYMBOL_POOLS.d3, random);
  if (Number(outcome.matchCount) === 3) return [match, match, match];
  const miss = randomItem(CASINO_ALL_SYMBOLS.filter(symbol => symbol.id !== match.id), random);
  const reels = [match, match, miss];
  for (let index = reels.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [reels[index], reels[swap]] = [reels[swap], reels[index]];
  }
  return reels;
}

export function resolveSlotSpin({ wager, jackpotAmount, jackpotSeed = 1000, random = Math.random }) {
  const cleanWager = Number(wager);
  if (!CASINO_SLOT_WAGERS.includes(cleanWager)) throw new Error('Select a valid spin amount.');
  const jackpotBefore = Math.floor(Number(jackpotAmount || jackpotSeed || 1000));
  const jackpotContribution = Math.round(cleanWager * CASINO_JACKPOT_CONTRIBUTION_RATE);
  const outcome = pickSlotOutcome(cleanWager, random);
  const reels = buildSlotReels(outcome, random);
  const payout = outcome.jackpot
    ? jackpotBefore + jackpotContribution + Math.round(cleanWager * Number(outcome.multiplier || 0))
    : Math.round(cleanWager * Number(outcome.multiplier || 0));
  const jackpotAfter = outcome.jackpot ? Number(jackpotSeed || 1000) : jackpotBefore + jackpotContribution;
  return { outcome, reels, payout, net: payout - cleanWager, jackpotBefore, jackpotAfter, jackpotContribution };
}

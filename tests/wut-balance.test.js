import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWutPositiveScoring, applyWutSelfTrinket, generateWutBoostPack } from '../services/cards.js';
import {
  WUT_LAUNCH_TRINKET_EFFECTS,
  WUT_RARITIES,
  adjacentWutSlots,
  chooseJourneymanIdentity,
  journeymanCandidateIdentity,
  journeymanCandidates,
  resolveJourneymanIdentity,
  resolveZebraStripes,
  trinketFitsWutPosition
} from '../services/wutBalanceRules.js';

const closeTo = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('launch balance table contains all fifteen five-rarity trinkets', () => {
  assert.equal(Object.keys(WUT_LAUNCH_TRINKET_EFFECTS).length, 15);
  for (const [family, effects] of Object.entries(WUT_LAUNCH_TRINKET_EFFECTS)) {
    assert.deepEqual(Object.keys(effects), WUT_RARITIES, `${family} must define the standard rarity ladder`);
  }
});

test('WUT boost pack generator uses common-rare rolls plus high-rarity guarantees', () => {
  const items = generateWutBoostPack({
    config: {
      boostPack: {
        commonRareRolls: 4,
        guaranteedHighRolls: 1,
        commonRareOdds: { common: 1, uncommon: 0, rare: 0 },
        guaranteedHighOdds: { epic: 0, legendary: 1 }
      }
    }
  });
  assert.equal(items.length, 5);
  assert.ok(items.every(item => item.itemType === 'boost'));
  assert.equal(items.filter(item => item.rarity === 'common').length, 4);
  assert.equal(items.filter(item => item.rarity === 'legendary').length, 1);
});

test('only Specialist and Generalist exclude goalies', () => {
  const families = Object.keys(WUT_LAUNCH_TRINKET_EFFECTS);
  assert.deepEqual(families.filter(family => !trinketFitsWutPosition(family, 'G')).sort(), ['generalist', 'specialist_tape']);
  assert.ok(families.every(family => trinketFitsWutPosition(family, 'F')));
  assert.ok(families.every(family => trinketFitsWutPosition(family, 'D')));
});

test('Underdog and Booster Cable use the post-simulation launch ladders', () => {
  assert.deepEqual(WUT_RARITIES.map(rarity => WUT_LAUNCH_TRINKET_EFFECTS.underdog_patch[rarity]), [
    [.05, .15], [.07, .22], [.09, .3], [.12, .4], [.15, .5]
  ]);
  assert.deepEqual(WUT_RARITIES.map(rarity => WUT_LAUNCH_TRINKET_EFFECTS.hex_bag[rarity][2]), [1, 1.25, 1.5, 1.75, 2]);
  assert.deepEqual(WUT_RARITIES.map(rarity => WUT_LAUNCH_TRINKET_EFFECTS.warding_charm[rarity]), [80, 65, 50, 38, 28]);
  assert.deepEqual(WUT_RARITIES.map(rarity => WUT_LAUNCH_TRINKET_EFFECTS.siphon_stone[rarity]), [
    { threshold: .5, steal: .04 },
    { threshold: .4, steal: .06 },
    { threshold: .3, steal: .08 },
    { threshold: .25, steal: .11 },
    { threshold: .2, steal: .14 }
  ]);
  assert.deepEqual(WUT_RARITIES.map(rarity => WUT_LAUNCH_TRINKET_EFFECTS.booster_cable[rarity].loadBonus), [0, 0, 0, 1, 1]);
  assert.deepEqual(WUT_RARITIES.map(rarity => WUT_LAUNCH_TRINKET_EFFECTS.booster_cable[rarity].own), [.15, .22, .3, .32, .42]);
});

test('new Glass Skates rewards a cleared spike and penalizes a miss', () => {
  const effect = { threshold: .5, bonus: .3, penalty: .06 };
  const boom = applyWutSelfTrinket({ exactFp: 100, gameFps: [20, 30, 45], trinket: { family: 'glass_skates', effect } });
  const bust = applyWutSelfTrinket({ exactFp: 100, gameFps: [20, 30, 44], trinket: { family: 'glass_skates', effect } });
  assert.equal(boom.exactFp, 130);
  assert.equal(bust.exactFp, 94);
  assert.match(boom.trinketLabel, /boom/);
  assert.match(bust.trinketLabel, /bust/);
});

test('Generalist rewards balanced skater-category FP instead of raw combo size', () => {
  const effect = { minCategories: 3, maxBonus: .3 };
  const balanced = applyWutSelfTrinket({
    exactFp: 100,
    breakdown: [
      { type: 'goal', basePoints: 10 },
      { type: 'assist', basePoints: 10 },
      { type: 'shot', basePoints: 10 },
      { type: 'hit', basePoints: 10 },
      { type: 'block', basePoints: 10 }
    ],
    trinket: { family: 'generalist', effect }
  });
  assert.equal(balanced.exactFp, 130);
  const spiky = applyWutSelfTrinket({
    exactFp: 100,
    breakdown: [
      { type: 'goal', basePoints: 30 },
      { type: 'assist', basePoints: 10 },
      { type: 'shot', basePoints: 5 },
      { type: 'hit', basePoints: 0 },
      { type: 'block', basePoints: 0 }
    ],
    trinket: { family: 'generalist', effect }
  });
  assert.equal(spiky.exactFp, 109);
  const two = applyWutSelfTrinket({ exactFp: 100, stats: { shots: 8, hits: 2 }, trinket: { family: 'generalist', effect } });
  assert.equal(two.exactFp, 100, 'goalie-only categories and two-category skaters do not qualify');
});

test('Booster Cable amplifies only committed boost FP and eligible neighbours', () => {
  const result = applyWutPositiveScoring({
    baseExactFp: 100,
    stats: { goals: 2 },
    boost: { boost_type: 'goal', rarity: 'rare', effect: { per: 1, bonus: 5 } },
    adjacentBoostGains: [4, 8],
    trinket: { family: 'booster_cable', effect: { own: .5, adjacent: .1, adjacentMode: 'strongest' } }
  });
  assert.equal(result.boostGain, 10);
  closeTo(result.cableGain, 5.8);
  closeTo(result.wouldBeFp, 115.8);
});

test('Zebra Stripes downgrades the opposite trinket and disables it below Common', () => {
  const entries = [
    { userId: 1, slot: 'F1', trinket: { family: 'zebra_stripes', rarity: 'rare', effect: 3 } },
    { userId: 2, slot: 'F1', trinket: { family: 'specialist_tape', rarity: 'epic', effect: .25 } }
  ];
  const downgraded = resolveZebraStripes(entries);
  assert.equal(downgraded[1].trinket.rarity, 'common');
  assert.equal(downgraded[1].trinket.effect, .08);
  entries[0].trinket = { family: 'zebra_stripes', rarity: 'legendary', effect: 5 };
  assert.equal(resolveZebraStripes(entries)[1].trinket, null);
});

test('opposing Zebra Stripes fizzle and lineup adjacency is stable', () => {
  const entries = [
    { userId: 1, slot: 'D1', trinket: { family: 'zebra_stripes', rarity: 'legendary', effect: 5 } },
    { userId: 2, slot: 'D1', trinket: { family: 'zebra_stripes', rarity: 'common', effect: 1 } }
  ];
  const result = resolveZebraStripes(entries);
  assert.equal(result[0].trinket.rarity, 'legendary');
  assert.equal(result[1].trinket.rarity, 'common');
  assert.deepEqual(adjacentWutSlots('D1'), ['F2', 'D2']);
  assert.deepEqual(adjacentWutSlots('G'), ['D2']);
});

test('Journeyman random modes sample cards while choice modes maximize chemistry', () => {
  const entries = [
    { userId: 1, slot: 'F1', printedChemistryKey: 'S1|A', trinket: { family: 'journeyman', effect: { mode: 'random_all', crossSide: false } } },
    { userId: 1, slot: 'F2', printedChemistryKey: 'S1|B' },
    { userId: 1, slot: 'D1', printedChemistryKey: 'S1|B' },
    { userId: 2, slot: 'F1', printedChemistryKey: 'S1|C' },
    { userId: 2, slot: 'F2', printedChemistryKey: 'S1|C' }
  ];
  assert.equal(chooseJourneymanIdentity(entries[0], entries, () => 0), 'S1|B');
  entries[0].trinket.effect = { mode: 'choose_any', crossSide: true };
  assert.equal(chooseJourneymanIdentity(entries[0], entries), 'S1|B', 'ties resolve in stable lineup order');
});

test('Journeyman copies another Journeyman effective team instead of its printed team', () => {
  const common = { userId: 1, slot: 'F1', printedChemistryKey: 'S2|ORIGINAL', trinket: { family: 'journeyman', rarity: 'common', effect: { mode: 'random_all', crossSide: false } } };
  const epic = { userId: 1, slot: 'F2', printedChemistryKey: 'S2|BARTS', placement: { journeyman_key: 'S2|FOXES' }, trinket: { family: 'journeyman', rarity: 'epic', effect: { mode: 'choose_own_or_opposite', crossSide: true } } };
  const entries = [common, epic];

  assert.equal(journeymanCandidateIdentity(epic), 'S2|FOXES');
  assert.equal(chooseJourneymanIdentity(common, entries, () => 0), 'S2|FOXES');
});

test('only Legendary Journeyman can copy another season', () => {
  const entries = [
    { userId: 1, slot: 'F1', printedChemistryKey: 'S1|A', trinket: { family: 'journeyman', effect: { mode: 'choose_own', crossSide: false } } },
    { userId: 1, slot: 'F2', printedChemistryKey: 'S3|B' },
    { userId: 2, slot: 'F1', printedChemistryKey: 'S1|C' },
    { userId: 2, slot: 'F2', printedChemistryKey: 'S2|A' }
  ];
  assert.deepEqual(journeymanCandidates(entries[0], entries), []);
  entries[0].trinket.effect = { mode: 'choose_own_or_opposite', crossSide: true };
  assert.deepEqual(journeymanCandidates(entries[0], entries).map(candidate => candidate.printedChemistryKey), ['S1|C']);
  entries[0].trinket.effect = { mode: 'choose_any', crossSide: true };
  assert.deepEqual(journeymanCandidates(entries[0], entries).map(candidate => candidate.printedChemistryKey), ['S3|B', 'S1|C', 'S2|A']);
  assert.equal(chooseJourneymanIdentity(entries[0], entries), 'S3|B');
});

test('Zebra and Legendary Journeyman resolve team selection in commit order', () => {
  const entries = [
    { userId: 1, slot: 'F1', printedChemistryKey: 'S1|A', placement: { journeyman_zebra_preexisting: false }, trinket: { family: 'journeyman', rarity: 'legendary', effect: WUT_LAUNCH_TRINKET_EFFECTS.journeyman.legendary } },
    { userId: 1, slot: 'F2', printedChemistryKey: 'S3|B' },
    { userId: 1, slot: 'D1', printedChemistryKey: 'S1|D' },
    { userId: 2, slot: 'F1', printedChemistryKey: 'S3|B', trinket: { family: 'zebra_stripes', rarity: 'rare', effect: 3 } }
  ];
  const resolved = resolveZebraStripes(entries);
  const journeyman = resolved[0];
  assert.equal(journeyman.trinket.rarity, 'uncommon');
  assert.equal(journeyman.trinket.effect.crossSide, false);
  assert.equal(journeymanCandidates(journeyman, resolved).some(candidate => candidate.printedChemistryKey === 'S3|B'), false);
  assert.equal(resolveJourneymanIdentity(journeyman, resolved, 'S3|B'), 'S3|B');
  journeyman.placement.journeyman_zebra_preexisting = true;
  assert.equal(resolveJourneymanIdentity(journeyman, resolved, 'S3|B', () => 0), 'S1|D');
});

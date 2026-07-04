import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWutPositiveScoring, applyWutSelfTrinket, captainPatchChemistry, resolveWutMatchingTrinkets } from '../services/cards.js';
import { WUT_TRINKET_EFFECTS } from '../db.js';
import { WUT_TRINKET_ICONS, wutTrinketDescription } from '../services/wutTrinketText.js';

const closeTo = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `Expected ${actual} to be within ${epsilon} of ${expected}`);
const self = (family, effect, options = {}) => applyWutSelfTrinket({ exactFp: 100, trinket: { family, effect }, ...options });
const slotEntry = ({ userId, slot = 'F1', wouldBeFp, finalFp = wouldBeFp, family = '', effect = null }) => ({
  placement: { user_id: userId, slot }, wouldBeFp, finalFp,
  trinket: family ? { family, effect } : null, logs: []
});

test('all fifteen trinket families define a valid five-rarity progression', () => {
  const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const families = ['lucky_charm', 'safety_net', 'glass_skates', 'hex_bag', 'warding_charm', 'specialist_tape', 'first_strike_tape', 'counterpunch_gloves', 'underdog_patch', 'team_crest', 'siphon_stone', 'journeyman', 'booster_cable', 'generalist', 'zebra_stripes'];
  assert.deepEqual(Object.keys(WUT_TRINKET_EFFECTS).sort(), [...families].sort());
  for (const family of families) assert.ok(rarities.every(rarity => WUT_TRINKET_EFFECTS[family][rarity] != null), `${family} must define every rarity`);

  const increasing = family => rarities.map(rarity => WUT_TRINKET_EFFECTS[family][rarity]);
  for (const family of ['safety_net', 'warding_charm', 'specialist_tape', 'first_strike_tape', 'counterpunch_gloves', 'team_crest', 'siphon_stone']) {
    const values = increasing(family); assert.ok(values.every((value, index) => index === 0 || value > values[index - 1]), `${family} must improve each rarity`);
  }
  const lucky = increasing('lucky_charm');
  assert.ok(lucky.every((value, index) => index === 0 || value.rolls >= lucky[index - 1].rolls));
  assert.ok(lucky.every((value, index) => index === 0 || value.threshold <= lucky[index - 1].threshold));
  const hex = increasing('hex_bag');
  assert.ok(hex.every((value, index) => index === 0 || (value[0] < hex[index - 1][0] && value[1] > hex[index - 1][1])));
  const underdog = increasing('underdog_patch');
  assert.ok(underdog.every((value, index) => index === 0 || (value[0] > underdog[index - 1][0] && value[1] > underdog[index - 1][1])));
});

test('Lucky Charm replaces only the lowest game when its threshold is cleared', () => {
  const rare = self('lucky_charm', { rolls: 1, threshold: 1 }, { exactFp: 60, gameFps: [10, 20, 30], bonusGameFps: [31] });
  assert.equal(rare.exactFp, 81);
  assert.equal(rare.trinketGain, 21);
  assert.deepEqual(rare.luckyCharm, { hit: true, replacedIndex: 0, usedBonusIndex: 0 });
  assert.match(rare.logs[0], /replaced 10\.0 with 31\.0/);

  const equalHigh = self('lucky_charm', { rolls: 1, threshold: 1 }, { exactFp: 60, gameFps: [10, 20, 30], bonusGameFps: [30] });
  assert.equal(equalHigh.exactFp, 60, 'equal is not "beats current highest"');
  assert.equal(equalHigh.trinketGain, 0);
  assert.deepEqual(equalHigh.luckyCharm, { hit: false, replacedIndex: null, usedBonusIndex: null });

  const commonBoundary = self('lucky_charm', { rolls: 1, threshold: 1.25 }, { exactFp: 70, gameFps: [10, 20, 40], bonusGameFps: [50] });
  assert.equal(commonBoundary.exactFp, 110, '25% boundary qualifies');
});

test('Lucky Charm honors the configured number of bonus rolls', () => {
  const epic = self('lucky_charm', { rolls: 2, threshold: 1 }, { exactFp: 60, gameFps: [10, 20, 30], bonusGameFps: [25, 45, 100] });
  assert.equal(epic.exactFp, 95, 'third bonus roll must be ignored');
});

test('Safety Net raises a dud but never lowers an already-safe game', () => {
  const raised = self('safety_net', .75, { exactFp: 70, gameFps: [10, 20, 40] });
  closeTo(raised.exactFp, 82.5);
  const unchanged = self('safety_net', .25, { exactFp: 70, gameFps: [10, 20, 40] });
  assert.equal(unchanged.exactFp, 70);
});

test('Glass Skates applies ceiling gain and floor loss to different kept games', () => {
  const result = self('glass_skates', [.65, -.4], { exactFp: 70, gameFps: [10, 20, 40] });
  assert.equal(result.exactFp, 92);
});

test('Specialist Tape boosts only the highest FP-contributing category', () => {
  const result = self('specialist_tape', .35, { exactFp: 50, breakdown: [
    { label: 'Goals', points: 30 }, { label: 'Shots', points: 20 }, { label: 'Unavailable', points: 999, unavailable: true }
  ] });
  closeTo(result.exactFp, 60.5);
  assert.match(result.logs[0], /Goals/);
});

test('First Strike and Counterpunch are mutually exclusive by commit order', () => {
  assert.equal(self('first_strike_tape', .3, { isFirst: true, hasOpponent: true }).exactFp, 130);
  assert.equal(self('first_strike_tape', .3, { isFirst: false, hasOpponent: true }).exactFp, 100);
  assert.equal(self('counterpunch_gloves', .3, { isFirst: false, hasOpponent: true }).exactFp, 130);
  assert.equal(self('counterpunch_gloves', .3, { isFirst: true, hasOpponent: true }).exactFp, 100);
  assert.equal(self('counterpunch_gloves', .3, { isFirst: false, hasOpponent: false }).exactFp, 100);
});

test('Underdog Patch scales by card-rarity difference and respects its cap', () => {
  assert.equal(self('underdog_patch', [.08, .5], { hasOpponent: true, cardRarityRank: 2, opponentRarityRank: 4 }).exactFp, 116);
  assert.equal(self('underdog_patch', [.08, .5], { hasOpponent: true, cardRarityRank: 1, opponentRarityRank: 11 }).exactFp, 150);
  assert.equal(self('underdog_patch', [.08, .5], { hasOpponent: true, cardRarityRank: 4, opponentRarityRank: 4 }).exactFp, 100);
});

test('all trinket descriptions are concise, present, and rules-accurate', () => {
  for (const [family, rarities] of Object.entries(WUT_TRINKET_EFFECTS)) {
    for (const [rarity, effect] of Object.entries(rarities)) {
      const description = wutTrinketDescription({ family, effect });
      assert.ok(description.length > 20 && description.length < 260, `${rarity} ${family} needs a concise description`);
    }
  }
  const underdog = wutTrinketDescription({ family: 'underdog_patch', effect: [.09, .3] });
  assert.match(underdog, /card-rarity tier/i);
  assert.match(underdog, /trinket rarity does not count/i);
  assert.doesNotMatch(underdog, /Power difference/i);
});

test("Captain's Patch uses the jersey C mark", () => {
  assert.equal(WUT_TRINKET_ICONS.team_crest, 'C');
});

test("Captain's Patch amplifies only the chemistry bonus and strongest Patch wins", () => {
  assert.equal(self('team_crest', .2, { teamCount: 5 }).exactFp, 100, 'Patch is not a direct self buff');
  const amplified = applyWutPositiveScoring({ baseExactFp: 100, chemistryMultiplier: captainPatchChemistry(1.25, [.08, .2]).multiplier });
  assert.equal(amplified.wouldBeFp, 130);
});

test('Warding Charm has no positive self-scoring effect', () => {
  assert.equal(self('warding_charm', .8).exactFp, 100);
});

test('positive scoring order is self trinket, then boost, then chemistry', () => {
  const result = applyWutPositiveScoring({
    baseExactFp: 100,
    trinket: { family: 'first_strike_tape', effect: .1 },
    isFirst: true,
    stats: { goals: 2 },
    boost: { boost_type: 'goal', rarity: 'legendary', effect: { per: 1, bonus: 10 } },
    boostLoad: 5,
    chemistryMultiplier: 1.5
  });
  assert.equal(result.selfFp, 110);
  assert.equal(result.boostGain, 20);
  assert.equal(result.chemistryGain, 65);
  assert.equal(result.wouldBeFp, 195);
  assert.deepEqual(result.logs.map(log => log.split(' ')[0]), ['First', 'goal', 'Chemistry']);
});

test('Hex evaluates the post-trinket, post-boost, post-chemistry would-be score', () => {
  const attacker = applyWutPositiveScoring({ baseExactFp: 50, stats: { goals: 2 }, boost: { boost_type: 'goal', rarity: 'legendary', effect: { per: 1, bonus: 10 } }, chemistryMultiplier: 1.5 });
  assert.equal(attacker.wouldBeFp, 105);
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', effect: [3, .4] }),
    slotEntry({ userId: 2, wouldBeFp: attacker.wouldBeFp })
  ]);
  assert.equal(result[1].finalFp, 63, 'Hex must reduce 40% of the fully layered 105 FP');
  assert.equal(result[0].scoringEffects[0].family, 'hex_bag');
  assert.equal(result[0].scoringEffects[0].direction, 'outgoing');
  assert.equal(result[0].scoringEffects[0].triggered, true);
});

test('Hex Bag uses would-be FP, the configured threshold, and max(source, 10)', () => {
  const below = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', effect: [2.5, .6] }),
    slotEntry({ userId: 2, wouldBeFp: 74 })
  ]);
  assert.equal(below[1].finalFp, 74);

  const boundary = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', effect: [2.5, .6] }),
    slotEntry({ userId: 2, wouldBeFp: 75 })
  ]);
  assert.equal(boundary[1].finalFp, 30);

  const zeroFloor = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 0, family: 'hex_bag', effect: [3, .4] }),
    slotEntry({ userId: 2, wouldBeFp: 30 })
  ]);
  assert.equal(zeroFloor[1].finalFp, 18);
});

test('Warding Charm reduces incoming Hex strength', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', effect: [2, .8] }),
    slotEntry({ userId: 2, wouldBeFp: 60, family: 'warding_charm', effect: .8 })
  ]);
  closeTo(result[1].finalFp, 50.4);
  assert.match(result[0].logs[0], /after Warding/);
  assert.deepEqual(result[1].scoringEffects.map(effect => effect.family), ['hex_bag', 'warding_charm']);
  closeTo(result[1].scoringEffects.reduce((sum, effect) => sum + effect.points, 0), -9.6);
});

test('Siphon Stone steals from the would-be FP gap and conserves the swing', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'siphon_stone', effect: .25 }),
    slotEntry({ userId: 2, wouldBeFp: 70 })
  ]);
  assert.equal(result[0].finalFp, 40);
  assert.equal(result[1].finalFp, 60);
  assert.equal(result[0].finalFp + result[1].finalFp, 100);
});

test('Warding Charm reduces both sides of a Siphon transfer', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'siphon_stone', effect: .25 }),
    slotEntry({ userId: 2, wouldBeFp: 70, family: 'warding_charm', effect: .8 })
  ]);
  closeTo(result[0].finalFp, 32);
  closeTo(result[1].finalFp, 68);
  closeTo(result[1].scoringEffects.reduce((sum, effect) => sum + effect.points, 0), -2);
});

test('hostile checks and amounts use would-be FP rather than an already-modified final', () => {
  const hex = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', effect: [3, .4] }),
    slotEntry({ userId: 2, wouldBeFp: 100, finalFp: 90 })
  ]);
  assert.equal(hex[1].finalFp, 50, 'loss is 40% of would-be 100, applied to current final 90');

  const siphon = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, finalFp: 20, family: 'siphon_stone', effect: .25 }),
    slotEntry({ userId: 2, wouldBeFp: 70, finalFp: 65 })
  ]);
  assert.equal(siphon[0].finalFp, 30);
  assert.equal(siphon[1].finalFp, 55);
});

test('matching-slot trinkets cannot affect a different slot', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, slot: 'F1', wouldBeFp: 20, family: 'hex_bag', effect: [2, .8] }),
    slotEntry({ userId: 2, slot: 'F2', wouldBeFp: 100 })
  ]);
  assert.equal(result[1].finalFp, 100);
});

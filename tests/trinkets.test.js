import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWutPositiveScoring, applyWutSelfTrinket, resolveWutMatchingTrinkets } from '../services/cards.js';
import { WUT_TRINKET_EFFECTS } from '../db.js';
import { normalizeWutTrinketEffect } from '../services/wutBalanceRules.js';
import { validateWutDeckSnapshots } from '../services/arenaRuntime.js';
import { WUT_TRINKET_ICONS, wutTrinketDescription, wutTrinketIcon } from '../services/wutTrinketText.js';

const closeTo = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `Expected ${actual} to be within ${epsilon} of ${expected}`);
const self = (family, effect, options = {}) => applyWutSelfTrinket({ exactFp: 100, trinket: { family, effect }, ...options });
const slotEntry = ({ userId, slot = 'F1', wardTargetSlot = '', wouldBeFp, finalFp = wouldBeFp, family = '', rarity = 'common', effect = null }) => ({
  placement: { user_id: userId, slot, ward_target_slot: wardTargetSlot }, wouldBeFp, finalFp,
  trinket: family ? { family, rarity, effect } : null, logs: []
});

test('all fifteen trinket families define a valid five-rarity progression', () => {
  const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const families = ['lucky_charm', 'safety_net', 'glass_skates', 'hex_bag', 'warding_charm', 'specialist_tape', 'first_strike_tape', 'counterpunch_gloves', 'underdog_patch', 'team_crest', 'siphon_stone', 'journeyman', 'booster_cable', 'generalist', 'zebra_stripes'];
  assert.deepEqual(Object.keys(WUT_TRINKET_EFFECTS).sort(), [...families].sort());
  for (const family of families) assert.ok(rarities.every(rarity => WUT_TRINKET_EFFECTS[family][rarity] != null), `${family} must define every rarity`);

  const increasing = family => rarities.map(rarity => WUT_TRINKET_EFFECTS[family][rarity]);
  for (const family of ['safety_net', 'specialist_tape', 'first_strike_tape', 'counterpunch_gloves']) {
    const values = increasing(family); assert.ok(values.every((value, index) => index === 0 || value > values[index - 1]), `${family} must improve each rarity`);
  }
  const ward = increasing('warding_charm');
  assert.ok(ward.every((value, index) => index === 0 || value < ward[index - 1]), 'warding_charm must require less FP lead each rarity');
  const siphon = increasing('siphon_stone');
  assert.ok(siphon.every((value, index) => index === 0 || (value.threshold < siphon[index - 1].threshold && value.steal > siphon[index - 1].steal)), 'siphon_stone must require less win margin and steal more each rarity');
  const captainPatch = increasing('team_crest');
  assert.ok(captainPatch.every((value, index) => index === 0 || value > captainPatch[index - 1]), 'team_crest must improve each rarity');
  const generalist = increasing('generalist');
  assert.ok(generalist.every((value, index) => index === 0 || value.maxBonus > generalist[index - 1].maxBonus), 'generalist max bonus must improve each rarity');
  const lucky = increasing('lucky_charm');
  assert.ok(lucky.every((value, index) => index === 0 || value.rolls >= lucky[index - 1].rolls));
  assert.ok(lucky.every((value, index) => index === 0 || value.threshold <= lucky[index - 1].threshold));
  const hex = increasing('hex_bag');
  assert.ok(hex.every((value, index) => index === 0 || (value[0] < hex[index - 1][0] && value[1] > hex[index - 1][1] && value[2] > hex[index - 1][2])));
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

test("Captain's Patch boosts only its wearer for same-team teammates", () => {
  assert.equal(self('team_crest', .06, { teamCount: 1 }).exactFp, 100);
  assert.equal(self('team_crest', .06, { teamCount: 2 }).exactFp, 106);
  assert.equal(self('team_crest', .06, { teamCount: 5 }).exactFp, 124);
  assert.equal(applyWutSelfTrinket({ exactFp: 100, trinket: { family: 'team_crest', effect: .06, captainRole: 'assistant_captain' }, teamCount: 5 }).exactFp, 112);
  const result = applyWutPositiveScoring({ baseExactFp: 100, trinket: { family: 'team_crest', effect: .06 }, teamCount: 3, chemistryMultiplier: 1.15 });
  assert.equal(result.selfFp, 112);
  closeTo(result.wouldBeFp, 128.8);
});

test("Captain's Patch allows a second Assistant Captain at half benefit", () => {
  assert.equal(wutTrinketIcon({ family: 'team_crest' }), 'C');
  assert.equal(wutTrinketIcon({ family: 'team_crest', captainRole: 'assistant_captain' }), 'A');
  assert.match(wutTrinketDescription({ family: 'team_crest', effect: .06, captainRole: 'assistant_captain' }), /50%/);
  const card = (index, family = '') => ({
    card_identity: `card-${index}`,
    position: index === 4 ? 'G' : index % 2 ? 'D' : 'F',
    power: 1,
    trinket: family ? { family, rarity: 'common', effect: .06 } : null
  });
  assert.doesNotThrow(() => validateWutDeckSnapshots([card(0, 'team_crest'), card(1, 'team_crest'), card(2), card(3), card(4), card(5), card(6), card(7)], { deckSize: 8, topLineupMaxPower: 15 }));
  assert.throws(() => validateWutDeckSnapshots([card(0, 'team_crest'), card(1, 'team_crest'), card(2, 'team_crest'), card(3), card(4), card(5), card(6), card(7)], { deckSize: 8, topLineupMaxPower: 15 }), /at most 2 Captain's Patch/);
});

test("legacy Captain's Patch effects normalize to the wearer-only scale", () => {
  assert.equal(normalizeWutTrinketEffect('team_crest', 'legendary', .2), .06);
  assert.equal(normalizeWutTrinketEffect('team_crest', 'legendary', { value: .07 }), .07);
  assert.equal(normalizeWutTrinketEffect('team_crest', 'legendary', { value: .2, countBonus: 1 }), .06);
});

test('legacy Generalist effects normalize to the balanced-profile shape', () => {
  assert.deepEqual(normalizeWutTrinketEffect('generalist', 'legendary', { 3: .1, 4: .16, 5: .22 }), { minCategories: 3, maxBonus: .26 });
  assert.deepEqual(normalizeWutTrinketEffect('generalist', 'legendary', { 3: .12, 4: .18, 5: .24 }), { minCategories: 3, maxBonus: .24 });
  assert.deepEqual(normalizeWutTrinketEffect('generalist', 'legendary', { minCategories: 4, maxBonus: .3 }), { minCategories: 4, maxBonus: .3 });
});

test('legacy Hex Charm effects normalize with the new drain cap', () => {
  assert.deepEqual(normalizeWutTrinketEffect('hex_bag', 'common', [3, .4]), [3, .4, 1]);
  assert.deepEqual(normalizeWutTrinketEffect('hex_bag', 'legendary', [2, .8]), [2, .8, 2]);
  assert.deepEqual(normalizeWutTrinketEffect('hex_bag', 'rare', [2.4, .55, 1.4]), [2.4, .55, 1.4]);
});

test('legacy Warding Charm effects normalize to FP-lead prevention requirements', () => {
  assert.equal(normalizeWutTrinketEffect('warding_charm', 'common', .25), 80);
  assert.equal(normalizeWutTrinketEffect('warding_charm', 'legendary', .85), 28);
  assert.equal(normalizeWutTrinketEffect('warding_charm', 'rare', 45), 45);
});

test('legacy Siphon Stone effects normalize to offensive threshold and steal values', () => {
  assert.deepEqual(normalizeWutTrinketEffect('siphon_stone', 'common', .05), { threshold: .5, steal: .04 });
  assert.deepEqual(normalizeWutTrinketEffect('siphon_stone', 'legendary', .25), { threshold: .2, steal: .14 });
  assert.deepEqual(normalizeWutTrinketEffect('siphon_stone', 'rare', { threshold: .35, steal: .09 }), { threshold: .35, steal: .09 });
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
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', effect: [3, .4, 1] }),
    slotEntry({ userId: 2, wouldBeFp: attacker.wouldBeFp })
  ]);
  assert.equal(result[1].finalFp, 75, 'Hex reads the fully layered 105 FP, then caps the drain at the Hex card FP');
  assert.equal(result[0].scoringEffects[0].family, 'hex_bag');
  assert.equal(result[0].scoringEffects[0].direction, 'outgoing');
  assert.equal(result[0].scoringEffects[0].triggered, true);
});

test('Hex Bag uses would-be FP, the configured threshold, and max(source, 10)', () => {
  const below = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', rarity: 'rare', effect: [2.5, .6, 1.5] }),
    slotEntry({ userId: 2, wouldBeFp: 74 })
  ]);
  assert.equal(below[1].finalFp, 74);

  const boundary = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', rarity: 'rare', effect: [2.5, .6, 1.5] }),
    slotEntry({ userId: 2, wouldBeFp: 75 })
  ]);
  assert.equal(boundary[1].finalFp, 30);

  const zeroFloor = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 0, family: 'hex_bag', effect: [3, .4, 1] }),
    slotEntry({ userId: 2, wouldBeFp: 30 })
  ]);
  assert.equal(zeroFloor[1].finalFp, 30);
});

test('Warding Charm prevents Hex loss when its bearer outscored the attacker enough', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', rarity: 'legendary', effect: [2, .8, 2] }),
    slotEntry({ userId: 2, slot: 'F1', wouldBeFp: 60 }),
    slotEntry({ userId: 2, slot: 'F2', wardTargetSlot: 'F1', wouldBeFp: 80, family: 'warding_charm', rarity: 'legendary', effect: 28 })
  ]);
  closeTo(result[1].finalFp, 60);
  closeTo(result[2].finalFp, 80);
  assert.match(result[0].logs[0], /Warding Charm prevented/);
  assert.deepEqual(result[1].scoringEffects.map(effect => effect.family), ['warding_charm']);
  assert.equal(result[1].scoringEffects.find(effect => effect.family === 'hex_bag'), undefined);
  assert.deepEqual(result[2].scoringEffects.map(effect => effect.family), []);
});

test('Warding Charm partial prevention scales by lead over the attacking card', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', rarity: 'legendary', effect: [2, .8, 2] }),
    slotEntry({ userId: 2, slot: 'F1', wouldBeFp: 60 }),
    slotEntry({ userId: 2, slot: 'F2', wardTargetSlot: 'F1', wouldBeFp: 44, family: 'warding_charm', rarity: 'legendary', effect: 28 })
  ]);
  closeTo(result[1].finalFp, 36);
  closeTo(result[2].finalFp, 44);
  assert.match(result[1].scoringEffects[0].label, /prevented 24\.0 FP/);
});

test('Siphon Stone steals opposing FP after winning by the configured margin', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 72, family: 'siphon_stone', rarity: 'legendary', effect: { threshold: .2, steal: .14 } }),
    slotEntry({ userId: 2, wouldBeFp: 60 })
  ]);
  closeTo(result[0].finalFp, 80.4);
  closeTo(result[1].finalFp, 51.6);
  closeTo(result[0].finalFp + result[1].finalFp, 132);
});

test('Siphon Stone does not trigger without the required win margin', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 70, family: 'siphon_stone', rarity: 'legendary', effect: { threshold: .2, steal: .14 } }),
    slotEntry({ userId: 2, wouldBeFp: 60 })
  ]);
  assert.equal(result[0].finalFp, 70);
  assert.equal(result[1].finalFp, 60);
  assert.equal(result[0].scoringEffects.length, 0);
});

test('Warding Charm reduces the actual Siphon steal', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 72, family: 'siphon_stone', rarity: 'legendary', effect: { threshold: .2, steal: .14 } }),
    slotEntry({ userId: 2, slot: 'F1', wouldBeFp: 60 }),
    slotEntry({ userId: 2, slot: 'F2', wardTargetSlot: 'F1', wouldBeFp: 86, family: 'warding_charm', rarity: 'legendary', effect: 28 })
  ]);
  closeTo(result[0].finalFp, 76.2);
  closeTo(result[1].finalFp, 55.8);
  closeTo(result[2].finalFp, 86);
  assert.match(result[1].scoringEffects[0].label, /prevented 4\.2 FP/);
});

test('Hex and offensive Siphon can both trigger from the would-be matchup', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', rarity: 'legendary', effect: [2, .8, 2] }),
    slotEntry({ userId: 2, wouldBeFp: 75, family: 'siphon_stone', rarity: 'legendary', effect: { threshold: .2, steal: .14 } })
  ]);
  closeTo(result[0].finalFp, 25.8);
  closeTo(result[1].finalFp, 19.2);
  assert.deepEqual(result[0].scoringEffects.map(effect => effect.family), ['hex_bag', 'siphon_stone']);
  assert.deepEqual(result[1].scoringEffects.map(effect => effect.family), ['hex_bag', 'siphon_stone']);
});

test('Warding Charm uses the bearer score after hostile effects aimed at the bearer', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, slot: 'F1', wouldBeFp: 30, family: 'hex_bag', rarity: 'legendary', effect: [2, .8, 2] }),
    slotEntry({ userId: 2, slot: 'F1', wouldBeFp: 60 }),
    slotEntry({ userId: 2, slot: 'G', wardTargetSlot: 'F1', wouldBeFp: 80, family: 'warding_charm', rarity: 'legendary', effect: 28 }),
    slotEntry({ userId: 1, slot: 'G', wouldBeFp: 30, family: 'hex_bag', rarity: 'common', effect: [2, .5, 1] })
  ]);
  closeTo(result[2].finalFp, 50);
  closeTo(result[1].finalFp, 60 - (48 * (1 - (20 / 28))));
});

test('hostile checks and amounts use would-be FP rather than an already-modified final', () => {
  const hex = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 30, family: 'hex_bag', effect: [3, .4, 1] }),
    slotEntry({ userId: 2, wouldBeFp: 100, finalFp: 90 })
  ]);
  assert.equal(hex[1].finalFp, 60, 'loss reads would-be 100, caps at source FP 30, then applies to current final 90');

  const siphon = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, wouldBeFp: 80, finalFp: 70, family: 'siphon_stone', effect: { threshold: .2, steal: .1 } }),
    slotEntry({ userId: 2, wouldBeFp: 60, finalFp: 55 })
  ]);
  assert.equal(siphon[0].finalFp, 76);
  assert.equal(siphon[1].finalFp, 49);
});

test('matching-slot trinkets cannot affect a different slot', () => {
  const result = resolveWutMatchingTrinkets([
    slotEntry({ userId: 1, slot: 'F1', wouldBeFp: 20, family: 'hex_bag', effect: [2, .8] }),
    slotEntry({ userId: 2, slot: 'F2', wouldBeFp: 100 })
  ]);
  assert.equal(result[1].finalFp, 100);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CASINO_SLOT_WAGERS,
  buildSlotReels,
  pickSlotOutcome,
  resolveSlotSpin
} from '../services/casinoSlots.js';
import {
  actBlackjack,
  betBlackjack,
  createBlackjackTable,
  handValue,
  publicBlackjackState,
  sitBlackjackSeat
} from '../services/casinoBlackjack.js';
import { buildShotDoctorRunShots, publicShotDoctorRun } from '../services/shotDoctor.js';

test('slot wagers retain the established allowed amounts', () => {
  assert.deepStrictEqual([...CASINO_SLOT_WAGERS], [10, 20, 30, 40, 50]);
});

test('a deterministic low roll resolves as a loss with three distinct reels', () => {
  const outcome = pickSlotOutcome(50, () => 0);
  const reels = buildSlotReels(outcome, () => 0);
  assert.equal(outcome.key, 'loss');
  assert.equal(new Set(reels.map(reel => reel.id)).size, 3);
});

test('a maximum roll at full wager resolves the jackpot atomically', () => {
  const spin = resolveSlotSpin({ wager: 50, jackpotAmount: 1250, jackpotSeed: 1000, random: () => 0.999999 });
  assert.equal(spin.outcome.key, 'mushy_jackpot');
  assert.equal(spin.jackpotContribution, 5);
  assert.equal(spin.payout, 1755);
  assert.equal(spin.net, 1705);
  assert.equal(spin.jackpotAfter, 1000);
  assert.deepStrictEqual(spin.reels.map(reel => reel.id), ['mushy', 'mushy', 'mushy']);
});

test('invalid slot wagers are rejected before any storage work', () => {
  assert.throws(() => resolveSlotSpin({ wager: 5, jackpotAmount: 1000 }), /valid spin amount/i);
});

test('Puck IQ public state exposes its active shot and deadline without leaking future results', () => {
  assert.equal(typeof buildShotDoctorRunShots, 'function');
  const run = publicShotDoctorRun({
    id: 1, user_id: 2, status: 'active', wager: 50, current_index: 0,
    current_shot_started_at: '2026-07-06T00:00:00.000Z', created_at: '2026-07-06T00:00:00.000Z',
    shots: [{ shooter_name: 'Shooter', goalie_name: 'Goalie', shot_type: 'Wrist', speed_kmh: 80, result: 'G' }],
    guesses: []
  });
  assert.equal(run.current_shot.shooter_name, 'Shooter');
  assert.equal(run.current_shot.result, undefined);
  assert.equal(run.deadline_at, '2026-07-06T00:00:15.000Z');
});

test('blackjack exposes split only for a same-rank first pair', () => {
  const now = new Date('2026-07-12T00:00:00.000Z');
  let table = createBlackjackTable();
  table = sitBlackjackSeat(table, { userId: 1, displayName: 'Tester', seatIndex: 0, now }).table;
  table.shoe = [
    { rank: '9', suit: 'C' },
    { rank: '8', suit: 'S' },
    { rank: '5', suit: 'D' },
    { rank: '8', suit: 'H' }
  ];
  table = betBlackjack(table, { userId: 1, wager: 25, now }).table;
  const state = publicBlackjackState(table, { userId: 1, now });
  assert.equal(state.currentActions.split, true);
  assert.equal(state.currentActions.double, true);
});

test('blackjack split aces receive one card each and auto-stand', () => {
  const now = new Date('2026-07-12T00:00:00.000Z');
  let table = createBlackjackTable();
  table = sitBlackjackSeat(table, { userId: 1, displayName: 'Tester', seatIndex: 0, now }).table;
  table.shoe = [
    { rank: '7', suit: 'C' },
    { rank: '9', suit: 'D' },
    { rank: 'K', suit: 'S' },
    { rank: '4', suit: 'H' },
    { rank: '3', suit: 'D' },
    { rank: 'A', suit: 'S' },
    { rank: '6', suit: 'C' },
    { rank: 'A', suit: 'H' }
  ];
  table = betBlackjack(table, { userId: 1, wager: 25, now }).table;
  const result = actBlackjack(table, { userId: 1, action: 'split', now });
  const hands = result.table.seats[0].hands;
  assert.equal(hands.length, 2);
  assert.deepStrictEqual(hands.map(hand => hand.splitAces), [true, true]);
  assert.deepStrictEqual(hands.map(hand => hand.status), ['settled', 'settled']);
  assert.equal(result.table.phase, 'result');
  assert.equal(result.transactions[0].kind, 'casino_blackjack_split');
});

test('blackjack hand value treats aces as soft until they would bust', () => {
  assert.deepStrictEqual(handValue([{ rank: 'A' }, { rank: '7' }]), { total: 18, soft: true, bust: false });
  assert.deepStrictEqual(handValue([{ rank: 'A' }, { rank: '7' }, { rank: '9' }]), { total: 17, soft: false, bust: false });
});

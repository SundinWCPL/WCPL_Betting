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
import {
  actHoldem,
  createHoldemTable,
  evaluateHoldemHand,
  leaveHoldemSeat,
  publicHoldemState
} from '../services/casinoHoldem.js';
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

test('holdem evaluator labels the best five-card hand', () => {
  const result = evaluateHoldemHand([
    { rank: 'A', suit: 'S' },
    { rank: 'K', suit: 'S' },
    { rank: 'Q', suit: 'S' },
    { rank: 'J', suit: 'S' },
    { rank: '10', suit: 'S' },
    { rank: '2', suit: 'D' },
    { rank: '3', suit: 'C' }
  ]);
  assert.equal(result.categoryLabel, 'Straight Flush');
  assert.equal(result.label, 'Straight Flush, Ace high');
  assert.deepStrictEqual(result.cards.map(card => `${card.rank}${card.suit}`), ['AS', 'KS', 'QS', 'JS', '10S']);
});

test('holdem side pots award only eligible players', () => {
  const now = new Date('2026-07-12T00:00:00.000Z');
  let table = createHoldemTable();
  table.phase = 'river';
  table.street = 'river';
  table.currentSeatIndex = 0;
  table.buttonIndex = 2;
  table.currentHandId = 1;
  table.board = [
    { rank: '2', suit: 'C' },
    { rank: '3', suit: 'D' },
    { rank: '4', suit: 'H' },
    { rank: '9', suit: 'S' },
    { rank: 'K', suit: 'D' }
  ];
  table.seats[0] = {
    ...table.seats[0],
    userId: 1, displayName: 'Aces', status: 'playing', stack: 1,
    holeCards: [{ rank: 'A', suit: 'S' }, { rank: 'A', suit: 'H' }],
    currentBet: 0, committed: 100, acted: false
  };
  table.seats[1] = {
    ...table.seats[1],
    userId: 2, displayName: 'Straight', status: 'all_in', stack: 0,
    holeCards: [{ rank: '5', suit: 'S' }, { rank: '6', suit: 'S' }],
    currentBet: 0, committed: 50, acted: true
  };
  table.seats[2] = {
    ...table.seats[2],
    userId: 3, displayName: 'Kings', status: 'all_in', stack: 0,
    holeCards: [{ rank: 'K', suit: 'C' }, { rank: 'Q', suit: 'D' }],
    currentBet: 0, committed: 100, acted: true
  };

  table = actHoldem(table, { userId: 1, action: 'check', now }).table;

  assert.equal(table.phase, 'showdown');
  assert.deepStrictEqual(table.pots.map(pot => pot.amount), [150, 100]);
  assert.deepStrictEqual(table.pots.map(pot => pot.winnerSeatIndexes), [[1], [0]]);
  assert.equal(table.seats[1].stack, 150);
  assert.equal(table.seats[0].stack, 101);
  assert.match(table.showdown.potAwards[0].label, /Straight wins with Straight, Six high/);
  assert.match(table.showdown.potAwards[1].label, /Aces wins with Pair of Aces/);
});

test('holdem public state hides opponent hole cards before showdown', () => {
  const now = new Date('2026-07-12T00:00:00.000Z');
  const table = createHoldemTable();
  table.phase = 'preflop';
  table.street = 'preflop';
  table.currentSeatIndex = 0;
  table.seats[0] = {
    ...table.seats[0],
    userId: 1, displayName: 'Hero', status: 'playing', stack: 240,
    holeCards: [{ rank: 'A', suit: 'S' }, { rank: 'A', suit: 'H' }]
  };
  table.seats[1] = {
    ...table.seats[1],
    userId: 2, displayName: 'Villain', status: 'playing', stack: 240,
    holeCards: [{ rank: 'K', suit: 'S' }, { rank: 'K', suit: 'H' }]
  };

  const state = publicHoldemState(table, { userId: 1, now });
  assert.equal(state.seats[0].holeCards[0].rank, 'A');
  assert.equal(state.seats[1].holeCards[0].hidden, true);
  assert.equal(state.currentActions.check, true);
});

test('holdem public state can be closed independently', () => {
  const state = publicHoldemState(createHoldemTable(), {
    userId: 1,
    now: new Date('2026-07-12T00:00:00.000Z'),
    isCasinoOpen: false
  });
  assert.equal(state.isCasinoOpen, false);
});

test('holdem leave after hand can be cancelled without folding current turn', () => {
  const now = new Date('2026-07-12T00:00:00.000Z');
  let table = createHoldemTable();
  table.phase = 'preflop';
  table.street = 'preflop';
  table.currentSeatIndex = 0;
  table.seats[0] = {
    ...table.seats[0],
    userId: 1, displayName: 'Hero', status: 'playing', stack: 240,
    holeCards: [{ rank: 'A', suit: 'S' }, { rank: 'K', suit: 'H' }]
  };
  table.seats[1] = {
    ...table.seats[1],
    userId: 2, displayName: 'Villain', status: 'playing', stack: 240,
    holeCards: [{ rank: 'Q', suit: 'S' }, { rank: 'Q', suit: 'H' }]
  };

  table = leaveHoldemSeat(table, { userId: 1, now }).table;
  assert.equal(table.seats[0].leaveAfterHand, true);
  assert.equal(table.seats[0].status, 'playing');
  assert.equal(table.currentSeatIndex, 0);

  table = leaveHoldemSeat(table, { userId: 1, now }).table;
  assert.equal(table.seats[0].leaveAfterHand, false);
  assert.equal(table.seats[0].status, 'playing');
  assert.equal(table.currentSeatIndex, 0);
});

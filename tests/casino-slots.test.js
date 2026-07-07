import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CASINO_SLOT_WAGERS,
  buildSlotReels,
  pickSlotOutcome,
  resolveSlotSpin
} from '../services/casinoSlots.js';
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

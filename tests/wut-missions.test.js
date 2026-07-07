import test from 'node:test';
import assert from 'node:assert/strict';
import { countDistinctBackedTeams, holdMissionUntilLock } from '../services/wutMissionRules.js';

test('No Home Team shows distinct backed teams before lock without completing early', () => {
  const bets = ['CLE', 'NK', 'SEA', 'LL', 'TOR', 'BCK', 'RCH'].map(team_id => ({ team_id }));
  const mission = {
    progress: Math.min(countDistinctBackedTeams(bets), 6),
    target: 6,
    complete: true
  };

  holdMissionUntilLock(mission, { requiresLock: true, locked: false });
  assert.equal(mission.progress, 6);
  assert.equal(mission.complete, false);
  assert.equal(mission.progressLabel, '6/6 ready for lock');

  const lockedMission = { progress: 6, target: 6, complete: true };
  holdMissionUntilLock(lockedMission, { requiresLock: true, locked: true });
  assert.equal(lockedMission.complete, true);
});

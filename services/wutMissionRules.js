export function countDistinctBackedTeams(bets = []) {
  return new Set(bets.map(bet => String(bet.team_id || '').trim()).filter(Boolean)).size;
}

export function holdMissionUntilLock(mission, { requiresLock = false, locked = false } = {}) {
  if (!mission || !requiresLock || locked) return mission;
  mission.complete = false;
  mission.progressLabel = `${mission.progress}/${mission.target} ready for lock`;
  return mission;
}

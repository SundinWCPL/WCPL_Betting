export const SHOT_DOCTOR_SECONDS_PER_SHOT = Number(process.env.SHOT_DOCTOR_SECONDS_PER_SHOT || 15);
export const SHOT_DOCTOR_WEEKLY_LIMIT = Number(process.env.SHOT_DOCTOR_WEEKLY_LIMIT || 5);
export const SHOT_DOCTOR_PAYOUTS = Object.freeze({
  0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 25, 6: 50, 7: 75, 8: 100, 9: 200, 10: 500
});

export function publicShotDoctorShot(shot) {
  if (!shot) return null;
  return {
    shooter_name: shot.shooter_name,
    goalie_name: shot.goalie_name,
    shot_type: shot.shot_type,
    speed_kmh: Number(shot.speed_kmh || 0),
    distance_m: Number(shot.distance_m || 0),
    x: Number(shot.x || 0),
    z: Number(shot.z || 0),
    xg: shot.xg == null ? null : Number(shot.xg)
  };
}

export function publicShotDoctorRun(run) {
  if (!run) return null;
  const currentIndex = Number(run.current_index || 0);
  const currentShot = Array.isArray(run.shots) ? run.shots[currentIndex] : null;
  const shotStartedAt = run.current_shot_started_at || null;
  const deadlineAt = shotStartedAt
    ? new Date(new Date(shotStartedAt).getTime() + SHOT_DOCTOR_SECONDS_PER_SHOT * 1000).toISOString()
    : null;
  return {
    id: run.id,
    user_id: run.user_id,
    game: 'shot_doctor',
    status: run.status,
    wager: Number(run.wager || 0),
    payout: Number(run.payout || 0),
    net: Number(run.net || 0),
    correct: Number(run.correct || 0),
    current_index: currentIndex,
    total_shots: Array.isArray(run.shots) ? run.shots.length : 0,
    guesses: Array.isArray(run.guesses) ? run.guesses.map(guess => ({
      index: guess.index,
      guess: guess.guess,
      result: guess.result,
      correct: Boolean(guess.correct),
      timed_out: Boolean(guess.timed_out)
    })) : [],
    current_shot: currentShot && run.status === 'active' ? publicShotDoctorShot(currentShot) : null,
    shot_started_at: shotStartedAt,
    deadline_at: deadlineAt,
    seconds_per_shot: SHOT_DOCTOR_SECONDS_PER_SHOT,
    created_at: run.created_at,
    completed_at: run.completed_at || null
  };
}

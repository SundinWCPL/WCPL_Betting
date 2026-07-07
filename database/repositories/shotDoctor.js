import { withTransaction } from '../postgres.js';
import {
  SHOT_DOCTOR_PAYOUTS,
  SHOT_DOCTOR_SECONDS_PER_SHOT,
  SHOT_DOCTOR_WEEKLY_LIMIT,
  publicShotDoctorRun,
  publicShotDoctorShot
} from '../../services/shotDoctor.js';
import {
  addBalanceTransaction,
  changeLockedUserBalance,
  formatBalanceSummary,
  getLockedBalanceSummary,
  lockUser
} from './wallet.js';

const asNumber = value => Number(value || 0);

async function settingsDocument(client) {
  const result = await client.query("SELECT data FROM app_documents WHERE document_key='settings'");
  if (!result.rows[0]) throw new Error('Required PostgreSQL document is missing: settings.');
  return result.rows[0].data || {};
}

export async function getShotDoctorStateForUserPostgres(pool, userId) {
  const currentWeekResult = await pool.query("SELECT data FROM app_documents WHERE document_key='settings'");
  const settings = currentWeekResult.rows[0]?.data || {};
  const currentWeek = asNumber(settings.currentWeek || 1);
  const [runsResult, balanceResult] = await Promise.all([
    pool.query(`
      SELECT r.data, u.display_name, u.username
      FROM shot_doctor_runs r LEFT JOIN users u ON u.id=r.user_id
      ORDER BY r.id DESC
    `),
    pool.query(`
      SELECT u.balance,
        COALESCE((SELECT sum(stake) FROM bets WHERE user_id=u.id AND status='open'), 0)::bigint AS open_wagered
      FROM users u WHERE u.id=$1
    `, [Number(userId)])
  ]);
  const runs = runsResult.rows.map(row => ({ ...row.data, _display_name: row.display_name || row.username }));
  const userRuns = runs.filter(run => Number(run.user_id) === Number(userId));
  const activeRun = userRuns.find(run => run.status === 'active') || null;
  const weeklyRunsUsed = userRuns.filter(run => Number(run.week || currentWeek) === currentWeek).length;
  const completedRuns = runs.filter(run => run.status === 'complete');
  const byUser = new Map();
  for (const run of runs) {
    const uid = Number(run.user_id);
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, {
      user_id: uid,
      display_name: run._display_name || `User ${uid}`,
      runs_completed: 0,
      total_correct: 0,
      total_wagered: 0
    });
    const row = byUser.get(uid);
    row.total_wagered += asNumber(run.wager);
    if (run.status === 'complete') {
      row.runs_completed += 1;
      row.total_correct += asNumber(run.correct);
    }
  }
  const leaderboard = [...byUser.values()].map(row => ({
    ...row,
    average_score: row.runs_completed ? row.total_correct / row.runs_completed : 0
  })).sort((a, b) =>
    b.average_score - a.average_score || b.total_wagered - a.total_wagered || a.display_name.localeCompare(b.display_name)
  );
  const balance = balanceResult.rows[0];
  return {
    isOpen: Boolean(settings.casinoOpen),
    entryFee: Number(process.env.SHOT_DOCTOR_ENTRY_FEE || 50),
    shotsPerRun: 10,
    secondsPerShot: SHOT_DOCTOR_SECONDS_PER_SHOT,
    weeklyLimit: SHOT_DOCTOR_WEEKLY_LIMIT,
    weeklyRunsUsed,
    weeklyRunsRemaining: SHOT_DOCTOR_WEEKLY_LIMIT > 0 ? Math.max(0, SHOT_DOCTOR_WEEKLY_LIMIT - weeklyRunsUsed) : null,
    payouts: SHOT_DOCTOR_PAYOUTS,
    activeRun: publicShotDoctorRun(activeRun),
    leaderboard,
    leaderboardSummary: {
      average_score: completedRuns.length
        ? completedRuns.reduce((sum, run) => sum + asNumber(run.correct), 0) / completedRuns.length
        : 0,
      total_wagered: runs.reduce((sum, run) => sum + asNumber(run.wager), 0)
    },
    balanceSummary: balance ? formatBalanceSummary(balance.balance, balance.open_wagered) : null
  };
}

export async function startShotDoctorRunWithClient(client, { userId, shots, wager, now = new Date() }) {
  const cleanWager = Number(wager || process.env.SHOT_DOCTOR_ENTRY_FEE || 50);
  if (!Number.isFinite(cleanWager) || cleanWager <= 0) throw new Error('Invalid entry fee.');
  if (!Array.isArray(shots) || shots.length !== 10) throw new Error('Puck IQ needs exactly 10 shots.');
  const settings = await settingsDocument(client);
  if (!settings.casinoOpen) throw new Error('The casino is currently closed.');
  const user = await lockUser(client, userId);
  const currentWeek = asNumber(settings.currentWeek || 1);
  const counts = await client.query(`
    SELECT count(*) FILTER (WHERE status='active')::integer AS active,
           count(*) FILTER (WHERE week=$2)::integer AS weekly
    FROM shot_doctor_runs WHERE user_id=$1
  `, [Number(userId), currentWeek]);
  if (asNumber(counts.rows[0].active)) throw new Error('Finish your current Puck IQ run before starting another.');
  if (SHOT_DOCTOR_WEEKLY_LIMIT > 0 && asNumber(counts.rows[0].weekly) >= SHOT_DOCTOR_WEEKLY_LIMIT) {
    throw new Error('You have used all of your Puck IQ runs for this week.');
  }
  if (asNumber(user.balance) < cleanWager) throw new Error('Insufficient balance.');
  await changeLockedUserBalance(client, user, -cleanWager);
  const createdAt = now.toISOString();
  const id = asNumber((await client.query("SELECT nextval('shot_doctor_runs_id_seq') AS id")).rows[0].id);
  const run = {
    id,
    user_id: Number(userId),
    game: 'shot_doctor',
    week: currentWeek,
    status: 'active',
    wager: cleanWager,
    payout: 0,
    net: -cleanWager,
    correct: 0,
    current_index: 0,
    shots,
    guesses: [],
    current_shot_started_at: createdAt,
    created_at: createdAt,
    completed_at: null
  };
  await client.query(`
    INSERT INTO shot_doctor_runs(id,user_id,week,status,created_at,source_order,data)
    VALUES($1,$2,$3,'active',$4,$5,$6::jsonb)
  `, [id, Number(userId), currentWeek, createdAt, id, JSON.stringify(run)]);
  await addBalanceTransaction(client, {
    userId,
    week: currentWeek,
    amount: -cleanWager,
    kind: 'casino_shot_doctor_entry',
    category: 'casino',
    game: 'shot_doctor',
    note: 'Puck IQ entry',
    shot_doctor_run_id: id,
    createdAt
  });
  return { run: publicShotDoctorRun(run), balanceSummary: await getLockedBalanceSummary(client, user) };
}

export async function submitShotDoctorGuessWithClient(client, { userId, runId, guess, now = new Date() }) {
  const settings = await settingsDocument(client);
  if (!settings.casinoOpen) throw new Error('The casino is currently closed.');
  const user = await lockUser(client, userId);
  const result = await client.query(
    'SELECT data FROM shot_doctor_runs WHERE id=$1 AND user_id=$2 FOR UPDATE',
    [Number(runId), Number(userId)]
  );
  const run = result.rows[0]?.data;
  if (!run) throw new Error('Puck IQ run not found.');
  if (run.status !== 'active') throw new Error('This Puck IQ run is already complete.');
  const index = asNumber(run.current_index);
  const shot = Array.isArray(run.shots) ? run.shots[index] : null;
  if (!shot) throw new Error('No active shot found.');
  const cleanGuess = String(guess || '').trim().toUpperCase();
  const timeoutGuess = cleanGuess === 'TIMEOUT';
  if (!timeoutGuess && cleanGuess !== 'G' && cleanGuess !== 'S') throw new Error('Guess must be Goal or Save.');
  const startedAt = new Date(run.current_shot_started_at || run.created_at || now.toISOString()).getTime();
  const timedOut = !Number.isFinite(startedAt) || now.getTime() > startedAt + SHOT_DOCTOR_SECONDS_PER_SHOT * 1000 + 750;
  const shotResult = String(shot.result || '').trim().toUpperCase();
  const correct = !timedOut && !timeoutGuess && cleanGuess === shotResult;
  if (correct) run.correct = asNumber(run.correct) + 1;
  const answeredAt = now.toISOString();
  const reveal = {
    index,
    guess: timeoutGuess || timedOut ? '' : cleanGuess,
    result: shotResult,
    correct,
    timed_out: timedOut || timeoutGuess,
    shot: publicShotDoctorShot(shot),
    answered_at: answeredAt
  };
  run.guesses = [...(run.guesses || []), reveal];
  run.current_index = index + 1;
  if (run.current_index >= run.shots.length) {
    run.status = 'complete';
    run.payout = asNumber(SHOT_DOCTOR_PAYOUTS[asNumber(run.correct)]);
    run.net = run.payout - asNumber(run.wager);
    run.completed_at = answeredAt;
    run.current_shot_started_at = null;
    if (run.payout > 0) {
      await changeLockedUserBalance(client, user, run.payout);
      await addBalanceTransaction(client, {
        userId,
        week: asNumber(run.week || settings.currentWeek || 1),
        amount: run.payout,
        kind: 'casino_shot_doctor_payout',
        category: 'casino',
        game: 'shot_doctor',
        note: `Puck IQ payout: ${asNumber(run.correct)}/10 correct`,
        shot_doctor_run_id: run.id,
        createdAt: answeredAt
      });
    }
  } else {
    run.current_shot_started_at = answeredAt;
  }
  await client.query(
    'UPDATE shot_doctor_runs SET status=$2, data=$3::jsonb WHERE id=$1',
    [run.id, run.status, JSON.stringify(run)]
  );
  return { reveal, run: publicShotDoctorRun(run), balanceSummary: await getLockedBalanceSummary(client, user) };
}

export const startShotDoctorRunPostgres = (pool, input) =>
  withTransaction(pool, client => startShotDoctorRunWithClient(client, input));
export const submitShotDoctorGuessPostgres = (pool, input) =>
  withTransaction(pool, client => submitShotDoctorGuessWithClient(client, input));

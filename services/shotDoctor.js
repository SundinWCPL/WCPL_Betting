import { getGames, getBoxscores, getPlayers } from './wcplData.js';

const SHOT_DOCTOR_SEASON = 'S2';
const SHOT_DOCTOR_DIVISION = 'ALL';
const SPEED_MULT = 3.6;
const NET_X = 0;
const NET_Z = 39.8;
const OFFENSIVE_BLUE_LINE_Z = 13.3;
const GOAL_LINE_Z = 39.8;
const MIN_SHOT_DISTANCE_M = 2.5;
const MAX_SHOT_DISTANCE_M = 25;
const SHOTS_PER_RUN = 10;
const EXCLUDED_GOALIE_NAMES = new Set(['bwall', 'midnight']);
const DISTANCE_BUCKETS = {
  close: { name: 'close', min: 2.5, max: 10 },
  mid: { name: 'mid', min: 10, max: 20 },
  long: { name: 'long', min: 20, max: 25.000001 }
};
const MIN_GOALS_PER_RUN = 3;
const MAX_GOALS_PER_RUN = 8;


let cache = null;
let cacheTs = 0;
const CACHE_MS = Number(process.env.SHOT_DOCTOR_CACHE_MS || 5 * 60 * 1000);

function normalizeId(v) {
  return String(v ?? '')
    .trim()
    .replace(/^=+/, '')
    .replace(/^"\s*/, '')
    .replace(/"\s*$/, '')
    .replace(/^'+/, '')
    .replace(/\s+/g, '');
}

function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function distToNet(x, z) {
  const dx = Number(x) - NET_X;
  const dz = Number(z) - NET_Z;
  return Math.sqrt(dx * dx + dz * dz);
}

function prettyShotType(value, shotKind = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (String(shotKind || '').toLowerCase() === 'bat') return 'Bat/Tip';
  if (raw === 'wrap_bank') return 'Wrap/Bank';
  if (raw === 'one_timer') return 'One Timer';
  return raw
    ? raw.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
    : 'Shot';
}

function parseShotSummary(summary) {
  const raw = String(summary || '').trim();
  if (!raw) return [];

  return raw.split(';').map(part => {
    const fields = part.split('|');
    const isNew = fields.length >= 11;
    if (!isNew && fields.length < 10) return null;

    const xg_i = isNew ? toNum(fields[5]) : null;
    const contactV = toNum(fields[isNew ? 6 : 5]);
    const x = toNum(fields[isNew ? 8 : 7]);
    const z = toNum(fields[isNew ? 9 : 8]);
    const result = String(fields[isNew ? 10 : 9] || '').trim().toUpperCase();

    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    if (result !== 'G' && result !== 'S') return null;
    if (!Number.isFinite(contactV) || contactV <= 0) return null;

    return {
      time_label: fields[0] || '',
      teamColor: String(fields[1] || '').trim(),
      steamId: normalizeId(fields[2]),
      shotKind: String(fields[3] || '').trim(),
      shotType: String(fields[4] || '').trim(),
      xg: Number.isFinite(xg_i) ? xg_i / 1000 : null,
      speed: contactV,
      speed_kmh: contactV * SPEED_MULT,
      x,
      z,
      result
    };
  }).filter(Boolean);
}

function sampleMany(items, count) {
  const pool = [...items];
  const out = [];
  while (out.length < count && pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDistancePlan() {
  // Target variety without making each run identical:
  // close 1-3, long 1-2, mid gets the remainder.
  // With 10 total shots this naturally makes mid 5-7 after rejecting 8-mid rolls.
  for (let tries = 0; tries < 100; tries++) {
    const close = randInt(1, 3);
    const long = randInt(1, 2);
    const mid = SHOTS_PER_RUN - close - long;
    if (mid >= 4 && mid <= 7) return { close, mid, long };
  }
  return { close: 2, mid: 6, long: 2 };
}

function bucketForDistance(distance) {
  const d = Number(distance);
  if (!Number.isFinite(d)) return '';
  if (d >= DISTANCE_BUCKETS.close.min && d < DISTANCE_BUCKETS.close.max) return 'close';
  if (d >= DISTANCE_BUCKETS.mid.min && d < DISTANCE_BUCKETS.mid.max) return 'mid';
  if (d >= DISTANCE_BUCKETS.long.min && d < DISTANCE_BUCKETS.long.max) return 'long';
  return '';
}

function buildBucketPools(bank) {
  const pools = {
    close: { G: [], S: [] },
    mid: { G: [], S: [] },
    long: { G: [], S: [] }
  };

  for (const shot of bank) {
    const bucket = bucketForDistance(shot.distance_m);
    const result = String(shot.result || '').toUpperCase();
    if (!pools[bucket] || (result !== 'G' && result !== 'S')) continue;
    pools[bucket][result].push(shot);
  }

  return pools;
}

function randomGoalTarget() {
  // Slightly favor 5-6 while allowing 3-8 so the answer mix is not predictable.
  const choices = [3, 4, 5, 6, 7, 8];
  const weights = [1, 2, 3, 3, 2, 1];
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = randInt(1, total);
  for (let i = 0; i < choices.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return choices[i];
  }
  return 5;
}

function validGoalAllocations(plan, targetGoals, pools) {
  const out = [];
  const bucketNames = ['close', 'mid', 'long'];

  function walk(i, alloc, goalsSoFar) {
    if (i >= bucketNames.length) {
      if (goalsSoFar === targetGoals) out.push({ ...alloc });
      return;
    }

    const bucketName = bucketNames[i];
    const count = Number(plan[bucketName] || 0);
    const goalPool = pools[bucketName]?.G || [];
    const savePool = pools[bucketName]?.S || [];

    for (let g = 0; g <= count; g++) {
      const savesNeeded = count - g;
      if (g > goalPool.length) continue;
      if (savesNeeded > savePool.length) continue;
      if (goalsSoFar + g > targetGoals) continue;
      alloc[bucketName] = g;
      walk(i + 1, alloc, goalsSoFar + g);
    }
  }

  walk(0, {}, 0);
  return out;
}

function sampleRunForPlanAndGoalTarget(bank, plan, targetGoals) {
  const pools = buildBucketPools(bank);
  const allocations = validGoalAllocations(plan, targetGoals, pools);
  if (!allocations.length) return null;

  const alloc = allocations[Math.floor(Math.random() * allocations.length)];
  const picked = [];
  const used = new Set();

  for (const bucketName of ['close', 'mid', 'long']) {
    const count = Number(plan[bucketName] || 0);
    const goalsNeeded = Number(alloc[bucketName] || 0);
    const savesNeeded = count - goalsNeeded;

    const goals = sampleMany(pools[bucketName].G.filter(s => !used.has(s.shot_id)), goalsNeeded);
    const saves = sampleMany(pools[bucketName].S.filter(s => !used.has(s.shot_id)), savesNeeded);
    if (goals.length < goalsNeeded || saves.length < savesNeeded) return null;

    for (const shot of [...goals, ...saves]) {
      used.add(shot.shot_id);
      picked.push(shot);
    }
  }

  if (picked.length !== SHOTS_PER_RUN) return null;
  return picked;
}

function weightedGoalCount() {
  const choices = [3, 4, 5, 6, 7];
  const weights = [1, 2, 4, 2, 1];
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.floor(Math.random() * total) + 1;
  for (let i = 0; i < choices.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return choices[i];
  }
  return 5;
}

function stripAnswer(shot) {
  const { result, ...publicShot } = shot;
  return publicShot;
}

async function buildShotBank() {
  const now = Date.now();
  if (cache && now - cacheTs < CACHE_MS) return cache;

  const [games, boxscores, players] = await Promise.all([
    getGames(SHOT_DOCTOR_DIVISION, SHOT_DOCTOR_SEASON),
    getBoxscores(SHOT_DOCTOR_DIVISION, SHOT_DOCTOR_SEASON),
    getPlayers(SHOT_DOCTOR_DIVISION, SHOT_DOCTOR_SEASON)
  ]);

  const gameById = new Map(games.map(g => [String(g.match_id || '').trim(), g]));
  const playerBySteam = new Map();
  for (const p of players || []) {
    const sid = normalizeId(p.steam_id);
    if (sid && !playerBySteam.has(sid)) playerBySteam.set(sid, p);
  }

  const boxByMatchSteam = new Map();
  const goalieByMatchTeam = new Map();
  for (const r of boxscores || []) {
    const matchId = String(r.match_id || '').trim();
    const sid = normalizeId(r.steam_id);
    if (matchId && sid) boxByMatchSteam.set(`${matchId}|${sid}`, r);

    const pos = String(r.position || '').trim().toUpperCase();
    const sa = Number(r.sa || 0);
    if (matchId && pos === 'G') {
      const teamId = String(r.team_id || '').trim();
      const key = `${matchId}|${teamId}`;
      const existing = goalieByMatchTeam.get(key);
      if (!existing || Number(existing.sa || 0) < sa) goalieByMatchTeam.set(key, r);
    }
  }

  const shots = [];
  for (const game of games || []) {
    const matchId = String(game.match_id || '').trim();
    if (!matchId || !String(game.shot_summary || '').trim()) continue;

    const homeTeam = String(game.home_team_id || '').trim();
    const awayTeam = String(game.away_team_id || '').trim();

    const parsed = parseShotSummary(game.shot_summary);
    parsed.forEach((s, index) => {
      const teamColor = String(s.teamColor || '').trim().toLowerCase();
      const shooterTeam = teamColor === 'red' ? homeTeam : teamColor === 'blue' ? awayTeam : '';
      const goalieTeam = teamColor === 'red' ? awayTeam : teamColor === 'blue' ? homeTeam : '';
      if (!shooterTeam || !goalieTeam) return;

      const shooterBox = boxByMatchSteam.get(`${matchId}|${s.steamId}`);
      const shooterPlayer = playerBySteam.get(s.steamId);
      const goalieBox = goalieByMatchTeam.get(`${matchId}|${goalieTeam}`);
      const goalieSteam = normalizeId(goalieBox?.steam_id);
      const goaliePlayer = goalieSteam ? playerBySteam.get(goalieSteam) : null;

      const shooterName = String(shooterBox?.player_name || shooterPlayer?.name || '').trim();
      const goalieName = String(goalieBox?.player_name || goaliePlayer?.name || '').trim();
      if (!shooterName || !goalieName) return;
      if (EXCLUDED_GOALIE_NAMES.has(normalizeName(goalieName))) return;

      // shot_summary coordinates are already mirrored by the importer so every shot attacks the same net.
      // Offensive zone = at/inside the attacking blue line toward the net.
      // Exclude behind-goal-line wrap/bank attempts because they display oddly in the quiz view.
      if (!Number.isFinite(s.z) || s.z < OFFENSIVE_BLUE_LINE_Z || s.z > GOAL_LINE_Z) return;

      const distance = distToNet(s.x, s.z);
      if (!Number.isFinite(distance)) return;
      if (distance < MIN_SHOT_DISTANCE_M || distance > MAX_SHOT_DISTANCE_M) return;

      shots.push({
        shot_id: `${SHOT_DOCTOR_SEASON}|${matchId}|${index}`,
        season_id: SHOT_DOCTOR_SEASON,
        match_id: matchId,
        shooter_name: shooterName,
        shooter_steam_id: s.steamId,
        shooter_team_id: shooterTeam,
        goalie_name: goalieName,
        goalie_steam_id: goalieSteam,
        goalie_team_id: goalieTeam,
        shot_type: prettyShotType(s.shotType, s.shotKind),
        shot_type_raw: s.shotType,
        shot_kind: s.shotKind,
        speed_kmh: Number(s.speed_kmh.toFixed(1)),
        distance_m: Number(distance.toFixed(1)),
        x: Number(s.x),
        z: Number(s.z),
        xg: Number.isFinite(s.xg) ? Number(s.xg.toFixed(3)) : null,
        result: s.result
      });
    });
  }

  cache = shots;
  cacheTs = now;
  return cache;
}

export function shotDoctorConfig() {
  return {
    seasonId: SHOT_DOCTOR_SEASON,
    entryFee: Number(process.env.SHOT_DOCTOR_ENTRY_FEE || 50),
    shotsPerRun: SHOTS_PER_RUN,
    secondsPerShot: Number(process.env.SHOT_DOCTOR_SECONDS_PER_SHOT || 15),
    weeklyLimit: Number(process.env.SHOT_DOCTOR_WEEKLY_LIMIT || 5),
    payouts: {
      0: 0,
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 25,
      6: 50,
      7: 75,
      8: 100,
      9: 200,
      10: 500
    }
  };
}

export async function buildShotDoctorRunShots() {
  const bank = await buildShotBank();
  if (bank.length < SHOTS_PER_RUN) throw new Error('Not enough S2 shot data to start Puck IQ.');

  // Build a run with both distance variety and a sane goal/save mix.
  // This prevents "guess save every time" runs while still making each run feel random.
  for (let tries = 0; tries < 5000; tries++) {
    const plan = randomDistancePlan();
    const targetGoals = randomGoalTarget();
    const picked = sampleRunForPlanAndGoalTarget(bank, plan, targetGoals);
    if (picked) return shuffle(picked);
  }

  // Emergency fallback: preserve the 3-8 goal constraint first, then distance variety as much as possible.
  for (let tries = 0; tries < 2000; tries++) {
    const targetGoals = randomGoalTarget();
    const goals = sampleMany(bank.filter(shot => String(shot.result).toUpperCase() === 'G'), targetGoals);
    const saves = sampleMany(bank.filter(shot => String(shot.result).toUpperCase() === 'S'), SHOTS_PER_RUN - targetGoals);
    const picked = [...goals, ...saves];
    if (picked.length === SHOTS_PER_RUN) return shuffle(picked);
  }

  throw new Error('Not enough balanced S2 shot data to start Puck IQ.');
}

export function publicShot(shot) {
  return stripAnswer(shot);
}

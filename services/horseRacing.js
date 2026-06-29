// Nightly horse-racing configuration lives here so names, timing and payouts
// can be changed without touching the persistence or UI layers.
export const HORSE_RACING_CONFIG = Object.freeze({
  timeZone: process.env.HORSE_RACING_TIME_ZONE || 'America/Los_Angeles',
  horses: Object.freeze([
    { id: 'horse-1', name: 'Pony Soprano' },
    { id: 'horse-2', name: 'Neigh Sayer' },
    { id: 'horse-3', name: 'Usain Colt' },
    { id: 'horse-4', name: 'Hay Fever' },
    { id: 'horse-5', name: 'Tater Trot' }
  ]),
  horseImage: '/images/casino/Horses/horse.png',
  raceHorseCount: 5,
  horsePurchasePrice: Number(process.env.HORSE_PURCHASE_PRICE || 5000),
  ownerBetShare: Number(process.env.HORSE_OWNER_BET_SHARE || 0.05),
  ownerWinBonus: Number(process.env.HORSE_OWNER_WIN_BONUS || 200),
  maxOwnedHorses: 3,
  horseNameMaxLength: 32,
  maxBet: Number(process.env.HORSE_RACING_MAX_BET || 500),
  payouts: Object.freeze({ 1: 4, 2: 0.75 }),
  raceTimes: Object.freeze([
    Object.freeze({ number: 1, bettingOpens: Object.freeze({ hour: 18, minute: 30 }), postTime: Object.freeze({ hour: 19, minute: 0 }) }),
    Object.freeze({ number: 2, bettingOpens: null, postTime: Object.freeze({ hour: 20, minute: 0 }) }),
    Object.freeze({ number: 3, bettingOpens: null, postTime: Object.freeze({ hour: 21, minute: 0 }) })
  ]),
  countdownSeconds: Number(process.env.HORSE_RACING_COUNTDOWN_SECONDS || 60),
  raceDurationMinSeconds: Number(process.env.HORSE_RACING_MIN_DURATION_SECONDS || 28),
  raceDurationMaxSeconds: Number(process.env.HORSE_RACING_MAX_DURATION_SECONDS || 32),
  chatMaxLength: 250,
  chatCooldownMs: 2000,
  chatPostRaceMinutes: 15
});

const zonedPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: HORSE_RACING_CONFIG.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function zonedParts(date) {
  return Object.fromEntries(
    zonedPartsFormatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );
}

export function getHorseRaceDateKey(now = new Date()) {
  const parts = zonedParts(now);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

// Convert a wall-clock time in the configured zone to an absolute instant.
// The small correction loop also handles daylight-saving offsets without an
// additional date library.
export function horseRaceZonedTimeToDate(dateKey, { hour, minute, second = 0 }) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desired;

  for (let i = 0; i < 3; i += 1) {
    const actual = zonedParts(new Date(guess));
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    guess += desired - actualAsUtc;
  }

  return new Date(guess);
}

export function getHorseRaceSchedule(dateKey, raceNumber = 1, bettingOpensAtOverride = null) {
  const raceTime = HORSE_RACING_CONFIG.raceTimes.find(item => Number(item.number) === Number(raceNumber));
  if (!raceTime) throw new Error(`Unknown horse race number: ${raceNumber}`);
  const bettingOpensAt = bettingOpensAtOverride
    ? new Date(bettingOpensAtOverride)
    : raceTime.bettingOpens
      ? horseRaceZonedTimeToDate(dateKey, raceTime.bettingOpens)
      : null;
  const raceStartsAt = horseRaceZonedTimeToDate(dateKey, raceTime.postTime);
  const bettingClosesAt = new Date(
    raceStartsAt.getTime() - HORSE_RACING_CONFIG.countdownSeconds * 1000
  );
  const midnightAt = horseRaceZonedTimeToDate(nextDateKey(dateKey), { hour: 0, minute: 0 });

  return { bettingOpensAt, bettingClosesAt, raceStartsAt, midnightAt };
}

export function getScheduledHorseRaceStatus(now, schedule, durationSeconds = null) {
  const time = now.getTime();
  if (!schedule.bettingOpensAt) return 'upcoming';
  if (time < schedule.bettingOpensAt.getTime()) return 'upcoming';
  if (time < schedule.bettingClosesAt.getTime()) return 'betting';
  if (time < schedule.raceStartsAt.getTime()) return 'countdown';
  if (durationSeconds == null) return 'racing';
  if (time < schedule.raceStartsAt.getTime() + durationSeconds * 1000) return 'racing';
  return 'complete';
}

export function nextDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [next.getUTCFullYear(), String(next.getUTCMonth() + 1).padStart(2, '0'), String(next.getUTCDate()).padStart(2, '0')].join('-');
}

export function previousDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return [previous.getUTCFullYear(), String(previous.getUTCMonth() + 1).padStart(2, '0'), String(previous.getUTCDate()).padStart(2, '0')].join('-');
}

export function getHorseRaceCardDateKey(now = new Date()) {
  const dateKey = getHorseRaceDateKey(now);
  const opensAt = getHorseRaceSchedule(dateKey, 1).bettingOpensAt;
  return now < opensAt ? previousDateKey(dateKey) : dateKey;
}

export function randomHorseRaceDurationSeconds() {
  const min = Math.min(HORSE_RACING_CONFIG.raceDurationMinSeconds, HORSE_RACING_CONFIG.raceDurationMaxSeconds);
  const max = Math.max(HORSE_RACING_CONFIG.raceDurationMinSeconds, HORSE_RACING_CONFIG.raceDurationMaxSeconds);
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function shuffledHorseIds(horses = HORSE_RACING_CONFIG.horses) {
  const ids = horses.map(horse => horse.id);
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

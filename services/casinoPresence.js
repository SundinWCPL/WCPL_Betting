const PRESENCE_TTL_MS = 35_000;
const CASINO_GAMES = Object.freeze(['slots', 'puckiq', 'horse-racing', 'blackjack', 'holdem']);
const presenceByUserId = new Map();

function cleanCasinoPresence(now = new Date()) {
  const cutoff = now.getTime() - PRESENCE_TTL_MS;
  for (const [userId, presence] of presenceByUserId.entries()) {
    if (!presence || Number(presence.seenAt || 0) < cutoff) presenceByUserId.delete(userId);
  }
}

export function normalizeCasinoGame(value) {
  const key = String(value || '').trim().toLowerCase();
  return CASINO_GAMES.includes(key) ? key : null;
}

export function recordCasinoPresence({ userId, game, now = new Date() }) {
  const cleanGame = normalizeCasinoGame(game);
  if (!cleanGame || userId == null) return casinoPresenceCounts(now);
  cleanCasinoPresence(now);
  presenceByUserId.set(Number(userId), { game: cleanGame, seenAt: now.getTime() });
  return casinoPresenceCounts(now);
}

export function clearCasinoPresence({ userId, game = null, now = new Date() }) {
  cleanCasinoPresence(now);
  const presence = presenceByUserId.get(Number(userId));
  const cleanGame = normalizeCasinoGame(game);
  if (presence && (!cleanGame || presence.game === cleanGame)) presenceByUserId.delete(Number(userId));
  return casinoPresenceCounts(now);
}

export function casinoPresenceCounts(now = new Date()) {
  cleanCasinoPresence(now);
  const counts = Object.fromEntries(CASINO_GAMES.map(game => [game, 0]));
  for (const presence of presenceByUserId.values()) {
    if (counts[presence.game] != null) counts[presence.game] += 1;
  }
  return counts;
}

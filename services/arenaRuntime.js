export const ARENA_DEFAULT_ELO = 1000;
export const ARENA_TURN_SEQUENCE = Object.freeze([1, 2, 2, 2, 2, 1]);

export function pairArenaEntries(entries, ratingForEntry = entry => Number(entry.elo || ARENA_DEFAULT_ELO), havePlayed = () => false) {
  const waiting = [...entries];
  let unmatched = null;
  if (waiting.length % 2 === 1) {
    waiting.sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || Number(a.id) - Number(b.id));
    unmatched = waiting.pop();
  }
  waiting.sort((a, b) => Number(ratingForEntry(a)) - Number(ratingForEntry(b)) ||
    new Date(a.created_at) - new Date(b.created_at) || Number(a.id) - Number(b.id));
  const pairKey = (a, b) => [Number(a.id), Number(b.id)].sort((x, y) => x - y).join('-');
  const better = (candidate, best) => !best || candidate.rematches < best.rematches ||
    (candidate.rematches === best.rematches && candidate.eloDifference < best.eloDifference) ||
    (candidate.rematches === best.rematches && candidate.eloDifference === best.eloDifference && candidate.key < best.key);
  let pairs;
  if (waiting.length <= 16) {
    const memo = new Map();
    const solve = mask => {
      if (!mask) return { pairs: [], rematches: 0, eloDifference: 0, key: '' };
      if (memo.has(mask)) return memo.get(mask);
      let firstIndex = 0;
      while ((mask & (1 << firstIndex)) === 0) firstIndex += 1;
      let best = null;
      for (let secondIndex = firstIndex + 1; secondIndex < waiting.length; secondIndex += 1) {
        if ((mask & (1 << secondIndex)) === 0) continue;
        const first = waiting[firstIndex];
        const second = waiting[secondIndex];
        const rest = solve(mask & ~(1 << firstIndex) & ~(1 << secondIndex));
        const candidate = {
          pairs: [[first, second], ...rest.pairs],
          rematches: Number(Boolean(havePlayed(first, second))) + rest.rematches,
          eloDifference: Math.abs(Number(ratingForEntry(first)) - Number(ratingForEntry(second))) + rest.eloDifference,
          key: `${pairKey(first, second)}|${rest.key}`
        };
        if (better(candidate, best)) best = candidate;
      }
      memo.set(mask, best);
      return best;
    };
    pairs = solve((1 << waiting.length) - 1)?.pairs || [];
  } else {
    const remaining = [...waiting];
    pairs = [];
    while (remaining.length) {
      const first = remaining.shift();
      const fresh = remaining.filter(candidate => !havePlayed(first, candidate));
      const candidates = fresh.length ? fresh : remaining;
      candidates.sort((a, b) => Math.abs(Number(ratingForEntry(first)) - Number(ratingForEntry(a))) -
        Math.abs(Number(ratingForEntry(first)) - Number(ratingForEntry(b))) || new Date(a.created_at) - new Date(b.created_at));
      const second = candidates[0];
      remaining.splice(remaining.indexOf(second), 1);
      pairs.push([first, second]);
    }
  }
  return { pairs, unmatched };
}

const localHour = (date, timeZone) => Number(new Intl.DateTimeFormat('en-CA', {
  timeZone, hour: '2-digit', hourCycle: 'h23'
}).formatToParts(date).find(part => part.type === 'hour')?.value || 0);

export function nextArenaDeadline(now, config) {
  const zone = config.timeZone || 'America/Los_Angeles';
  const paused = date => {
    const hour = localHour(date, zone);
    const start = Number(config.pauseStartHour ?? 0);
    const end = Number(config.pauseEndHour ?? 8);
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  };
  let cursor = new Date(now);
  let remaining = Number(config.turnHours || 2) * 3600000;
  while (remaining > 0) {
    const step = Math.min(60000, remaining);
    cursor = new Date(cursor.getTime() + step);
    if (!paused(new Date(cursor.getTime() - 1))) remaining -= step;
  }
  return cursor.toISOString();
}

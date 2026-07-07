import { withTransaction } from '../postgres.js';
import {
  HORSE_RACING_CONFIG,
  getHorseRaceCardDateKey,
  getHorseRaceDateKey,
  getHorseRaceSchedule,
  getScheduledHorseRaceStatus,
  nextDateKey,
  randomHorseRaceDurationSeconds,
  shuffledHorseIds
} from '../../services/horseRacing.js';
import {
  addBalanceTransaction,
  changeLockedUserBalance,
  lockUser
} from './wallet.js';
import { lockAndLoadHorseStore, saveHorseStore } from './horseStore.js';

const asNumber = value => Number(value || 0);

function publicBet(bet) {
  if (!bet) return null;
  return {
    id: bet.id,
    horse_id: bet.horse_id,
    horse_name: bet.horse_name,
    stake: asNumber(bet.stake),
    payout: bet.payout == null ? null : asNumber(bet.payout),
    finishing_position: bet.finishing_position == null ? null : asNumber(bet.finishing_position),
    settled: Boolean(bet.settled),
    updated_at: bet.updated_at || bet.created_at
  };
}

function publicOwnedHorse(horse, rewards = []) {
  const races = asNumber(horse.races);
  const pending = rewards.filter(reward => !reward.claimed_at && String(reward.horse_id) === String(horse.id));
  return {
    id: horse.id,
    name: horse.name,
    races,
    wins: asNumber(horse.wins),
    secondPlaces: asNumber(horse.second_places),
    averageFinish: races ? Number((asNumber(horse.total_finishing_position) / races).toFixed(2)) : null,
    pendingWinnings: pending.reduce((sum, reward) => sum + asNumber(reward.amount), 0),
    pendingRewards: pending.length,
    purchasedAt: horse.created_at || null
  };
}

export async function buyHorseWithClient(client, { userId, name, now = new Date() }) {
  const { settings, store } = await lockAndLoadHorseStore(client);
  if (!settings.casinoOpen) throw new Error('The casino is currently closed.');
  const ownedCount = store.horses.filter(horse => Number(horse.owner_user_id) === Number(userId)).length;
  if (ownedCount >= HORSE_RACING_CONFIG.maxOwnedHorses) {
    throw new Error(`You can own a maximum of ${HORSE_RACING_CONFIG.maxOwnedHorses} horses.`);
  }
  const cleanName = String(name || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleanName.length < 2) throw new Error('Horse name must be at least 2 characters.');
  if (cleanName.length > HORSE_RACING_CONFIG.horseNameMaxLength) {
    throw new Error(`Horse names are limited to ${HORSE_RACING_CONFIG.horseNameMaxLength} characters.`);
  }
  if (store.horses.some(horse => String(horse.name).toLowerCase() === cleanName.toLowerCase())) {
    throw new Error('That horse name is already taken.');
  }
  const user = await lockUser(client, userId);
  const price = Math.ceil(asNumber(store.config?.horsePurchasePrice));
  if (asNumber(user.balance) < price) throw new Error('Insufficient balance.');
  let id;
  do {
    id = `horse-${asNumber(store.nextHorseId || 1)}`;
    store.nextHorseId = asNumber(store.nextHorseId || 1) + 1;
  } while (store.horses.some(horse => String(horse.id) === id));
  const horse = {
    id,
    name: cleanName,
    owner_user_id: Number(userId),
    purchase_price: price,
    races: 0,
    wins: 0,
    second_places: 0,
    total_finishing_position: 0,
    created_at: now.toISOString()
  };
  store.horses.push(horse);
  await changeLockedUserBalance(client, user, -price);
  await addBalanceTransaction(client, {
    userId,
    week: asNumber(settings.currentWeek || 1),
    amount: -price,
    kind: 'casino_horse_purchase',
    category: 'casino',
    game: 'horse_racing',
    horse_id: horse.id,
    note: `Purchased horse: ${horse.name}`,
    createdAt: now.toISOString()
  });
  await saveHorseStore(client, store);
  return publicOwnedHorse(horse);
}

export async function placeOrUpdateHorseRaceBetWithClient(client, { userId, horseId, stake, now = new Date() }) {
  const cleanStake = Number(stake);
  if (!Number.isInteger(cleanStake) || cleanStake <= 0) throw new Error('Stake must be a positive whole number.');
  const { settings, store } = await lockAndLoadHorseStore(client);
  if (!settings.casinoOpen) throw new Error('The casino is currently closed.');
  const race = store.races.filter(candidate => candidate.status === 'betting').sort((a, b) =>
    String(b.race_date || '').localeCompare(String(a.race_date || '')) ||
    asNumber(b.race_number) - asNumber(a.race_number) ||
    asNumber(b.id) - asNumber(a.id)
  )[0];
  if (!race) throw new Error('Horse race betting is not open.');
  const maxBet = asNumber(store.config?.maxBet);
  if (cleanStake > maxBet) throw new Error(`Max horse race bet is ${maxBet} Mushybux.`);
  const horse = (race.horse_names || []).find(candidate => String(candidate.id) === String(horseId));
  if (!horse) throw new Error('Select a valid horse.');
  const user = await lockUser(client, userId);
  const existing = store.bets.find(bet => Number(bet.race_id) === Number(race.id) && Number(bet.user_id) === Number(userId));
  if (existing?.settled) throw new Error('This wager has already been settled.');
  const oldStake = asNumber(existing?.stake);
  if (asNumber(user.balance) + oldStake < cleanStake) throw new Error('Insufficient balance.');
  await changeLockedUserBalance(client, user, oldStake - cleanStake);
  if (existing) {
    existing.horse_id = horse.id;
    existing.horse_name = horse.name;
    existing.stake = cleanStake;
    existing.updated_at = now.toISOString();
    await addBalanceTransaction(client, {
      userId, week: asNumber(settings.currentWeek || 1), amount: oldStake - cleanStake,
      kind: 'casino_horse_racing_bet_change', category: 'casino', game: 'horse_racing',
      race_id: race.id, horse_race_bet_id: existing.id,
      note: `Horse race wager changed: ${horse.name}`, createdAt: now.toISOString()
    });
    await saveHorseStore(client, store);
    return { action: 'updated', bet: publicBet(existing) };
  }
  const bet = {
    id: asNumber(store.nextBetId || 1),
    race_id: race.id,
    user_id: Number(userId),
    horse_id: horse.id,
    horse_name: horse.name,
    stake: cleanStake,
    payout: null,
    payout_multiplier: null,
    finishing_position: null,
    settled: false,
    status: 'open',
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
  store.nextBetId = bet.id + 1;
  store.bets.push(bet);
  await addBalanceTransaction(client, {
    userId, week: asNumber(settings.currentWeek || 1), amount: -cleanStake,
    kind: 'casino_horse_racing_wager', category: 'casino', game: 'horse_racing',
    race_id: race.id, horse_race_bet_id: bet.id,
    note: `Horse race wager: ${horse.name}`, createdAt: now.toISOString()
  });
  await saveHorseStore(client, store);
  return { action: 'placed', bet: publicBet(bet) };
}

export async function claimHorseOwnerWinningsWithClient(client, { userId, horseId, now = new Date() }) {
  const { settings, store } = await lockAndLoadHorseStore(client);
  const horse = store.horses.find(candidate => String(candidate.id) === String(horseId) && Number(candidate.owner_user_id) === Number(userId));
  if (!horse) throw new Error('Owned horse not found.');
  const rewards = store.ownerRewards.filter(reward =>
    Number(reward.user_id) === Number(userId) && String(reward.horse_id) === String(horse.id) && !reward.claimed_at
  );
  if (!rewards.length) throw new Error('This horse has no winnings ready to collect.');
  const user = await lockUser(client, userId);
  let total = 0;
  for (const reward of rewards) {
    const amount = Math.round(asNumber(reward.amount));
    total += amount;
    const transaction = await addBalanceTransaction(client, {
      userId, week: asNumber(settings.currentWeek || 1), amount,
      kind: 'casino_horse_owner_winnings', category: 'casino', game: 'horse_racing',
      race_id: Number(reward.race_id), horse_id: horse.id, horse_owner_reward_id: reward.id,
      note: `${horse.name} owner winnings: ${reward.bet_share} bet share + ${reward.win_bonus} win bonus`,
      createdAt: now.toISOString()
    });
    reward.claimed_at = now.toISOString();
    reward.claim_transaction_id = transaction.id;
  }
  await changeLockedUserBalance(client, user, total);
  await saveHorseStore(client, store);
  return { horseId: horse.id, horseName: horse.name, rewards: rewards.length, amount: total };
}

export async function settleHorseRaceWithClient(client, { store, settings, race, now = new Date(), persist = true }) {
  if (race.settled_at) return false;
  const order = Array.isArray(race.finishing_order) ? race.finishing_order : [];
  if (!order.length) throw new Error('Horse race cannot settle without a finishing order.');
  for (const bet of store.bets.filter(candidate => Number(candidate.race_id) === Number(race.id))) {
    if (bet.settled) continue;
    const finishingPosition = order.findIndex(horseId => String(horseId) === String(bet.horse_id)) + 1;
    const multiplier = asNumber(HORSE_RACING_CONFIG.payouts[finishingPosition]);
    const payout = Math.round(asNumber(bet.stake) * multiplier);
    bet.finishing_position = finishingPosition || null;
    bet.payout_multiplier = multiplier;
    bet.payout = payout;
    bet.settled = true;
    bet.status = 'settled';
    bet.settled_at = now.toISOString();
    if (payout > 0) {
      const user = await lockUser(client, bet.user_id);
      await changeLockedUserBalance(client, user, payout);
      await addBalanceTransaction(client, {
        userId: bet.user_id,
        week: asNumber(settings.currentWeek || 1),
        amount: payout,
        kind: 'casino_horse_racing_payout',
        category: 'casino',
        game: 'horse_racing',
        race_id: race.id,
        horse_race_bet_id: bet.id,
        note: `Horse racing payout: ${finishingPosition === 1 ? '1st' : '2nd'} place`,
        createdAt: now.toISOString()
      });
    }
  }
  if (!race.stats_recorded_at) {
    const horses = new Map(store.horses.map(horse => [String(horse.id), horse]));
    const raceBets = store.bets.filter(bet => Number(bet.race_id) === Number(race.id));
    order.forEach((horseId, index) => {
      const horse = horses.get(String(horseId));
      if (!horse) return;
      const position = index + 1;
      horse.races = asNumber(horse.races) + 1;
      horse.total_finishing_position = asNumber(horse.total_finishing_position) + position;
      if (position === 1) horse.wins = asNumber(horse.wins) + 1;
      if (position === 2) horse.second_places = asNumber(horse.second_places) + 1;
      if (horse.owner_user_id == null) return;
      const wagered = raceBets.filter(bet => String(bet.horse_id) === String(horse.id))
        .reduce((sum, bet) => sum + asNumber(bet.stake), 0);
      const betShare = Math.round(wagered * asNumber(store.config?.ownerBetSharePercent) / 100);
      const winBonus = position === 1 ? Math.round(asNumber(store.config?.ownerWinBonus)) : 0;
      const amount = betShare + winBonus;
      if (amount <= 0) return;
      const id = asNumber(store.nextOwnerRewardId || 1);
      store.nextOwnerRewardId = id + 1;
      store.ownerRewards.push({
        id,
        race_id: Number(race.id),
        race_date: race.race_date,
        horse_id: horse.id,
        horse_name: horse.name,
        user_id: Number(horse.owner_user_id),
        finishing_position: position,
        wagered_on_horse: wagered,
        bet_share: betShare,
        win_bonus: winBonus,
        amount,
        claimed_at: null,
        claim_transaction_id: null,
        created_at: now.toISOString()
      });
    });
    race.stats_recorded_at = now.toISOString();
    race.owner_rewards_created_at = now.toISOString();
  }
  race.settled_at = now.toISOString();
  race.status = 'complete';
  race.updated_at = now.toISOString();
  if (persist) await saveHorseStore(client, store);
  return true;
}

export async function settleHorseRacePostgres(pool, raceId, now = new Date()) {
  return withTransaction(pool, async client => {
    const { settings, store } = await lockAndLoadHorseStore(client);
    const race = store.races.find(candidate => Number(candidate.id) === Number(raceId));
    if (!race) throw new Error('Horse race not found.');
    return settleHorseRaceWithClient(client, { store, settings, race, now });
  });
}

function createScheduledRace(store, dateKey, raceNumber, now) {
  const schedule = getHorseRaceSchedule(dateKey, raceNumber);
  const horseIds = shuffledHorseIds(store.horses).slice(0, HORSE_RACING_CONFIG.raceHorseCount);
  if (horseIds.length < HORSE_RACING_CONFIG.raceHorseCount) {
    throw new Error(`At least ${HORSE_RACING_CONFIG.raceHorseCount} horses are required to create a race.`);
  }
  const horses = new Map(store.horses.map(horse => [String(horse.id), horse]));
  const race = {
    id: asNumber(store.nextRaceId || 1),
    race_date: dateKey,
    race_number: Number(raceNumber),
    schedule_version: 2,
    time_zone: HORSE_RACING_CONFIG.timeZone,
    betting_opens_at: schedule.bettingOpensAt?.toISOString() || null,
    betting_closes_at: schedule.bettingClosesAt.toISOString(),
    race_starts_at: schedule.raceStartsAt.toISOString(),
    horse_names: horseIds.map(id => ({ id: horses.get(String(id)).id, name: horses.get(String(id)).name })),
    horse_image: HORSE_RACING_CONFIG.horseImage,
    status: 'upcoming',
    finishing_order: null,
    pace_seed: null,
    race_duration_seconds: null,
    result_generated_at: null,
    settled_at: null,
    debug_state: null,
    debug_race_starts_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
  store.nextRaceId = race.id + 1;
  store.races.push(race);
  return race;
}

function raceSchedule(race) {
  return {
    bettingOpensAt: race.betting_opens_at ? new Date(race.betting_opens_at) : null,
    bettingClosesAt: new Date(race.betting_closes_at),
    raceStartsAt: new Date(race.debug_race_starts_at || race.race_starts_at)
  };
}

function generateRaceResult(race, now) {
  if (Array.isArray(race.finishing_order) && race.finishing_order.length === race.horse_names.length) return false;
  race.finishing_order = shuffledHorseIds(race.horse_names);
  race.pace_seed = 1 + Math.floor(Math.random() * 2147483646);
  race.race_duration_seconds = randomHorseRaceDurationSeconds();
  race.result_generated_at = now.toISOString();
  race.updated_at = now.toISOString();
  return true;
}

function effectiveRaceStatus(race, now) {
  const schedule = raceSchedule(race);
  if (!race.debug_state) return getScheduledHorseRaceStatus(now, schedule, race.race_duration_seconds);
  if (race.debug_state === 'countdown' && now >= schedule.raceStartsAt) race.debug_state = 'racing';
  if (race.debug_state === 'racing' && race.race_duration_seconds != null &&
      now.getTime() >= schedule.raceStartsAt.getTime() + asNumber(race.race_duration_seconds) * 1000) {
    race.debug_state = 'complete';
  }
  return race.debug_state;
}

export async function processCurrentHorseRaceWithClient(client, now = new Date()) {
  const { settings, store } = await lockAndLoadHorseStore(client);
  const dateKey = getHorseRaceDateKey(now);
  const races = [];
  let changed = false;
  for (const raceTime of HORSE_RACING_CONFIG.raceTimes) {
    let race = store.races.find(candidate =>
      candidate.race_date === dateKey && Number(candidate.race_number || 3) === Number(raceTime.number)
    );
    if (!race) {
      race = createScheduledRace(store, dateKey, raceTime.number, now);
      changed = true;
    } else if (asNumber(race.schedule_version) < 2 && !race.settled_at) {
      const schedule = getHorseRaceSchedule(dateKey, raceTime.number);
      Object.assign(race, {
        race_number: Number(raceTime.number),
        schedule_version: 2,
        betting_opens_at: schedule.bettingOpensAt?.toISOString() || null,
        betting_closes_at: schedule.bettingClosesAt.toISOString(),
        race_starts_at: schedule.raceStartsAt.toISOString(),
        updated_at: now.toISOString()
      });
      changed = true;
    }
    races.push(race);
  }
  for (let index = 0; index < races.length; index += 1) {
    const race = races[index];
    const priorDebug = race.debug_state;
    const status = effectiveRaceStatus(race, now);
    if (priorDebug !== race.debug_state) changed = true;
    if (['countdown', 'racing', 'complete'].includes(status)) changed = generateRaceResult(race, now) || changed;
    if (race.status !== status) {
      race.status = status;
      race.updated_at = now.toISOString();
      changed = true;
    }
    if (status === 'complete') changed = await settleHorseRaceWithClient(client, {
      store, settings, race, now, persist: false
    }) || changed;
    const nextRace = races[index + 1];
    if (status === 'complete' && nextRace && !nextRace.betting_opens_at) {
      nextRace.betting_opens_at = race.settled_at || now.toISOString();
      nextRace.updated_at = now.toISOString();
      changed = true;
    }
  }
  if (changed) await saveHorseStore(client, store);
  return JSON.parse(JSON.stringify(races.find(race => race.status !== 'complete') || races.at(-1)));
}

export const processCurrentHorseRacePostgres = (pool, now = new Date()) =>
  withTransaction(pool, client => processCurrentHorseRaceWithClient(client, now));

function publicRaceResult(store, race, userId) {
  if (!race?.settled_at || !Array.isArray(race.finishing_order)) return null;
  const names = new Map((race.horse_names || []).map(horse => [String(horse.id), horse]));
  const bet = store.bets.find(item => Number(item.race_id) === Number(race.id) && Number(item.user_id) === Number(userId));
  return {
    id: Number(race.id), date: race.race_date, number: Number(race.race_number || 1),
    finishingOrder: race.finishing_order.map((horseId, index) => ({ position: index + 1, ...names.get(String(horseId)) })),
    userBet: publicBet(bet), settledAt: race.settled_at
  };
}

export async function getHorseRaceStateForUserWithClient(client, { userId, now = new Date() }) {
  const current = await processCurrentHorseRaceWithClient(client, now);
  const { settings, store } = await lockAndLoadHorseStore(client);
  const race = store.races.find(item => Number(item.id) === Number(current.id)) || current;
  const schedule = raceSchedule(race);
  const userBet = store.bets.find(item => Number(item.race_id) === Number(race.id) && Number(item.user_id) === Number(userId));
  const ownerRewards = store.ownerRewards.filter(reward => Number(reward.user_id) === Number(userId));
  const ownedHorses = store.horses.filter(horse => Number(horse.owner_user_id) === Number(userId))
    .map(horse => publicOwnedHorse(horse, ownerRewards)).sort((a, b) => a.name.localeCompare(b.name));
  const chat = syncHorseChat(store, now);
  if (chat.changed) await saveHorseStore(client, store);
  const cardRaces = store.races.filter(item => item.race_date === race.race_date)
    .sort((a, b) => Number(a.race_number) - Number(b.race_number));
  const pastResults = store.races.filter(item => item.settled_at && Array.isArray(item.finishing_order))
    .sort((a, b) => new Date(b.settled_at) - new Date(a.settled_at))
    .map(item => publicRaceResult(store, item, userId)).filter(Boolean);
  const previousResults = pastResults.filter(result => result.date === race.race_date && result.number < Number(race.race_number || 1))
    .sort((a, b) => a.number - b.number);
  const careers = new Map(store.horses.map(horse => [String(horse.id), publicOwnedHorse(horse)]));
  const names = new Map((race.horse_names || []).map(horse => [String(horse.id), horse]));
  const reveal = ['racing', 'complete'].includes(race.status);
  const finishingOrder = reveal && Array.isArray(race.finishing_order)
    ? race.finishing_order.map((horseId, index) => ({ position: index + 1, ...names.get(String(horseId)) }))
    : null;
  let nextTransitionAt = null;
  if (race.status === 'upcoming' && !race.debug_state) nextTransitionAt = race.betting_opens_at;
  if (race.status === 'betting' && !race.debug_state) nextTransitionAt = race.betting_closes_at;
  if (race.status === 'countdown') nextTransitionAt = schedule.raceStartsAt.toISOString();
  if (race.status === 'racing') nextTransitionAt = new Date(schedule.raceStartsAt.getTime() + asNumber(race.race_duration_seconds) * 1000).toISOString();
  const balanceRow = (await client.query('SELECT balance FROM users WHERE id=$1', [Number(userId)])).rows[0];
  if (!balanceRow) throw new Error('User not found.');
  const openWagered = asNumber((await client.query("SELECT COALESCE(sum(stake),0) AS value FROM bets WHERE user_id=$1 AND status='open'", [Number(userId)])).rows[0].value);
  const available = asNumber(balanceRow.balance);
  return {
    serverNow: now.toISOString(), isCasinoOpen: settings.casinoOpen !== false,
    race: {
      id: race.id, date: race.race_date, number: Number(race.race_number || 1), status: race.status,
      isDebug: Boolean(race.debug_state),
      horses: (race.horse_names || []).map(horse => {
        const career = careers.get(String(horse.id));
        return { ...horse, image: race.horse_image, career: { races: asNumber(career?.races), wins: asNumber(career?.wins), averageFinish: career?.averageFinish ?? null } };
      }),
      bettingOpensAt: race.betting_opens_at, bettingClosesAt: race.betting_closes_at,
      raceStartsAt: schedule.raceStartsAt.toISOString(), raceDurationSeconds: race.race_duration_seconds,
      nextTransitionAt, finishingOrder, paceSeed: asNumber(race.pace_seed || race.id),
      resultGeneratedAt: race.result_generated_at, settledAt: race.settled_at
    },
    card: {
      raceCount: HORSE_RACING_CONFIG.raceTimes.length, previousResults,
      races: cardRaces.map(item => ({ id: item.id, number: Number(item.race_number), status: item.status,
        bettingOpensAt: item.betting_opens_at, bettingClosesAt: item.betting_closes_at, raceStartsAt: item.race_starts_at }))
    },
    pastResults,
    config: {
      timeZone: HORSE_RACING_CONFIG.timeZone, maxBet: asNumber(store.config.maxBet), payouts: HORSE_RACING_CONFIG.payouts,
      countdownSeconds: HORSE_RACING_CONFIG.countdownSeconds, raceDurationMinSeconds: HORSE_RACING_CONFIG.raceDurationMinSeconds,
      raceDurationMaxSeconds: HORSE_RACING_CONFIG.raceDurationMaxSeconds, chatMaxLength: HORSE_RACING_CONFIG.chatMaxLength,
      chatPostRaceMinutes: HORSE_RACING_CONFIG.chatPostRaceMinutes
    },
    horseOwnership: {
      purchasePrice: asNumber(store.config.horsePurchasePrice), ownerBetSharePercent: asNumber(store.config.ownerBetSharePercent),
      ownerWinBonus: asNumber(store.config.ownerWinBonus), maxOwnedHorses: HORSE_RACING_CONFIG.maxOwnedHorses,
      nameMaxLength: HORSE_RACING_CONFIG.horseNameMaxLength, ownedHorses,
      pendingWinnings: ownedHorses.reduce((sum, horse) => sum + asNumber(horse.pendingWinnings), 0)
    },
    userBet: publicBet(userBet),
    balanceSummary: { available_balance: available, open_wagered: openWagered, total_balance: available + openWagered, display: `${available + openWagered} (${openWagered})` },
    chatOpen: chat.open, chatClosesAt: chat.closesAt?.toISOString() || null, chatResetAt: chat.resetAt.toISOString()
  };
}

export const getHorseRaceStateForUserPostgres = (pool, input) =>
  withTransaction(pool, client => getHorseRaceStateForUserWithClient(client, input));

function syncHorseChat(store, now) {
  const cardDate = getHorseRaceCardDateKey(now);
  let changed = false;
  store.chat ||= { cardDate: '', messages: [], nextMessageId: 1 };
  if (store.chat.cardDate !== cardDate) {
    store.chat.cardDate = cardDate;
    store.chat.messages = [];
    store.chat.nextMessageId = 1;
    changed = true;
  }
  const opensAt = getHorseRaceSchedule(cardDate, 1).bettingOpensAt;
  const cardExists = store.races.some(race => race.race_date === cardDate);
  const lastRace = store.races.find(race =>
    race.race_date === cardDate && Number(race.race_number) === HORSE_RACING_CONFIG.raceTimes.length
  );
  const closesAt = lastRace?.settled_at
    ? new Date(new Date(lastRace.settled_at).getTime() + HORSE_RACING_CONFIG.chatPostRaceMinutes * 60000)
    : null;
  const resetAt = getHorseRaceSchedule(nextDateKey(cardDate), 1).bettingOpensAt;
  return {
    changed,
    cardDate,
    opensAt,
    closesAt,
    resetAt,
    open: cardExists && now >= opensAt && (!closesAt || now < closesAt)
  };
}

export async function getHorseRaceChatStateWithClient(client, now = new Date()) {
  const { store } = await lockAndLoadHorseStore(client);
  const chat = syncHorseChat(store, now);
  if (chat.changed) await saveHorseStore(client, store);
  return {
    cardDate: chat.cardDate, open: chat.open,
    closesAt: chat.closesAt?.toISOString() || null, resetAt: chat.resetAt.toISOString(),
    messages: JSON.parse(JSON.stringify(store.chat?.messages || []))
  };
}

export const getHorseRaceChatStatePostgres = (pool, now = new Date()) =>
  withTransaction(pool, client => getHorseRaceChatStateWithClient(client, now));

export async function addHorseRaceChatMessageWithClient(client, {
  userId, username, message, now = new Date()
}) {
  await processCurrentHorseRaceWithClient(client, now);
  const { store } = await lockAndLoadHorseStore(client);
  const chat = syncHorseChat(store, now);
  if (!chat.open) throw new Error('Race chat is currently closed.');
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) throw new Error('Chat message is required.');
  if (cleanMessage.length > HORSE_RACING_CONFIG.chatMaxLength) {
    throw new Error(`Chat messages are limited to ${HORSE_RACING_CONFIG.chatMaxLength} characters.`);
  }
  const entry = {
    id: asNumber(store.chat.nextMessageId || 1),
    userId: Number(userId),
    username: String(username || `User ${userId}`),
    message: cleanMessage,
    createdAt: now.toISOString()
  };
  store.chat.nextMessageId = entry.id + 1;
  store.chat.messages.push(entry);
  await saveHorseStore(client, store);
  return { ...entry };
}

function revertHorseStatsAndRewards(store, race) {
  if (!race.stats_recorded_at) return;
  const horses = new Map(store.horses.map(horse => [String(horse.id), horse]));
  (race.finishing_order || []).forEach((horseId, index) => {
    const horse = horses.get(String(horseId));
    if (!horse) return;
    const position = index + 1;
    horse.races = Math.max(0, asNumber(horse.races) - 1);
    horse.total_finishing_position = Math.max(0, asNumber(horse.total_finishing_position) - position);
    if (position === 1) horse.wins = Math.max(0, asNumber(horse.wins) - 1);
    if (position === 2) horse.second_places = Math.max(0, asNumber(horse.second_places) - 1);
  });
  store.ownerRewards = store.ownerRewards.filter(reward => Number(reward.race_id) !== Number(race.id));
  race.stats_recorded_at = null;
  race.owner_rewards_created_at = null;
}

export async function controlCurrentHorseRaceWithClient(client, action, now = new Date()) {
  const current = await processCurrentHorseRaceWithClient(client, now);
  const { store } = await lockAndLoadHorseStore(client);
  const race = store.races.find(candidate => Number(candidate.id) === Number(current.id));
  if (!race) throw new Error('Horse race not found.');
  const command = String(action || '').toLowerCase();
  if (command === 'reset') {
    const transactions = await client.query(`
      SELECT id, user_id, amount FROM balance_transactions
      WHERE data->>'game'='horse_racing' AND data->>'race_id'=$1
      FOR UPDATE
    `, [String(race.id)]);
    const netByUser = new Map();
    for (const row of transactions.rows) {
      netByUser.set(Number(row.user_id), asNumber(netByUser.get(Number(row.user_id))) + asNumber(row.amount));
    }
    for (const [userId, net] of [...netByUser].sort((a, b) => a[0] - b[0])) {
      const user = await lockUser(client, userId);
      await changeLockedUserBalance(client, user, -net, { allowNegative: true });
    }
    if (transactions.rows.length) {
      await client.query('DELETE FROM balance_transactions WHERE id=ANY($1::bigint[])', [transactions.rows.map(row => row.id)]);
    }
    store.bets = store.bets.filter(bet => Number(bet.race_id) !== Number(race.id));
    revertHorseStatsAndRewards(store, race);
    Object.assign(race, {
      finishing_order: null,
      pace_seed: null,
      race_duration_seconds: null,
      result_generated_at: null,
      settled_at: null,
      debug_state: 'upcoming',
      debug_race_starts_at: null,
      status: 'upcoming'
    });
  } else {
    if (race.settled_at) throw new Error('Reset the completed race before running another debug command.');
    if (command === 'open') {
      race.debug_state = 'betting';
      race.debug_race_starts_at = null;
      race.status = 'betting';
    } else if (command === 'close') {
      generateRaceResult(race, now);
      race.debug_state = 'countdown';
      race.debug_race_starts_at = new Date(now.getTime() + HORSE_RACING_CONFIG.countdownSeconds * 1000).toISOString();
      race.status = 'countdown';
    } else if (command === 'start') {
      generateRaceResult(race, now);
      race.debug_state = 'racing';
      race.debug_race_starts_at = now.toISOString();
      race.status = 'racing';
    } else {
      throw new Error('Unknown horse race debug command.');
    }
  }
  race.updated_at = now.toISOString();
  await saveHorseStore(client, store);
  return { action: command, raceId: race.id, status: race.status };
}

export const addHorseRaceChatMessagePostgres = (pool, input) =>
  withTransaction(pool, client => addHorseRaceChatMessageWithClient(client, input));
export const controlCurrentHorseRacePostgres = (pool, action, now = new Date()) =>
  withTransaction(pool, client => controlCurrentHorseRaceWithClient(client, action, now));

export async function saveHorseRacingConfigWithClient(client, input) {
  const { store } = await lockAndLoadHorseStore(client);
  const cleanWhole = (value, label, allowZero = false) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} whole number.`);
    return parsed;
  };
  const share = Number(input.ownerBetSharePercent);
  if (!Number.isFinite(share) || share < 0 || share > 100) throw new Error('Horse owner bet cut must be between 0% and 100%.');
  store.config = {
    maxBet: cleanWhole(input.maxBet, 'Horse racing max bet'),
    horsePurchasePrice: cleanWhole(input.horsePurchasePrice, 'Horse purchase price'),
    ownerBetSharePercent: Number(share.toFixed(2)),
    ownerWinBonus: cleanWhole(input.ownerWinBonus, 'Horse win bonus', true)
  };
  await saveHorseStore(client, store);
  return JSON.parse(JSON.stringify(store.config));
}

export const buyHorsePostgres = (pool, input) => withTransaction(pool, client => buyHorseWithClient(client, input));
export const placeOrUpdateHorseRaceBetPostgres = (pool, input) => withTransaction(pool, client => placeOrUpdateHorseRaceBetWithClient(client, input));
export const claimHorseOwnerWinningsPostgres = (pool, input) => withTransaction(pool, client => claimHorseOwnerWinningsWithClient(client, input));
export const saveHorseRacingConfigPostgres = (pool, input) => withTransaction(pool, client => saveHorseRacingConfigWithClient(client, input));

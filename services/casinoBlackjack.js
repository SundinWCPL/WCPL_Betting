export const BLACKJACK_ALLOWED_WAGERS = Object.freeze([25, 50, 75, 100]);

export const BLACKJACK_CONFIG = Object.freeze({
  seatCount: 5,
  deckCount: 6,
  bettingSeconds: 20,
  actionSeconds: 20,
  resultSeconds: 6,
  heartbeatMs: 20_000,
  chatMaxLength: 240,
  chatMessageLimit: 60,
  handLogLimit: 20,
  recentHandLimit: 12
});

const SUITS = Object.freeze(['S', 'H', 'D', 'C']);
const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
const FACE_RANKS = new Set(['J', 'Q', 'K']);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asNumber = value => Number(value || 0);
const iso = value => value instanceof Date ? value.toISOString() : new Date(value || Date.now()).toISOString();
const ms = value => new Date(value || 0).getTime();

export function createBlackjackTable() {
  return {
    phase: 'waiting',
    phaseDeadline: null,
    currentSeatIndex: null,
    currentHandIndex: null,
    currentHandId: null,
    nextHandId: 1,
    nextMessageId: 1,
    dealer: { cards: [], holeRevealed: false },
    shoe: [],
    seats: Array.from({ length: BLACKJACK_CONFIG.seatCount }, (_, index) => emptySeat(index)),
    handLog: [],
    recentHands: [],
    chat: [],
    totals: { wagered: 0, paid: 0, hands: 0 },
    updatedAt: null
  };
}

export function ensureBlackjackTable(raw = {}) {
  const table = { ...createBlackjackTable(), ...(raw || {}) };
  table.seats = Array.from({ length: BLACKJACK_CONFIG.seatCount }, (_, index) => ({
    ...emptySeat(index),
    ...(Array.isArray(table.seats) ? table.seats[index] || {} : {}),
    index
  }));
  for (const seat of table.seats) {
    seat.userId = seat.userId == null ? null : Number(seat.userId);
    seat.hands = Array.isArray(seat.hands) ? seat.hands : [];
    seat.missedBetCount = asNumber(seat.missedBetCount);
    seat.missedActionCount = asNumber(seat.missedActionCount);
  }
  table.dealer = { cards: [], holeRevealed: false, ...(table.dealer || {}) };
  table.dealer.cards = Array.isArray(table.dealer.cards) ? table.dealer.cards : [];
  table.shoe = Array.isArray(table.shoe) ? table.shoe : [];
  table.handLog = Array.isArray(table.handLog) ? table.handLog.slice(-BLACKJACK_CONFIG.handLogLimit) : [];
  table.recentHands = Array.isArray(table.recentHands) ? table.recentHands.slice(-BLACKJACK_CONFIG.recentHandLimit) : [];
  table.chat = Array.isArray(table.chat) ? table.chat.slice(-BLACKJACK_CONFIG.chatMessageLimit) : [];
  table.totals = { wagered: 0, paid: 0, hands: 0, ...(table.totals || {}) };
  table.nextHandId = Math.max(1, asNumber(table.nextHandId || 1));
  table.nextMessageId = Math.max(1, asNumber(table.nextMessageId || 1), ...table.chat.map(message => asNumber(message.id) + 1));
  return table;
}

function emptySeat(index) {
  return {
    index,
    userId: null,
    displayName: '',
    status: 'empty',
    joinedAt: null,
    lastHeartbeatAt: null,
    missedBetCount: 0,
    missedActionCount: 0,
    leaveAfterHand: false,
    hands: []
  };
}

function resetSeat(seat) {
  const index = seat.index;
  Object.assign(seat, emptySeat(index));
}

function occupiedSeats(table) {
  return table.seats.filter(seat => seat.userId != null);
}

function activeSeats(table) {
  return table.seats.filter(seat => seat.userId != null && seat.hands.some(hand => hand.status !== 'settled'));
}

function addSeconds(now, seconds) {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function touch(table, now) {
  table.updatedAt = now.toISOString();
}

function appendLog(table, message, now) {
  table.handLog.push({ message, createdAt: now.toISOString() });
  table.handLog = table.handLog.slice(-BLACKJACK_CONFIG.handLogLimit);
}

function buildShoe(random = Math.random) {
  const cards = [];
  for (let deck = 0; deck < BLACKJACK_CONFIG.deckCount; deck += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) cards.push({ rank, suit });
    }
  }
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [cards[index], cards[swap]] = [cards[swap], cards[index]];
  }
  return cards;
}

function draw(table, random) {
  if (!Array.isArray(table.shoe) || table.shoe.length === 0) table.shoe = buildShoe(random);
  return table.shoe.pop();
}

export function handValue(cards = []) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 'A') {
      total += 11;
      aces += 1;
    } else if (FACE_RANKS.has(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank || 0);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0, bust: total > 21 };
}

function isNaturalBlackjack(hand) {
  return !hand.isSplit && hand.cards.length === 2 && handValue(hand.cards).total === 21;
}

function canSplitHand(hand) {
  return Boolean(
    hand &&
    !hand.isSplit &&
    !hand.doubled &&
    hand.cards.length === 2 &&
    hand.cards[0]?.rank === hand.cards[1]?.rank
  );
}

function canDoubleHand(hand) {
  return Boolean(
    hand &&
    !hand.isSplit &&
    !hand.doubled &&
    hand.cards.length === 2 &&
    hand.status === 'active'
  );
}

function currentSeat(table) {
  return table.seats.find(seat => Number(seat.index) === Number(table.currentSeatIndex));
}

function currentHand(table) {
  const seat = currentSeat(table);
  return seat?.hands?.[Number(table.currentHandIndex || 0)] || null;
}

function nextPlayableHand(table, fromSeatIndex = 0, fromHandIndex = 0) {
  for (let seatIndex = fromSeatIndex; seatIndex < table.seats.length; seatIndex += 1) {
    const seat = table.seats[seatIndex];
    if (seat.userId == null) continue;
    const handStart = seatIndex === fromSeatIndex ? fromHandIndex : 0;
    for (let handIndex = handStart; handIndex < seat.hands.length; handIndex += 1) {
      const hand = seat.hands[handIndex];
      if (hand && hand.status === 'active') return { seatIndex, handIndex };
    }
  }
  return null;
}

function moveToNextTurn(table, now, { fromNextHand = false } = {}, transactions = []) {
  const startSeat = table.currentSeatIndex == null ? 0 : Number(table.currentSeatIndex);
  const startHand = table.currentHandIndex == null ? 0 : Number(table.currentHandIndex) + (fromNextHand ? 1 : 0);
  const next = nextPlayableHand(table, startSeat, startHand);
  if (next) {
    table.phase = 'player_turn';
    table.currentSeatIndex = next.seatIndex;
    table.currentHandIndex = next.handIndex;
    table.phaseDeadline = addSeconds(now, BLACKJACK_CONFIG.actionSeconds);
    return;
  }
  finishDealerAndSettle(table, now, transactions);
}

function createHand(bet, cards, extra = {}) {
  return {
    bet: asNumber(bet),
    cards,
    status: 'active',
    doubled: false,
    isSplit: false,
    splitAces: false,
    result: null,
    payout: 0,
    ...extra
  };
}

function startBetting(table, now) {
  table.phase = 'betting';
  table.phaseDeadline = addSeconds(now, BLACKJACK_CONFIG.bettingSeconds);
  table.currentSeatIndex = null;
  table.currentHandIndex = null;
  table.currentHandId = null;
  table.dealer = { cards: [], holeRevealed: false };
  for (const seat of occupiedSeats(table)) {
    seat.status = 'betting';
    seat.hands = [];
    seat.leaveAfterHand = false;
  }
  appendLog(table, 'Betting is open.', now);
  touch(table, now);
}

function clearRound(table, now) {
  table.dealer = { cards: [], holeRevealed: false };
  table.currentSeatIndex = null;
  table.currentHandIndex = null;
  table.currentHandId = null;
  table.phaseDeadline = null;
  for (const seat of [...table.seats]) {
    if (seat.userId == null) continue;
    seat.hands = [];
    if (seat.leaveAfterHand) resetSeat(seat);
    else seat.status = 'waiting';
  }
  if (occupiedSeats(table).length) startBetting(table, now);
  else {
    table.phase = 'waiting';
    appendLog(table, 'Table is waiting for players.', now);
  }
  touch(table, now);
}

function startHand(table, now, random, transactions = []) {
  const bettors = table.seats.filter(seat => seat.userId != null && seat.hands.length === 1);
  if (!bettors.length) {
    table.phase = 'waiting';
    table.phaseDeadline = null;
    appendLog(table, 'No bets placed. Table is waiting.', now);
    return;
  }
  table.currentHandId = table.nextHandId++;
  table.dealer = { cards: [], holeRevealed: false };
  table.totals.hands = asNumber(table.totals.hands) + 1;
  for (const seat of bettors) seat.status = 'playing';

  for (let round = 0; round < 2; round += 1) {
    for (const seat of bettors) seat.hands[0].cards.push(draw(table, random));
    table.dealer.cards.push(draw(table, random));
  }

  for (const seat of bettors) {
    const hand = seat.hands[0];
    if (isNaturalBlackjack(hand)) hand.status = 'standing';
  }

  appendLog(table, `Hand #${table.currentHandId} dealt.`, now);
  const next = nextPlayableHand(table, 0, 0);
  if (next) {
    table.phase = 'player_turn';
    table.currentSeatIndex = next.seatIndex;
    table.currentHandIndex = next.handIndex;
    table.phaseDeadline = addSeconds(now, BLACKJACK_CONFIG.actionSeconds);
  } else {
    finishDealerAndSettle(table, now, transactions);
  }
}

function dealerShouldDraw(cards) {
  const value = handValue(cards);
  return value.total < 17;
}

function settleOneHand(hand, dealerValue) {
  const value = handValue(hand.cards);
  if (value.bust) return { result: 'loss', payout: 0 };
  if (isNaturalBlackjack(hand)) {
    if (dealerValue.total === 21 && dealerValue.cardCount === 2) return { result: 'push', payout: hand.bet };
    return { result: 'blackjack', payout: Math.round(hand.bet * 2.5) };
  }
  if (dealerValue.bust) return { result: 'win', payout: hand.bet * 2 };
  if (value.total > dealerValue.total) return { result: 'win', payout: hand.bet * 2 };
  if (value.total === dealerValue.total) return { result: 'push', payout: hand.bet };
  return { result: 'loss', payout: 0 };
}

function finishDealerAndSettle(table, now, transactions = []) {
  table.phase = 'settling';
  table.dealer.holeRevealed = true;
  const liveHands = activeSeats(table).flatMap(seat => seat.hands).filter(hand => !handValue(hand.cards).bust);
  if (liveHands.length) {
    while (dealerShouldDraw(table.dealer.cards)) table.dealer.cards.push(draw(table, Math.random));
  }
  const dealerValue = { ...handValue(table.dealer.cards), cardCount: table.dealer.cards.length };
  const summary = [];

  for (const seat of activeSeats(table)) {
    let seatPaid = 0;
    for (const hand of seat.hands) {
      const settled = settleOneHand(hand, dealerValue);
      hand.status = 'settled';
      hand.result = settled.result;
      hand.payout = settled.payout;
      seatPaid += settled.payout;
      if (settled.payout > 0) {
        transactions.push({
          userId: seat.userId,
          amount: settled.payout,
          kind: settled.result === 'blackjack' ? 'casino_blackjack_natural_payout' : 'casino_blackjack_payout',
          note: `Blackjack ${settled.result}: ${settled.payout}`,
          game: 'blackjack',
          blackjackHandId: table.currentHandId
        });
      }
    }
    summary.push({ userId: seat.userId, displayName: seat.displayName, paid: seatPaid });
    seat.status = 'settled';
  }

  const totalPaid = transactions.reduce((sum, tx) => sum + asNumber(tx.amount), 0);
  table.totals.paid = asNumber(table.totals.paid) + totalPaid;
  table.recentHands.push({
    id: table.currentHandId,
    dealerCards: clone(table.dealer.cards),
    dealerTotal: dealerValue.total,
    seats: table.seats
      .filter(seat => seat.hands.length)
      .map(seat => ({
        seatIndex: seat.index,
        displayName: seat.displayName,
        hands: seat.hands.map(hand => ({
          cards: clone(hand.cards),
          total: handValue(hand.cards).total,
          bet: hand.bet,
          result: hand.result,
          payout: hand.payout
        }))
      })),
    createdAt: now.toISOString()
  });
  table.recentHands = table.recentHands.slice(-BLACKJACK_CONFIG.recentHandLimit);
  appendLog(table, `Dealer ${dealerValue.bust ? 'busted' : `stood on ${dealerValue.total}`}. ${summary.length} seat(s) settled.`, now);
  table.phase = 'result';
  table.phaseDeadline = addSeconds(now, BLACKJACK_CONFIG.resultSeconds);
  table.currentSeatIndex = null;
  table.currentHandIndex = null;
  touch(table, now);
  return transactions;
}

function removeDisconnectedSeats(table, now) {
  if (table.phase === 'waiting' || table.phase === 'betting' || table.phase === 'result') {
    for (const seat of table.seats) {
      if (seat.userId == null || !seat.lastHeartbeatAt) continue;
      if (now.getTime() - ms(seat.lastHeartbeatAt) > BLACKJACK_CONFIG.heartbeatMs) {
        appendLog(table, `${seat.displayName || `Seat ${seat.index + 1}`} left the table.`, now);
        resetSeat(seat);
      }
    }
    return;
  }
  for (const seat of activeSeats(table)) {
    if (!seat.lastHeartbeatAt) continue;
    if (now.getTime() - ms(seat.lastHeartbeatAt) > BLACKJACK_CONFIG.heartbeatMs) seat.leaveAfterHand = true;
  }
}

export function processBlackjackTable(rawTable, { now = new Date(), random = Math.random } = {}) {
  const table = ensureBlackjackTable(rawTable);
  const transactions = [];
  removeDisconnectedSeats(table, now);

  if (table.phase === 'waiting' && occupiedSeats(table).length) {
    startBetting(table, now);
  }

  if (table.phaseDeadline && now.getTime() >= ms(table.phaseDeadline)) {
    if (table.phase === 'betting') {
      for (const seat of occupiedSeats(table)) {
        if (seat.hands.length) continue;
        appendLog(table, `${seat.displayName || `Seat ${seat.index + 1}`} missed betting and left the seat.`, now);
        resetSeat(seat);
      }
      startHand(table, now, random, transactions);
    } else if (table.phase === 'player_turn') {
      const seat = currentSeat(table);
      const hand = currentHand(table);
      if (seat && hand) {
        hand.status = 'standing';
        seat.missedActionCount = asNumber(seat.missedActionCount) + 1;
        seat.leaveAfterHand = true;
        appendLog(table, `${seat.displayName} timed out and stood.`, now);
        moveToNextTurn(table, now, { fromNextHand: true }, transactions);
      }
    } else if (table.phase === 'result') {
      clearRound(table, now);
    }
  }

  return { table, transactions };
}

function placeBetOnTable(table, { userId, wager, now = new Date(), random = Math.random }) {
  if (table.phase !== 'betting') throw new Error('Betting is not open right now.');
  if (!BLACKJACK_ALLOWED_WAGERS.includes(Number(wager))) throw new Error('Choose a valid blackjack bet.');
  const seat = table.seats.find(candidate => Number(candidate.userId) === Number(userId));
  if (!seat) throw new Error('Take a seat before betting.');
  if (seat.hands.length) throw new Error('You already have a bet down for this hand.');

  seat.hands = [createHand(wager, [])];
  seat.status = 'ready';
  seat.missedBetCount = 0;
  seat.lastHeartbeatAt = now.toISOString();
  table.totals.wagered = asNumber(table.totals.wagered) + Number(wager);
  appendLog(table, `${seat.displayName} bet ${wager}.`, now);

  const transactions = [{
    userId,
    amount: -Number(wager),
    kind: 'casino_blackjack_wager',
    note: `Blackjack wager: ${wager}`,
    game: 'blackjack',
    blackjackHandId: table.currentHandId || table.nextHandId
  }];
  const everyoneActed = occupiedSeats(table).every(candidate => candidate.hands.length > 0);
  if (everyoneActed) startHand(table, now, random, transactions);
  touch(table, now);
  return transactions;
}

export function sitBlackjackSeat(rawTable, { userId, displayName, seatIndex, now = new Date() }) {
  const table = ensureBlackjackTable(rawTable);
  if (table.seats.some(seat => Number(seat.userId) === Number(userId))) throw new Error('You are already seated at this table.');
  const seat = table.seats[Number(seatIndex)];
  if (!seat) throw new Error('Choose a valid seat.');
  if (seat.userId != null) throw new Error('That seat is already taken.');
  Object.assign(seat, {
    ...emptySeat(Number(seatIndex)),
    userId: Number(userId),
    displayName: String(displayName || `User ${userId}`),
    status: table.phase === 'betting' ? 'betting' : 'waiting',
    joinedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString()
  });
  appendLog(table, `${seat.displayName} sat down in seat ${seat.index + 1}.`, now);
  if (table.phase === 'waiting') startBetting(table, now);
  touch(table, now);
  return { table, transactions: [] };
}

export function leaveBlackjackSeat(rawTable, { userId, now = new Date() }) {
  const table = ensureBlackjackTable(rawTable);
  const seat = table.seats.find(candidate => Number(candidate.userId) === Number(userId));
  if (!seat) return { table, transactions: [] };
  if (seat.hands.some(hand => hand.status !== 'settled') && ['player_turn', 'settling'].includes(table.phase)) {
    seat.leaveAfterHand = true;
    appendLog(table, `${seat.displayName} will leave after the hand.`, now);
  } else {
    appendLog(table, `${seat.displayName} left the table.`, now);
    resetSeat(seat);
  }
  touch(table, now);
  return { table, transactions: [] };
}

export function heartbeatBlackjackSeat(rawTable, { userId, now = new Date() }) {
  const table = ensureBlackjackTable(rawTable);
  const seat = table.seats.find(candidate => Number(candidate.userId) === Number(userId));
  if (seat) seat.lastHeartbeatAt = now.toISOString();
  touch(table, now);
  return { table, transactions: [] };
}

export function betBlackjack(rawTable, input) {
  const table = ensureBlackjackTable(rawTable);
  return { table, transactions: placeBetOnTable(table, input) };
}

export function blackjackRequiredDebit(rawTable, { userId, action, wager }) {
  const table = ensureBlackjackTable(rawTable);
  if (action === 'bet') return Number(wager || 0);
  if (!['double', 'split'].includes(action)) return 0;
  const hand = currentHand(table);
  const seat = currentSeat(table);
  if (!seat || !hand || Number(seat.userId) !== Number(userId)) return 0;
  return Number(hand.bet || 0);
}

export function actBlackjack(rawTable, { userId, action, now = new Date(), random = Math.random }) {
  const table = ensureBlackjackTable(rawTable);
  if (table.phase !== 'player_turn') throw new Error('It is not a player action phase.');
  const seat = currentSeat(table);
  const hand = currentHand(table);
  if (!seat || !hand || Number(seat.userId) !== Number(userId)) throw new Error('It is not your turn.');
  if (hand.status !== 'active') throw new Error('That hand is not active.');

  const cleanAction = String(action || '').toLowerCase();
  const transactions = [];
  if (cleanAction === 'hit') {
    hand.cards.push(draw(table, random));
    const value = handValue(hand.cards);
    if (value.bust) hand.status = 'busted';
    else if (value.total === 21) hand.status = 'standing';
    appendLog(table, `${seat.displayName} hit${hand.status === 'busted' ? ' and busted' : ''}.`, now);
    if (hand.status !== 'active') moveToNextTurn(table, now, { fromNextHand: true }, transactions);
    else table.phaseDeadline = addSeconds(now, BLACKJACK_CONFIG.actionSeconds);
  } else if (cleanAction === 'stand') {
    hand.status = 'standing';
    appendLog(table, `${seat.displayName} stood on ${handValue(hand.cards).total}.`, now);
    moveToNextTurn(table, now, { fromNextHand: true }, transactions);
  } else if (cleanAction === 'double') {
    if (!canDoubleHand(hand)) throw new Error('Double is only available on your first two cards before a split.');
    transactions.push({
      userId,
      amount: -hand.bet,
      kind: 'casino_blackjack_double',
      note: `Blackjack double: ${hand.bet}`,
      game: 'blackjack',
      blackjackHandId: table.currentHandId
    });
    table.totals.wagered = asNumber(table.totals.wagered) + hand.bet;
    hand.bet *= 2;
    hand.doubled = true;
    hand.cards.push(draw(table, random));
    hand.status = handValue(hand.cards).bust ? 'busted' : 'standing';
    appendLog(table, `${seat.displayName} doubled.`, now);
    moveToNextTurn(table, now, { fromNextHand: true }, transactions);
  } else if (cleanAction === 'split') {
    if (!canSplitHand(hand)) throw new Error('Split is only available on a same-rank first pair.');
    transactions.push({
      userId,
      amount: -hand.bet,
      kind: 'casino_blackjack_split',
      note: `Blackjack split: ${hand.bet}`,
      game: 'blackjack',
      blackjackHandId: table.currentHandId
    });
    table.totals.wagered = asNumber(table.totals.wagered) + hand.bet;
    const [first, second] = hand.cards;
    const splitAces = first.rank === 'A';
    const firstHand = createHand(hand.bet, [first, draw(table, random)], { isSplit: true, splitAces });
    const secondHand = createHand(hand.bet, [second, draw(table, random)], { isSplit: true, splitAces });
    if (splitAces) {
      firstHand.status = 'standing';
      secondHand.status = 'standing';
    }
    seat.hands.splice(Number(table.currentHandIndex), 1, firstHand, secondHand);
    appendLog(table, `${seat.displayName} split ${first.rank}s.`, now);
    if (splitAces) moveToNextTurn(table, now, { fromNextHand: true }, transactions);
    else {
      table.phaseDeadline = addSeconds(now, BLACKJACK_CONFIG.actionSeconds);
    }
  } else {
    throw new Error('Choose hit, stand, double, or split.');
  }
  touch(table, now);
  return { table, transactions };
}

export function addBlackjackChat(rawTable, { userId, username, message, now = new Date() }) {
  const table = ensureBlackjackTable(rawTable);
  const clean = String(message || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!clean) throw new Error('Enter a message first.');
  if (clean.length > BLACKJACK_CONFIG.chatMaxLength) throw new Error(`Messages are limited to ${BLACKJACK_CONFIG.chatMaxLength} characters.`);
  const entry = {
    id: table.nextMessageId++,
    userId: Number(userId),
    username: String(username || `User ${userId}`),
    message: clean,
    createdAt: now.toISOString()
  };
  table.chat.push(entry);
  table.chat = table.chat.slice(-BLACKJACK_CONFIG.chatMessageLimit);
  touch(table, now);
  return { table, transactions: [], message: entry };
}

export function publicBlackjackState(rawTable, {
  userId = null,
  balanceSummary = null,
  isCasinoOpen = true,
  now = new Date()
} = {}) {
  const table = ensureBlackjackTable(rawTable);
  const userSeat = table.seats.find(seat => Number(seat.userId) === Number(userId)) || null;
  const hand = currentHand(table);
  const currentActions = userSeat && Number(userSeat.index) === Number(table.currentSeatIndex) && hand?.status === 'active'
    ? {
        hit: true,
        stand: true,
        double: canDoubleHand(hand),
        split: canSplitHand(hand)
      }
    : { hit: false, stand: false, double: false, split: false };
  const showDealerHole = table.dealer.holeRevealed || ['settling', 'result'].includes(table.phase);
  return {
    isCasinoOpen: Boolean(isCasinoOpen),
    serverNow: now.toISOString(),
    config: {
      ...BLACKJACK_CONFIG,
      allowedWagers: [...BLACKJACK_ALLOWED_WAGERS],
      houseRules: [
        'Dealer stands on soft 17.',
        'Blackjack pays 3:2.',
        'Double is only available on the first two cards.',
        'Split is only available on a same-rank first pair.',
        'No re-splitting or double-after-split.',
        'Split aces receive one card each and stand.',
        'A 21 after splitting is paid as a normal 21, not a natural blackjack.'
      ]
    },
    phase: table.phase,
    phaseDeadline: table.phaseDeadline,
    currentSeatIndex: table.currentSeatIndex,
    currentHandIndex: table.currentHandIndex,
    dealer: {
      cards: table.dealer.cards.map((card, index) => index === 1 && !showDealerHole ? { hidden: true } : card),
      total: showDealerHole ? handValue(table.dealer.cards).total : null
    },
    seats: table.seats.map(seat => ({
      index: seat.index,
      userId: seat.userId,
      displayName: seat.displayName,
      status: seat.status,
      isCurrentTurn: Number(seat.index) === Number(table.currentSeatIndex),
      isUser: Number(seat.userId) === Number(userId),
      leaveAfterHand: Boolean(seat.leaveAfterHand),
      hands: seat.hands.map(item => ({
        bet: item.bet,
        cards: item.cards,
        total: handValue(item.cards).total,
        soft: handValue(item.cards).soft,
        status: item.status,
        doubled: Boolean(item.doubled),
        isSplit: Boolean(item.isSplit),
        splitAces: Boolean(item.splitAces),
        result: item.result,
        payout: item.payout
      }))
    })),
    userSeatIndex: userSeat?.index ?? null,
    currentActions,
    handLog: clone(table.handLog),
    recentHands: clone(table.recentHands),
    chat: clone(table.chat),
    totals: clone(table.totals),
    balanceSummary
  };
}

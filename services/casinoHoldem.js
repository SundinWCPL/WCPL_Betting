export const HOLDEM_CONFIG = Object.freeze({
  seatCount: 6,
  buyIn: 250,
  smallBlind: 5,
  bigBlind: 10,
  actionSeconds: 30,
  resultSeconds: 28,
  heartbeatMs: 20_000,
  chatMaxLength: 240,
  chatMessageLimit: 60,
  handLogLimit: 24,
  recentHandLimit: 12
});

const SUITS = Object.freeze(['S', 'H', 'D', 'C']);
const RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']);
const RANK_VALUE = Object.freeze({ '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14 });
const CATEGORY_LABELS = Object.freeze([
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush'
]);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asNumber = value => Number(value || 0);
const ms = value => new Date(value || 0).getTime();

function addSeconds(now, seconds) {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function cardCode(card) {
  return card && !card.hidden ? `${card.rank}${card.suit}` : 'BACK';
}

function emptySeat(index) {
  return {
    index,
    userId: null,
    displayName: '',
    status: 'empty',
    stack: 0,
    holeCards: [],
    currentBet: 0,
    committed: 0,
    acted: false,
    joinedAt: null,
    lastHeartbeatAt: null,
    leaveAfterHand: false,
    missedActionCount: 0
  };
}

function resetSeat(seat) {
  const index = seat.index;
  Object.assign(seat, emptySeat(index));
}

export function createHoldemTable() {
  return {
    phase: 'waiting',
    street: 'waiting',
    phaseDeadline: null,
    currentHandId: null,
    nextHandId: 1,
    nextMessageId: 1,
    buttonIndex: null,
    smallBlindIndex: null,
    bigBlindIndex: null,
    currentSeatIndex: null,
    currentBet: 0,
    lastRaise: HOLDEM_CONFIG.bigBlind,
    deck: [],
    board: [],
    pots: [],
    showdown: null,
    seats: Array.from({ length: HOLDEM_CONFIG.seatCount }, (_, index) => emptySeat(index)),
    handLog: [],
    recentHands: [],
    chat: [],
    totals: { buyIns: 0, cashOuts: 0, hands: 0 },
    updatedAt: null
  };
}

export function ensureHoldemTable(raw = {}) {
  const table = { ...createHoldemTable(), ...(raw || {}) };
  table.seats = Array.from({ length: HOLDEM_CONFIG.seatCount }, (_, index) => ({
    ...emptySeat(index),
    ...(Array.isArray(table.seats) ? table.seats[index] || {} : {}),
    index
  }));
  for (const seat of table.seats) {
    seat.userId = seat.userId == null ? null : Number(seat.userId);
    seat.stack = Math.max(0, asNumber(seat.stack));
    seat.currentBet = Math.max(0, asNumber(seat.currentBet));
    seat.committed = Math.max(0, asNumber(seat.committed));
    seat.holeCards = Array.isArray(seat.holeCards) ? seat.holeCards : [];
    seat.acted = Boolean(seat.acted);
    seat.leaveAfterHand = Boolean(seat.leaveAfterHand);
    seat.missedActionCount = asNumber(seat.missedActionCount);
  }
  table.deck = Array.isArray(table.deck) ? table.deck : [];
  table.board = Array.isArray(table.board) ? table.board : [];
  table.pots = Array.isArray(table.pots) ? table.pots : [];
  table.handLog = Array.isArray(table.handLog) ? table.handLog.slice(-HOLDEM_CONFIG.handLogLimit) : [];
  table.recentHands = Array.isArray(table.recentHands) ? table.recentHands.slice(-HOLDEM_CONFIG.recentHandLimit) : [];
  table.chat = Array.isArray(table.chat) ? table.chat.slice(-HOLDEM_CONFIG.chatMessageLimit) : [];
  table.totals = { buyIns: 0, cashOuts: 0, hands: 0, ...(table.totals || {}) };
  table.currentBet = Math.max(0, asNumber(table.currentBet));
  table.lastRaise = Math.max(HOLDEM_CONFIG.bigBlind, asNumber(table.lastRaise || HOLDEM_CONFIG.bigBlind));
  table.nextHandId = Math.max(1, asNumber(table.nextHandId || 1));
  table.nextMessageId = Math.max(1, asNumber(table.nextMessageId || 1), ...table.chat.map(message => asNumber(message.id) + 1));
  return table;
}

function touch(table, now) {
  table.updatedAt = now.toISOString();
}

function appendLog(table, message, now) {
  table.handLog.push({ message, createdAt: now.toISOString() });
  table.handLog = table.handLog.slice(-HOLDEM_CONFIG.handLogLimit);
}

function occupiedSeats(table) {
  return table.seats.filter(seat => seat.userId != null);
}

function seatedWithStack(table) {
  return table.seats.filter(seat => seat.userId != null && seat.stack > 0);
}

function handSeats(table) {
  return table.seats.filter(seat => ['playing', 'folded', 'all_in', 'showdown'].includes(seat.status) || seat.committed > 0 || seat.holeCards.length);
}

function liveSeats(table) {
  return table.seats.filter(seat => ['playing', 'all_in', 'showdown'].includes(seat.status));
}

function actionableSeats(table) {
  return table.seats.filter(seat => seat.status === 'playing' && seat.stack > 0);
}

function nextOccupiedIndex(table, fromIndex, predicate = seat => seat.userId != null && seat.stack > 0) {
  for (let offset = 1; offset <= table.seats.length; offset += 1) {
    const index = ((Number(fromIndex ?? -1) + offset) + table.seats.length) % table.seats.length;
    if (predicate(table.seats[index])) return index;
  }
  return null;
}

function orderedHandSeats(table, fromIndex = table.buttonIndex) {
  const rows = [];
  for (let offset = 1; offset <= table.seats.length; offset += 1) {
    const index = ((Number(fromIndex ?? -1) + offset) + table.seats.length) % table.seats.length;
    const seat = table.seats[index];
    if (seat.userId != null && (seat.holeCards.length || seat.committed > 0)) rows.push(seat);
  }
  return rows;
}

function buildDeck(random = Math.random) {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) cards.push({ rank, suit });
  }
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [cards[index], cards[swap]] = [cards[swap], cards[index]];
  }
  return cards;
}

function draw(table) {
  if (!Array.isArray(table.deck) || table.deck.length === 0) table.deck = buildDeck();
  return table.deck.pop();
}

function commitChips(seat, amount) {
  const cleanAmount = Math.max(0, Math.min(asNumber(amount), asNumber(seat.stack)));
  seat.stack -= cleanAmount;
  seat.currentBet += cleanAmount;
  seat.committed += cleanAmount;
  if (seat.stack <= 0 && ['playing', 'waiting'].includes(seat.status)) seat.status = 'all_in';
  return cleanAmount;
}

function resetStreetBets(table) {
  for (const seat of table.seats) {
    seat.currentBet = 0;
    seat.acted = false;
  }
  table.currentBet = 0;
  table.lastRaise = HOLDEM_CONFIG.bigBlind;
}

function setCurrentSeat(table, fromIndex = table.buttonIndex) {
  const next = nextOccupiedIndex(table, fromIndex, seat => seat.status === 'playing' && seat.stack > 0);
  table.currentSeatIndex = next;
  return next;
}

function amountToCall(table, seat) {
  return Math.max(0, asNumber(table.currentBet) - asNumber(seat.currentBet));
}

function bettingRoundComplete(table) {
  const actionable = actionableSeats(table);
  if (!actionable.length) return true;
  return actionable.every(seat => seat.acted && amountToCall(table, seat) === 0);
}

function onlyOneLiveSeat(table) {
  const live = liveSeats(table).filter(seat => seat.status !== 'folded');
  return live.length === 1 ? live[0] : null;
}

function dealBoardTo(table, count) {
  while (table.board.length < count) table.board.push(draw(table));
}

function startHand(table, now, random = Math.random) {
  const entrants = seatedWithStack(table);
  if (entrants.length < 2) {
    table.phase = 'waiting';
    table.street = 'waiting';
    table.phaseDeadline = null;
    table.currentSeatIndex = null;
    return;
  }

  table.currentHandId = table.nextHandId++;
  table.totals.hands = asNumber(table.totals.hands) + 1;
  table.deck = buildDeck(random);
  table.board = [];
  table.pots = [];
  table.showdown = null;
  table.phase = 'preflop';
  table.street = 'preflop';
  table.phaseDeadline = addSeconds(now, HOLDEM_CONFIG.actionSeconds);
  table.currentBet = 0;
  table.lastRaise = HOLDEM_CONFIG.bigBlind;

  for (const seat of table.seats) {
    seat.holeCards = [];
    seat.currentBet = 0;
    seat.committed = 0;
    seat.acted = false;
    if (seat.userId != null && seat.stack > 0) seat.status = 'playing';
    else if (seat.userId != null) seat.status = 'waiting';
  }

  table.buttonIndex = nextOccupiedIndex(table, table.buttonIndex, seat => seat.userId != null && seat.stack > 0);
  const activeCount = entrants.length;
  if (activeCount === 2) {
    table.smallBlindIndex = table.buttonIndex;
    table.bigBlindIndex = nextOccupiedIndex(table, table.smallBlindIndex, seat => seat.userId != null && seat.stack > 0);
  } else {
    table.smallBlindIndex = nextOccupiedIndex(table, table.buttonIndex, seat => seat.userId != null && seat.stack > 0);
    table.bigBlindIndex = nextOccupiedIndex(table, table.smallBlindIndex, seat => seat.userId != null && seat.stack > 0);
  }

  commitChips(table.seats[table.smallBlindIndex], HOLDEM_CONFIG.smallBlind);
  commitChips(table.seats[table.bigBlindIndex], HOLDEM_CONFIG.bigBlind);
  table.currentBet = Math.max(table.seats[table.smallBlindIndex].currentBet, table.seats[table.bigBlindIndex].currentBet);

  for (let round = 0; round < 2; round += 1) {
    for (const seat of entrants) {
      if (seat.status === 'playing' || seat.status === 'all_in') seat.holeCards.push(draw(table));
    }
  }

  setCurrentSeat(table, table.bigBlindIndex);
  appendLog(table, `Hand #${table.currentHandId} started. Blinds ${HOLDEM_CONFIG.smallBlind}/${HOLDEM_CONFIG.bigBlind}.`, now);
  touch(table, now);
}

function settleFoldedHand(table, winner, now, transactions = []) {
  const pot = table.seats.reduce((sum, seat) => sum + asNumber(seat.committed), 0);
  winner.stack += pot;
  table.pots = [{ id: 1, amount: pot, eligibleSeatIndexes: [winner.index], winnerSeatIndexes: [winner.index], splitAmount: pot }];
  table.showdown = { kind: 'fold', revealQueue: [], potAwards: [{ potId: 1, amount: pot, winners: [winner.index], label: `${winner.displayName} wins uncontested.` }] };
  appendLog(table, `${winner.displayName} wins ${pot} uncontested.`, now);
  finishHand(table, now, transactions, { showdown: false });
}

function finishHand(table, now, transactions = [], { showdown = true } = {}) {
  for (const seat of handSeats(table)) {
    if (seat.status !== 'folded' && seat.holeCards.length) seat.status = 'showdown';
  }
  table.phase = showdown ? 'showdown' : 'result';
  table.street = table.phase;
  table.phaseDeadline = addSeconds(now, HOLDEM_CONFIG.resultSeconds);
  table.currentSeatIndex = null;
  table.recentHands.push({
    id: table.currentHandId,
    board: clone(table.board),
    pots: clone(table.pots),
    awards: clone(table.showdown?.potAwards || []),
    seats: handSeats(table).map(seat => ({
      seatIndex: seat.index,
      displayName: seat.displayName,
      status: seat.status,
      committed: seat.committed,
      holeCards: clone(seat.holeCards),
      handLabel: table.showdown?.evaluations?.find(item => item.seatIndex === seat.index)?.label || null
    })),
    createdAt: now.toISOString()
  });
  table.recentHands = table.recentHands.slice(-HOLDEM_CONFIG.recentHandLimit);
  touch(table, now);
}

function combinations(items, size) {
  const result = [];
  const build = (start, combo) => {
    if (combo.length === size) {
      result.push(combo);
      return;
    }
    for (let index = start; index <= items.length - (size - combo.length); index += 1) {
      build(index + 1, [...combo, items[index]]);
    }
  };
  build(0, []);
  return result;
}

function straightHigh(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    const slice = unique.slice(index, index + 5);
    if (slice[0] - slice[4] === 4 && new Set(slice).size === 5) return slice[0] === 14 && slice[4] === 10 ? 14 : slice[0];
  }
  return null;
}

function rankName(value, plural = false) {
  const names = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };
  const name = names[value] || String(value);
  if (!plural) return name;
  if (name === 'Six') return 'Sixes';
  return `${name}s`;
}

function evaluateFive(cards) {
  const values = cards.map(card => RANK_VALUE[card.rank]).sort((a, b) => b - a);
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(card => card.suit === cards[0].suit);
  const straight = straightHigh(values);

  let category = 0;
  let tiebreakers = [...values];
  let label = `${rankName(values[0])} High`;

  if (flush && straight) {
    category = 8;
    tiebreakers = [straight];
    label = `Straight Flush, ${rankName(straight)} high`;
  } else if (groups[0][1] === 4) {
    category = 7;
    tiebreakers = [groups[0][0], groups[1][0]];
    label = `Four of a Kind, ${rankName(groups[0][0], true)}`;
  } else if (groups[0][1] === 3 && groups[1]?.[1] === 2) {
    category = 6;
    tiebreakers = [groups[0][0], groups[1][0]];
    label = `Full House, ${rankName(groups[0][0], true)} over ${rankName(groups[1][0], true)}`;
  } else if (flush) {
    category = 5;
    label = `Flush, ${rankName(values[0])} high`;
  } else if (straight) {
    category = 4;
    tiebreakers = [straight];
    label = `Straight, ${rankName(straight)} high`;
  } else if (groups[0][1] === 3) {
    category = 3;
    tiebreakers = [groups[0][0], ...groups.slice(1).map(item => item[0]).sort((a, b) => b - a)];
    label = `Three of a Kind, ${rankName(groups[0][0], true)}`;
  } else if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const pairs = groups.filter(item => item[1] === 2).map(item => item[0]).sort((a, b) => b - a);
    const kicker = groups.find(item => item[1] === 1)?.[0] || 0;
    category = 2;
    tiebreakers = [...pairs, kicker];
    label = `Two Pair, ${rankName(pairs[0], true)} and ${rankName(pairs[1], true)}`;
  } else if (groups[0][1] === 2) {
    category = 1;
    tiebreakers = [groups[0][0], ...groups.slice(1).map(item => item[0]).sort((a, b) => b - a)];
    label = `Pair of ${rankName(groups[0][0], true)}`;
  }

  return { category, categoryLabel: CATEGORY_LABELS[category], tiebreakers, cards, label };
}

function compareEvaluations(left, right) {
  if (left.category !== right.category) return left.category - right.category;
  const length = Math.max(left.tiebreakers.length, right.tiebreakers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = asNumber(left.tiebreakers[index]) - asNumber(right.tiebreakers[index]);
    if (diff) return diff;
  }
  return 0;
}

export function evaluateHoldemHand(cards) {
  if (!Array.isArray(cards) || cards.length < 5) throw new Error('At least five cards are required.');
  return combinations(cards, 5).map(evaluateFive).sort((a, b) => compareEvaluations(b, a))[0];
}

function buildSidePots(seats) {
  const committedLevels = [...new Set(seats.map(seat => asNumber(seat.committed)).filter(amount => amount > 0))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0;
  for (const level of committedLevels) {
    const contributors = seats.filter(seat => asNumber(seat.committed) >= level);
    const amount = (level - previous) * contributors.length;
    const eligible = contributors.filter(seat => seat.status !== 'folded');
    if (amount > 0 && eligible.length) {
      pots.push({
        id: pots.length + 1,
        amount,
        eligibleSeatIndexes: eligible.map(seat => seat.index),
        contributorSeatIndexes: contributors.map(seat => seat.index)
      });
    }
    previous = level;
  }
  return pots;
}

function settleShowdown(table, now, transactions = []) {
  dealBoardTo(table, 5);
  const contenders = liveSeats(table).filter(seat => seat.status !== 'folded');
  const evaluations = contenders.map(seat => ({
    seatIndex: seat.index,
    displayName: seat.displayName,
    cards: clone(seat.holeCards),
    ...evaluateHoldemHand([...seat.holeCards, ...table.board])
  }));
  const pots = buildSidePots(handSeats(table));
  const potAwards = [];

  for (const pot of pots) {
    const eligibleEvaluations = evaluations.filter(item => pot.eligibleSeatIndexes.includes(item.seatIndex));
    const best = eligibleEvaluations.sort((a, b) => compareEvaluations(b, a))[0];
    const winners = eligibleEvaluations.filter(item => compareEvaluations(item, best) === 0);
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    const orderedWinners = orderedHandSeats(table, table.buttonIndex).filter(seat => winners.some(winner => winner.seatIndex === seat.index));
    for (const seat of orderedWinners) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      seat.stack += share + extra;
    }
    pot.winnerSeatIndexes = orderedWinners.map(seat => seat.index);
    pot.splitAmount = share;
    potAwards.push({
      potId: pot.id,
      amount: pot.amount,
      winners: pot.winnerSeatIndexes,
      label: `${pot.id === 1 ? 'Main Pot' : `Side Pot ${pot.id - 1}`} ${pot.amount}: ${orderedWinners.map(seat => seat.displayName).join(', ')} win${orderedWinners.length === 1 ? 's' : ''} with ${best.label}.`
    });
  }

  table.pots = pots;
  table.showdown = {
    kind: 'showdown',
    revealQueue: orderedHandSeats(table, table.buttonIndex)
      .filter(seat => evaluations.some(item => item.seatIndex === seat.index))
      .map(seat => {
        const evaluation = evaluations.find(item => item.seatIndex === seat.index);
        return {
          seatIndex: seat.index,
          displayName: seat.displayName,
          cards: clone(seat.holeCards),
          label: evaluation.label,
          category: evaluation.categoryLabel,
          bestCardCodes: evaluation.cards.map(cardCode)
        };
      }),
    evaluations: evaluations.map(item => ({
      seatIndex: item.seatIndex,
      displayName: item.displayName,
      label: item.label,
      category: item.categoryLabel,
      bestCardCodes: item.cards.map(cardCode)
    })),
    potAwards
  };
  for (const award of potAwards) appendLog(table, award.label, now);
  finishHand(table, now, transactions, { showdown: true });
}

function advanceStreet(table, now, transactions = []) {
  const loneWinner = onlyOneLiveSeat(table);
  if (loneWinner) {
    settleFoldedHand(table, loneWinner, now, transactions);
    return;
  }

  const liveWithChips = actionableSeats(table);
  if (!liveWithChips.length) {
    settleShowdown(table, now, transactions);
    return;
  }

  if (table.street === 'preflop') {
    table.street = 'flop';
    table.phase = 'flop';
    dealBoardTo(table, 3);
  } else if (table.street === 'flop') {
    table.street = 'turn';
    table.phase = 'turn';
    dealBoardTo(table, 4);
  } else if (table.street === 'turn') {
    table.street = 'river';
    table.phase = 'river';
    dealBoardTo(table, 5);
  } else {
    settleShowdown(table, now, transactions);
    return;
  }

  resetStreetBets(table);
  setCurrentSeat(table, table.buttonIndex);
  table.phaseDeadline = addSeconds(now, HOLDEM_CONFIG.actionSeconds);
  appendLog(table, `${table.street[0].toUpperCase()}${table.street.slice(1)} betting is open.`, now);
}

function completeAction(table, now, transactions = []) {
  const loneWinner = onlyOneLiveSeat(table);
  if (loneWinner) {
    settleFoldedHand(table, loneWinner, now, transactions);
    return;
  }
  if (bettingRoundComplete(table)) {
    advanceStreet(table, now, transactions);
    return;
  }
  setCurrentSeat(table, table.currentSeatIndex);
  table.phaseDeadline = addSeconds(now, HOLDEM_CONFIG.actionSeconds);
}

export function sitHoldemSeat(rawTable, { userId, displayName, seatIndex, now = new Date() }) {
  const table = ensureHoldemTable(rawTable);
  if (table.seats.some(seat => Number(seat.userId) === Number(userId))) throw new Error('You are already seated at this table.');
  const seat = table.seats[Number(seatIndex)];
  if (!seat) throw new Error('Choose a valid seat.');
  if (seat.userId != null) throw new Error('That seat is already taken.');
  Object.assign(seat, {
    ...emptySeat(Number(seatIndex)),
    userId: Number(userId),
    displayName: String(displayName || `User ${userId}`),
    status: 'waiting',
    stack: HOLDEM_CONFIG.buyIn,
    joinedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString()
  });
  table.totals.buyIns = asNumber(table.totals.buyIns) + HOLDEM_CONFIG.buyIn;
  const transactions = [{
    userId,
    amount: -HOLDEM_CONFIG.buyIn,
    kind: 'casino_holdem_buyin',
    note: `Texas Hold'em buy-in: ${HOLDEM_CONFIG.buyIn}`,
    game: 'holdem',
    holdemHandId: table.currentHandId
  }];
  appendLog(table, `${seat.displayName} bought in for ${HOLDEM_CONFIG.buyIn}.`, now);
  if (table.phase === 'waiting' && seatedWithStack(table).length >= 2) startHand(table, now, Math.random);
  touch(table, now);
  return { table, transactions };
}

export function leaveHoldemSeat(rawTable, { userId, now = new Date() }) {
  const table = ensureHoldemTable(rawTable);
  const seat = table.seats.find(candidate => Number(candidate.userId) === Number(userId));
  if (!seat) return { table, transactions: [] };
  const inHand = Boolean(seat.holeCards.length && ['preflop', 'flop', 'turn', 'river'].includes(table.phase));
  if (inHand) {
    if (seat.leaveAfterHand) {
      seat.leaveAfterHand = false;
      appendLog(table, `${seat.displayName} will stay at the table.`, now);
      touch(table, now);
      return { table, transactions: [] };
    }
    seat.leaveAfterHand = true;
    appendLog(table, `${seat.displayName} will leave after the hand.`, now);
    touch(table, now);
    return { table, transactions: [] };
  }
  const transactions = [];
  if (seat.stack > 0) {
    transactions.push({
      userId: seat.userId,
      amount: seat.stack,
      kind: 'casino_holdem_cashout',
      note: `Texas Hold'em cash out: ${seat.stack}`,
      game: 'holdem',
      holdemHandId: table.currentHandId
    });
    table.totals.cashOuts = asNumber(table.totals.cashOuts) + seat.stack;
  }
  appendLog(table, `${seat.displayName} left the table.`, now);
  resetSeat(seat);
  if (table.phase === 'waiting' && seatedWithStack(table).length >= 2) startHand(table, now, Math.random);
  touch(table, now);
  return { table, transactions };
}

export function heartbeatHoldemSeat(rawTable, { userId, now = new Date() }) {
  const table = ensureHoldemTable(rawTable);
  const seat = table.seats.find(candidate => Number(candidate.userId) === Number(userId));
  if (seat) seat.lastHeartbeatAt = now.toISOString();
  touch(table, now);
  return { table, transactions: [] };
}

export function actHoldem(rawTable, { userId, action, amount, now = new Date() }) {
  const table = ensureHoldemTable(rawTable);
  if (!['preflop', 'flop', 'turn', 'river'].includes(table.phase)) throw new Error('There is no active betting round.');
  const seat = table.seats.find(candidate => Number(candidate.index) === Number(table.currentSeatIndex));
  if (!seat || Number(seat.userId) !== Number(userId)) throw new Error('It is not your turn.');
  if (seat.status !== 'playing') throw new Error('You cannot act with this hand.');

  const cleanAction = String(action || '').toLowerCase();
  const toCall = amountToCall(table, seat);
  if (cleanAction === 'fold') {
    seat.status = 'folded';
    seat.acted = true;
    appendLog(table, `${seat.displayName} folded.`, now);
  } else if (cleanAction === 'check') {
    if (toCall > 0) throw new Error('You cannot check while facing a bet.');
    seat.acted = true;
    appendLog(table, `${seat.displayName} checked.`, now);
  } else if (cleanAction === 'call') {
    const paid = commitChips(seat, toCall);
    seat.acted = true;
    appendLog(table, `${seat.displayName} ${seat.status === 'all_in' ? `called all-in for ${paid}` : `called ${paid}`}.`, now);
  } else if (cleanAction === 'raise') {
    const raiseTo = Math.max(0, Math.floor(asNumber(amount)));
    const previousBet = table.currentBet;
    const maxRaiseTo = seat.currentBet + seat.stack;
    const minRaiseTo = previousBet + table.lastRaise;
    if (raiseTo <= previousBet) throw new Error('Raise must be higher than the current bet.');
    if (raiseTo < minRaiseTo && raiseTo < maxRaiseTo) throw new Error(`Minimum raise is to ${minRaiseTo}.`);
    const paid = commitChips(seat, raiseTo - seat.currentBet);
    const actualRaiseTo = seat.currentBet;
    if (actualRaiseTo > previousBet) {
      const raiseSize = actualRaiseTo - previousBet;
      if (raiseSize >= table.lastRaise) {
        table.currentBet = actualRaiseTo;
        table.lastRaise = raiseSize;
        for (const other of actionableSeats(table)) {
          if (other.index !== seat.index) other.acted = false;
        }
      }
    }
    seat.acted = true;
    appendLog(table, `${seat.displayName} raised to ${actualRaiseTo}${seat.status === 'all_in' ? ' and is all-in' : ''}.`, now);
    if (!paid) throw new Error('You do not have chips to raise.');
  } else if (cleanAction === 'all_in') {
    const previousBet = table.currentBet;
    commitChips(seat, seat.stack);
    if (seat.currentBet > previousBet) {
      const raiseSize = seat.currentBet - previousBet;
      if (raiseSize >= table.lastRaise) {
        table.currentBet = seat.currentBet;
        table.lastRaise = raiseSize;
        for (const other of actionableSeats(table)) {
          if (other.index !== seat.index) other.acted = false;
        }
      }
    }
    seat.acted = true;
    appendLog(table, `${seat.displayName} moved all-in for ${seat.currentBet}.`, now);
  } else {
    throw new Error('Choose fold, check, call, raise, or all-in.');
  }

  completeAction(table, now, []);
  touch(table, now);
  return { table, transactions: [] };
}

function clearFinishedHand(table, now, transactions = []) {
  for (const seat of [...table.seats]) {
    if (seat.userId == null) continue;
    if (seat.leaveAfterHand) {
      if (seat.stack > 0) {
        transactions.push({
          userId: seat.userId,
          amount: seat.stack,
          kind: 'casino_holdem_cashout',
          note: `Texas Hold'em cash out: ${seat.stack}`,
          game: 'holdem',
          holdemHandId: table.currentHandId
        });
        table.totals.cashOuts = asNumber(table.totals.cashOuts) + seat.stack;
        appendLog(table, `${seat.displayName} cashed out ${seat.stack}.`, now);
      }
      resetSeat(seat);
    } else if (seat.stack <= 0) {
      appendLog(table, `${seat.displayName} busted.`, now);
      resetSeat(seat);
    }
  }

  table.board = [];
  table.pots = [];
  table.showdown = null;
  table.currentHandId = null;
  table.currentSeatIndex = null;
  table.currentBet = 0;
  table.lastRaise = HOLDEM_CONFIG.bigBlind;
  for (const seat of table.seats) {
    if (seat.userId == null) continue;
    seat.holeCards = [];
    seat.currentBet = 0;
    seat.committed = 0;
    seat.acted = false;
    if (seat.stack <= 0) resetSeat(seat);
    else seat.status = 'waiting';
  }
  if (seatedWithStack(table).length >= 2) startHand(table, now, Math.random);
  else {
    table.phase = 'waiting';
    table.street = 'waiting';
    table.phaseDeadline = null;
    appendLog(table, 'Table is waiting for players.', now);
  }
  touch(table, now);
  return transactions;
}

function removeDisconnectedSeats(table, now, transactions = []) {
  for (const seat of table.seats) {
    if (seat.userId == null || !seat.lastHeartbeatAt) continue;
    if (now.getTime() - ms(seat.lastHeartbeatAt) <= HOLDEM_CONFIG.heartbeatMs) continue;
    const inHand = Boolean(seat.holeCards.length && ['preflop', 'flop', 'turn', 'river'].includes(table.phase));
    if (inHand) {
      seat.leaveAfterHand = true;
      if (Number(table.currentSeatIndex) === Number(seat.index) && seat.status === 'playing') {
        if (amountToCall(table, seat) > 0) seat.status = 'folded';
        else seat.acted = true;
        seat.missedActionCount += 1;
        completeAction(table, now, transactions);
      }
    } else {
      if (seat.stack > 0) {
        transactions.push({
          userId: seat.userId,
          amount: seat.stack,
          kind: 'casino_holdem_cashout',
          note: `Texas Hold'em disconnect cash out: ${seat.stack}`,
          game: 'holdem',
          holdemHandId: table.currentHandId
        });
        table.totals.cashOuts = asNumber(table.totals.cashOuts) + seat.stack;
      }
      appendLog(table, `${seat.displayName || `Seat ${seat.index + 1}`} left the table.`, now);
      resetSeat(seat);
    }
  }
}

export function processHoldemTable(rawTable, { now = new Date(), random = Math.random } = {}) {
  const table = ensureHoldemTable(rawTable);
  const transactions = [];
  removeDisconnectedSeats(table, now, transactions);

  if (table.phase === 'waiting' && seatedWithStack(table).length >= 2) startHand(table, now, random);

  if (table.phaseDeadline && now.getTime() >= ms(table.phaseDeadline)) {
    if (['preflop', 'flop', 'turn', 'river'].includes(table.phase)) {
      const seat = table.seats.find(candidate => Number(candidate.index) === Number(table.currentSeatIndex));
      if (seat && seat.status === 'playing') {
        if (amountToCall(table, seat) > 0) {
          seat.status = 'folded';
          appendLog(table, `${seat.displayName} timed out and folded.`, now);
        } else {
          seat.acted = true;
          appendLog(table, `${seat.displayName} timed out and checked.`, now);
        }
        seat.missedActionCount += 1;
        seat.leaveAfterHand = true;
        completeAction(table, now, transactions);
      }
    } else if (['showdown', 'result'].includes(table.phase)) {
      clearFinishedHand(table, now, transactions);
    }
  }

  return { table, transactions };
}

export function addHoldemChat(rawTable, { userId, username, message, now = new Date() }) {
  const table = ensureHoldemTable(rawTable);
  const clean = String(message || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!clean) throw new Error('Enter a message first.');
  if (clean.length > HOLDEM_CONFIG.chatMaxLength) throw new Error(`Messages are limited to ${HOLDEM_CONFIG.chatMaxLength} characters.`);
  const entry = {
    id: table.nextMessageId++,
    userId: Number(userId),
    username: String(username || `User ${userId}`),
    message: clean,
    createdAt: now.toISOString()
  };
  table.chat.push(entry);
  table.chat = table.chat.slice(-HOLDEM_CONFIG.chatMessageLimit);
  touch(table, now);
  return { table, transactions: [], message: entry };
}

function publicCardsForSeat(seat, userId, table) {
  const reveal = Number(seat.userId) === Number(userId) || ['showdown', 'result'].includes(table.phase) || seat.status === 'folded';
  if (!seat.holeCards.length) return [];
  if (reveal && seat.status !== 'folded') return clone(seat.holeCards);
  return seat.holeCards.map(() => ({ hidden: true }));
}

function currentActionsFor(table, userId) {
  const seat = table.seats.find(candidate => Number(candidate.index) === Number(table.currentSeatIndex));
  if (!seat || Number(seat.userId) !== Number(userId) || seat.status !== 'playing') {
    return { fold: false, check: false, call: false, raise: false, allIn: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 };
  }
  const callAmount = amountToCall(table, seat);
  const maxRaiseTo = seat.currentBet + seat.stack;
  const minRaiseTo = Math.min(maxRaiseTo, table.currentBet + table.lastRaise);
  return {
    fold: callAmount > 0,
    check: callAmount === 0,
    call: callAmount > 0,
    raise: maxRaiseTo > table.currentBet,
    allIn: seat.stack > 0,
    callAmount,
    minRaiseTo,
    maxRaiseTo
  };
}

export function publicHoldemState(rawTable, {
  userId = null,
  balanceSummary = null,
  isCasinoOpen = true,
  now = new Date()
} = {}) {
  const table = ensureHoldemTable(rawTable);
  const userSeat = table.seats.find(seat => Number(seat.userId) === Number(userId)) || null;
  return {
    isCasinoOpen: Boolean(isCasinoOpen),
    serverNow: now.toISOString(),
    config: {
      ...HOLDEM_CONFIG,
      houseRules: [
        'No-limit Texas Holdem.',
        `Buy-in is ${HOLDEM_CONFIG.buyIn} Mushybux.`,
        `Blinds are fixed at ${HOLDEM_CONFIG.smallBlind}/${HOLDEM_CONFIG.bigBlind}.`,
        'Leaving during a hand folds/check-folds when action reaches you, then cashes out after the hand.'
      ]
    },
    phase: table.phase,
    street: table.street,
    phaseDeadline: table.phaseDeadline,
    currentHandId: table.currentHandId,
    buttonIndex: table.buttonIndex,
    smallBlindIndex: table.smallBlindIndex,
    bigBlindIndex: table.bigBlindIndex,
    currentSeatIndex: table.currentSeatIndex,
    currentBet: table.currentBet,
    board: clone(table.board),
    pots: clone(table.pots),
    showdown: clone(table.showdown),
    seats: table.seats.map(seat => ({
      index: seat.index,
      userId: seat.userId,
      displayName: seat.displayName,
      status: seat.status,
      stack: seat.stack,
      currentBet: seat.currentBet,
      committed: seat.committed,
      acted: seat.acted,
      isUser: Number(seat.userId) === Number(userId),
      isCurrentTurn: Number(seat.index) === Number(table.currentSeatIndex),
      leaveAfterHand: seat.leaveAfterHand,
      holeCards: publicCardsForSeat(seat, userId, table)
    })),
    userSeatIndex: userSeat?.index ?? null,
    currentActions: currentActionsFor(table, userId),
    handLog: clone(table.handLog),
    recentHands: clone(table.recentHands),
    chat: clone(table.chat),
    totals: clone(table.totals),
    balanceSummary
  };
}

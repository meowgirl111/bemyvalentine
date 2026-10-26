// Логика игры. Выполняется только у хоста (или локально в режиме «на одном устройстве»).
// Состояние — обычный JSON-объект, который целиком рассылается второму игроку.
import {
  BOARD, GROUPS, JAIL_POS, TRANSPORT_RENT, OWNABLE, groupCells,
  BONUS, CHANCE, CHEST, CHAPTERS, CHAPTER_POOL,
} from './data.js';

export const DEFAULT_SETTINGS = {
  startMoney: 1500,
  salary: 200,
  maxRounds: 0,        // 0 — до банкротства
  auctions: true,      // аукцион, если игрок отказался от покупки
  jackpot: false,      // налоги и штрафы копятся в Парке Горького
  doubleGo: false,     // точное попадание на Старт — двойная зарплата
  chapters: true,      // сюжетные главы с изменением правил
  chapterLen: 4,       // кругов в главе
  mortgageFee: true,   // 10% при получении заложенного объекта при обмене
};

export const money = (n) => `${(n * 1000).toLocaleString('ru-RU')} ₽`;
const rnd = (n) => Math.floor(Math.random() * n);
const die = () => 1 + rnd(6);
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const range = (n) => [...Array(n).keys()];
const who = (s, pid) => { const p = s.players[pid]; return p ? `${p.token} ${p.name}` : '?'; };
const other = (s, pid) => (pid + 1) % s.players.length;

export function createState(settings = {}) {
  return {
    v: 1,
    phase: 'lobby',
    settings: { ...DEFAULT_SETTINGS, ...settings },
    players: [],
    props: {},
    bank: { houses: 32, hotels: 12 },
    turn: null,
    firstPid: 0,
    round: 1,
    lastDice: null,
    anim: { id: 0, dice: null, moves: [] },
    pending: null,
    trade: null,
    decks: { chance: [], chest: [] },
    chapter: null,
    chapterOrder: [],
    jackpot: 0,
    log: [],
    seq: 1,
    reaction: null,
    winner: null,
    endReason: null,
    results: null,
  };
}

export function addPlayer(s, { name, token, color, clientId }) {
  const id = s.players.length;
  s.players.push({
    id, name: cleanName(name) || `Игрок ${id + 1}`, token, color, clientId: clientId || null,
    connected: true, money: 0, pos: 0, inJail: false, jailTries: 0, hand: [], skip: 0, bankrupt: false,
    stats: blankStats(),
  });
  return id;
}

const blankStats = () => ({ rentPaid: 0, rentGot: 0, bought: 0, built: 0, jail: 0, doubles: 0, cards: 0, passGo: 0, maxRent: 0 });
const cleanName = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 16);

// ---------------------------------------------------------------- журнал
function log(s, text, kind = 'info', pid = null) {
  s.log.push({ id: s.seq++, text, kind, pid });
  if (s.log.length > 120) s.log.splice(0, s.log.length - 120);
}

// ---------------------------------------------------------------- старт
export function startGame(s) {
  const st = s.settings;
  for (const p of s.players) {
    Object.assign(p, { money: st.startMoney, pos: 0, inJail: false, jailTries: 0, hand: [], skip: 0, bankrupt: false, stats: blankStats() });
  }
  s.props = {};
  for (const i of OWNABLE) s.props[i] = { owner: -1, houses: 0, mortgaged: false, closedUntil: 0 };
  s.bank = { houses: 32, hotels: 12 };
  s.decks = { chance: shuffle(range(CHANCE.length)), chest: shuffle(range(CHEST.length)) };
  s.round = 1;
  s.jackpot = 0;
  s.pending = null;
  s.trade = null;
  s.winner = null;
  s.endReason = null;
  s.results = null;
  s.lastDice = null;
  s.log = [];
  s.phase = 'playing';
  s.gameId = s.seq++;
  s.firstPid = rnd(s.players.length);
  s.turn = { pid: s.firstPid, stage: 'roll', doubles: 0, again: false, n: 1 };
  s.chapterOrder = shuffle(CHAPTER_POOL);
  s.chapter = null;
  log(s, 'Игра началась! Удачи и любви 💗', 'news');
  if (st.chapters) beginChapter(s, 'arrival');
  log(s, `Жребий брошен: первым ходит ${who(s, s.firstPid)}.`, 'turn', s.firstPid);
}

// ---------------------------------------------------------------- сюжет
export function mods(s) {
  if (!s.settings.chapters || !s.chapter) return {};
  return CHAPTERS[s.chapter.key].mods || {};
}

function beginChapter(s, key) {
  const n = s.chapter ? s.chapter.n + 1 : 1;
  const ch = CHAPTERS[key];
  s.chapter = { key, n, startRound: s.round, progress: s.players.map(() => ({})), questDone: false, questWinner: null };
  log(s, `Глава ${n}. ${ch.emoji} ${ch.title}: ${ch.effect}`, 'chapter');
  if (ch.gift) {
    for (const p of s.players) p.money += ch.gift;
    log(s, `Все получают по ${money(ch.gift)} 🎁`, 'money');
  }
  if (ch.giftBonus) {
    const pool = ['lawyer', 'promo', 'blat', 'taxi', 'insurance', 'inspection', 'traffic'];
    for (const p of s.players) giveBonus(s, p.id, pool[rnd(pool.length)]);
  }
  if (ch.underdog) {
    const worths = s.players.map((p) => netWorth(s, p.id));
    if (worths[0] !== worths[1]) {
      const pid = worths[0] < worths[1] ? 0 : 1;
      s.players[pid].money += ch.underdog;
      log(s, `${who(s, pid)} получает грант ${money(ch.underdog)} 🤝`, 'money', pid);
    } else {
      log(s, 'Капиталы равны — грант делят пополам.', 'money');
      for (const p of s.players) p.money += ch.underdog / 2;
    }
  }
}

function nextChapterKey(s) {
  if (!s.chapterOrder.length) s.chapterOrder = shuffle(CHAPTER_POOL);
  return s.chapterOrder.shift();
}

function track(s, pid, kind, n = 1) {
  const c = s.chapter;
  if (!c || c.questDone || !s.settings.chapters) return;
  const q = CHAPTERS[c.key].quest;
  if (!q || q.kind !== kind) return;
  const pr = c.progress[pid];
  pr[kind] = (pr[kind] || 0) + n;
  if (pr[kind] >= q.n) {
    c.questDone = true;
    c.questWinner = pid;
    const parts = [];
    if (q.money) { s.players[pid].money += q.money; parts.push(money(q.money)); }
    if (q.bonus) { giveBonus(s, pid, q.bonus, true); parts.push(`карту «${BONUS[q.bonus].name}»`); }
    log(s, `🏅 ${who(s, pid)} выполняет задание главы «${q.text}» и получает ${parts.join(' и ')}!`, 'quest', pid);
  }
}

// ---------------------------------------------------------------- деньги и имущество
const ownedBy = (s, pid) => OWNABLE.filter((i) => s.props[i].owner === pid);
export const ownsGroup = (s, pid, g) => groupCells(g).every((i) => s.props[i].owner === pid);
const groupHouses = (s, g) => groupCells(g).map((i) => s.props[i].houses);
export const houseCost = (s, i) => Math.round(GROUPS[BOARD[i].group].house * (mods(s).buildMult || 1));
export const unmortgageCost = (i) => Math.ceil((BOARD[i].price / 2) * 1.1);
export const buyPrice = (s, i) => Math.round(BOARD[i].price * (mods(s).buyMult || 1));
export const salary = (s) => mods(s).salary || s.settings.salary;
export const isClosed = (s, i) => s.props[i] && s.props[i].closedUntil > s.round;

export function monopolies(s, pid) {
  return Object.keys(GROUPS).filter((g) => ownsGroup(s, pid, g));
}

export function netWorth(s, pid) {
  const p = s.players[pid];
  let w = p.money;
  for (const i of ownedBy(s, pid)) {
    const c = BOARD[i], pr = s.props[i];
    w += pr.mortgaged ? c.price / 2 : c.price;
    if (c.type === 'property') w += pr.houses * GROUPS[c.group].house;
  }
  return Math.round(w);
}

// Сколько игрок может собрать, продав всё и заложив всё.
export function liquidity(s, pid) {
  const p = s.players[pid];
  let w = p.money;
  for (const i of ownedBy(s, pid)) {
    const c = BOARD[i], pr = s.props[i];
    if (c.type === 'property') w += (pr.houses * GROUPS[c.group].house) / 2;
    if (!pr.mortgaged) w += c.price / 2;
  }
  return Math.floor(w);
}

function pay(s, pid, amount, to = null) {
  s.players[pid].money -= amount;
  if (to !== null) s.players[to].money += amount;
}

// Налоги и штрафы — при включённом правиле копятся в джекпоте Парка Горького.
function fine(s, pid, amount) {
  pay(s, pid, amount);
  if (s.settings.jackpot) s.jackpot += amount;
}

function giveBonus(s, pid, key, silent = false) {
  const p = s.players[pid];
  p.hand.push({ k: key, uid: s.seq++ });
  if (!silent) log(s, `${who(s, pid)} получает карту «${BONUS[key].emoji} ${BONUS[key].name}».`, 'bonus', pid);
}

const takeBonus = (s, pid, key) => {
  const p = s.players[pid];
  const idx = p.hand.findIndex((h) => h.k === key);
  if (idx < 0) return false;
  p.hand.splice(idx, 1);
  return true;
};
const hasBonus = (s, pid, key) => s.players[pid].hand.some((h) => h.k === key);

// ---------------------------------------------------------------- аренда
export function calcRent(s, i, opts = {}) {
  const c = BOARD[i], pr = s.props[i], m = mods(s);
  if (!pr || pr.owner < 0) return 0;
  let r = 0;
  if (c.type === 'property') {
    r = pr.houses === 0 ? c.rent[0] * (ownsGroup(s, pr.owner, c.group) ? 2 : 1) : c.rent[pr.houses];
    r *= (m.groupMult && m.groupMult[c.group]) || 1;
  } else if (c.type === 'transport') {
    const n = OWNABLE.filter((j) => BOARD[j].type === 'transport' && s.props[j].owner === pr.owner).length;
    r = TRANSPORT_RENT[n - 1] * (m.transportMult || 1) * (opts.transportMult || 1);
  } else if (c.type === 'utility') {
    const n = OWNABLE.filter((j) => BOARD[j].type === 'utility' && s.props[j].owner === pr.owner).length;
    const dice = opts.utilDice ?? (s.lastDice ? s.lastDice.a + s.lastDice.b : 7);
    r = dice * (opts.utilFactor || (n === 2 ? 10 : 4)) * (m.utilMult || 1);
  }
  return Math.round(r * (m.rentMult || 1));
}

function payRent(s, pid, owner, amount, i) {
  pay(s, pid, amount, owner);
  const p = s.players[pid], o = s.players[owner];
  p.stats.rentPaid += amount;
  o.stats.rentGot += amount;
  o.stats.maxRent = Math.max(o.stats.maxRent, amount);
  log(s, `${who(s, pid)} платит аренду ${money(amount)} за «${BOARD[i].name}» → ${who(s, owner)}`, 'rent', pid);
  track(s, owner, 'rentCount');
  track(s, owner, 'rentSum', amount);
}

// ---------------------------------------------------------------- движение
function animMove(s, pid, from, to, steps, jump = false) {
  s.anim.moves.push({ pid, from, to, steps, jump });
}

function passGo(s, pid, exact) {
  let amt = salary(s);
  if (exact && s.settings.doubleGo) amt *= 2;
  s.players[pid].money += amt;
  s.players[pid].stats.passGo++;
  log(s, `${who(s, pid)} ${exact ? 'попадает ровно на' : 'проходит'} Старт и получает ${money(amt)}`, 'money', pid);
  track(s, pid, 'passGo');
}

function walk(s, pid, steps) {
  const p = s.players[pid];
  const from = p.pos;
  const to = (((from + steps) % 40) + 40) % 40;
  animMove(s, pid, from, to, steps);
  p.pos = to;
  if (steps > 0 && from + steps >= 40) passGo(s, pid, to === 0);
}

function goTo(s, pid, to) {
  const steps = (to - s.players[pid].pos + 40) % 40;
  walk(s, pid, steps);
}

function sendToJail(s, pid, reason) {
  const p = s.players[pid];
  animMove(s, pid, p.pos, JAIL_POS, 0, true);
  p.pos = JAIL_POS;
  p.inJail = true;
  p.jailTries = 0;
  p.stats.jail++;
  if (s.turn && s.turn.pid === pid) s.turn.again = false;
  log(s, `🚔 ${who(s, pid)} отправляется в обезьянник${reason ? ` (${reason})` : ''}.`, 'jail', pid);
}

function landOn(s, pid, opts = {}) {
  const p = s.players[pid];
  const i = p.pos;
  const c = BOARD[i];
  switch (c.type) {
    case 'property':
    case 'transport':
    case 'utility': {
      const pr = s.props[i];
      if (pr.owner === -1) {
        s.pending = { type: 'buy', pid, cell: i, price: buyPrice(s, i) };
        return;
      }
      if (pr.owner === pid) { log(s, `${who(s, pid)} заглядывает в свой «${c.name}».`, 'info', pid); return; }
      if (pr.mortgaged) { log(s, `«${c.name}» в залоге — аренда не взимается.`, 'info', pid); return; }
      if (isClosed(s, i)) { log(s, `«${c.name}» закрыт проверкой 🔍 — аренда не взимается.`, 'info', pid); return; }
      if (s.players[pr.owner].bankrupt) return;
      const rent = calcRent(s, i, opts);
      if (opts.utilDice) log(s, `🎲 Бросок для такси: ${opts.utilDice}`, 'info', pid);
      if (hasBonus(s, pid, 'blat')) {
        s.pending = { type: 'rent', pid, to: pr.owner, amount: rent, cell: i };
        return;
      }
      payRent(s, pid, pr.owner, rent, i);
      return;
    }
    case 'tax': {
      const amt = Math.round(c.amount * (mods(s).taxMult || 1));
      fine(s, pid, amt);
      log(s, `${who(s, pid)} платит «${c.name}»: ${money(amt)}`, 'money', pid);
      return;
    }
    case 'chance':
    case 'chest':
      return draw(s, pid, c.type);
    case 'gotojail':
      return sendToJail(s, pid, 'задержание');
    case 'parking': {
      const m = mods(s);
      if (m.parkingBonus) {
        p.money += m.parkingBonus;
        log(s, `🎡 ${who(s, pid)} отдыхает на фестивале и получает ${money(m.parkingBonus)}`, 'money', pid);
      }
      if (s.settings.jackpot && s.jackpot > 0) {
        p.money += s.jackpot;
        log(s, `💰 ${who(s, pid)} срывает джекпот Парка Горького: ${money(s.jackpot)}!`, 'news', pid);
        s.jackpot = 0;
      } else if (!m.parkingBonus) {
        log(s, `🎡 ${who(s, pid)} гуляет по Парку Горького.`, 'info', pid);
      }
      return;
    }
    default:
  }
}

function draw(s, pid, deck) {
  const list = s.decks[deck];
  if (!list.length) s.decks[deck] = shuffle(range((deck === 'chance' ? CHANCE : CHEST).length));
  const idx = s.decks[deck].shift();
  s.decks[deck].push(idx);
  s.players[pid].stats.cards++;
  s.pending = { type: 'card', pid, deck, idx };
  track(s, pid, 'draw');
}

function applyCard(s, pid, deck, idx) {
  const card = (deck === 'chance' ? CHANCE : CHEST)[idx];
  const p = s.players[pid];
  const o = other(s, pid);
  log(s, `${card.emoji} ${who(s, pid)}: «${card.title}» — ${card.text}`, 'card', pid);
  switch (card.a) {
    case 'money':
      if (card.v >= 0) p.money += card.v; else fine(s, pid, -card.v);
      break;
    case 'irl':
      p.money += card.v;
      break;
    case 'irlBoth':
      for (const pl of s.players) pl.money += card.v;
      break;
    case 'moveTo':
      goTo(s, pid, card.to);
      landOn(s, pid);
      break;
    case 'moveBy':
      walk(s, pid, card.v);
      landOn(s, pid);
      break;
    case 'jail':
      sendToJail(s, pid);
      break;
    case 'bonus':
      giveBonus(s, pid, card.b, true);
      break;
    case 'repairs': {
      let h = 0, ht = 0;
      for (const i of ownedBy(s, pid)) {
        const n = s.props[i].houses;
        if (n === 5) ht++; else h += n;
      }
      const amt = h * card.house + ht * card.hotel;
      fine(s, pid, amt);
      log(s, `Домов: ${h}, отелей: ${ht}. Итого ${money(amt)}.`, 'money', pid);
      break;
    }
    case 'toEach':
      pay(s, pid, card.v, o);
      break;
    case 'fromEach':
      pay(s, o, card.v, pid);
      break;
    case 'skip':
      p.skip++;
      break;
    case 'perMonopoly': {
      const n = monopolies(s, pid).length;
      const amt = Math.max(card.min, n * card.v);
      p.money += amt;
      log(s, `Монополий: ${n}. Получено ${money(amt)}.`, 'money', pid);
      break;
    }
    case 'nearest': {
      let i = p.pos;
      do { i = (i + 1) % 40; } while (BOARD[i].type !== card.kind);
      goTo(s, pid, i);
      const pr = s.props[i];
      if (card.kind === 'utility' && pr.owner !== -1 && pr.owner !== pid) {
        const a = die(), b = die();
        s.anim.dice = { a, b };
        landOn(s, pid, { utilDice: a + b, utilFactor: 10 });
      } else {
        landOn(s, pid, { transportMult: 2 });
      }
      break;
    }
    default:
  }
}

// ---------------------------------------------------------------- ходы
function settle(s) {
  const t = s.turn;
  if (!t || s.phase !== 'playing') return;
  if (s.pending) { t.stage = 'resolve'; return; }
  if (t.stage === 'resolve') {
    const p = s.players[t.pid];
    t.stage = t.again && !p.inJail ? 'roll' : 'end';
  }
}

function roll(s, pid) {
  const p = s.players[pid];
  const a = die(), b = die();
  const dbl = a === b;
  s.lastDice = { a, b };
  s.anim.dice = { a, b };
  if (dbl) p.stats.doubles++;
  log(s, `🎲 ${who(s, pid)} выбрасывает ${a} и ${b}${dbl ? ' — дубль!' : ''}`, 'dice', pid);
  s.turn.stage = 'resolve';
  if (p.inJail) {
    s.turn.again = false;
    if (dbl) {
      p.inJail = false;
      log(s, `${who(s, pid)} выходит из обезьянника благодаря дублю!`, 'jail', pid);
    } else {
      p.jailTries++;
      if (p.jailTries < 3) {
        log(s, `${who(s, pid)} остаётся в обезьяннике (попытка ${p.jailTries} из 3).`, 'jail', pid);
        return;
      }
      fine(s, pid, 50);
      p.inJail = false;
      log(s, `Третья попытка не удалась — ${who(s, pid)} платит штраф ${money(50)} и выходит.`, 'jail', pid);
    }
  } else if (dbl) {
    s.turn.doubles++;
    if (s.turn.doubles >= 3) {
      sendToJail(s, pid, 'три дубля подряд — подозрительно везёт');
      return;
    }
    s.turn.again = true;
  } else {
    s.turn.again = false;
  }
  walk(s, pid, a + b);
  landOn(s, pid);
}

function nextTurn(s) {
  let cur = s.turn.pid;
  for (let guard = 0; guard < 10; guard++) {
    const next = (cur + 1) % s.players.length;
    if (next === s.firstPid) {
      s.round++;
      newRound(s);
      if (s.phase !== 'playing') return;
    }
    const np = s.players[next];
    if (np.skip > 0) {
      np.skip--;
      log(s, `🚧 ${who(s, next)} пропускает ход.`, 'turn', next);
      cur = next;
      continue;
    }
    s.turn = { pid: next, stage: 'roll', doubles: 0, again: false, n: (s.turn.n || 0) + 1 };
    log(s, `Ход: ${who(s, next)} (круг ${s.round})`, 'turn', next);
    return;
  }
}

function newRound(s) {
  const st = s.settings;
  if (st.maxRounds && s.round > st.maxRounds) {
    endGame(s, 'rounds');
    return;
  }
  if (!st.chapters || !s.chapter) return;
  const finalStart = st.maxRounds ? Math.max(2, st.maxRounds - 2) : 0;
  if (finalStart && s.round >= finalStart) {
    if (s.chapter.key !== 'final') beginChapter(s, 'final');
    return;
  }
  if (s.round - s.chapter.startRound >= st.chapterLen) beginChapter(s, nextChapterKey(s));
}

function endGame(s, reason, winner = null) {
  s.phase = 'ended';
  s.endReason = reason;
  s.pending = null;
  s.trade = null;
  const worths = s.players.map((p) => netWorth(s, p.id));
  if (winner === null) winner = worths[0] === worths[1] ? -1 : worths.indexOf(Math.max(...worths));
  s.winner = winner;
  s.results = s.players.map((p) => ({ worth: worths[p.id], money: p.money, props: ownedBy(s, p.id).length, monopolies: monopolies(s, p.id).length }));
  log(s, winner >= 0 ? `🏆 Победа: ${who(s, winner)}!` : '🤝 Ничья!', 'news');
}

// ---------------------------------------------------------------- постройки и залог
function checkBuild(s, pid, i) {
  const c = BOARD[i], pr = s.props[i];
  if (!c || c.type !== 'property') return 'Здесь нельзя строить';
  if (pr.owner !== pid) return 'Это не твой объект';
  if (!ownsGroup(s, pid, c.group)) return 'Нужна вся цветовая группа';
  if (groupCells(c.group).some((j) => s.props[j].mortgaged)) return 'В группе есть заложенные объекты';
  if (pr.houses >= 5) return 'Уже стоит отель';
  if (isClosed(s, i)) return 'Объект закрыт проверкой';
  if (pr.houses > Math.min(...groupHouses(s, c.group))) return 'Строй равномерно по всей группе';
  if (pr.houses < 4 && s.bank.houses <= 0) return 'В банке закончились дома';
  if (pr.houses === 4 && s.bank.hotels <= 0) return 'В банке закончились отели';
  if (s.players[pid].money < houseCost(s, i)) return 'Не хватает денег';
  return null;
}

function checkSell(s, pid, i) {
  const c = BOARD[i], pr = s.props[i];
  if (!c || c.type !== 'property' || pr.owner !== pid) return 'Это не твой объект';
  if (pr.houses <= 0) return 'Здесь нечего продавать';
  if (pr.houses < Math.max(...groupHouses(s, c.group))) return 'Продавай равномерно по группе';
  if (pr.houses === 5 && s.bank.houses < 4) return 'В банке не хватает домов, чтобы разменять отель';
  return null;
}

function checkMortgage(s, pid, i) {
  const c = BOARD[i], pr = s.props[i];
  if (!pr || pr.owner !== pid) return 'Это не твой объект';
  if (pr.mortgaged) return 'Уже в залоге';
  if (c.type === 'property' && groupHouses(s, c.group).some((h) => h > 0)) return 'Сначала продай постройки в группе';
  return null;
}

export const can = { build: checkBuild, sell: checkSell, mortgage: checkMortgage };

// ---------------------------------------------------------------- обмен
function validateSide(s, pid, side) {
  const p = s.players[pid];
  if (!Number.isInteger(side.money) || side.money < 0) return 'Неверная сумма';
  if (side.money > Math.max(0, p.money)) return `У ${p.name} не хватает денег`;
  for (const i of side.props) {
    const pr = s.props[i];
    if (!pr || pr.owner !== pid) return 'Объект уже не принадлежит игроку';
    const c = BOARD[i];
    if (c.type === 'property' && groupHouses(s, c.group).some((h) => h > 0)) return `Сначала продай постройки в группе «${GROUPS[c.group].name}»`;
  }
  for (const uid of side.bonus) if (!p.hand.some((h) => h.uid === uid)) return 'Карты уже нет на руке';
  return null;
}

function normSide(x) {
  return {
    props: Array.isArray(x && x.props) ? [...new Set(x.props.map(Number))] : [],
    money: Math.floor(Number((x && x.money) || 0)),
    bonus: Array.isArray(x && x.bonus) ? [...new Set(x.bonus.map(Number))] : [],
  };
}

function transferSide(s, from, to, side) {
  s.players[from].money -= side.money;
  s.players[to].money += side.money;
  for (const i of side.props) {
    s.props[i].owner = to;
    if (s.props[i].mortgaged && s.settings.mortgageFee) {
      const fee = Math.ceil(BOARD[i].price / 2 / 10);
      s.players[to].money -= fee;
      log(s, `${who(s, to)} платит банку ${money(fee)} — 10% за заложенный «${BOARD[i].name}».`, 'money', to);
    }
  }
  for (const uid of side.bonus) {
    const idx = s.players[from].hand.findIndex((h) => h.uid === uid);
    s.players[to].hand.push(s.players[from].hand.splice(idx, 1)[0]);
  }
}

function describeSide(s, side) {
  const parts = side.props.map((i) => `«${BOARD[i].name}»`);
  if (side.money) parts.push(money(side.money));
  for (const uid of side.bonus) {
    const h = s.players.flatMap((p) => p.hand).find((x) => x.uid === uid);
    if (h) parts.push(`карту «${BONUS[h.k].name}»`);
  }
  return parts.length ? parts.join(', ') : 'ничего';
}

function announceMonopolies(s, pid, before) {
  for (const g of monopolies(s, pid)) {
    if (!before.includes(g)) log(s, `📰 Московский вестник: ${who(s, pid)} собирает монополию «${GROUPS[g].name}»!`, 'news', pid);
  }
}

// ---------------------------------------------------------------- главный обработчик
// Возвращает null при успехе или текст ошибки.
export function act(s, pid, a) {
  if (!a || typeof a.type !== 'string') return 'Неизвестное действие';
  s.anim = { id: s.seq++, dice: null, moves: [] };
  const err = handle(s, pid, a);
  if (!err) settle(s);
  return err;
}

function handle(s, pid, a) {
  const p = s.players[pid];
  if (!p) return 'Нет такого игрока';

  // --- действия в любой фазе
  if (a.type === 'react') {
    s.reaction = { id: s.seq++, pid, emoji: String(a.emoji).slice(0, 8) };
    return null;
  }
  if (a.type === 'chat') {
    const text = String(a.text || '').trim().slice(0, 200);
    if (!text) return 'Пустое сообщение';
    log(s, text, 'chat', pid);
    return null;
  }

  // --- лобби
  if (s.phase === 'lobby') {
    if (a.type === 'profile') {
      const name = cleanName(a.name);
      if (name) p.name = name;
      if (a.token && !s.players.some((q) => q.id !== pid && q.token === a.token)) p.token = a.token;
      if (a.color) p.color = String(a.color).slice(0, 9);
      return null;
    }
    if (a.type === 'settings') {
      if (pid !== 0) return 'Настройки меняет хозяин комнаты';
      const st = a.settings || {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (k in st && typeof st[k] === typeof DEFAULT_SETTINGS[k]) s.settings[k] = st[k];
      }
      return null;
    }
    if (a.type === 'start') {
      if (pid !== 0) return 'Начать игру может хозяин комнаты';
      if (s.players.length < 2) return 'Ждём второго игрока';
      if (s.players[0].token === s.players[1].token) return 'Выберите разные фишки';
      startGame(s);
      return null;
    }
    return 'Игра ещё не началась';
  }

  if (s.phase === 'ended') {
    if (a.type === 'rematch') { startGame(s); return null; }
    return 'Игра окончена';
  }

  const t = s.turn;
  const myTurn = t.pid === pid;
  const pend = s.pending;

  switch (a.type) {
    case 'roll':
      if (!myTurn) return 'Сейчас не твой ход';
      if (t.stage !== 'roll' || pend) return 'Сейчас нельзя бросать кубики';
      if (p.money < 0) return 'Сначала погаси долг: продай постройки или заложи объекты';
      roll(s, pid);
      return null;

    case 'endTurn':
      if (!myTurn) return 'Сейчас не твой ход';
      if (t.stage !== 'end' || pend) return 'Ход ещё не закончен';
      if (p.money < 0) return 'Сначала погаси долг или объяви банкротство';
      nextTurn(s);
      return null;

    case 'payJail':
      if (!myTurn || t.stage !== 'roll' || !p.inJail) return 'Сейчас нельзя';
      if (p.money < 50) return 'Не хватает денег на штраф';
      fine(s, pid, 50);
      p.inJail = false;
      log(s, `${who(s, pid)} платит штраф ${money(50)} и выходит на свободу.`, 'jail', pid);
      return null;

    case 'buy': {
      if (!pend || pend.type !== 'buy' || pend.pid !== pid) return 'Нечего покупать';
      let price = pend.price;
      if (a.promo) {
        if (!hasBonus(s, pid, 'promo')) return 'Нет промокода';
        price = Math.round(price / 2);
      }
      if (p.money < price) return 'Не хватает денег — можно заложить что-нибудь';
      if (a.promo) takeBonus(s, pid, 'promo');
      const before = monopolies(s, pid);
      pay(s, pid, price);
      s.props[pend.cell].owner = pid;
      p.stats.bought++;
      log(s, `🛒 ${who(s, pid)} покупает «${BOARD[pend.cell].name}» за ${money(price)}${a.promo ? ' по промокоду' : ''}`, 'buy', pid);
      s.pending = null;
      track(s, pid, 'buy');
      announceMonopolies(s, pid, before);
      return null;
    }

    case 'decline': {
      if (!pend || pend.type !== 'buy' || pend.pid !== pid) return 'Нечего отклонять';
      if (s.settings.auctions) {
        s.pending = { type: 'auction', cell: pend.cell, bid: 0, bidder: -1, turn: pid, passes: 0 };
        log(s, `🔨 «${BOARD[pend.cell].name}» уходит с аукциона!`, 'auction');
      } else {
        s.pending = null;
        log(s, `${who(s, pid)} отказывается от покупки «${BOARD[pend.cell].name}».`, 'info', pid);
      }
      return null;
    }

    case 'bid': {
      if (!pend || pend.type !== 'auction' || pend.turn !== pid) return 'Сейчас не твоя ставка';
      const amt = Math.floor(Number(a.amount));
      if (!(amt > pend.bid) || amt < 10) return 'Ставка должна быть больше текущей (минимум 10 000 ₽)';
      if (amt > p.money) return 'Не хватает денег';
      pend.bid = amt;
      pend.bidder = pid;
      pend.passes = 0;
      pend.turn = other(s, pid);
      log(s, `🔨 ${who(s, pid)} ставит ${money(amt)}`, 'auction', pid);
      return null;
    }

    case 'pass': {
      if (!pend || pend.type !== 'auction' || pend.turn !== pid) return 'Сейчас не твоя ставка';
      if (pend.bidder >= 0 && pend.bidder !== pid) {
        const w = pend.bidder;
        const before = monopolies(s, w);
        pay(s, w, pend.bid);
        s.props[pend.cell].owner = w;
        s.players[w].stats.bought++;
        log(s, `🔨 Продано! ${who(s, w)} получает «${BOARD[pend.cell].name}» за ${money(pend.bid)}`, 'auction', w);
        s.pending = null;
        track(s, w, 'buy');
        announceMonopolies(s, w, before);
        return null;
      }
      pend.passes++;
      log(s, `${who(s, pid)} пасует.`, 'auction', pid);
      if (pend.passes >= s.players.length) {
        log(s, `Никто не купил «${BOARD[pend.cell].name}» — объект остаётся у банка.`, 'auction');
        s.pending = null;
      } else pend.turn = other(s, pid);
      return null;
    }

    case 'cardOk': {
      if (!pend || pend.type !== 'card' || pend.pid !== pid) return 'Нет карты';
      s.pending = null;
      applyCard(s, pid, pend.deck, pend.idx);
      return null;
    }

    case 'rentPay':
    case 'rentBlat': {
      if (!pend || pend.type !== 'rent' || pend.pid !== pid) return 'Нечего платить';
      s.pending = null;
      if (a.type === 'rentBlat' && takeBonus(s, pid, 'blat')) {
        log(s, `🤝 ${who(s, pid)} включает блат и не платит аренду за «${BOARD[pend.cell].name}»!`, 'bonus', pid);
      } else payRent(s, pid, pend.to, pend.amount, pend.cell);
      return null;
    }

    case 'build': {
      if (!myTurn) return 'Строить можно только в свой ход';
      if (pend) return 'Сначала закончи текущее действие';
      const i = Number(a.cell);
      const e = checkBuild(s, pid, i);
      if (e) return e;
      const pr = s.props[i];
      pay(s, pid, houseCost(s, i));
      pr.houses++;
      if (pr.houses === 5) { s.bank.hotels--; s.bank.houses += 4; } else s.bank.houses--;
      p.stats.built++;
      if (pr.houses === 5) log(s, `📰 Московский вестник: ${who(s, pid)} открывает флагманский отель в «${BOARD[i].name}»! 🏨`, 'news', pid);
      else log(s, `🏠 ${who(s, pid)} строит дом в «${BOARD[i].name}» (${pr.houses}) за ${money(houseCost(s, i))}`, 'build', pid);
      track(s, pid, 'build');
      return null;
    }

    case 'sell': {
      const i = Number(a.cell);
      if (pend && pend.type === 'auction') return 'Подожди окончания аукциона';
      const e = checkSell(s, pid, i);
      if (e) return e;
      const pr = s.props[i];
      if (pr.houses === 5) { s.bank.hotels++; s.bank.houses -= 4; } else s.bank.houses++;
      pr.houses--;
      const back = GROUPS[BOARD[i].group].house / 2;
      p.money += back;
      log(s, `${who(s, pid)} продаёт постройку в «${BOARD[i].name}» за ${money(back)}`, 'build', pid);
      return null;
    }

    case 'mortgage': {
      const i = Number(a.cell);
      if (pend && pend.type === 'auction') return 'Подожди окончания аукциона';
      const e = checkMortgage(s, pid, i);
      if (e) return e;
      s.props[i].mortgaged = true;
      p.money += BOARD[i].price / 2;
      log(s, `🏦 ${who(s, pid)} закладывает «${BOARD[i].name}» и получает ${money(BOARD[i].price / 2)}`, 'money', pid);
      return null;
    }

    case 'unmortgage': {
      const i = Number(a.cell);
      const pr = s.props[i];
      if (!pr || pr.owner !== pid || !pr.mortgaged) return 'Нельзя выкупить';
      const cost = unmortgageCost(i);
      if (p.money < cost) return 'Не хватает денег';
      pay(s, pid, cost);
      pr.mortgaged = false;
      log(s, `${who(s, pid)} выкупает «${BOARD[i].name}» из залога за ${money(cost)}`, 'money', pid);
      return null;
    }

    case 'useBonus':
      return useBonus(s, pid, a);

    case 'tradePropose': {
      if (s.trade) return 'Уже есть активное предложение обмена';
      if (pend && pend.type === 'auction') return 'Подожди окончания аукциона';
      const to = other(s, pid);
      const give = normSide(a.give), get = normSide(a.get);
      if (!give.props.length && !give.money && !give.bonus.length && !get.props.length && !get.money && !get.bonus.length) return 'Пустое предложение';
      const e = validateSide(s, pid, give) || validateSide(s, to, get);
      if (e) return e;
      s.trade = { id: s.seq++, from: pid, to, give, get };
      log(s, `🤝 ${who(s, pid)} предлагает обмен: ${describeSide(s, give)} ⇄ ${describeSide(s, get)}`, 'trade', pid);
      return null;
    }

    case 'tradeAccept': {
      const tr = s.trade;
      if (!tr || tr.to !== pid) return 'Нет предложения';
      const e = validateSide(s, tr.from, tr.give) || validateSide(s, tr.to, tr.get);
      if (e) { s.trade = null; log(s, `Обмен отменён: ${e}`, 'trade'); return null; }
      const bf = monopolies(s, tr.from), bt = monopolies(s, tr.to);
      log(s, `🤝 Сделка! ${who(s, tr.from)} отдаёт ${describeSide(s, tr.give)}, ${who(s, tr.to)} отдаёт ${describeSide(s, tr.get)}`, 'trade');
      transferSide(s, tr.from, tr.to, tr.give);
      transferSide(s, tr.to, tr.from, tr.get);
      s.trade = null;
      announceMonopolies(s, tr.from, bf);
      announceMonopolies(s, tr.to, bt);
      return null;
    }

    case 'tradeDecline': {
      const tr = s.trade;
      if (!tr || (tr.to !== pid && tr.from !== pid)) return 'Нет предложения';
      log(s, tr.to === pid ? `${who(s, pid)} отклоняет обмен.` : `${who(s, pid)} отзывает предложение обмена.`, 'trade', pid);
      s.trade = null;
      return null;
    }

    case 'bankrupt': {
      log(s, `💔 ${who(s, pid)} объявляет банкротство.`, 'news', pid);
      p.bankrupt = true;
      endGame(s, 'bankrupt', other(s, pid));
      return null;
    }

    case 'finish': {
      // досрочно закончить игру и посчитать капитал (только хозяин)
      if (pid !== 0) return 'Только хозяин комнаты';
      endGame(s, 'manual');
      return null;
    }

    default:
      return 'Неизвестное действие';
  }
}

function useBonus(s, pid, a) {
  const p = s.players[pid];
  const h = p.hand.find((x) => x.uid === Number(a.uid));
  if (!h) return 'Нет такой карты';
  const t = s.turn;
  const o = other(s, pid);
  if (t.pid !== pid) return 'Карты можно играть только в свой ход';
  if (s.pending) return 'Сначала закончи текущее действие';
  const b = BONUS[h.k];
  const remove = () => p.hand.splice(p.hand.indexOf(h), 1);
  const shielded = () => {
    if (!hasBonus(s, o, 'insurance')) return false;
    takeBonus(s, o, 'insurance');
    remove();
    log(s, `🛡️ Страховка ${who(s, o)} отражает «${b.name}»!`, 'bonus', o);
    return true;
  };

  switch (h.k) {
    case 'lawyer':
      if (!p.inJail || t.stage !== 'roll') return 'Адвокат нужен, только когда ты в обезьяннике';
      remove();
      p.inJail = false;
      log(s, `⚖️ Адвокат вытаскивает ${who(s, pid)} из обезьянника!`, 'bonus', pid);
      return null;
    case 'taxi':
      if (t.stage !== 'roll' || p.inJail) return 'Такси можно вызвать только до броска (и не из обезьянника)';
      if (p.pos === 0) return 'Ты и так на Старте';
      remove();
      log(s, `🚕 ${who(s, pid)} едет на такси до Старта.`, 'bonus', pid);
      animMove(s, pid, p.pos, 0, 0, true);
      p.pos = 0;
      passGo(s, pid, true);
      return null;
    case 'traffic':
      if (shielded()) return null;
      remove();
      s.players[o].skip++;
      log(s, `🚧 ${who(s, pid)} устраивает ${who(s, o)} пробку на МКАДе — следующий ход пропущен!`, 'bonus', pid);
      return null;
    case 'inspection': {
      const i = Number(a.target);
      const pr = s.props[i];
      if (!pr || pr.owner !== o) return 'Выбери объект соперника';
      if (shielded()) return null;
      remove();
      pr.closedUntil = s.round + 2;
      log(s, `🔍 Роспотребнадзор закрывает «${BOARD[i].name}» (${who(s, o)}) на 2 круга!`, 'bonus', pid);
      return null;
    }
    case 'deal': {
      const i = Number(a.target);
      const pr = s.props[i];
      if (!pr || pr.owner !== o) return 'Выбери объект соперника';
      const c = BOARD[i];
      if (c.type === 'property' && groupHouses(s, c.group).some((x) => x > 0)) return 'В группе этого объекта есть постройки';
      const price = Math.ceil(c.price * 1.5);
      if (p.money < price) return `Нужно ${money(price)}`;
      if (shielded()) return null;
      remove();
      const before = monopolies(s, pid);
      pay(s, pid, price, o);
      pr.owner = pid;
      log(s, `💼 ${who(s, pid)} выкупает «${c.name}» у ${who(s, o)} за ${money(price)}!`, 'bonus', pid);
      announceMonopolies(s, pid, before);
      return null;
    }
    default:
      return `Карта «${b.name}» срабатывает сама (${b.when.toLowerCase()})`;
  }
}

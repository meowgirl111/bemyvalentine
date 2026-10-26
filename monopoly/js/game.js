// Отрисовка игрового экрана: поле, фишки, панели, модальные окна, анимации.
import { BOARD, GROUPS, BONUS, CHANCE, CHEST, CHAPTERS, REACTIONS, TRANSPORT_RENT, OWNABLE, groupCells } from './data.js';
import {
  money, calcRent, can, houseCost, unmortgageCost, mods, netWorth, liquidity, ownsGroup, isClosed, salary, monopolies,
} from './engine.js';
import { sfx, toast, esc, floatEmoji, confetti, vibrate, isMuted, toggleMute } from './fx.js';
import { rulesHTML } from './rules.js';

let ctx = null;           // { mode, myPids, dispatch(action, pid), leave(), status }
const view = {
  latest: null,           // последнее состояние от хоста
  shown: null,            // состояние, которое отрисовано
  animId: null,
  animQueue: Promise.resolve(),
  animating: 0,
  shownPos: [],
  lastLogId: null,
  seenChapter: null,
  prevMoney: null,
  lastReaction: null,
  tab: 'props',
  manual: null,           // модалка, открытая пользователем
  hiddenKey: null,        // авто-модалка, которую свернули
  modalKey: '',
  tradeDraft: null,
  endShown: false,
  unreadLog: 0,
  gameId: null,
};

const $ = (id) => document.getElementById(id);
const short = (n) => `${n}к`;
const mine = (pid) => ctx && ctx.myPids.includes(pid);
const P = (s, pid) => s.players[pid];
const tokName = (s, pid) => `${P(s, pid).token} ${esc(P(s, pid).name)}`;

// ======================================================================= init
export function initGame(c) {
  ctx = c;
  Object.assign(view, {
    latest: null, shown: null, animId: null, animQueue: Promise.resolve(), animating: 0, shownPos: [],
    lastLogId: null, seenChapter: null, prevMoney: null, lastReaction: null, manual: null, hiddenKey: null,
    modalKey: '', tradeDraft: null, endShown: false, unreadLog: 0, gameId: null,
  });
  buildBoard();
  $('reactions').innerHTML = REACTIONS.map((r) => `<button data-a="react" data-e="${r}">${r}</button>`).join('');
  $('btn-sound').textContent = isMuted() ? '🔇' : '🔊';
  $('modal-root').innerHTML = '';
  setTab(view.tab);
}

let bound = false;
export function bindGameOnce() {
  if (bound) return;
  bound = true;
  document.addEventListener('click', onClick);
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('chat-input').value.trim();
    if (!v) return;
    send({ type: 'chat', text: v });
    $('chat-input').value = '';
  });
  $('btn-sound').addEventListener('click', () => { $('btn-sound').textContent = toggleMute() ? '🔇' : '🔊'; });
  $('btn-rules').addEventListener('click', () => openManual({ kind: 'rules' }));
  $('btn-menu').addEventListener('click', () => openManual({ kind: 'menu' }));
  $('chapter-pill').addEventListener('click', () => setTab('story'));
  new ResizeObserver(() => view.shown && placeTokens(view.shown, false)).observe($('board'));
}

function setTab(t) {
  view.tab = t;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === t);
  for (const id of ['props', 'cards', 'story', 'log']) $(`tab-${id}`).classList.toggle('hidden', id !== t);
  if (t === 'log') { view.unreadLog = 0; $('log-dot').textContent = ''; const l = $('log'); l.scrollTop = l.scrollHeight; }
}

// ======================================================================= поле
function gridPos(i) {
  if (i === 0) return [11, 11];
  if (i < 10) return [11, 11 - i];
  if (i === 10) return [11, 1];
  if (i < 20) return [11 - (i - 10), 1];
  if (i === 20) return [1, 1];
  if (i < 30) return [1, 1 + (i - 20)];
  if (i === 30) return [1, 11];
  return [1 + (i - 30), 11];
}
const sideOf = (i) => (i % 10 === 0 ? 'corner' : i < 10 ? 's-bottom' : i < 20 ? 's-left' : i < 30 ? 's-top' : 's-right');

function buildBoard() {
  const board = $('board');
  board.querySelectorAll('.cell').forEach((c) => c.remove());
  BOARD.forEach((c, i) => {
    const el = document.createElement('div');
    const [r, col] = gridPos(i);
    el.className = `cell ${sideOf(i)}`;
    el.dataset.a = 'deed';
    el.dataset.cell = i;
    el.id = `cell-${i}`;
    el.style.gridRow = r;
    el.style.gridColumn = col;
    const strip = c.type === 'property' ? `<div class="strip" style="background:${GROUPS[c.group].color}"></div>` : '';
    const price = c.price ? `<div class="cp">${short(c.price)}</div>` : c.type === 'tax' ? `<div class="cp">−${short(c.amount)}</div>` : '';
    el.innerHTML = `${strip}<div class="body"><div class="ce">${c.emoji}</div><div class="cn">${esc(c.name)}</div>${price}</div><div class="houses"></div>`;
    board.appendChild(el);
  });
}

function renderBoard(s) {
  for (const i of OWNABLE) {
    const el = $(`cell-${i}`);
    const pr = s.props[i];
    if (!pr) continue;
    el.classList.toggle('mortgaged', pr.mortgaged);
    el.classList.toggle('closed', isClosed(s, i));
    let ow = el.querySelector('.owner');
    if (pr.owner >= 0) {
      if (!ow) { ow = document.createElement('div'); ow.className = 'owner'; el.appendChild(ow); }
      el.style.setProperty('--oc', P(s, pr.owner).color);
    } else if (ow) ow.remove();
    const h = el.querySelector('.houses');
    const html = pr.houses === 5 ? '🏨' : '🏠'.repeat(pr.houses);
    if (h.innerHTML !== html) h.innerHTML = html;
  }
}

function placeTokens(s, hop, hopPid) {
  const layer = $('tokens');
  const board = $('board');
  const bw = board.clientWidth || 1;
  s.players.forEach((p, pid) => {
    let t = $(`token-${pid}`);
    if (!t) {
      t = document.createElement('div');
      t.id = `token-${pid}`;
      t.className = 'token';
      layer.appendChild(t);
    }
    t.textContent = p.token;
    t.style.setProperty('--tc', p.color);
    const pos = view.shownPos[pid] ?? p.pos;
    const cell = $(`cell-${pos}`);
    const sameCell = s.players.filter((q, j) => (view.shownPos[j] ?? q.pos) === pos).length > 1;
    const off = sameCell ? (pid === 0 ? -1 : 1) * bw * 0.018 : 0;
    t.style.left = `${cell.offsetLeft + cell.offsetWidth / 2 + off}px`;
    t.style.top = `${cell.offsetTop + cell.offsetHeight / 2 + off * 0.6}px`;
    t.classList.toggle('jail', p.inJail && pos === 10);
    t.classList.toggle('active', s.phase === 'playing' && s.turn && s.turn.pid === pid && !view.animating);
    if (hop && hopPid === pid) { t.classList.remove('hop'); void t.offsetWidth; t.classList.add('hop'); }
  });
  for (const t of [...layer.children]) if (Number(t.id.split('-')[1]) >= s.players.length) t.remove();
}

const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
function setDie(el, n) {
  el.innerHTML = Array.from({ length: 9 }, (_, k) => (PIPS[n].includes(k + 1) ? '<i></i>' : '<span></span>')).join('');
}

// ======================================================================= состояние
export function onState(s) {
  view.latest = s;
  const first = !view.shown;
  if (first) {
    view.shownPos = s.players.map((p) => p.pos);
    view.lastLogId = s.log.length ? s.log[s.log.length - 1].id : 0;
    view.animId = s.anim ? s.anim.id : null;
    view.lastReaction = s.reaction ? s.reaction.id : null;
    view.endShown = s.phase === 'ended';
  }
  if (view.gameId !== s.gameId) { view.gameId = s.gameId; view.seenChapter = null; } // новая партия (реванш)
  if (s.chapter && view.seenChapter === null) {
    // Вступление первой главы показываем только в самом начале партии.
    view.seenChapter = s.chapter.n === 1 && !s.lastDice ? 0 : s.chapter.n;
  }
  if (s.reaction && s.reaction.id !== view.lastReaction) {
    view.lastReaction = s.reaction.id;
    const p = s.players[s.reaction.pid];
    floatEmoji(s.reaction.emoji, p ? p.name : '');
    sfx.pop();
  }
  if (!first && s.anim && s.anim.id !== view.animId) {
    view.animId = s.anim.id;
    if (s.anim.dice || s.anim.moves.length) {
      const anim = s.anim;
      view.animating++;
      view.animQueue = view.animQueue.then(() => playAnim(anim, s)).catch(console.error).then(() => {
        view.animating--;
        if (!view.animating) render(view.latest);
      });
      return;
    }
  }
  if (!view.animating) render(s);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function playAnim(anim, s) {
  closeAutoModalForAnim();
  if (anim.dice) {
    const d1 = $('die1'), d2 = $('die2');
    d1.classList.add('rolling'); d2.classList.add('rolling');
    sfx.dice();
    for (let k = 0; k < 7; k++) {
      setDie(d1, 1 + Math.floor(Math.random() * 6));
      setDie(d2, 1 + Math.floor(Math.random() * 6));
      await wait(80);
    }
    d1.classList.remove('rolling'); d2.classList.remove('rolling');
    setDie(d1, anim.dice.a); setDie(d2, anim.dice.b);
    await wait(250);
  }
  for (const m of anim.moves) {
    if (m.jump || !m.steps) {
      view.shownPos[m.pid] = m.to;
      placeTokens(s, true, m.pid);
      if (m.to === 10) sfx.jail(); else sfx.step();
      await wait(450);
      continue;
    }
    const dir = Math.sign(m.steps);
    for (let k = 1; k <= Math.abs(m.steps); k++) {
      view.shownPos[m.pid] = (((m.from + dir * k) % 40) + 40) % 40;
      placeTokens(s, true, m.pid);
      sfx.step();
      await wait(175);
    }
    await wait(200);
  }
  s.players.forEach((p, i) => { view.shownPos[i] = view.latest.players[i] ? view.latest.players[i].pos : p.pos; });
}

function closeAutoModalForAnim() {
  if (!view.manual) { $('modal-root').innerHTML = ''; view.modalKey = ''; }
}

function render(s) {
  view.shown = s;
  s.players.forEach((p, i) => { view.shownPos[i] = p.pos; });
  renderTop(s);
  renderBoard(s);
  placeTokens(s, false);
  renderDice(s);
  renderCenter(s);
  renderPlayers(s);
  renderProps(s);
  renderCards(s);
  renderStory(s);
  renderLog(s);
  processNewLog(s);
  renderModal(s);
  if (s.phase === 'ended' && !view.endShown) {
    view.endShown = true;
    confetti(5000);
    sfx.win();
  }
  if (s.phase === 'playing') view.endShown = false;
}

function renderDice(s) {
  const d = s.lastDice || { a: 5, b: 2 };
  setDie($('die1'), d.a);
  setDie($('die2'), d.b);
}

// ======================================================================= шапка
export function setConn(text, level = '') {
  const el = $('conn');
  if (!el) return;
  el.textContent = text;
  el.className = `conn ${level}`;
}

function renderTop(s) {
  const pill = $('chapter-pill');
  const rounds = s.settings.maxRounds ? `${s.round}/${s.settings.maxRounds}` : s.round;
  if (s.chapter) {
    const ch = CHAPTERS[s.chapter.key];
    pill.textContent = `${ch.emoji} Гл. ${s.chapter.n}: ${ch.title} · круг ${rounds}`;
  } else pill.textContent = `Круг ${rounds}`;
}

// ======================================================================= центр
function renderCenter(s) {
  const st = $('center-status');
  const ac = $('center-actions');
  let status = '';
  let btns = '';
  if (s.phase === 'ended') {
    status = s.winner >= 0 ? `🏆 Победа: ${tokName(s, s.winner)}!` : '🤝 Ничья!';
    btns = `<button class="btn btn-primary" data-a="showEnd">Итоги</button>`;
  } else {
    const t = s.turn;
    const cp = P(s, t.pid);
    const myTurn = mine(t.pid);
    const who = ctx.mode === 'local' ? `${tokName(s, t.pid)}` : myTurn ? 'Твой ход' : `Ходит ${tokName(s, t.pid)}`;
    const pend = s.pending;
    if (pend) {
      const actor = pend.type === 'auction' ? pend.turn : pend.pid;
      const labels = { buy: 'решает, покупать ли', auction: 'аукцион', card: 'читает карточку', rent: 'платит аренду' };
      status = pend.type === 'auction' ? `🔨 Аукцион: «${esc(BOARD[pend.cell].name)}»` : `${tokName(s, actor)} ${labels[pend.type]}…`;
      if (mine(actor)) btns = `<button class="btn btn-primary" data-a="reopen">Открыть решение</button>`;
    } else if (myTurn) {
      status = ctx.mode === 'local' ? `Ход: ${who}` : who + '!';
      if (t.stage === 'roll') {
        if (cp.inJail) {
          status += `<small>🚔 В обезьяннике · попытка ${cp.jailTries + 1} из 3</small>`;
          btns += `<button class="btn btn-primary" data-a="roll">🎲 Бросить на дубль</button>`;
          btns += `<button class="btn btn-secondary" data-a="payJail" ${cp.money < 50 ? 'disabled' : ''}>Штраф ${short(50)}</button>`;
          const law = cp.hand.find((h) => h.k === 'lawyer');
          if (law) btns += `<button class="btn btn-gold" data-a="useBonus" data-uid="${law.uid}">⚖️ Адвокат</button>`;
        } else {
          if (t.doubles > 0) status += `<small>Дубль! Бросай ещё раз</small>`;
          btns += `<button class="btn btn-primary" data-a="roll" ${cp.money < 0 ? 'disabled' : ''}>🎲 Бросить кубики</button>`;
        }
      } else if (t.stage === 'end') {
        status += `<small>Можно строить, меняться или играть карты</small>`;
        btns += `<button class="btn btn-primary" data-a="endTurn" ${cp.money < 0 ? 'disabled' : ''}>Завершить ход ➜</button>`;
      }
    } else {
      status = `${who}…`;
    }
    if (s.trade) {
      if (mine(s.trade.from)) btns += `<button class="btn btn-ghost btn-sm" data-a="tradeDecline" data-who="from">Отозвать обмен</button>`;
      else if (mine(s.trade.to)) btns += `<button class="btn btn-gold btn-sm" data-a="reopenTrade">🤝 Предложение обмена</button>`;
    }
    for (const p of s.players) {
      if (p.money < 0 && mine(p.id)) {
        const liq = liquidity(s, p.id);
        btns += `<div class="debt-box">${ctx.mode === 'local' ? esc(p.name) + ': ' : ''}долг ${money(-p.money)}. Продай постройки или заложи объекты во вкладке «Объекты».
          ${liq < 0 ? '<br>Денег не хватит даже после продажи всего.' : ''}
          <div style="margin-top:6px"><button class="btn btn-bad btn-sm" data-a="bankrupt" data-pid="${p.id}">💔 Объявить банкротство</button></div></div>`;
      }
    }
    if (s.settings.jackpot && s.jackpot > 0) status += `<small>💰 Джекпот Парка Горького: ${money(s.jackpot)}</small>`;
  }
  if (st.innerHTML !== status) st.innerHTML = status;
  if (ac.innerHTML !== btns) ac.innerHTML = btns;
}

// ======================================================================= игроки
function renderPlayers(s) {
  const box = $('players');
  const prev = view.prevMoney;
  box.innerHTML = s.players.map((p) => {
    const isTurn = s.phase === 'playing' && s.turn.pid === p.id;
    const owned = OWNABLE.filter((i) => s.props[i].owner === p.id).length;
    const meta = [
      `🏪 ${owned}`,
      `🃏 ${p.hand.length}`,
      `💎 ${short(netWorth(s, p.id))}`,
      p.inJail ? '🚔 в обезьяннике' : '',
      p.skip ? '🚧 пропуск хода' : '',
      ctx.mode !== 'local' && p.connected === false ? '<span class="off">⚠️ не в сети</span>' : '',
    ].filter(Boolean).join(' · ');
    return `<div class="pcard ${isTurn ? 'turn' : ''}" style="--pc:${p.color}" id="pcard-${p.id}">
      ${isTurn ? '<div class="badge-turn">ХОД</div>' : ''}
      <div class="row1"><div class="tk">${p.token}</div><div style="min-width:0"><div class="nm">${esc(p.name)}</div>${mine(p.id) && ctx.mode !== 'local' ? '<div class="me">это ты</div>' : ''}</div></div>
      <div class="money ${p.money < 0 ? 'neg' : ''}">${money(p.money)}</div>
      <div class="meta">${meta}</div>
    </div>`;
  }).join('');
  if (prev) {
    s.players.forEach((p) => {
      const d = p.money - (prev[p.id] ?? p.money);
      if (!d) return;
      const el = document.createElement('div');
      el.className = `money-fly ${d > 0 ? 'plus' : 'minus'}`;
      el.textContent = `${d > 0 ? '+' : '−'}${short(Math.abs(d))}`;
      $(`pcard-${p.id}`).appendChild(el);
      if (mine(p.id)) (d > 0 ? sfx.coin : sfx.pay)();
    });
  }
  view.prevMoney = s.players.map((p) => p.money);
}

// ======================================================================= объекты
function propRowActions(s, i, pid) {
  if (!mine(pid) || s.phase !== 'playing') return '';
  const c = BOARD[i], pr = s.props[i];
  const out = [];
  if (c.type === 'property' && ownsGroup(s, pid, c.group)) {
    const eb = can.build(s, pid, i) || (s.turn.pid !== pid ? 'Строить можно в свой ход' : s.pending ? 'Сначала закончи действие' : null);
    if (pr.houses < 5) out.push(`<button class="btn btn-good btn-xs" data-a="build" data-cell="${i}" ${eb ? `disabled title="${esc(eb)}"` : `title="Построить за ${short(houseCost(s, i))}"`}>+🏠</button>`);
    if (pr.houses > 0) {
      const es = can.sell(s, pid, i);
      out.push(`<button class="btn btn-ghost btn-xs" data-a="sell" data-cell="${i}" ${es ? `disabled title="${esc(es)}"` : ''}>−🏠</button>`);
    }
  }
  if (pr.mortgaged) out.push(`<button class="btn btn-secondary btn-xs" data-a="unmortgage" data-cell="${i}" ${P(s, pid).money < unmortgageCost(i) ? 'disabled' : ''} title="Выкуп за ${short(unmortgageCost(i))}">Выкуп</button>`);
  else {
    const em = can.mortgage(s, pid, i);
    out.push(`<button class="btn btn-ghost btn-xs" data-a="mortgage" data-cell="${i}" ${em ? `disabled title="${esc(em)}"` : `title="Получить ${short(BOARD[i].price / 2)}"`}>Залог</button>`);
  }
  return out.join('');
}

function propSub(s, i) {
  const pr = s.props[i];
  const parts = [];
  if (pr.mortgaged) parts.push('🏦 в залоге');
  else if (isClosed(s, i)) parts.push('🔍 закрыт');
  else parts.push(`аренда ${short(rentPreview(s, i))}`);
  if (pr.houses) parts.push(pr.houses === 5 ? '🏨 отель' : `🏠×${pr.houses}`);
  return parts.join(' · ');
}

function rentPreview(s, i) {
  if (BOARD[i].type === 'utility') return calcRent(s, i, { utilDice: 7 });
  return calcRent(s, i);
}

function renderProps(s) {
  const order = [...ctx.myPids, ...s.players.map((p) => p.id).filter((id) => !ctx.myPids.includes(id))];
  const uniq = [...new Set(order)];
  let html = `<div class="note" style="font-size:12px;color:var(--muted);margin-bottom:8px">🏦 В банке: 🏠 ${s.bank.houses} · 🏨 ${s.bank.hotels}${s.settings.jackpot ? ` · 💰 джекпот ${short(s.jackpot)}` : ''}</div>`;
  for (const pid of uniq) {
    const p = P(s, pid);
    const owned = OWNABLE.filter((i) => s.props[i].owner === pid);
    html += `<div class="owner-sec"><h4><span style="color:${p.color}">${p.token}</span> ${esc(p.name)} ${mine(pid) && ctx.mode !== 'local' ? '(ты)' : ''}</h4>`;
    if (!owned.length) html += `<div class="empty-note">Пока ничего нет</div>`;
    const groups = {};
    for (const i of owned) {
      const c = BOARD[i];
      const g = c.type === 'property' ? c.group : c.type;
      (groups[g] = groups[g] || []).push(i);
    }
    for (const [g, cells] of Object.entries(groups)) {
      const gd = GROUPS[g];
      const title = gd ? `${gd.name}${ownsGroup(s, pid, g) ? ' · монополия ✨' : ` · ${cells.length}/${groupCells(g).length}`}` : g === 'transport' ? `Транспорт · ${cells.length}/4` : `Сервисы · ${cells.length}/2`;
      const color = gd ? gd.color : g === 'transport' ? '#8a7f99' : '#6fa8b8';
      html += `<div class="grp"><div class="grp-h" style="background:${color}"><span>${title}</span></div>`;
      for (const i of cells) {
        html += `<div class="prow"><div class="pn" data-a="deed" data-cell="${i}">${BOARD[i].emoji} ${esc(BOARD[i].name)}<small>${propSub(s, i)}</small></div><div class="acts">${propRowActions(s, i, pid)}</div></div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  if (s.phase === 'playing' && !s.trade) {
    html += `<button class="btn btn-secondary" style="width:100%;margin-top:12px" data-a="tradeOpen">🤝 Предложить обмен</button>`;
  }
  $('tab-props').innerHTML = html;
}

// ======================================================================= карты
function renderCards(s) {
  let html = '';
  let myCount = 0;
  for (const p of s.players) {
    const own = mine(p.id);
    if (own) myCount += p.hand.length;
    html += `<div class="owner-sec"><h4><span style="color:${p.color}">${p.token}</span> ${esc(p.name)}</h4>`;
    if (!p.hand.length) html += `<div class="empty-note">${own ? 'Бонусных карт нет. Их дают «Шанс», «Копилка» и задания глав.' : 'Карт нет'}</div>`;
    for (const h of p.hand) {
      const b = BONUS[h.k];
      const playable = own && ['lawyer', 'taxi', 'traffic', 'inspection', 'deal'].includes(h.k) && s.phase === 'playing';
      html += `<div class="bcard ${b.kind}"><div class="be">${b.emoji}</div><div class="bt"><b>${b.name}</b>${b.text}<br><small>${b.when}</small></div>
        ${playable ? `<button class="btn btn-primary btn-sm" data-a="useBonus" data-uid="${h.uid}" ${s.turn.pid !== p.id ? 'disabled' : ''}>Сыграть</button>` : ''}</div>`;
    }
    html += `</div>`;
  }
  $('tab-cards').innerHTML = html;
  $('cards-count').textContent = myCount || '';
}

// ======================================================================= сюжет
function storyText(s, ch) {
  return esc(ch.story);
}

function questHTML(s) {
  const c = s.chapter;
  const q = CHAPTERS[c.key].quest;
  if (!q) return '';
  const reward = [q.money ? money(q.money) : '', q.bonus ? `карта «${BONUS[q.bonus].emoji} ${BONUS[q.bonus].name}»` : ''].filter(Boolean).join(' + ');
  if (c.questDone) return `<div class="quest">🏅 Задание «${esc(q.text)}» выполнено: ${tokName(s, c.questWinner)}</div>`;
  const bars = s.players.map((p) => {
    const v = Math.min(q.n, (c.progress[p.id] && c.progress[p.id][q.kind]) || 0);
    return `<div>${p.token} ${q.kind === 'rentSum' ? short(v) : v}/${q.kind === 'rentSum' ? short(q.n) : q.n}<div class="bar"><i style="width:${(v / q.n) * 100}%;background:${p.color}"></i></div></div>`;
  }).join('');
  return `<div class="quest">🎯 <b>Задание главы:</b> ${esc(q.text)}<br>Награда первому: ${reward}<div class="qp">${bars}</div></div>`;
}

function renderStory(s) {
  let html = '';
  if (s.chapter) {
    const ch = CHAPTERS[s.chapter.key];
    const left = s.settings.maxRounds && s.chapter.key === 'final' ? '' : `<p class="note" style="font-size:12px;color:var(--muted)">Следующая глава через ${Math.max(1, s.settings.chapterLen - (s.round - s.chapter.startRound))} кр.</p>`;
    html += `<div class="story-card"><div class="se">${ch.emoji}</div><div class="note" style="font-size:12px;font-weight:900;color:var(--muted)">ГЛАВА ${s.chapter.n}</div>
      <h3>${ch.title}</h3><p>${storyText(s, ch)}</p><div class="effect">⚡ ${esc(ch.effect)}</div>${questHTML(s)}${left}</div>`;
    const past = s.log.filter((l) => l.kind === 'chapter');
    if (past.length > 1) html += `<h4 style="margin:14px 0 6px;font-size:14px">📚 Летопись</h4>` + past.map((l) => `<div class="note" style="font-size:12px;margin-bottom:4px">${esc(l.text)}</div>`).join('');
  } else {
    html += `<div class="empty-note">Сюжетные главы выключены — классическая игра.</div>`;
  }
  const st = s.settings;
  html += `<div class="rules-mini"><b>Правила этой партии:</b><br>
    Зарплата на Старте: <b>${money(salary(s))}</b>${st.doubleGo ? ' (×2 при точном попадании)' : ''}<br>
    Аукционы: <b>${st.auctions ? 'да' : 'нет'}</b> · Джекпот: <b>${st.jackpot ? 'да' : 'нет'}</b><br>
    Длина игры: <b>${st.maxRounds ? `${st.maxRounds} кругов` : 'до банкротства'}</b></div>`;
  $('tab-story').innerHTML = html;
}

// ======================================================================= журнал
function renderLog(s) {
  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = s.log.map((l) => {
    if (l.kind === 'chat') {
      const p = s.players[l.pid];
      return `<div class="e chat" style="--pc:${p ? p.color : '#000'}"><b>${p ? p.token + ' ' + esc(p.name) : ''}:</b> ${esc(l.text)}</div>`;
    }
    return `<div class="e ${l.kind}">${esc(l.text)}</div>`;
  }).join('');
  if (atBottom || view.tab !== 'log') box.scrollTop = box.scrollHeight;
}

function processNewLog(s) {
  const fresh = s.log.filter((l) => l.id > view.lastLogId);
  if (!s.log.length) return;
  view.lastLogId = s.log[s.log.length - 1].id;
  if (fresh.length > 12) return; // после переподключения не спамим
  for (const l of fresh) {
    const fromOther = l.pid !== null && !mine(l.pid);
    switch (l.kind) {
      case 'news': toast(`📰 ${l.text}`, 'news'); break;
      case 'quest': toast(l.text, 'quest'); break;
      case 'chapter': sfx.chapter(); break;
      case 'chat': if (fromOther) { toast(`💬 ${s.players[l.pid].name}: ${l.text}`); sfx.pop(); } break;
      case 'rent': case 'bonus': case 'trade': toast(l.text); break;
      case 'jail': if (/отправляется/.test(l.text)) toast(l.text); break;
      case 'buy': case 'auction': if (fromOther || /Продано/.test(l.text)) toast(l.text); break;
      case 'build': sfx.build(); break;
      case 'turn': if (l.pid !== null && mine(l.pid) && ctx.mode !== 'local') { sfx.turn(); vibrate(60); } break;
      default:
    }
    if (view.tab !== 'log' && (l.kind === 'chat' && fromOther)) view.unreadLog++;
  }
  $('log-dot').textContent = view.unreadLog ? view.unreadLog : '';
}

// ======================================================================= модальные окна
function openManual(m) { view.manual = m; renderModal(view.shown || view.latest, true); }
function closeManual() { view.manual = null; renderModal(view.shown || view.latest, true); }

function autoModal(s) {
  if (!s) return null;
  if (s.phase === 'ended') return { kind: 'end', key: `end:${s.winner}:${s.log.length ? s.log[s.log.length - 1].id : 0}` };
  if (s.chapter && view.seenChapter !== null && s.chapter.n > view.seenChapter) return { kind: 'chapter', key: `ch:${s.chapter.n}` };
  const p = s.pending;
  if (p) {
    const key = `${JSON.stringify(p)}:${s.turn.n}`;
    if (p.type === 'card') return { kind: 'card', key };
    if (p.type === 'auction') return { kind: 'auction', key: `${key}:${P(s, p.turn).money}` };
    if (p.type === 'buy' && mine(p.pid)) return { kind: 'buy', key: `${key}:${P(s, p.pid).money}` };
    if (p.type === 'rent' && mine(p.pid)) return { kind: 'rent', key };
  }
  if (s.trade && mine(s.trade.to)) return { kind: 'tradeIn', key: `trade:${s.trade.id}` };
  return null;
}

function renderModal(s, force = false) {
  const root = $('modal-root');
  if (!s) return;
  let desc = view.manual;
  if (!desc && !view.animating) {
    desc = autoModal(s);
    if (desc && desc.key === view.hiddenKey) desc = null;
  }
  if (!desc) { if (root.innerHTML) root.innerHTML = ''; view.modalKey = ''; return; }
  const content = MODALS[desc.kind](s, desc);
  if (!content) { root.innerHTML = ''; view.modalKey = ''; return; }
  const key = `${desc.kind}:${desc.key || ''}:${content.key || ''}`;
  if (!force && key === view.modalKey && root.innerHTML) return;
  view.modalKey = key;
  root.innerHTML = `<div class="modal-back" data-a="${content.closable === false ? '' : 'backdrop'}">
    <div class="modal ${content.wide ? 'wide' : ''}" data-modal="1">
      ${content.closable === false ? '' : `<button class="x" data-a="${content.close || 'close'}">✕</button>`}
      <div class="modal-body">${content.html}</div></div></div>`;
  if (content.after) content.after(root);
  if (desc.kind === 'card') sfx.card();
}

function deedHTML(s, i, compact = false) {
  const c = BOARD[i];
  const pr = s.props[i] || { owner: -1, houses: 0 };
  const color = c.type === 'property' ? GROUPS[c.group].color : c.type === 'transport' ? '#8a7f99' : c.type === 'utility' ? '#6fa8b8' : '#ff8cc0';
  const gname = c.type === 'property' ? GROUPS[c.group].name : c.type === 'transport' ? 'Транспорт' : c.type === 'utility' ? 'Сервис' : '';
  let body = `<p class="desc">${esc(c.desc || '')}</p>`;
  const m = mods(s);
  if (c.type === 'property') {
    const rows = [
      ['Аренда', c.rent[0]], ['Монополия (без домов)', c.rent[0] * 2], ['С 1 домом', c.rent[1]], ['С 2 домами', c.rent[2]],
      ['С 3 домами', c.rent[3]], ['С 4 домами', c.rent[4]], ['С отелем 🏨', c.rent[5]],
    ];
    const curIdx = pr.owner >= 0 ? (pr.houses ? pr.houses + 1 : ownsGroup(s, pr.owner, c.group) ? 1 : 0) : -1;
    if (!compact) body += `<table>${rows.map(([t, v], k) => `<tr class="${k === curIdx ? 'cur' : ''}"><td>${t}</td><td>${short(v)}</td></tr>`).join('')}</table><hr>`;
    body += `<table><tr><td>Дом / отель</td><td>${short(houseCost(s, i))}${m.buildMult ? ' ⚡' : ''}</td></tr>`;
  } else if (c.type === 'transport') {
    if (!compact) body += `<table>${TRANSPORT_RENT.map((v, k) => `<tr><td>${k + 1} транспорт${k ? 'а' : ''}</td><td>${short(v)}</td></tr>`).join('')}</table><hr>`;
    body += '<table>';
  } else if (c.type === 'utility') {
    body += `<table><tr><td>1 сервис</td><td>кубики × 4</td></tr><tr><td>2 сервиса</td><td>кубики × 10</td></tr>`;
  } else {
    return `<div class="deed"><div class="deed-h" style="background:${color}"><div class="de">${c.emoji}</div><div class="dn">${esc(c.name)}</div></div><div class="deed-b"><p>${esc(c.desc)}</p>${c.type === 'go' ? `<p>Сейчас зарплата: <b>${money(salary(s))}</b></p>` : ''}${c.type === 'tax' ? `<p>Сейчас: <b>${money(Math.round(c.amount * (m.taxMult || 1)))}</b></p>` : ''}${c.type === 'parking' && s.settings.jackpot ? `<p>Джекпот: <b>${money(s.jackpot)}</b></p>` : ''}</div></div>`;
  }
  body += `<tr><td>Залог</td><td>${short(c.price / 2)}</td></tr></table>`;
  const tags = [];
  if (pr.owner >= 0) {
    tags.push(`<span class="tag" style="background:${P(s, pr.owner).color};color:#fff">${tokName(s, pr.owner)}</span>`);
    if (pr.mortgaged) tags.push('<span class="tag bad">🏦 в залоге</span>');
    else if (isClosed(s, i)) tags.push('<span class="tag bad">🔍 закрыт проверкой</span>');
    else tags.push(`<span class="tag good">аренда сейчас: ${c.type === 'utility' ? 'бросок × ' + (calcRent(s, i, { utilDice: 1 })) : money(calcRent(s, i))}</span>`);
  } else if (s.props[i]) tags.push('<span class="tag">свободен</span>');
  return `<div class="deed"><div class="deed-h" style="background:${color}"><div class="de">${c.emoji}</div><div class="dg">${gname}</div><div class="dn">${esc(c.name)}</div><div style="font-weight:800">${money(c.price)}</div></div>
    <div class="deed-b">${body}${tags.length ? `<div style="margin-top:8px">${tags.join(' ')}</div>` : ''}</div></div>`;
}

const MODALS = {
  deed(s, d) {
    const i = d.cell;
    const pr = s.props[i];
    let actions = '';
    if (pr && pr.owner >= 0 && mine(pr.owner)) actions = `<div class="modal-actions">${propRowActions(s, i, pr.owner).replace(/btn-xs/g, 'btn-sm')}</div>`;
    return { html: deedHTML(s, i) + actions, key: JSON.stringify(pr) + (pr && pr.owner >= 0 ? P(s, pr.owner).money : '') + s.turn?.pid };
  },

  rules() { return { html: `<h3>📖 Правила</h3>${rulesHTML()}`, wide: true }; },

  menu(s) {
    const host = ctx.myPids.includes(0);
    return {
      html: `<h3>Меню</h3><div style="display:grid;gap:8px">
        <button class="btn btn-ghost" data-a="rules">📖 Правила</button>
        ${s.phase === 'playing' && host ? '<button class="btn btn-ghost" data-a="finish">🏁 Закончить игру и подсчитать капитал</button>' : ''}
        ${s.phase === 'playing' ? `<button class="btn btn-bad" data-a="bankrupt" data-pid="${ctx.mode === 'local' ? s.turn.pid : ctx.myPids[0]}">🏳️ Сдаться</button>` : ''}
        <button class="btn btn-secondary" data-a="leave">🚪 Выйти в главное меню</button>
        <p class="note">${ctx.mode === 'guest' ? 'Если выйдешь, сможешь вернуться по тому же коду комнаты.' : 'Игра сохраняется на этом устройстве — её можно продолжить из главного меню.'}</p></div>`,
    };
  },

  confirm(s, d) {
    return { html: `<h3>${d.title}</h3><p>${d.text}</p><div class="modal-actions"><button class="btn btn-ghost" data-a="close">Отмена</button><button class="btn btn-bad" data-a="confirmYes">${d.yes}</button></div>` };
  },

  chapter(s) {
    const ch = CHAPTERS[s.chapter.key];
    const leader = s.players.length === 2 ? (() => {
      const w = s.players.map((p) => netWorth(s, p.id));
      if (s.chapter.n === 1 || w[0] === w[1]) return '';
      const l = w[0] > w[1] ? 0 : 1;
      return `<p class="note">📊 Сейчас лидирует ${tokName(s, l)} — капитал ${money(w[l])}. Но всё может измениться!</p>`;
    })() : '';
    return {
      closable: false,
      html: `<div class="chapter-modal"><div class="num">Глава ${s.chapter.n}</div><div class="big">${ch.emoji}</div><h3>${ch.title}</h3>
        <div class="story">${storyText(s, ch)}</div><div class="effect" style="margin-top:10px">⚡ ${esc(ch.effect)}</div>${questHTML(s)}${leader}
        <div class="modal-actions"><button class="btn btn-primary btn-big" data-a="chapterOk">Вперёд! ✨</button></div></div>`,
    };
  },

  card(s) {
    const p = s.pending;
    const card = (p.deck === 'chance' ? CHANCE : CHEST)[p.idx];
    const actor = mine(p.pid);
    return {
      close: actor ? 'minimize' : 'minimize',
      html: `<div class="chance-card ${p.deck} flip"><div class="ck">${p.deck === 'chance' ? '🎲 Шанс' : '🐷 Копилка'}</div><div class="cem">${card.emoji}</div><h4>${esc(card.title)}</h4><p>${esc(card.text)}</p></div>
        <div class="modal-actions">${actor ? `<button class="btn btn-primary btn-big" data-a="cardOk">${ctx.mode === 'local' ? `${esc(P(s, p.pid).name)}: ` : ''}Окей!</button>` : `<p class="note" style="text-align:center;width:100%">Карту вытягивает ${tokName(s, p.pid)}…</p>`}</div>`,
    };
  },

  buy(s) {
    const p = s.pending;
    const pl = P(s, p.pid);
    const promo = pl.hand.find((h) => h.k === 'promo');
    const half = Math.round(p.price / 2);
    const disc = p.price !== BOARD[p.cell].price ? ` <s style="opacity:.6">${short(BOARD[p.cell].price)}</s>` : '';
    return {
      close: 'minimize',
      html: `${ctx.mode === 'local' ? `<p class="note">${tokName(s, p.pid)}</p>` : ''}${deedHTML(s, p.cell)}
        <p class="note" style="text-align:center">У тебя: <b>${money(pl.money)}</b></p>
        <div class="modal-actions">
          <button class="btn btn-primary" data-a="buy" ${pl.money < p.price ? 'disabled' : ''}>Купить за ${short(p.price)}${disc}</button>
          ${promo ? `<button class="btn btn-gold" data-a="buyPromo" ${pl.money < half ? 'disabled' : ''}>🏷️ С промокодом за ${short(half)}</button>` : ''}
          <button class="btn btn-ghost" data-a="decline">${s.settings.auctions ? 'На аукцион 🔨' : 'Отказаться'}</button>
        </div>
        ${pl.money < p.price ? '<p class="note" style="text-align:center">Не хватает денег — можно заложить объекты (сверни окно) или выставить на аукцион.</p>' : ''}`,
    };
  },

  auction(s) {
    const p = s.pending;
    const actor = mine(p.turn);
    const pl = P(s, p.turn);
    const steps = [10, 50, 100];
    return {
      close: 'minimize',
      html: `<h3>🔨 Аукцион</h3>${deedHTML(s, p.cell, true)}
        <div class="auction-bid"><div class="note">Текущая ставка</div><div class="ab">${p.bid ? money(p.bid) : '—'}</div>
          <div class="note">${p.bidder >= 0 ? `у ${tokName(s, p.bidder)}` : 'ставок ещё нет'} · цена банка ${short(BOARD[p.cell].price)}</div></div>
        ${actor ? `<p class="note" style="text-align:center">${ctx.mode === 'local' ? tokName(s, p.turn) + ', твоя' : 'Твоя'} ставка (есть ${money(pl.money)})</p>
          <div class="bid-btns">${steps.map((d) => `<button class="btn btn-secondary btn-sm" data-a="bid" data-amt="${Math.max(10, p.bid + d)}" ${Math.max(10, p.bid + d) > pl.money ? 'disabled' : ''}>${short(Math.max(10, p.bid + d))}</button>`).join('')}</div>
          <div class="bid-custom"><input class="num-input" id="bid-input" type="number" inputmode="numeric" min="${p.bid + 1}" placeholder="Своя ставка, тыс. ₽" /><button class="btn btn-primary btn-sm" data-a="bidCustom">Ставка</button></div>
          <div class="modal-actions"><button class="btn btn-ghost" data-a="pass">${p.bidder >= 0 ? `Пас (объект уйдёт ${esc(P(s, p.bidder).name)})` : 'Пас'}</button></div>`
        : `<p class="note" style="text-align:center">Ставку делает ${tokName(s, p.turn)}…</p>`}`,
    };
  },

  rent(s) {
    const p = s.pending;
    return {
      close: 'minimize',
      html: `<h3>Аренда</h3><p>«${esc(BOARD[p.cell].name)}» принадлежит ${tokName(s, p.to)}. Аренда: <b>${money(p.amount)}</b>.</p>
        <p>У тебя есть карта <b>🤝 Блат</b> — можно не платить!</p>
        <div class="modal-actions"><button class="btn btn-gold" data-a="rentBlat">🤝 Включить блат</button><button class="btn btn-ghost" data-a="rentPay">Заплатить</button></div>`,
    };
  },

  tradeIn(s) {
    const t = s.trade;
    return {
      close: 'minimize',
      wide: true,
      html: `<h3>🤝 Предложение обмена</h3><p>${tokName(s, t.from)} предлагает сделку${ctx.mode === 'local' ? ` для ${tokName(s, t.to)}` : ''}:</p>
        <div class="trade-summary"><div class="ts-row"><div><b>${ctx.mode === 'local' ? esc(P(s, t.to).name) + ' получает' : 'Ты получаешь'}:</b>${sideList(s, t.give)}</div><div>⇄</div><div><b>${ctx.mode === 'local' ? esc(P(s, t.to).name) + ' отдаёт' : 'Ты отдаёшь'}:</b>${sideList(s, t.get)}</div></div></div>
        <div class="modal-actions"><button class="btn btn-good" data-a="tradeAccept">Принять ✅</button><button class="btn btn-bad" data-a="tradeDecline" data-who="to">Отклонить</button></div>`,
    };
  },

  trade(s) {
    const d = view.tradeDraft;
    const me = d.from, op = d.to;
    const col = (pid, side) => {
      const owned = OWNABLE.filter((i) => s.props[i].owner === pid);
      const items = owned.map((i) => {
        const c = BOARD[i];
        const blocked = c.type === 'property' && groupCells(c.group).some((j) => s.props[j].houses > 0);
        const color = c.type === 'property' ? GROUPS[c.group].color : '#b9a9c9';
        const on = d[side].props.includes(i);
        return `<label class="titem ${blocked ? 'dis' : ''}"><input type="checkbox" data-tr="${side}" data-cell="${i}" ${on ? 'checked' : ''} ${blocked ? 'disabled' : ''}/><span class="sw" style="background:${color}"></span>${c.emoji} ${esc(c.name)}${s.props[i].mortgaged ? ' 🏦' : ''}</label>`;
      }).join('') || '<div class="empty-note">Нет объектов</div>';
      const cards = P(s, pid).hand.map((h) => `<label class="titem"><input type="checkbox" data-trb="${side}" data-uid="${h.uid}" ${d[side].bonus.includes(h.uid) ? 'checked' : ''}/>${BONUS[h.k].emoji} ${BONUS[h.k].name}</label>`).join('');
      return `${items}${cards}<label class="note" style="display:block;margin-top:6px">Деньги (тыс. ₽, есть ${short(Math.max(0, P(s, pid).money))}):</label>
        <input class="num-input" type="number" inputmode="numeric" min="0" data-trm="${side}" value="${d[side].money || ''}" placeholder="0"/>`;
    };
    return {
      wide: true,
      html: `<h3>🤝 Обмен с ${tokName(s, op)}</h3>
        <div class="trade-cols"><div class="trade-col"><h4>${ctx.mode === 'local' ? esc(P(s, me).name) + ' отдаёт' : 'Ты отдаёшь'}</h4>${col(me, 'give')}</div>
        <div class="trade-col"><h4>${ctx.mode === 'local' ? esc(P(s, me).name) + ' получает' : 'Ты получаешь'}</h4>${col(op, 'get')}</div></div>
        <p class="note">Объекты из групп с постройками менять нельзя. За заложенный объект получатель платит банку 10%.</p>
        <div class="modal-actions"><button class="btn btn-ghost" data-a="close">Отмена</button><button class="btn btn-primary" data-a="tradeSend">Отправить предложение</button></div>`,
    };
  },

  target(s, d) {
    const h = P(s, d.pid).hand.find((x) => x.uid === d.uid);
    if (!h) return null;
    const b = BONUS[h.k];
    const op = (d.pid + 1) % s.players.length;
    const list = OWNABLE.filter((i) => s.props[i].owner === op).filter((i) => {
      if (h.k !== 'deal') return true;
      const c = BOARD[i];
      return !(c.type === 'property' && groupCells(c.group).some((j) => s.props[j].houses > 0));
    });
    const items = list.map((i) => {
      const c = BOARD[i];
      const extra = h.k === 'deal' ? ` — ${short(Math.ceil(c.price * 1.5))}` : isClosed(s, i) ? ' (уже закрыт)' : ` — аренда ${short(rentPreview(s, i))}`;
      return `<button class="titem" style="width:100%;text-align:left" data-a="target" data-cell="${i}"><span class="sw" style="background:${c.type === 'property' ? GROUPS[c.group].color : '#b9a9c9'}"></span>${c.emoji} ${esc(c.name)}${extra}</button>`;
    }).join('') || '<div class="empty-note">У соперника нет подходящих объектов</div>';
    return { html: `<h3>${b.emoji} ${b.name}</h3><p>${b.text}</p><p class="note">Выбери объект ${tokName(s, op)}:</p>${items}` };
  },

  end(s) {
    const w = s.winner;
    const reasons = { bankrupt: 'Соперник обанкротился', rounds: 'Закончились круги — победил самый богатый', manual: 'Игра завершена — подсчёт капитала' };
    const rows = [
      ['Капитал', (p) => money(s.results[p.id].worth)],
      ['Деньги', (p) => money(p.money)],
      ['Объектов', (p) => s.results[p.id].props],
      ['Монополий', (p) => s.results[p.id].monopolies],
      ['Получено аренды', (p) => money(p.stats.rentGot)],
      ['Заплачено аренды', (p) => money(p.stats.rentPaid)],
      ['Самая большая аренда', (p) => money(p.stats.maxRent)],
      ['Куплено объектов', (p) => p.stats.bought],
      ['Построено', (p) => p.stats.built],
      ['Дублей', (p) => p.stats.doubles],
      ['Раз в обезьяннике', (p) => p.stats.jail],
      ['Карточек вытянуто', (p) => p.stats.cards],
    ];
    const title = w >= 0 ? (ctx.mode !== 'local' ? (mine(w) ? 'Ты победил(а)! 🎉' : `Победа: ${tokName(s, w)}`) : `Победа: ${tokName(s, w)}`) : 'Ничья!';
    return {
      wide: true,
      close: 'hideEnd',
      html: `<div class="end-modal"><div class="crown">${w >= 0 ? P(s, w).token : '🤝'}👑</div><h3>${title}</h3><p class="note">${reasons[s.endReason] || ''} · кругов сыграно: ${s.round}</p>
        <table class="end-table"><tr><th></th>${s.players.map((p) => `<th style="color:${p.color}">${p.token} ${esc(p.name)}</th>`).join('')}</tr>
        ${rows.map(([t, f]) => `<tr><td>${t}</td>${s.players.map((p) => `<td>${f(p)}</td>`).join('')}</tr>`).join('')}</table>
        <p>${w >= 0 ? `${esc(P(s, w).name)} выбирает, куда пойти на следующее свидание 💗` : 'Свидание выбираете вместе 💗'}</p>
        <div class="modal-actions"><button class="btn btn-primary" data-a="rematch">🔁 Реванш</button><button class="btn btn-ghost" data-a="leave">В меню</button></div></div>`,
    };
  },
};

function sideList(s, side) {
  const items = side.props.map((i) => `<li>${BOARD[i].emoji} ${esc(BOARD[i].name)}${s.props[i].mortgaged ? ' 🏦' : ''}</li>`);
  if (side.money) items.push(`<li>💰 ${money(side.money)}</li>`);
  for (const uid of side.bonus) {
    const h = s.players.flatMap((p) => p.hand).find((x) => x.uid === uid);
    if (h) items.push(`<li>${BONUS[h.k].emoji} ${BONUS[h.k].name}</li>`);
  }
  return items.length ? `<ul>${items.join('')}</ul>` : '<p class="note">ничего</p>';
}

// ======================================================================= клики
function actorFor(type, el) {
  const s = view.latest;
  if (ctx.mode !== 'local') return ctx.myPids[0];
  const cell = el && el.dataset.cell !== undefined ? Number(el.dataset.cell) : null;
  switch (type) {
    case 'bid': case 'pass': return s.pending.turn;
    case 'buy': case 'decline': case 'cardOk': case 'rentPay': case 'rentBlat': return s.pending.pid;
    case 'tradeAccept': return s.trade.to;
    case 'tradeDecline': return el && el.dataset.who === 'from' ? s.trade.from : s.trade.to;
    case 'sell': case 'mortgage': case 'unmortgage': case 'build': return s.props[cell].owner;
    default: return s.turn ? s.turn.pid : 0;
  }
}

function send(action, pid) {
  ctx.dispatch(action, pid ?? actorFor(action.type));
}

function onClick(e) {
  if ($('screen-game').classList.contains('hidden') && !e.target.closest('#modal-root')) return;
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a;
  if (!a) return;
  if (a === 'backdrop') {
    if (e.target !== el) return; // клик внутри окна
    const btn = el.querySelector('.x');
    if (btn) btn.click();
    return;
  }
  if (el.disabled) return;
  const s = view.latest;
  const cell = el.dataset.cell !== undefined ? Number(el.dataset.cell) : null;
  switch (a) {
    case 'deed': openManual({ kind: 'deed', cell }); break;
    case 'close': closeManual(); break;
    case 'minimize': view.hiddenKey = (autoModal(s) || {}).key; view.manual = null; renderModal(s, true); break;
    case 'reopen': view.hiddenKey = null; view.manual = null; renderModal(s, true); break;
    case 'reopenTrade': view.hiddenKey = null; view.manual = null; renderModal(s, true); break;
    case 'hideEnd': view.hiddenKey = (autoModal(s) || {}).key; renderModal(s, true); break;
    case 'showEnd': view.hiddenKey = null; renderModal(s, true); break;
    case 'rules': openManual({ kind: 'rules' }); break;
    case 'leave': view.manual = null; $('modal-root').innerHTML = ''; ctx.leave(); break;
    case 'chapterOk': view.seenChapter = s.chapter.n; renderModal(s, true); break;
    case 'react': send({ type: 'react', emoji: el.dataset.e }); break;
    case 'roll': case 'endTurn': case 'payJail': case 'decline': case 'cardOk': case 'pass': case 'rentPay': case 'rentBlat':
    case 'tradeAccept': case 'rematch':
      if (a === 'cardOk' || a === 'tradeAccept') view.manual = null;
      send({ type: a }, actorFor(a, el));
      break;
    case 'tradeDecline': send({ type: 'tradeDecline' }, actorFor(a, el)); break;
    case 'buy': send({ type: 'buy' }); break;
    case 'buyPromo': send({ type: 'buy', promo: true }, actorFor('buy')); break;
    case 'bid': send({ type: 'bid', amount: Number(el.dataset.amt) }); break;
    case 'bidCustom': {
      const v = Math.floor(Number($('bid-input').value));
      if (!v) { toast('Введи сумму ставки в тысячах рублей', 'err'); return; }
      send({ type: 'bid', amount: v }, actorFor('bid'));
      break;
    }
    case 'build': case 'sell': case 'mortgage': case 'unmortgage':
      send({ type: a, cell }, actorFor(a, el));
      break;
    case 'useBonus': {
      const uid = Number(el.dataset.uid);
      const pid = s.players.find((p) => p.hand.some((h) => h.uid === uid)).id;
      const h = P(s, pid).hand.find((x) => x.uid === uid);
      if (h.k === 'inspection' || h.k === 'deal') openManual({ kind: 'target', uid, pid });
      else send({ type: 'useBonus', uid }, pid);
      break;
    }
    case 'target': {
      const m = view.manual;
      view.manual = null;
      send({ type: 'useBonus', uid: m.uid, target: cell }, m.pid);
      renderModal(s, true);
      break;
    }
    case 'tradeOpen': {
      const from = ctx.mode === 'local' ? s.turn.pid : ctx.myPids[0];
      view.tradeDraft = { from, to: (from + 1) % s.players.length, give: { props: [], money: 0, bonus: [] }, get: { props: [], money: 0, bonus: [] } };
      openManual({ kind: 'trade' });
      bindTradeInputs();
      break;
    }
    case 'tradeSend': {
      const d = view.tradeDraft;
      view.manual = null;
      send({ type: 'tradePropose', give: d.give, get: d.get }, d.from);
      renderModal(s, true);
      break;
    }
    case 'bankrupt': {
      const pid = Number(el.dataset.pid);
      openManual({ kind: 'confirm', title: '💔 Банкротство', text: `${esc(P(s, pid).name)} сдаётся, и игра заканчивается. Уверен(а)?`, yes: 'Да, сдаюсь', action: { type: 'bankrupt' }, pid });
      break;
    }
    case 'finish':
      openManual({ kind: 'confirm', title: '🏁 Закончить игру', text: 'Игра завершится, победит тот, у кого больше капитал. Продолжить?', yes: 'Закончить', action: { type: 'finish' }, pid: 0 });
      break;
    case 'confirmYes': {
      const m = view.manual;
      view.manual = null;
      send(m.action, m.pid);
      renderModal(s, true);
      break;
    }
    default:
  }
}

function bindTradeInputs() {
  const root = $('modal-root');
  root.oninput = (e) => {
    const t = e.target;
    if (t.dataset.trm) view.tradeDraft[t.dataset.trm].money = Math.max(0, Math.floor(Number(t.value) || 0));
  };
  root.onchange = (e) => {
    const t = e.target;
    const d = view.tradeDraft;
    if (t.dataset.tr) {
      const arr = d[t.dataset.tr].props;
      const i = Number(t.dataset.cell);
      if (t.checked) arr.push(i); else arr.splice(arr.indexOf(i), 1);
    }
    if (t.dataset.trb) {
      const arr = d[t.dataset.trb].bonus;
      const uid = Number(t.dataset.uid);
      if (t.checked) arr.push(uid); else arr.splice(arr.indexOf(uid), 1);
    }
  };
}

export function showError(msg) { toast(msg, 'err'); sfx.err(); }

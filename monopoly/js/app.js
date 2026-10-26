// Главный модуль: меню, лобби, сеть, сохранение.
import { createState, addPlayer, act } from './engine.js';
import { TOKENS, COLORS } from './data.js';
import { Host, Guest, makeCode, normCode } from './net.js';
import * as G from './game.js';
import { toast, bgHearts, esc } from './fx.js';
import { rulesHTML } from './rules.js';

const $ = (id) => document.getElementById(id);

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* переполнение или приватный режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

const rid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const clientId = store.get('rm_client') || rid();
store.set('rm_client', clientId);

let profile = store.get('rm_profile') || {
  name: '',
  token: TOKENS[Math.floor(Math.random() * TOKENS.length)].e,
  color: COLORS[0],
};

const app = {
  mode: null,      // 'host' | 'guest' | 'local'
  state: null,
  net: null,
  myPids: [],
  code: null,
  netStatus: '',
  netLevel: '',
  gameInited: false,
};

// ======================================================================= экраны
function show(screen) {
  for (const s of ['home', 'lobby', 'game']) $(`screen-${s}`).classList.toggle('hidden', s !== screen);
  window.scrollTo(0, 0);
}

function staticModal(html, wide = true) {
  $('modal-root').innerHTML = `<div class="modal-back" data-static="1"><div class="modal ${wide ? 'wide' : ''}"><button class="x" data-static="1">✕</button><div class="modal-body">${html}</div></div></div>`;
}
$('modal-root').addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.static) $('modal-root').innerHTML = '';
});

// ======================================================================= главное меню
function tokenGrid(sel, taken, attr) {
  return TOKENS.map((t) => `<button class="token-opt ${t.e === sel ? 'sel' : ''} ${taken.includes(t.e) ? 'taken' : ''}" ${attr}="${t.e}" title="${t.n}" ${taken.includes(t.e) ? 'disabled' : ''}>${t.e}</button>`).join('');
}
function colorRow(sel, attr) {
  return COLORS.map((c) => `<button class="color-opt ${c === sel ? 'sel' : ''}" ${attr}="${c}" style="background:${c}" title="${c}"></button>`).join('');
}

function renderHome() {
  $('nick').value = profile.name;
  $('token-grid').innerHTML = tokenGrid(profile.token, [], 'data-tok');
  $('color-row').innerHTML = colorRow(profile.color, 'data-col');
  const res = [];
  const h = store.get('rm_host');
  if (h && h.state && h.state.phase !== 'lobby') res.push(`<button class="btn btn-gold" id="btn-resume-host">▶ Продолжить игру (комната ${esc(h.code)}, круг ${h.state.round})</button>`);
  const l = store.get('rm_local');
  if (l && l.state && l.state.phase !== 'lobby') res.push(`<button class="btn btn-gold" id="btn-resume-local">▶ Продолжить игру на одном устройстве (круг ${l.state.round})</button>`);
  const g = store.get('rm_guest');
  if (g && g.code) res.push(`<button class="btn btn-secondary" id="btn-resume-guest">↩ Вернуться в комнату ${esc(g.code)}</button>`);
  $('home-resume').innerHTML = res.join('');
  if ($('btn-resume-host')) $('btn-resume-host').onclick = () => resumeHost(h);
  if ($('btn-resume-local')) $('btn-resume-local').onclick = () => resumeLocal(l);
  if ($('btn-resume-guest')) $('btn-resume-guest').onclick = () => { $('join-code').value = g.code; joinRoom(); };
}

function saveProfile() {
  profile.name = $('nick').value.trim().slice(0, 16);
  store.set('rm_profile', profile);
}

function needName() {
  saveProfile();
  if (!profile.name) {
    $('home-error').textContent = 'Придумай никнейм 💗';
    $('nick').focus();
    return false;
  }
  $('home-error').textContent = '';
  return true;
}

$('token-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tok]');
  if (!b) return;
  profile.token = b.dataset.tok;
  saveProfile();
  renderHome();
});
$('color-row').addEventListener('click', (e) => {
  const b = e.target.closest('[data-col]');
  if (!b) return;
  profile.color = b.dataset.col;
  saveProfile();
  renderHome();
});
$('nick').addEventListener('input', saveProfile);
$('btn-create').onclick = () => needName() && createRoom();
$('btn-join').onclick = () => needName() && joinRoom();
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter' && needName()) joinRoom(); });
$('btn-local').onclick = () => needName() && createLocal();
$('btn-rules-home').onclick = () => staticModal(`<h3>📖 Правила</h3>${rulesHTML()}`);

// ======================================================================= создание игр
function newLobbyState() {
  const s = createState({ maxRounds: 25 });
  addPlayer(s, { ...profile, clientId });
  return s;
}

function createRoom() {
  stopNet();
  app.mode = 'host';
  app.code = makeCode();
  app.state = newLobbyState();
  app.myPids = [0];
  startHost();
}

function resumeHost(saved) {
  stopNet();
  app.mode = 'host';
  app.code = saved.code;
  app.state = saved.state;
  app.myPids = [0];
  for (const p of app.state.players) if (p.id !== 0) p.connected = false;
  startHost();
}

function startHost() {
  app.netStatus = 'Создаю комнату…';
  app.netLevel = 'warn';
  app.net = new Host(app.code, {
    open: () => { setNet(guestOnline() ? 'Соперник онлайн' : 'Комната готова', guestOnline() ? '' : 'warn'); renderAll(); },
    message: onHostMessage,
    close: onHostClose,
    status: (t, lvl) => setNet(t, lvl),
    error: (t) => { setNet(t, 'bad'); toast(t, 'err'); },
  });
  commit();
}

const guestOnline = () => app.state.players.length > 1 && app.state.players[1].connected;

function onHostMessage(conn, msg) {
  const s = app.state;
  if (msg.t === 'hello') {
    let pid = s.players.findIndex((p) => p.clientId === msg.clientId);
    if (pid === 0) { app.net.send(conn, { t: 'full', msg: 'Это устройство уже хозяин комнаты. Открой игру на другом устройстве.' }); return; }
    if (pid < 0) {
      if (s.players.length < 2 && s.phase === 'lobby') {
        const prof = msg.profile || {};
        const taken = s.players.map((p) => p.token);
        let token = prof.token;
        if (!token || taken.includes(token)) token = TOKENS.map((t) => t.e).find((t) => !taken.includes(t));
        let color = prof.color || COLORS[1];
        if (color === s.players[0].color) color = COLORS.find((c) => c !== color);
        pid = addPlayer(s, { name: prof.name, token, color, clientId: msg.clientId });
      } else if (s.players.length === 2 && !s.players[1].connected) {
        pid = 1; // новое устройство занимает место отключившегося игрока
        s.players[1].clientId = msg.clientId;
      } else {
        app.net.send(conn, { t: 'full', msg: 'В комнате уже два игрока.' });
        return;
      }
    }
    for (const c of app.net.conns) if (c !== conn && c.pid === pid) c.close();
    conn.pid = pid;
    s.players[pid].connected = true;
    app.net.send(conn, { t: 'welcome', pid });
    toast(`💗 ${s.players[pid].name} в комнате!`);
    setNet('Соперник онлайн', '');
    commit();
    return;
  }
  if (msg.t === 'act' && conn.pid !== undefined) {
    const err = act(s, conn.pid, msg.a);
    if (err) app.net.send(conn, { t: 'err', msg: err });
    else commit();
  }
}

function onHostClose(conn) {
  if (conn.pid === undefined || !app.state) return;
  const still = [...app.net.conns].some((c) => c.pid === conn.pid);
  if (still) return;
  const p = app.state.players[conn.pid];
  if (p) p.connected = false;
  setNet('Соперник отключился', 'warn');
  toast(`⚠️ ${p ? p.name : 'Соперник'} отключился. Ждём переподключения…`, 'err');
  commit();
}

function joinRoom() {
  const code = normCode($('join-code').value);
  if (code.length !== 4) { $('home-error').textContent = 'Код комнаты — 4 символа'; return; }
  stopNet();
  app.mode = 'guest';
  app.code = code;
  app.state = null;
  app.myPids = [];
  store.set('rm_guest', { code });
  setNet('Подключаюсь…', 'warn');
  app.net = new Guest(code, {
    open: () => {
      setNet('🟢 Онлайн', '');
      app.net.send({ t: 'hello', clientId, profile });
    },
    message: onGuestMessage,
    status: (t, lvl) => setNet(t, lvl),
    error: (t) => { setNet(t, 'bad'); toast(t, 'err'); },
  });
  show('lobby');
  renderLobby();
}

function onGuestMessage(msg) {
  if (msg.t === 'welcome') { app.myPids = [msg.pid]; return; }
  if (msg.t === 'state') { app.state = msg.s; renderAll(); return; }
  if (msg.t === 'err') { G.showError(msg.msg); return; }
  if (msg.t === 'full') {
    toast(msg.msg, 'err');
    store.del('rm_guest');
    leave();
  }
}

function createLocal() {
  stopNet();
  app.mode = 'local';
  app.code = null;
  app.state = newLobbyState();
  const tok = TOKENS.map((t) => t.e).find((t) => t !== profile.token);
  addPlayer(app.state, { name: 'Игрок 2', token: tok, color: COLORS.find((c) => c !== profile.color) });
  app.myPids = [0, 1];
  setNet('Один экран', '');
  commit();
}

function resumeLocal(saved) {
  stopNet();
  app.mode = 'local';
  app.state = saved.state;
  app.myPids = [0, 1];
  setNet('Один экран', '');
  commit();
}

// ======================================================================= действия
function dispatch(action, pid) {
  if (!app.state) return;
  if (app.mode === 'guest') {
    if (!app.net || !app.net.send({ t: 'act', a: action })) G.showError('Нет связи с хозяином комнаты — переподключаюсь…');
    return;
  }
  const err = act(app.state, pid ?? app.myPids[0], action);
  if (err) { G.showError(err); return; }
  commit();
}

function commit() {
  if (app.mode === 'host') {
    store.set('rm_host', { code: app.code, state: app.state });
    app.net && app.net.broadcast({ t: 'state', s: app.state });
  } else if (app.mode === 'local') {
    store.set('rm_local', { state: app.state });
  }
  renderAll();
}

function setNet(text, level) {
  app.netStatus = text;
  app.netLevel = level;
  G.setConn(text, level);
  if (!$('screen-lobby').classList.contains('hidden')) renderLobbyStatus();
}

function stopNet() {
  if (app.net) app.net.destroy();
  app.net = null;
  app.gameInited = false;
}

function leave() {
  stopNet();
  releaseWake();
  app.mode = null;
  app.state = null;
  $('modal-root').innerHTML = '';
  history.replaceState(null, '', location.pathname);
  show('home');
  renderHome();
}

// ======================================================================= отрисовка
function renderAll() {
  const s = app.state;
  if (!app.mode) return;
  if (!s || s.phase === 'lobby') {
    app.gameInited = false;
    show('lobby');
    renderLobby();
    return;
  }
  if (!app.gameInited) {
    show('game');
    $('modal-root').innerHTML = '';
    G.initGame({ mode: app.mode, myPids: app.myPids, dispatch, leave });
    G.bindGameOnce();
    app.gameInited = true;
    requestWake();
  }
  G.onState(s);
  G.setConn(app.mode === 'host' ? (guestOnline() ? '🟢 Соперник онлайн' : '🟠 Соперник не в сети') : app.mode === 'local' ? '📱 Один экран' : app.netStatus, app.mode === 'host' ? (guestOnline() ? '' : 'warn') : app.netLevel);
}

function shareURL() { return `${location.origin}${location.pathname}?room=${app.code}`; }

function renderLobbyStatus() {
  const el = $('lobby-status');
  const s = app.state;
  let t = '';
  if (app.mode === 'host') t = !s || s.players.length < 2 ? `⏳ ${app.netStatus === 'Комната готова' ? 'Ждём второго игрока…' : app.netStatus}` : guestOnline() ? '💗 Второй игрок в комнате!' : '⚠️ Второй игрок отключился';
  else if (app.mode === 'guest') t = s ? `💗 ${app.netStatus === '🟢 Онлайн' ? 'Ты в комнате! Ждём, когда хозяин начнёт игру' : app.netStatus}` : `⏳ ${app.netStatus}`;
  else t = 'Передавайте устройство друг другу по очереди 💗';
  el.textContent = t;
}

const SETTINGS_UI = [
  { k: 'maxRounds', t: 'Длина игры', d: 'На вечер советуем 20–30 кругов', opts: [[15, '15 кругов (~1 ч)'], [20, '20 кругов'], [25, '25 кругов (~1,5 ч)'], [30, '30 кругов'], [40, '40 кругов'], [0, 'До банкротства']] },
  { k: 'startMoney', t: 'Стартовый капитал', opts: [[1000, '1 000 000 ₽'], [1500, '1 500 000 ₽'], [2000, '2 000 000 ₽'], [2500, '2 500 000 ₽']] },
  { k: 'chapters', t: 'Сюжетные главы', d: 'События меняют правила, у каждой главы — задание', bool: true },
  { k: 'chapterLen', t: 'Длина главы', opts: [[3, '3 круга'], [4, '4 круга'], [5, '5 кругов'], [6, '6 кругов']] },
  { k: 'auctions', t: 'Аукционы', d: 'Если отказаться от покупки — объект разыгрывается', bool: true },
  { k: 'jackpot', t: 'Джекпот в Парке Горького', d: 'Налоги и штрафы копятся, их забирает вставший на парковку', bool: true },
  { k: 'doubleGo', t: 'Двойной Старт', d: 'Точное попадание на Старт — двойная зарплата', bool: true },
];

function renderLobby() {
  const s = app.state;
  $('lobby-title').textContent = app.mode === 'local' ? 'Игра на одном устройстве' : `Комната ${app.code}`;

  // приглашение
  if (app.mode === 'host') {
    const url = shareURL();
    let qr = '';
    try {
      const q = window.qrcode(0, 'M');
      q.addData(url);
      q.make();
      qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) { qr = ''; }
    if (!$('lobby-share').dataset.code || $('lobby-share').dataset.code !== app.code) {
      $('lobby-share').dataset.code = app.code;
      $('lobby-share').innerHTML = `<div class="share"><div><p>Код комнаты:</p><div class="code">${app.code}</div>
        <p>Второй игрок открывает эту страницу и вводит код — или сканирует QR-код телефоном.</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" id="btn-copy">📋 Ссылка</button>${navigator.share ? '<button class="btn btn-secondary btn-sm" id="btn-share">📤 Отправить</button>' : ''}</div></div>
        <div class="qr">${qr}</div></div>`;
      $('btn-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована 💗'); } catch (e) { prompt('Скопируй ссылку:', url); }
      };
      if ($('btn-share')) $('btn-share').onclick = () => navigator.share({ title: 'Розовая Монополия', text: `Заходи играть! Код комнаты: ${app.code}`, url }).catch(() => {});
    }
  } else {
    $('lobby-share').innerHTML = '';
    $('lobby-share').dataset.code = '';
  }
  renderLobbyStatus();

  // игроки (не перерисовываем, пока пользователь печатает имя)
  const active = document.activeElement;
  if (!(active && active.closest && active.closest('#lobby-players') && active.tagName === 'INPUT')) {
    const players = s ? s.players : [];
    let html = players.map((p) => {
      const editable = app.myPids.includes(p.id);
      const taken = players.filter((q) => q.id !== p.id).map((q) => q.token);
      return `<div class="lp"><div class="lp-head"><div class="lp-token" style="border-color:${p.color}">${p.token}</div>
        <div><div class="lp-name">${esc(p.name)}</div><div class="lp-sub">${p.id === 0 && app.mode !== 'local' ? 'хозяин комнаты' : `игрок ${p.id + 1}`}${editable && app.mode !== 'local' ? ' · это ты' : ''}${app.mode !== 'local' && !p.connected ? ' · ⚠️ не в сети' : ''}</div></div></div>
        ${editable ? `<div class="editor"><input data-pname="${p.id}" maxlength="16" value="${esc(p.name)}" placeholder="Никнейм"/>
          <div class="token-grid">${tokenGrid(p.token, taken, `data-ptok="${p.id}" data-v`)}</div>
          <div class="color-row" style="margin-top:8px">${colorRow(p.color, `data-pcol="${p.id}" data-v`)}</div></div>` : ''}</div>`;
    }).join('');
    if (players.length < 2) html += `<div class="lp empty">${s ? 'Ждём второго игрока… 💌' : 'Подключение…'}</div>`;
    $('lobby-players').innerHTML = html;
  }

  // настройки
  const canEdit = app.mode !== 'guest';
  const st = s ? s.settings : null;
  if (st) {
    $('lobby-settings').innerHTML = `<h3>⚙️ Правила партии${canEdit ? '' : ' (выбирает хозяин комнаты)'}</h3>` + SETTINGS_UI.map((o) => {
      if (o.k === 'chapterLen' && !st.chapters) return '';
      const ctl = o.bool
        ? `<label class="switch"><input type="checkbox" data-set="${o.k}" ${st[o.k] ? 'checked' : ''} ${canEdit ? '' : 'disabled'}/><span></span></label>`
        : `<select data-set="${o.k}" ${canEdit ? '' : 'disabled'}>${o.opts.map(([v, t]) => `<option value="${v}" ${st[o.k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
      return `<div class="set-row"><div><div class="t">${o.t}</div>${o.d ? `<div class="d">${o.d}</div>` : ''}</div>${ctl}</div>`;
    }).join('');
  } else $('lobby-settings').innerHTML = '';

  const startBtn = $('btn-start');
  startBtn.classList.toggle('hidden', app.mode === 'guest');
  startBtn.disabled = !s || s.players.length < 2 || (app.mode === 'host' && !guestOnline());
  $('lobby-hint').textContent = app.mode === 'guest' ? 'Игру запускает хозяин комнаты.' : app.mode === 'host' && (!s || s.players.length < 2) ? 'Кнопка станет активной, когда второй игрок войдёт в комнату.' : '';
}

$('lobby-players').addEventListener('click', (e) => {
  const t = e.target.closest('[data-v]');
  if (!t) return;
  if (t.dataset.ptok !== undefined) dispatch({ type: 'profile', token: t.dataset.v }, Number(t.dataset.ptok));
  if (t.dataset.pcol !== undefined) dispatch({ type: 'profile', color: t.dataset.v }, Number(t.dataset.pcol));
});
$('lobby-players').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.pname !== undefined) {
    dispatch({ type: 'profile', name: t.value }, Number(t.dataset.pname));
    if (app.mode !== 'local' || Number(t.dataset.pname) === 0) { profile.name = t.value.trim().slice(0, 16) || profile.name; store.set('rm_profile', profile); }
  }
});
$('lobby-players').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('lobby-settings').addEventListener('change', (e) => {
  const t = e.target;
  const k = t.dataset.set;
  if (!k) return;
  const v = t.type === 'checkbox' ? t.checked : Number(t.value);
  dispatch({ type: 'settings', settings: { [k]: v } }, 0);
});
$('btn-start').onclick = () => dispatch({ type: 'start' }, 0);
$('btn-lobby-back').onclick = () => leave();

// ======================================================================= экран не гаснет во время игры
let wake = null;
async function requestWake() {
  try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { wake = null; }
}
function releaseWake() { if (wake) { wake.release().catch(() => {}); wake = null; } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && app.gameInited) requestWake(); });

// ======================================================================= старт
bgHearts();
renderHome();
const params = new URLSearchParams(location.search);
const room = normCode(params.get('room'));
if (room) {
  $('join-code').value = room;
  $('home-error').innerHTML = '';
  const note = document.createElement('p');
  note.className = 'hint';
  note.innerHTML = `💌 Тебя пригласили в комнату <b>${esc(room)}</b>. Выбери никнейм и фишку, затем нажми «Войти по коду».`;
  $('home-resume').prepend(note);
}

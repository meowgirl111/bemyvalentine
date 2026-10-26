// Связь двух устройств напрямую через WebRTC (PeerJS).
// Хост держит состояние игры, гость присылает действия и получает состояние.
/* global Peer */

const PREFIX = 'pink-monopoly-ru-v1-';
const PEER_OPTS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

// ---------------------------------------------------------------- хост
export class Host {
  // on: { open(code), message(conn, msg), close(conn), status(text, level), error(text) }
  constructor(code, on) {
    this.code = code;
    this.on = on;
    this.conns = new Set();
    this.destroyed = false;
    this.retries = 0;
    this.start();
    this.pinger = setInterval(() => this.broadcast({ t: 'ping' }), 5000);
  }

  start() {
    if (typeof Peer === 'undefined') { this.on.error('Не удалось загрузить сетевой модуль. Проверь интернет.'); return; }
    this.peer = new Peer(PREFIX + this.code, PEER_OPTS);
    this.peer.on('open', () => { this.retries = 0; this.on.open(this.code); });
    this.peer.on('connection', (conn) => this.attach(conn));
    this.peer.on('disconnected', () => {
      if (this.destroyed) return;
      this.on.status('Переподключаюсь к серверу…', 'warn');
      setTimeout(() => { if (!this.destroyed && this.peer && !this.peer.destroyed) this.peer.reconnect(); }, 1500);
    });
    this.peer.on('error', (e) => {
      if (this.destroyed) return;
      if (e.type === 'unavailable-id') {
        // Код ещё «занят» прошлой вкладкой — подождём, сервер его освободит.
        this.retries++;
        this.on.status(`Комната ${this.code} ещё занята, жду… (${this.retries})`, 'warn');
        if (this.retries > 12) { this.on.error('Этот код комнаты занят. Создай новую комнату.'); return; }
        this.peer.destroy();
        setTimeout(() => !this.destroyed && this.start(), 2500);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        this.on.status('Нет связи с сервером, пробую снова…', 'warn');
        this.peer.destroy();
        setTimeout(() => !this.destroyed && this.start(), 3000);
      } else if (e.type === 'browser-incompatible') {
        this.on.error('Браузер не поддерживает WebRTC. Попробуй Chrome, Safari или Firefox.');
      } else {
        console.warn('peer error', e.type, e);
      }
    });
  }

  attach(conn) {
    conn.on('open', () => { this.conns.add(conn); conn.lastSeen = Date.now(); });
    conn.on('data', (msg) => { conn.lastSeen = Date.now(); if (msg && msg.t !== 'ping') this.on.message(conn, msg); });
    const drop = () => { if (this.conns.delete(conn)) this.on.close(conn); };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  send(conn, msg) { try { if (conn.open) conn.send(msg); } catch (e) { console.warn(e); } }
  broadcast(msg) {
    const now = Date.now();
    for (const c of [...this.conns]) {
      if (now - (c.lastSeen || now) > 20000) { c.close(); this.conns.delete(c); this.on.close(c); continue; }
      this.send(c, msg);
    }
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.pinger);
    for (const c of this.conns) c.close();
    if (this.peer) this.peer.destroy();
  }
}

// ---------------------------------------------------------------- гость
export class Guest {
  // on: { open(), message(msg), status(text, level), error(text) }
  constructor(code, on) {
    this.code = code;
    this.on = on;
    this.destroyed = false;
    this.conn = null;
    this.lastSeen = 0;
    this.misses = 0;
    this.start();
    this.watch = setInterval(() => this.tick(), 3000);
  }

  start() {
    if (typeof Peer === 'undefined') { this.on.error('Не удалось загрузить сетевой модуль. Проверь интернет.'); return; }
    this.peer = new Peer(PEER_OPTS);
    this.peer.on('open', () => this.connect());
    this.peer.on('disconnected', () => { if (!this.destroyed && !this.peer.destroyed) setTimeout(() => this.peer.reconnect(), 1500); });
    this.peer.on('error', (e) => {
      if (this.destroyed) return;
      if (e.type === 'peer-unavailable') {
        this.misses++;
        this.on.status(this.misses > 2 ? `Комната ${this.code} не отвечает. Хозяин комнаты в игре? Пробую ещё…` : 'Ищу комнату…', 'warn');
        setTimeout(() => !this.destroyed && this.connect(), 3000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        this.on.status('Нет связи с сервером, пробую снова…', 'warn');
        this.restart();
      } else if (e.type === 'browser-incompatible') {
        this.on.error('Браузер не поддерживает WebRTC. Попробуй Chrome, Safari или Firefox.');
      } else console.warn('peer error', e.type, e);
    });
  }

  restart() {
    try { this.peer.destroy(); } catch (e) { /* уже закрыт */ }
    this.conn = null;
    setTimeout(() => !this.destroyed && this.start(), 3000);
  }

  connect() {
    if (this.destroyed || !this.peer || this.peer.destroyed || this.peer.disconnected) return;
    if (this.conn) { try { this.conn.close(); } catch (e) { /* ignore */ } }
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    this.connStarted = Date.now();
    conn.on('open', () => { this.misses = 0; this.lastSeen = Date.now(); this.on.open(); });
    conn.on('data', (msg) => { this.lastSeen = Date.now(); if (msg && msg.t !== 'ping') this.on.message(msg); });
    conn.on('close', () => { if (this.conn === conn) { this.conn = null; this.on.status('Связь потеряна, переподключаюсь…', 'warn'); } });
    conn.on('error', () => { if (this.conn === conn) this.conn = null; });
  }

  tick() {
    if (this.destroyed) return;
    const now = Date.now();
    if (this.conn && this.conn.open) {
      this.send({ t: 'ping' });
      if (now - this.lastSeen > 16000) {
        this.on.status('Связь потеряна, переподключаюсь…', 'warn');
        this.connect();
      }
    } else if (!this.conn || now - this.connStarted > 12000) {
      if (this.peer && !this.peer.destroyed && !this.peer.disconnected) this.connect();
    }
  }

  send(msg) {
    try { if (this.conn && this.conn.open) { this.conn.send(msg); return true; } } catch (e) { console.warn(e); }
    return false;
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.watch);
    if (this.peer) this.peer.destroy();
  }
}

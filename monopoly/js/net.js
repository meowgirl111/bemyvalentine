// Связь двух устройств через публичные MQTT-брокеры (WebSocket по TLS).
// Работает из любых сетей: оба устройства сами подключаются к брокеру, прямое соединение не нужно.
// Сообщения публикуются сразу во все доступные брокеры, дубликаты отбрасываются по id.
// Хост держит состояние игры, гость присылает действия и получает состояние.
/* global Paho */

const PREFIX = 'pink-monopoly-ru/v2/';
const BROKERS = [
  { uri: 'wss://public.cloud.shiftr.io:443/', user: 'public', pass: 'public' },
  { uri: 'wss://broker.emqx.io:8084/mqtt' },
  { uri: 'wss://broker.hivemq.com:8884/mqtt' },
];

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
const rid = (n = 12) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

// ---------------------------------------------------------------- ретранслятор
class Relay {
  // onMessage(obj) — каждое уникальное сообщение один раз; onChange(connectedCount)
  constructor(topic, onMessage, onChange) {
    this.topic = topic;
    this.onMessage = onMessage;
    this.onChange = onChange;
    this.seen = new Set();
    this.seenOrder = [];
    this.destroyed = false;
    this.clients = BROKERS.map((b) => ({ b, client: null, ok: false, timer: null }));
    if (typeof Paho === 'undefined') return;
    for (const slot of this.clients) this.connect(slot);
  }

  connect(slot) {
    if (this.destroyed) return;
    const client = new Paho.Client(slot.b.uri, `pm${rid(12)}`);
    slot.client = client;
    client.onMessageArrived = (m) => {
      let obj;
      try { obj = JSON.parse(m.payloadString); } catch (e) { return; }
      if (!obj || !obj.mid || this.seen.has(obj.mid)) return;
      this.seen.add(obj.mid);
      this.seenOrder.push(obj.mid);
      if (this.seenOrder.length > 600) this.seen.delete(this.seenOrder.shift());
      this.onMessage(obj);
    };
    client.onConnected = () => {
      try { client.subscribe(this.topic, { qos: 1 }); } catch (e) { /* переподключится */ }
      slot.ok = true;
      this.onChange(this.count());
    };
    client.onConnectionLost = () => { slot.ok = false; this.onChange(this.count()); };
    const opts = {
      useSSL: true,
      timeout: 10,
      keepAliveInterval: 20,
      cleanSession: true,
      reconnect: true,
      onFailure: () => {
        slot.ok = false;
        this.onChange(this.count());
        clearTimeout(slot.timer);
        slot.timer = setTimeout(() => this.connect(slot), 6000);
      },
    };
    if (slot.b.user) { opts.userName = slot.b.user; opts.password = slot.b.pass; }
    try { client.connect(opts); } catch (e) { opts.onFailure(); }
  }

  count() { return this.clients.filter((s) => s.ok).length; }

  publish(topic, obj) {
    obj.mid = obj.mid || rid(14);
    const payload = JSON.stringify(obj);
    let sent = false;
    for (const s of this.clients) {
      if (!s.ok) continue;
      try { s.client.send(topic, payload, 1, false); sent = true; } catch (e) { s.ok = false; }
    }
    return sent;
  }

  destroy() {
    this.destroyed = true;
    for (const s of this.clients) {
      clearTimeout(s.timer);
      try { if (s.client && s.ok) s.client.disconnect(); } catch (e) { /* ignore */ }
    }
  }
}

const noPaho = (on) => on.error('Не удалось загрузить сетевой модуль. Проверь интернет и обнови страницу.');

// ---------------------------------------------------------------- хост
// on: { open(code), message(conn, msg), close(conn), status(text, level), error(text), seq() }
export class Host {
  constructor(code, on) {
    this.code = code;
    this.on = on;
    this.conns = new Set();
    this.byId = new Map();
    this.down = `${PREFIX}${code}/down`;
    this.opened = false;
    if (typeof Paho === 'undefined') { noPaho(on); return; }
    this.relay = new Relay(`${PREFIX}${code}/up`, (o) => this.receive(o), (n) => this.netChange(n));
    this.pinger = setInterval(() => this.tick(), 4000);
    this.slowStart = setTimeout(() => { if (!this.opened) on.status('Не могу связаться с сервером, пробую ещё…', 'warn'); }, 12000);
  }

  netChange(n) {
    if (n > 0 && !this.opened) { this.opened = true; this.on.open(this.code); }
    else if (n === 0 && this.opened) this.on.status('Нет связи с сервером, переподключаюсь…', 'warn');
    else if (n > 0) this.on.status('Комната готова', '');
  }

  receive(o) {
    if (!o.sid || !o.msg) return;
    let conn = this.byId.get(o.sid);
    if (!conn) {
      conn = { sid: o.sid, lastSeen: Date.now(), open: true, close: () => this.drop(conn, false) };
      this.byId.set(o.sid, conn);
      this.conns.add(conn);
      // Незнакомый отправитель без приветствия — например, хозяин комнаты перезагрузил страницу.
      // Просим гостя представиться заново.
      if (o.msg.t !== 'hello') this.send(conn, { t: 'who' });
    }
    conn.lastSeen = Date.now();
    if (o.msg.t !== 'ping') this.on.message(conn, o.msg);
  }

  drop(conn, notify) {
    if (!this.conns.delete(conn)) return;
    this.byId.delete(conn.sid);
    if (notify) this.on.close(conn);
  }

  tick() {
    const now = Date.now();
    for (const c of [...this.conns]) if (now - c.lastSeen > 15000) this.drop(c, true);
    this.relay.publish(this.down, { msg: { t: 'ping', seq: this.on.seq ? this.on.seq() : 0 } });
  }

  send(conn, msg) { this.relay && this.relay.publish(this.down, { to: conn.sid, msg }); }
  broadcast(msg) { this.relay && this.relay.publish(this.down, { msg }); }

  destroy() {
    clearInterval(this.pinger);
    clearTimeout(this.slowStart);
    if (this.relay) this.relay.destroy();
  }
}

// ---------------------------------------------------------------- гость
// hello — сообщение-приветствие, которое гость повторяет, пока хост не ответит.
// on: { open(), message(msg), status(text, level), error(text) }
export class Guest {
  constructor(code, hello, on) {
    this.code = code;
    this.hello = hello;
    this.on = on;
    this.sid = rid(16);
    this.up = `${PREFIX}${code}/up`;
    this.linked = false;
    this.lastSeen = 0;
    this.started = Date.now();
    if (typeof Paho === 'undefined') { noPaho(on); return; }
    this.relay = new Relay(`${PREFIX}${code}/down`, (o) => this.receive(o), (n) => {
      if (n > 0 && !this.linked) { this.on.status('Ищу комнату…', 'warn'); this.pub(this.hello); }
      if (n === 0) this.on.status('Нет связи с сервером, переподключаюсь…', 'warn');
    });
    this.timer = setInterval(() => this.tick(), 3000);
  }

  pub(msg) { return this.relay.publish(this.up, { sid: this.sid, msg }); }

  receive(o) {
    if (o.to && o.to !== this.sid) return;
    this.lastSeen = Date.now();
    // хост отвечает именно нам (welcome) — значит, связь установлена
    if (!this.linked && o.to === this.sid) {
      this.linked = true;
      this.on.open();
    }
    if (o.msg && o.msg.t === 'who') { this.pub(this.hello); return; }
    if (o.msg) this.on.message(o.msg);
  }

  tick() {
    const now = Date.now();
    if (!this.relay.count()) return;
    if (!this.linked) {
      this.pub(this.hello);
      if (now - this.started > 15000) this.on.status(`Комната ${this.code} не отвечает. Хозяин комнаты в игре? Пробую ещё…`, 'warn');
      return;
    }
    this.pub({ t: 'ping' });
    if (now - this.lastSeen > 15000) {
      this.linked = false;
      this.started = now;
      this.on.status('Связь с хозяином комнаты потеряна, переподключаюсь…', 'warn');
      this.pub(this.hello);
    }
  }

  send(msg) {
    if (!this.relay || !this.linked) return false;
    return this.pub(msg);
  }

  destroy() {
    clearInterval(this.timer);
    if (this.relay) this.relay.destroy();
  }
}

// Звуки, всплывающие уведомления, реакции и конфетти.

let audio = null;
let muted = false;
try { muted = localStorage.getItem('rm_muted') === '1'; } catch (e) { /* приватный режим */ }

export const isMuted = () => muted;
export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('rm_muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
  return muted;
}

function ctx() {
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audio = new AC();
  }
  if (audio.state === 'suspended') audio.resume();
  return audio;
}
// Разблокировка звука на iOS после первого касания
window.addEventListener('pointerdown', () => { if (!muted) ctx(); }, { once: true });

function tone(freq, dur = 0.12, type = 'sine', vol = 0.15, delay = 0) {
  const a = ctx();
  if (!a || muted) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  dice() { for (let i = 0; i < 6; i++) tone(180 + Math.random() * 260, 0.05, 'square', 0.04, i * 0.07); },
  step() { tone(660, 0.05, 'triangle', 0.05); },
  coin() { tone(988, 0.08, 'square', 0.06); tone(1319, 0.18, 'square', 0.06, 0.08); },
  pay() { tone(392, 0.1, 'triangle', 0.1); tone(294, 0.2, 'triangle', 0.1, 0.1); },
  card() { tone(523, 0.08, 'sine', 0.1); tone(784, 0.15, 'sine', 0.1, 0.08); },
  jail() { tone(220, 0.15, 'sawtooth', 0.06); tone(165, 0.3, 'sawtooth', 0.06, 0.15); },
  turn() { tone(784, 0.1, 'sine', 0.12); tone(1046, 0.18, 'sine', 0.12, 0.1); },
  build() { tone(440, 0.06, 'square', 0.05); tone(554, 0.06, 'square', 0.05, 0.07); tone(659, 0.12, 'square', 0.05, 0.14); },
  win() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.18, 'triangle', 0.12, i * 0.14)); },
  chapter() { [392, 523, 659, 784].forEach((f, i) => tone(f, 0.25, 'sine', 0.09, i * 0.12)); },
  pop() { tone(880, 0.06, 'sine', 0.1); },
  err() { tone(200, 0.15, 'square', 0.05); },
};

export function vibrate(ms = 30) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } }

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(text, kind = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = esc(text);
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'news' || kind === 'quest' ? 4800 : 3400);
}

export function floatEmoji(emoji, label) {
  const box = document.getElementById('floaters');
  for (let i = 0; i < 5; i++) {
    const el = document.createElement('div');
    el.className = 'floater';
    el.style.left = `${10 + Math.random() * 75}%`;
    el.style.animationDelay = `${i * 0.18}s`;
    el.style.fontSize = `${40 + Math.random() * 30}px`;
    el.innerHTML = esc(emoji) + (i === 0 && label ? `<small>${esc(label)}</small>` : '');
    box.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }
}

export function bgHearts() {
  const box = document.getElementById('bg-hearts');
  const items = ['💗', '💕', '🌸', '✨', '💖', '🛍️'];
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('span');
    s.textContent = items[i % items.length];
    s.style.left = `${Math.random() * 100}%`;
    s.style.animationDuration = `${14 + Math.random() * 16}s`;
    s.style.animationDelay = `${-Math.random() * 25}s`;
    s.style.fontSize = `${14 + Math.random() * 18}px`;
    box.appendChild(s);
  }
}

export function confetti(duration = 4000) {
  const cv = document.getElementById('confetti');
  const c = cv.getContext('2d');
  const W = (cv.width = innerWidth), H = (cv.height = innerHeight);
  const colors = ['#ff5fa2', '#ffd27a', '#9b6bff', '#5fd3a0', '#ff8a3d', '#7cc6e8'];
  const parts = Array.from({ length: 160 }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H * 0.5, r: 4 + Math.random() * 6,
    vx: -2 + Math.random() * 4, vy: 2 + Math.random() * 4, a: Math.random() * 6, va: -0.2 + Math.random() * 0.4,
    col: colors[Math.floor(Math.random() * colors.length)], heart: Math.random() < 0.3,
  }));
  const end = performance.now() + duration;
  (function frame(now) {
    c.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.a += p.va; p.vy += 0.03;
      c.save(); c.translate(p.x, p.y); c.rotate(p.a); c.fillStyle = p.col;
      if (p.heart) { c.font = `${p.r * 3}px serif`; c.fillText('💗', 0, 0); } else c.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6);
      c.restore();
    }
    if (now < end) requestAnimationFrame(frame); else c.clearRect(0, 0, W, H);
  })(performance.now());
}

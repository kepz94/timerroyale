// TV gameboard (ADR-004). /tv → /tv/CODE. Phase 1: highlight menu driven by the
// host's D-Pad. Phase 2: Start Game launches a PvE engine (KOTH/LMS) on the TV;
// phones send press events; the host paces rounds with Next Round (Phase 3).
import QRCode from 'qrcode';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
import { initFirebase } from './firebase.js';
import { createSession, logTransition } from './session.js';
import { watchPlayers } from './players.js';
import { consumeEvents } from './engine.js';
import { validatePool, validateCategory, ENVIRONMENTS, KOTH_THRESHOLDS } from './hostconfig.js';
import { createKoth } from './koth.js';
import { createMatch as createElim } from './elimination.js';
import { fmtOff, fmtS2 } from './format.js';

const el = (id) => document.getElementById(id);
const fmt = (ms) => (ms / 1000).toFixed(1);
const db = initFirebase();
const parts = location.pathname.split('/').filter(Boolean);
const lobbyId = parts[1] ? parts[1].toUpperCase() : null;

let players = [];
let hostId = null;
let match = null; // active PvE engine

/* ---------------- Phase 1: highlight menu ---------------- */
const config = { pool: { classic: true, hard: false, guess: false }, category: null, pveMode: 'koth', kothN: 5 };
let stack = ['main'];
let focus = 0;
const pop = () => { if (stack.length > 1) { stack.pop(); focus = 0; } };
const togglePve = () => { config.pveMode = config.pveMode === 'koth' ? 'lms' : 'koth'; };
const cycleKoth = (d) => { const i = KOTH_THRESHOLDS.indexOf(config.kothN); config.kothN = KOTH_THRESHOLDS[Math.min(KOTH_THRESHOLDS.length - 1, Math.max(0, i + d))]; };

const screens = {
  main: () => [
    { label: '▸ Game Pool', enter: 'pool' },
    { label: `▸ Category${config.category ? ':  ' + config.category.toUpperCase() : ''}`, enter: 'category' },
    { label: '▶ START GAME', onSelect: startGame }
  ],
  pool: () => [
    { label: `Classic       [${config.pool.classic ? '✓' : ' '}]`, onSelect: () => (config.pool.classic = !config.pool.classic) },
    { label: `Hard Classic  [${config.pool.hard ? '✓' : ' '}]`, onSelect: () => (config.pool.hard = !config.pool.hard) },
    { label: `Guess Timer   [${config.pool.guess ? '✓' : ' '}]`, onSelect: () => (config.pool.guess = !config.pool.guess) },
    { label: '◂ Back', onSelect: pop }
  ],
  category: () => [
    { label: `PvE Arcade ▸${config.category === 'pve' ? '  ✓' : ''}`, onSelect: () => (config.category = 'pve'), enter: 'pve' },
    { label: `PvP Tournament${config.category === 'pvp' ? '  ✓' : ''}`, onSelect: () => (config.category = 'pvp') },
    { label: `Teams Tournament${config.category === 'teams' ? '  ✓' : ''}`, onSelect: () => (config.category = 'teams') },
    { label: '◂ Back', onSelect: pop }
  ],
  pve: () => [
    { label: `Mode:  ${config.pveMode === 'koth' ? 'King of the Hill' : 'Last Man Standing'}   ◀ ▶`, onLeft: togglePve, onRight: togglePve },
    { label: `KOTH:  First to ${config.kothN}   ◀ ▶`, onLeft: () => cycleKoth(-1), onRight: () => cycleKoth(1) },
    { label: '◂ Back', onSelect: pop }
  ]
};

function onNav(dir) {
  const items = screens[stack[stack.length - 1]]();
  if (dir === 'up') focus = (focus - 1 + items.length) % items.length;
  else if (dir === 'down') focus = (focus + 1) % items.length;
  else if (dir === 'left') items[focus].onLeft?.();
  else if (dir === 'right') items[focus].onRight?.();
  else if (dir === 'select') { const it = items[focus]; it.onSelect?.(); if (it.enter) { stack.push(it.enter); focus = 0; } }
  else if (dir === 'back') pop();
  render();
}

const menuMsg = (t) => (el('tv-menu-msg').textContent = t);

function render() {
  const menu = el('tv-menu');
  if (!hostId || match) { menu.hidden = true; return; }
  menu.hidden = false;
  const items = screens[stack[stack.length - 1]]();
  if (focus >= items.length) focus = items.length - 1;
  const list = el('tv-menu-list');
  list.innerHTML = '';
  items.forEach((it, i) => { const li = document.createElement('li'); li.textContent = it.label; if (i === focus) li.classList.add('focused'); list.appendChild(li); });
}

/* ---------------- Phase 2: launch + render PvE ---------------- */
const activePlayers = () => players.filter((p) => p.connected !== false).map(({ playerId, name, members }) => ({ playerId, name, members }));

function startGame() {
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  const pc = activePlayers().length;
  const pv = validatePool(ENVIRONMENTS.PARTY, pool);
  if (!pv.ok) return menuMsg(pv.reason);
  if (!config.category) return menuMsg('Pick a category first.');
  const cv = validateCategory(config.category, pc);
  if (!cv.ok) return menuMsg(cv.reason);
  if (config.category !== 'pve') return menuMsg(`✅ ${config.category.toUpperCase()} is ready — its launch is the next slice (uses bracket.js).`);
  launchPve();
}

function launchPve() {
  const hard = !!config.pool.hard;
  const roster = activePlayers();
  showGame(true);
  el('tv-match-banner').textContent = config.pveMode === 'koth'
    ? `King of the Hill — first to ${config.kothN}${hard ? ' 🔥' : ''}`
    : 'Last Man Standing';
  if (config.pveMode === 'koth') {
    match = createKoth({ db, room: lobbyId, players: roster, n: config.kothN, hard, onTv: { state: renderRound }, onMatch: renderKoth });
  } else {
    match = createElim({ db, room: lobbyId, players: roster, onTv: { state: renderRound }, onMatch: renderElim });
  }
  logTransition('tv', 'setup', 'pve-launch', `${config.pveMode} n=${config.kothN} hard=${hard} players=${roster.length}`);
  match.nextRound();
}

function showGame(on) {
  el('tv-game').hidden = !on;
  el('tv-menu').hidden = on || !hostId;
  document.querySelector('.join-panel').hidden = on;
  document.querySelector('.players-panel').hidden = on;
  el('status').hidden = on;
}

function renderRound(g) {
  el('tv-target').innerHTML = `${fmt(g.targetMs)}<span class="timer-unit">s</span>`;
  const rows = el('tv-round-rows');
  rows.innerHTML = '';
  const order = g.status === 'over' && g.ranking
    ? g.ranking.concat(Object.keys(g.players).filter((id) => !g.ranking.includes(id)))
    : Object.keys(g.players);
  order.forEach((id) => {
    const s = g.players[id];
    const li = document.createElement('li');
    li.className = `round-row ${s.state}`;
    const time = s.state === 'stopped' ? `${fmtS2(s.elapsedMs)}s <span class="deviation">Δ ${fmtOff(s.deviationMs)}s</span>`
      : s.state === 'dnf' ? 'DNF' : s.state === 'running' ? '⏱…' : '—';
    const medal = g.status === 'over' && g.ranking?.[0] === id ? '🏆 ' : '';
    li.innerHTML = `<span class="row-name">${medal}${s.name}</span><span class="row-time">${time}</span>`;
    rows.appendChild(li);
  });
  const msg = el('tv-game-msg');
  msg.classList.toggle('final', g.status === 'over');
  msg.textContent = g.status === 'running'
    ? 'Tap to start your timer, tap again to stop — land on the target!'
    : g.status === 'over'
      ? (g.winner ? `🏆 ${g.winner.name} takes the round!` : 'No winner — host taps Next Round.')
      : '';
}

function renderKoth(m) {
  el('tv-match-banner').textContent = m.status === 'king' ? '👑 WE HAVE A KING 👑'
    : `King of the Hill — first to ${m.n} (round ${m.roundNum})${m.hard ? ' 🔥' : ''}`;
  const st = el('tv-standings');
  st.innerHTML = '';
  (m.tally || []).forEach((t) => { const li = document.createElement('li'); li.className = 'standing alive'; li.textContent = `${t.name} — ${t.wins}/${m.n}${'👑'.repeat(t.wins)}`; st.appendChild(li); });
  if (m.status === 'king') { el('tv-game-msg').classList.add('final'); el('tv-game-msg').textContent = `👑 ${m.king.name} is the King of the Hill!`; }
}

function renderElim(m) {
  el('tv-match-banner').textContent = m.status === 'champion' ? '👑 CHAMPION 👑' : `Last Man Standing — round ${m.roundNum}`;
  const st = el('tv-standings');
  st.innerHTML = '';
  for (const [id, name] of Object.entries(m.alive || {})) { const li = document.createElement('li'); li.className = 'standing alive'; li.textContent = name; st.appendChild(li); }
  for (const e of [...(m.eliminated || [])].reverse()) { const li = document.createElement('li'); li.className = 'standing out'; li.textContent = `${e.name} — out R${e.round}`; st.appendChild(li); }
  if (m.status === 'champion') { el('tv-game-msg').classList.add('final'); el('tv-game-msg').textContent = `👑 ${m.champion.name} is the last one standing!`; }
}

/* ---------------- boot ---------------- */
async function boot() {
  if (!lobbyId) { const { code } = await createSession(db); logTransition('tv', 'boot', 'created', `room ${code}`); location.replace(`/tv/${code}`); return; }
  el('room-code').textContent = lobbyId;
  const joinUrl = `${location.origin}/play/${lobbyId}`;
  el('join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  await QRCode.toCanvas(el('qr'), joinUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0d0f14', light: '#ffffff' } });
  el('status').textContent = 'Waiting for players…';
  watchPlayers(db, lobbyId, (list) => {
    players = list;
    hostId = (list.find((p) => p.uid) || {}).playerId || null;
    const ul = el('player-list'); ul.innerHTML = '';
    list.forEach((p) => { const li = document.createElement('li'); li.textContent = (hostId === p.playerId ? '⭐ ' : '') + (p.connected === false ? `⚠ ${p.name}` : p.name); li.classList.toggle('offline', p.connected === false); ul.appendChild(li); });
    el('players-empty').hidden = list.length > 0;
    if (!match) el('status').textContent = list.length ? `${list.length} in the lobby${hostId ? '' : ' — waiting for a signed-in host'}` : 'Waiting for players…';
    render();
  });
  consumeEvents(db, lobbyId, (ev) => {
    if (ev.type === 'nav' && !match && ev.playerId === hostId && ev.dir) { onNav(ev.dir); return; }
    if (ev.type === 'press' && match) { match.handleEvent(ev); return; }
    if (ev.type === 'next' && match && ev.playerId === hostId && match.isBetween()) { match.nextRound(); return; }
  });
  logTransition('tv', 'boot', 'lobby', `room ${lobbyId}`);
}
boot();

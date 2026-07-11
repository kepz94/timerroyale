// Phone controller (ADR-004). /play/CODE. Phases: SETUP (host D-Pad remote drives
// the TV menu), ACTIVE (all players get a PRESS button during a round),
// INTERMISSION (host taps Next Round to advance). First signed-in joiner = host.
import { ref as dref, update as dupdate, onValue } from 'firebase/database';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
import { initFirebase } from './firebase.js';
import { getSession, restorePlayer, joinRoom, validateName, watchPlayers, setupPresence } from './players.js';
import { watchAuth, signInGoogle, signOutUser, getProfile } from './auth.js';
import { sendEvent, sendPress } from './engine.js';
import { sfxStart, sfxStop, guessStartCue, guessStopCue, slamFlash } from './sfx.js';

const el = (id) => document.getElementById(id);
const db = initFirebase();
const parts = location.pathname.split('/').filter(Boolean);
const code = parts[1] ? parts[1].toUpperCase() : null;

const fmt2 = (ms) => (ms / 1000).toFixed(2);
const signed = (ms) => { const x = ms / 1000; return (x > 0 ? '+' : x < 0 ? '-' : '') + Math.abs(x).toFixed(2); };

let currentUser = null;
let me = null;
let players = [];
let gameState = null;
let matchState = null;
let guessDigits = '';
let guessSubmitted = false; // optimistic "locked in" feedback
let lastGuess = '';

async function boot() {
  const rc = el('reconnect-btn'); if (rc) rc.addEventListener('click', () => location.reload());
  if (!code) { el('status').textContent = 'No lobby in this link.'; return; }
  el('room-banner').textContent = `Lobby ${code}`;
  const session = await getSession(db, code);
  if (!session) { el('status').textContent = `Lobby ${code} not found — check the code on the TV.`; return; }
  me = await restorePlayer(db, code);
  if (me) onJoined(); else { el('join-form').hidden = false; el('status').textContent = 'Enter your name to join.'; }
  watchPlayers(db, code, (list) => { players = list; renderPhase(); });
  onValue(dref(db, `sessions/${code}/game`), (s) => {
    const prev = gameState;
    gameState = s.val();
    // Guess whole-screen signal (TR-56 spec B4): slam + beep on the phase
    // TRANSITIONS so every phone fires the cue in sync with the TV.
    if (gameState?.mode === 'guess' && prev?.mode === 'guess') {
      if (prev.status === 'get-ready' && gameState.status === 'interval') { slamFlash('start'); guessStartCue(); }
      else if (prev.status === 'interval' && gameState.status === 'guessing') { slamFlash('stop'); guessStopCue(); }
    }
    renderPhase();
  });
  onValue(dref(db, `sessions/${code}/match`), (s) => { matchState = s.val(); renderPhase(); });
  onValue(dref(db, `sessions/${code}/config`), (s) => { cfgState = s.val(); renderPhase(); });
}

function stampUid() { if (me && currentUser) dupdate(dref(db, `sessions/${code}/players/${me.playerId}`), { uid: currentUser.uid }).catch(() => {}); }

watchAuth(async (user) => {
  currentUser = user;
  el('auth-btn').hidden = !!user; el('auth-name').hidden = !user; el('signout-btn').hidden = !user;
  if (user) { const profile = await getProfile(db, user.uid); el('auth-name').textContent = profile?.displayName ?? user.email ?? 'signed in'; stampUid(); }
  renderPhase();
});
el('auth-btn').addEventListener('click', async () => { el('auth-btn').disabled = true; try { await signInGoogle(); } catch (err) { if (err.code !== 'auth/popup-closed-by-user') console.warn('[auth]', err.code); } el('auth-btn').disabled = false; });
el('signout-btn').addEventListener('click', signOutUser);

/* ---- Host setup: touch config UI (Stage 1 — the D-pad remote is deleted).
   The TV owns config truth at sessions/code/config; every control here sends
   the WHOLE desired config as a 'cfg' event, and this panel re-renders from
   the TV's published copy (stateless phone). ---- */
let cfgState = null;

function sendCfg(mutate) {
  if (!me) return;
  const c = cfgState
    ? { pool: { ...cfgState.pool }, category: cfgState.category ?? null, pveMode: cfgState.pveMode, kothN: cfgState.kothN, numTeams: cfgState.numTeams }
    : { pool: { classic: true, hard: false, guess: false }, category: null, pveMode: 'koth', kothN: 5, numTeams: 2 };
  mutate(c);
  sendEvent(db, code, me.playerId, 'cfg', { config: c });
}

document.querySelectorAll('#host-config [data-pool]').forEach((b) =>
  b.addEventListener('click', () => sendCfg((c) => { c.pool[b.dataset.pool] = !c.pool[b.dataset.pool]; })));
document.querySelectorAll('#host-config [data-cat]').forEach((b) =>
  b.addEventListener('click', () => sendCfg((c) => { c.category = b.dataset.cat; })));
el('hc-pve-mode')?.addEventListener('click', () => sendCfg((c) => { c.pveMode = c.pveMode === 'koth' ? 'lms' : 'koth'; }));
el('hc-koth-n')?.addEventListener('click', () => sendCfg((c) => { const t = [5, 7, 10]; c.kothN = t[(t.indexOf(c.kothN) + 1) % t.length]; }));
el('hc-teams-minus')?.addEventListener('click', () => sendCfg((c) => { c.numTeams = Math.max(2, (c.numTeams || 2) - 1); }));
el('hc-teams-plus')?.addEventListener('click', () => sendCfg((c) => { c.numTeams = Math.min(8, (c.numTeams || 2) + 1); }));
el('hc-start')?.addEventListener('click', () => { if (me) sendEvent(db, code, me.playerId, 'startgame'); });

function renderHostConfig(show) {
  const panel = el('host-config'); if (!panel) return;
  panel.hidden = !show;
  if (!show) return;
  const c = cfgState || { pool: { classic: true, hard: false, guess: false }, category: null, pveMode: 'koth', kothN: 5, numTeams: 2 };
  document.querySelectorAll('#host-config [data-pool]').forEach((b) => b.classList.toggle('hc-on', !!c.pool?.[b.dataset.pool]));
  document.querySelectorAll('#host-config [data-cat]').forEach((b) => b.classList.toggle('hc-on', c.category === b.dataset.cat));
  const pve = el('hc-pve'); if (pve) pve.hidden = c.category !== 'pve';
  const tms = el('hc-teams'); if (tms) tms.hidden = c.category !== 'teams';
  if (el('hc-pve-mode')) el('hc-pve-mode').textContent = c.pveMode === 'koth' ? `King of the Hill — first to ${c.kothN}` : 'Last Man Standing';
  if (el('hc-koth-n')) { el('hc-koth-n').hidden = c.pveMode !== 'koth'; el('hc-koth-n').textContent = `First to: ${c.kothN} (tap to cycle)`; }
  if (el('hc-teams-count')) el('hc-teams-count').textContent = String(c.numTeams || 2);
  if (el('hc-msg')) el('hc-msg').textContent = c.msg || '';
}
let readySent = false; // dual ready-up (Stage 2): one READY per presentation

el('big-press').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!me) return;
  // Matchup presentation: the big button IS the ready-up control.
  if (gameState?.mode === 'present') {
    if (readySent || !gameState.players?.[me.playerId]) return;
    readySent = true;
    sendEvent(db, code, me.playerId, 'ready');
    if (navigator.vibrate) navigator.vibrate(30);
    renderPhase();
    return;
  }
  if (gameState?.status !== 'running') return;
  const st = gameState.players?.[me.playerId]?.state;
  if (st !== 'waiting' && st !== 'running') return;
  const btn = el('big-press');
  btn.classList.add('pressed'); setTimeout(() => btn.classList.remove('pressed'), 150);
  const lbl = el('big-press-label');
  if (st === 'waiting') { try { sfxStart(); } catch {} if (navigator.vibrate) navigator.vibrate(30); btn.classList.add('running'); if (lbl) lbl.textContent = 'TAP TO STOP'; }
  else { try { sfxStop(); } catch {} if (navigator.vibrate) navigator.vibrate(20); btn.classList.remove('running'); btn.disabled = true; if (lbl) lbl.textContent = 'DONE'; }
  sendPress(db, code, me.playerId);
});
el('next-round-btn').addEventListener('click', () => { if (me) sendEvent(db, code, me.playerId, 'next'); });

/* ---- Guess Timer numeric keypad ---- */
function updateGuessDisplay() { const d = el('guess-display'); if (d) d.innerHTML = `${guessDigits || '0'}<span class="gd-unit">s</span>`; }
document.querySelectorAll('#guess-keys [data-k]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.k;
  if (k === 'back') guessDigits = guessDigits.slice(0, -1);
  else if (k === '.') { if (!guessDigits.includes('.')) guessDigits += (guessDigits === '' ? '0.' : '.'); }
  else if (guessDigits.replace('.', '').length < 5) guessDigits += k;
  updateGuessDisplay();
}));
el('guess-submit')?.addEventListener('click', () => {
  const secs = parseFloat(guessDigits);
  if (!me || !Number.isFinite(secs) || secs <= 0) return;
  sendEvent(db, code, me.playerId, 'guess', { value: Math.round(secs * 1000) });
  if (navigator.vibrate) navigator.vibrate(30);
  lastGuess = secs.toFixed(2); guessSubmitted = true; // instant confirmation
  guessDigits = ''; updateGuessDisplay();
  renderGuessPhone();
});

const nameOfLocal = (pid) => (players.find((p) => p.playerId === pid) || {}).name || pid;
el('draft-name-form').addEventListener('submit', (e) => { e.preventDefault(); const v = el('draft-name-input').value.trim(); if (me && v) sendEvent(db, code, me.playerId, 'team-name', { name: v }); el('draft-name-input').value = ''; });
document.querySelectorAll('#draft-emoji .emoji-btn').forEach((b) => b.addEventListener('click', () => { if (me) sendEvent(db, code, me.playerId, 'team-emoji', { emoji: b.textContent }); }));
el('draft-start-btn').addEventListener('click', () => { if (me) sendEvent(db, code, me.playerId, 'draft-done'); });
setInterval(() => { if (matchState && matchState.type === 'draft') renderDraftUI(); }, 1000);

function renderDraftUI() {
  const d = matchState;
  el('draft-panel').hidden = false;
  el('big-press').hidden = true; renderHostConfig(false); el('next-round-btn').hidden = true;
  if (el('result-panel')) el('result-panel').hidden = true;
  if (el('guess-panel')) el('guess-panel').hidden = true;
  const iAmCaptain = (d.teams || []).some((t) => t.captainId === me?.playerId);
  const isMyPick = d.status === 'drafting' && d.teams?.[d.turn]?.captainId === me?.playerId;
  const pool = el('draft-pool'); pool.innerHTML = '';
  el('draft-pool-label').hidden = !isMyPick;
  if (isMyPick) (d.pool || []).forEach((pid) => { const btn = document.createElement('button'); btn.className = 'join-btn'; btn.textContent = `Draft ${nameOfLocal(pid)}`; btn.addEventListener('click', () => sendEvent(db, code, me.playerId, 'draft-pick', { pick: pid })); pool.appendChild(btn); });
  const naming = d.status === 'naming' && iAmCaptain;
  el('draft-name-form').hidden = !naming;
  el('draft-emoji').hidden = !naming;
  const host = hostPlayer(); const iAmHost = host && me && host.playerId === me.playerId;
  el('draft-start-btn').hidden = !(iAmHost && d.status === 'naming');
  const secs = d.deadline ? Math.max(0, Math.ceil((d.deadline - Date.now()) / 1000)) : 0;
  el('turn-banner').textContent = d.status === 'drafting'
    ? (isMyPick ? `📋 Your pick! (${secs}s) Tap a player below.` : `📋 Draft in progress — ${nameOfLocal(d.teams?.[d.turn]?.captainId)} picking… (${secs}s)`)
    : (naming ? '🏷️ Name your team + pick an emoji.' : (iAmHost ? 'Captains are naming — tap Start Tournament when ready.' : 'Waiting for captains to name their teams…'));
}

el('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const check = validateName(el('name-input').value, players.map((p) => p.name));
  if (!check.ok) { el('join-error').textContent = check.error; return; }
  el('join-error').textContent = '';
  me = await joinRoom(db, code, check.name);
  stampUid(); setupPresence(db, code, me.playerId); onJoined();
});

function onJoined() { el('join-form').hidden = true; el('joined-panel').hidden = false; el('joined-name').textContent = me.name; el('status').textContent = "You're in — watch the TV!"; renderPhase(); }

const hostPlayer = () => players.find((p) => p.uid);

// The controller's result panel: "locked in" after you stop (blind), then the
// full reveal (your time + deviation vs opponents + who won) once the round ends.
function renderResult() {
  const panel = el('result-panel');
  if (!panel) return;
  const g = gameState;
  const mine = g && g.players ? g.players[me?.playerId] : null;
  if (!g || g.mode !== 'target' || !mine) { panel.hidden = true; return; } // hard/guess have their own UIs
  if (g.status === 'over') {
    const rows = Object.keys(g.players).map((id) => {
      const s = g.players[id];
      const t = s.state === 'stopped' ? `${fmt2(s.elapsedMs)}s (${signed(s.elapsedMs - g.targetMs)})` : s.state === 'dnf' ? 'DNF' : '—';
      const win = g.winner && g.winner.playerId === id ? ' 🏆' : '';
      const label = id === me.playerId ? 'You' : s.name;
      return `<div class="res-row${id === me.playerId ? ' me' : ''}"><span>${label}${win}</span><span>${t}</span></div>`;
    }).join('');
    const iWon = g.winner && g.winner.playerId === me.playerId;
    const title = iWon ? '🏆 You won the round!' : (g.winner ? 'You lost this round' : 'No winner this round');
    panel.innerHTML = `<div class="res-title">${title}</div>${rows}`;
    panel.hidden = false;
  } else if (mine.state === 'stopped') {
    panel.innerHTML = '<div class="res-title">🔒 Locked in</div><div class="res-sub">Waiting for the reveal on the TV…</div>';
    panel.hidden = false;
  } else {
    panel.hidden = true;
  }
}

// Guess Timer controller: the phone is a private numeric keypad. Show it only
// during the submission window if you're a contender this round.
function renderGuessPhone() {
  const panel = el('guess-panel'); if (!panel) return;
  const g = gameState;
  const mine = g && g.players ? g.players[me?.playerId] : null;
  const banner = el('turn-banner');
  if (!mine) { panel.hidden = true; if (banner) banner.textContent = '👀 Watch the TV — guess round in progress!'; return; }
  if (g.status === 'guessing' && mine.state !== 'guessed' && !guessSubmitted) {
    panel.hidden = false;
    el('guess-phone-status').textContent = '🚨 How long was the timer? Type your guess:';
  } else if (g.status === 'guessing' && (mine.state === 'guessed' || guessSubmitted)) {
    panel.hidden = true;
    if (banner) banner.textContent = `🔒 Locked in${lastGuess ? `: ${lastGuess}s` : ''} — watch the reveal!`;
  } else if (g.status === 'over') {
    panel.hidden = true; guessSubmitted = false; lastGuess = ''; guessDigits = ''; updateGuessDisplay();
    if (banner) banner.textContent = '👀 Check the reveal on the TV!';
  } else { // ready | get-ready | interval
    panel.hidden = true; guessSubmitted = false; lastGuess = '';
    if (banner) banner.textContent = '👂 Watch & listen — the timer is running (hidden)!';
  }
}

function renderPhase() {
  if (matchState && matchState.type === 'draft') { renderDraftUI(); return; }
  if (el('draft-panel')) el('draft-panel').hidden = true;
  const host = hostPlayer();
  const iAmHost = host && me && host.playerId === me.playerId;
  const guessMode = gameState?.mode === 'guess';
  const presentMode = gameState?.mode === 'present';
  if (!presentMode && readySent) readySent = false; // reset for the next matchup
  const active = guessMode ? (gameState.status && gameState.status !== 'over') : (gameState?.status === 'running');
  const over = ['king', 'champion'].includes(matchState?.status);
  const inMatch = matchState != null;
  const phase = over ? 'over' : active ? 'active' : inMatch ? 'intermission' : 'setup';

  renderHostConfig(iAmHost && phase === 'setup');
  const calledUp = presentMode && me && gameState?.players && gameState.players[me.playerId];
  const inThisRound = phase === 'active' && me && gameState?.players && gameState.players[me.playerId];
  if (el('big-press')) el('big-press').hidden = calledUp ? false : (!inThisRound || guessMode);
  if (calledUp) {
    const btn = el('big-press'); const lbl = el('big-press-label');
    btn.classList.remove('running');
    btn.disabled = readySent;
    if (lbl) lbl.textContent = readySent ? 'READY ✓' : "I'M READY";
  } else if (inThisRound && !guessMode) {
    const st = gameState.players?.[me.playerId]?.state;
    const btn = el('big-press'); const lbl = el('big-press-label');
    if (st === 'running') { btn.classList.add('running'); btn.disabled = false; if (lbl) lbl.textContent = 'TAP TO STOP'; }
    else if (st === 'stopped' || st === 'dnf') { btn.classList.remove('running'); btn.disabled = true; if (lbl) lbl.textContent = st === 'dnf' ? 'DNF' : 'DONE'; }
    else { btn.classList.remove('running'); btn.disabled = false; if (lbl) lbl.textContent = 'TAP TO START'; }
  }
  if (el('next-round-btn')) el('next-round-btn').hidden = !(iAmHost && phase === 'intermission');

  renderResult();
  if (guessMode && phase === 'active') renderGuessPhone();
  else if (el('guess-panel')) el('guess-panel').hidden = true;

  const banner = el('turn-banner');
  if (banner && !(guessMode && phase === 'active')) {
    if (!me) banner.textContent = '';
    else if (presentMode) banner.textContent = calledUp
      ? (readySent ? '✓ Ready — wait for your opponent…' : "📣 YOU'RE UP! Stand, face AWAY from the TV, tap I'M READY.")
      : '👀 Matchup on the TV — next round is being called.';
    else if (phase === 'active') banner.textContent = inThisRound ? '⏱ Tap to start, tap to stop — time it blind!' : '👀 Watching — you\'re up soon!';
    else if (phase === 'intermission') banner.textContent = iAmHost ? 'Round over — tap Next when ready.' : 'Round over — waiting for the host…';
    else if (phase === 'over') banner.textContent = '🏆 Game over — check the TV!';
    else if (iAmHost) banner.textContent = '⭐ You are the HOST — set up the night below; the TV mirrors your choices.';
    else if (host) banner.textContent = `Host: ${host.name}. Waiting for the game to start…`;
    else if (currentUser) banner.textContent = "You're signed in — you'll be host unless someone signed in before you.";
    else banner.textContent = 'Waiting for a signed-in host. Sign in with Google to host.';
  }

  const list = el('player-list');
  if (list) { list.innerHTML = ''; players.forEach((p) => { const li = document.createElement('li'); li.textContent = (host && host.playerId === p.playerId ? '⭐ ' : '') + p.name; li.classList.toggle('offline', p.connected === false); list.appendChild(li); }); }
}
boot();

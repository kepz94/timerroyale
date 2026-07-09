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
import { sfxStart, sfxStop } from './sfx.js';

const el = (id) => document.getElementById(id);
const db = initFirebase();
const parts = location.pathname.split('/').filter(Boolean);
const code = parts[1] ? parts[1].toUpperCase() : null;

let currentUser = null;
let me = null;
let players = [];
let gameState = null;
let matchState = null;

async function boot() {
  if (!code) { el('status').textContent = 'No lobby in this link.'; return; }
  el('room-banner').textContent = `Lobby ${code}`;
  const session = await getSession(db, code);
  if (!session) { el('status').textContent = `Lobby ${code} not found — check the code on the TV.`; return; }
  me = await restorePlayer(db, code);
  if (me) onJoined(); else { el('join-form').hidden = false; el('status').textContent = 'Enter your name to join.'; }
  watchPlayers(db, code, (list) => { players = list; renderPhase(); });
  onValue(dref(db, `sessions/${code}/game`), (s) => { gameState = s.val(); renderPhase(); });
  onValue(dref(db, `sessions/${code}/match`), (s) => { matchState = s.val(); renderPhase(); });
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

document.querySelectorAll('#dpad [data-dir]').forEach((b) => { b.addEventListener('click', () => { if (me) sendEvent(db, code, me.playerId, 'nav', { dir: b.dataset.dir }); }); });
el('big-press').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!me || gameState?.status !== 'running') return;
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

const nameOfLocal = (pid) => (players.find((p) => p.playerId === pid) || {}).name || pid;
el('draft-name-form').addEventListener('submit', (e) => { e.preventDefault(); const v = el('draft-name-input').value.trim(); if (me && v) sendEvent(db, code, me.playerId, 'team-name', { name: v }); el('draft-name-input').value = ''; });
document.querySelectorAll('#draft-emoji .emoji-btn').forEach((b) => b.addEventListener('click', () => { if (me) sendEvent(db, code, me.playerId, 'team-emoji', { emoji: b.textContent }); }));
el('draft-start-btn').addEventListener('click', () => { if (me) sendEvent(db, code, me.playerId, 'draft-done'); });
setInterval(() => { if (matchState && matchState.type === 'draft') renderDraftUI(); }, 1000);

function renderDraftUI() {
  const d = matchState;
  el('draft-panel').hidden = false;
  el('big-press').hidden = true; el('dpad').hidden = true; el('next-round-btn').hidden = true;
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

function renderPhase() {
  if (matchState && matchState.type === 'draft') { renderDraftUI(); return; }
  if (el('draft-panel')) el('draft-panel').hidden = true;
  const host = hostPlayer();
  const iAmHost = host && me && host.playerId === me.playerId;
  const active = gameState?.status === 'running';
  const over = ['king', 'champion'].includes(matchState?.status);
  const inMatch = matchState != null;
  const phase = over ? 'over' : active ? 'active' : inMatch ? 'intermission' : 'setup';

  if (el('dpad')) el('dpad').hidden = !(iAmHost && phase === 'setup');
  const inThisRound = phase === 'active' && me && gameState?.players && gameState.players[me.playerId];
  if (el('big-press')) el('big-press').hidden = !inThisRound;
  if (inThisRound) {
    const st = gameState.players?.[me.playerId]?.state;
    const btn = el('big-press'); const lbl = el('big-press-label');
    if (st === 'running') { btn.classList.add('running'); btn.disabled = false; if (lbl) lbl.textContent = 'TAP TO STOP'; }
    else if (st === 'stopped' || st === 'dnf') { btn.classList.remove('running'); btn.disabled = true; if (lbl) lbl.textContent = st === 'dnf' ? 'DNF' : 'DONE'; }
    else { btn.classList.remove('running'); btn.disabled = false; if (lbl) lbl.textContent = 'TAP TO START'; }
  }
  if (el('next-round-btn')) el('next-round-btn').hidden = !(iAmHost && phase === 'intermission');

  const banner = el('turn-banner');
  if (banner) {
    if (!me) banner.textContent = '';
    else if (phase === 'active') banner.textContent = inThisRound ? '⏱ Tap to start, tap to stop — time it blind!' : '👀 Watching — you\'re up soon!';
    else if (phase === 'intermission') banner.textContent = iAmHost ? 'Round over — tap Next Round when ready.' : 'Round over — waiting for the host…';
    else if (phase === 'over') banner.textContent = '🏆 Game over — check the TV!';
    else if (iAmHost) banner.textContent = '⭐ You are the HOST — set up the game on the TV with the remote.';
    else if (host) banner.textContent = `Host: ${host.name}. Waiting for the game to start…`;
    else if (currentUser) banner.textContent = "You're signed in — you'll be host unless someone signed in before you.";
    else banner.textContent = 'Waiting for a signed-in host. Sign in with Google to host.';
  }

  const list = el('player-list');
  if (list) { list.innerHTML = ''; players.forEach((p) => { const li = document.createElement('li'); li.textContent = (host && host.playerId === p.playerId ? '⭐ ' : '') + p.name; li.classList.toggle('offline', p.connected === false); list.appendChild(li); }); }
}
boot();

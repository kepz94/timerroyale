// Phone controller (ADR-004). Route: /play/CODE. Join a lobby; the FIRST
// signed-in player becomes the host, everyone else is a regular player. The
// D-Pad remote (setup phase), per-mode game input (active phase), and Next
// Round button (intermission) land in the follow-up TR-47 slice.
import { ref as dref, update as dupdate } from 'firebase/database';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
import { initFirebase } from './firebase.js';
import { getSession, restorePlayer, joinRoom, validateName, watchPlayers, setupPresence } from './players.js';
import { watchAuth, signInGoogle, signOutUser, getProfile } from './auth.js';
import { sendEvent } from './engine.js';

const el = (id) => document.getElementById(id);
const db = initFirebase();
const parts = location.pathname.split('/').filter(Boolean); // ['play','CODE']
const code = parts[1] ? parts[1].toUpperCase() : null;

let currentUser = null;
let me = null;      // {playerId, name}
let players = [];

async function boot() {
  if (!code) { el('status').textContent = 'No lobby in this link.'; return; }
  el('room-banner').textContent = `Lobby ${code}`;
  const session = await getSession(db, code);
  if (!session) { el('status').textContent = `Lobby ${code} not found — check the code on the TV.`; return; }
  me = await restorePlayer(db, code);
  if (me) onJoined(); else { el('join-form').hidden = false; el('status').textContent = 'Enter your name to join.'; }
  watchPlayers(db, code, (list) => { players = list; renderRoster(); });
}

function stampUid() {
  if (me && currentUser) dupdate(dref(db, `sessions/${code}/players/${me.playerId}`), { uid: currentUser.uid }).catch(() => {});
}

watchAuth(async (user) => {
  currentUser = user;
  el('auth-btn').hidden = !!user;
  el('auth-name').hidden = !user;
  el('signout-btn').hidden = !user;
  if (user) {
    const profile = await getProfile(db, user.uid);
    el('auth-name').textContent = profile?.displayName ?? user.email ?? 'signed in';
    stampUid();
  }
  renderRoster();
});
el('auth-btn').addEventListener('click', async () => {
  el('auth-btn').disabled = true;
  try { await signInGoogle(); } catch (err) { if (err.code !== 'auth/popup-closed-by-user') console.warn('[auth]', err.code); }
  el('auth-btn').disabled = false;
});
el('signout-btn').addEventListener('click', signOutUser);

// Host remote: each D-Pad button appends a 'nav' event the TV consumes to move
// the highlight / activate the focused option (Phase 1 — setup).
document.querySelectorAll('#dpad [data-dir]').forEach((b) => {
  b.addEventListener('click', () => { if (me) sendEvent(db, code, me.playerId, 'nav', { dir: b.dataset.dir }); });
});

el('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const check = validateName(el('name-input').value, players.map((p) => p.name));
  if (!check.ok) { el('join-error').textContent = check.error; return; }
  el('join-error').textContent = '';
  me = await joinRoom(db, code, check.name);
  stampUid();
  setupPresence(db, code, me.playerId);
  onJoined();
});

function onJoined() {
  el('join-form').hidden = true;
  el('joined-panel').hidden = false;
  el('joined-name').textContent = me.name;
  el('status').textContent = "You're in — watch the TV!";
  renderRoster();
}

/** Host = first joined player (roster is sorted by joinedAt) who is signed in. */
function hostPlayer() { return players.find((p) => p.uid); }

function renderRoster() {
  const host = hostPlayer();
  const banner = el('turn-banner');
  if (banner && me) {
    const iAmHost = host && host.playerId === me.playerId;
    if (el('dpad')) el('dpad').hidden = !iAmHost;
    if (iAmHost) banner.textContent = '⭐ You are the HOST — use the remote to set up the game on the TV.';
    else if (host) banner.textContent = `Host: ${host.name}. Waiting for the game to start…`;
    else if (currentUser) banner.textContent = "You're signed in — you'll be host unless someone signed in before you.";
    else banner.textContent = 'Waiting for a signed-in host. Sign in with Google to host.';
  }
  const list = el('player-list');
  if (list) {
    list.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = (host && host.playerId === p.playerId ? '⭐ ' : '') + p.name;
      li.classList.toggle('offline', p.connected === false);
      list.appendChild(li);
    });
  }
}
boot();

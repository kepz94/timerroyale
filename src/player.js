// Player (phone) entry point — a dumb remote that only sends button-press events.
import { ref, onValue } from 'firebase/database';
import { initFirebase } from './firebase.js';
import { getSession, restorePlayer, joinRoom, validateName, watchPlayers } from './players.js';
import { sendPress, sendEvent } from './engine.js';
import { logTransition } from './session.js';

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();

let currentPlayers = [];
let me = null;
let dbRef = null;
let game = null;

function isCaptain() {
  return me && currentPlayers.length > 0 && currentPlayers[0].playerId === me.playerId;
}

function renderGame() {
  if (!me) return;
  const banner = el('turn-banner');
  const btn = el('big-btn');
  const startBtn = el('start-btn');
  const rematchBtn = el('rematch-btn');
  const hint = el('joined-hint');

  const playing = game?.status === 'playing';
  const over = game?.status === 'over';
  const iAmDuelist = !!game?.duelists?.some((p) => p.playerId === me.playerId);
  const myTurn = playing && game.activePlayerId === me.playerId;

  startBtn.hidden = !(isCaptain() && !playing && !over && currentPlayers.length >= 2);
  rematchBtn.hidden = !(over && iAmDuelist);
  btn.hidden = (playing || over) && !iAmDuelist;

  btn.classList.toggle('your-turn', myTurn);
  btn.classList.toggle('waiting', playing && iAmDuelist && !myTurn);
  btn.disabled = playing && iAmDuelist && !myTurn;

  if (!game || (!playing && !over)) {
    banner.textContent = '';
    hint.textContent = startBtn.hidden ? "You're in — watch the TV!" : 'Everyone in? Start the duel!';
  } else if (playing) {
    banner.textContent = iAmDuelist ? (myTurn ? 'YOUR TURN!' : 'Wait…') : 'Spectating';
    hint.textContent = '';
  } else if (over) {
    if (me.playerId === game.winner?.playerId) banner.textContent = '🏆 You win!';
    else if (me.playerId === game.loser?.playerId) banner.textContent = "Time's up — you lose!";
    else banner.textContent = `${game.winner?.name} wins`;
    hint.textContent = '';
  }
}

function showJoined(name) {
  el('join-form').hidden = true;
  el('joined-panel').hidden = false;
  el('joined-name').textContent = name;
  el('status').textContent = '';
  renderGame();
}

function wireButtons() {
  el('big-btn').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!me || !dbRef || el('big-btn').disabled) return;
    el('big-btn').classList.add('pressed');
    setTimeout(() => el('big-btn').classList.remove('pressed'), 150);
    sendPress(dbRef, room, me.playerId);
  });
  el('start-btn').addEventListener('click', () => {
    sendEvent(dbRef, room, me.playerId, 'start');
    logTransition('player-ui', 'lobby', 'start-sent', me.playerId);
  });
  el('rematch-btn').addEventListener('click', () => {
    sendEvent(dbRef, room, me.playerId, 'rematch');
    logTransition('player-ui', 'over', 'rematch-sent', me.playerId);
  });
}

async function start() {
  const db = initFirebase();
  if (!room) {
    el('status').textContent = 'No room code — scan the QR on the TV to join.';
    return;
  }
  if (!db) {
    el('status').textContent = 'Firebase not configured.';
    return;
  }
  el('room-banner').textContent = `Room ${room}`;

  const session = await getSession(db, room);
  if (!session) {
    el('status').textContent = `Room ${room} doesn't exist — check the TV and rescan.`;
    logTransition('player-ui', 'loading', 'room-not-found', room);
    return;
  }

  dbRef = db;
  wireButtons();
  watchPlayers(db, room, (players) => { currentPlayers = players; renderGame(); });
  onValue(ref(db, `sessions/${room}/game`), (snap) => {
    game = snap.val();
    renderGame();
  });

  const restored = await restorePlayer(db, room);
  if (restored) {
    me = restored;
    showJoined(restored.name);
    return;
  }

  el('join-form').hidden = false;
  el('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const check = validateName(el('name-input').value, currentPlayers.map((p) => p.name));
    if (!check.ok) {
      el('join-error').textContent = check.error;
      logTransition('player-ui', 'form', 'rejected', check.error);
      return;
    }
    el('join-error').textContent = '';
    el('join-btn').disabled = true;
    try {
      const joined = await joinRoom(db, room, check.name);
      me = joined;
      showJoined(joined.name);
    } catch (err) {
      el('join-btn').disabled = false;
      el('join-error').textContent = `Couldn't join: ${err.message}`;
    }
  });
}

start();

// Player (phone) entry point — a blind remote. It never shows elapsed time:
// timing it in your head IS the game. Results appear on the TV only.
import { ref, onValue } from 'firebase/database';
import { registerSW } from 'virtual:pwa-register';
import { initFirebase } from './firebase.js';
registerSW({ immediate: true });
import { getSession, restorePlayer, joinRoom, validateName, watchPlayers, setupPresence } from './players.js';
import { sendPress, sendEvent } from './engine.js';
import { logTransition } from './session.js';

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();

let currentPlayers = [];
let me = null;
let dbRef = null;
let game = null;
let match = null;

function isCaptain() {
  return me && currentPlayers.length > 0 && currentPlayers[0].playerId === me.playerId;
}

function renderGame() {
  if (!me) return;
  const banner = el('turn-banner');
  const btn = el('big-btn');
  const label = el('big-btn-label');
  const startBtn = el('start-btn');
  const hint = el('joined-hint');

  const teamsBtn = el('teams-btn');
  const kothBtn = el('koth-btn');
  // ---- KOTH branch (TR-12) ----
  if (match?.type === 'koth') {
    teamsBtn.hidden = true;
    el('rematch-btn').hidden = true;
    kothBtn.hidden = true;
    el('koth-n').hidden = true;
    const mine = (match.tally || []).find((t) => t.playerId === me.playerId);
    if (match.status === 'round') {
      // fall through to the normal round rendering below (game node drives it)
    } else if (match.status === 'between') {
      banner.textContent = `${mine?.wins ?? 0}/${match.n} wins`;
      label.textContent = 'PRESS';
      btn.disabled = true; btn.classList.remove('your-turn', 'waiting');
      startBtn.hidden = !isCaptain();
      startBtn.textContent = 'Next round';
      hint.textContent = 'Crown race on the TV.';
      return;
    } else if (match.status === 'king') {
      const iAmKing = match.king?.playerId === me.playerId;
      banner.textContent = iAmKing ? '👑 YOU ARE THE KING!' : `👑 ${match.king?.name} is King`;
      label.textContent = 'PRESS';
      btn.disabled = true; btn.classList.remove('your-turn', 'waiting');
      startBtn.hidden = !isCaptain();
      startBtn.textContent = 'New game';
      hint.textContent = '';
      return;
    }
  }
  // ---- Team match branch (TR-7) ----
  if (match?.type === 'teams') {
    const target = game?.targetMs ? (game.targetMs / 1000).toFixed(1) : '?';
    const slot = game?.mode === 'relay' ? game.units?.[me.playerId] : null;
    teamsBtn.hidden = true;
    el('rematch-btn').hidden = true;
    if (match.status === 'round' && slot) {
      startBtn.hidden = true;
      const memberNow = slot.members?.[slot.current];
      if (slot.state === 'waiting') {
        banner.textContent = `Target: ${target}s — ${memberNow}, you're up!`;
        label.textContent = 'TAP TO START';
        btn.disabled = false; btn.classList.add('your-turn'); btn.classList.remove('waiting');
        hint.textContent = 'No peeking — pass the phone after your go.';
      } else if (slot.state === 'running') {
        banner.textContent = `Target: ${target}s`;
        label.textContent = 'TAP TO STOP';
        btn.disabled = false; btn.classList.add('your-turn'); btn.classList.remove('waiting');
        hint.textContent = '';
      } else if (slot.state === 'between') {
        banner.textContent = `Pass to ${memberNow}!`;
        label.textContent = 'TAP TO START';
        btn.disabled = false; btn.classList.add('your-turn'); btn.classList.remove('waiting');
        hint.textContent = `${slot.current}/${slot.members.length} done. No peeking!`;
      } else if (slot.state === 'done') {
        banner.textContent = 'All done!';
        label.textContent = '···';
        btn.disabled = true; btn.classList.remove('your-turn'); btn.classList.add('waiting');
        hint.textContent = 'Watch the TV.';
      } else {
        banner.textContent = 'Too slow — DNF';
        label.textContent = '···';
        btn.disabled = true; btn.classList.remove('your-turn'); btn.classList.add('waiting');
        hint.textContent = '';
      }
      return;
    }
    const standing = (match.leaderboard || []).findIndex((t) => t.unitId === me.playerId) + 1;
    const mine = (match.leaderboard || []).find((t) => t.unitId === me.playerId);
    if (match.status === 'between') {
      banner.textContent = `Round ${match.roundNum}/${match.rounds} done — ${standing ? `#${standing}, ${mine.points} pts` : ''}`;
      label.textContent = 'PRESS';
      btn.disabled = true; btn.classList.remove('your-turn', 'waiting');
      startBtn.hidden = !isCaptain();
      startBtn.textContent = 'Next round';
      hint.textContent = 'Standings on the TV.';
      return;
    }
    if (match.status === 'final') {
      const iWon = match.winner?.unitId === me.playerId;
      banner.textContent = iWon ? '🏆 Your team wins the series!' : `🏆 ${match.winner?.name} wins the series`;
      label.textContent = 'PRESS';
      btn.disabled = true; btn.classList.remove('your-turn', 'waiting');
      startBtn.hidden = !isCaptain();
      startBtn.textContent = 'New game';
      hint.textContent = standing ? `You finished #${standing} with ${mine.points} pts.` : '';
      return;
    }
  }
  // ---- end team branch ----

  const running = game?.status === 'running';
  const over = game?.status === 'over';
  const mySlot = game?.players?.[me.playerId] ?? null;
  const inMatch = match && match.type === 'elim' && match.status !== undefined;
  const iAmEliminated = inMatch && (match.eliminated || []).some((e) => e.playerId === me.playerId);
  const iAmChampion = inMatch && match.status === 'champion' && match.champion?.playerId === me.playerId;

  const elimBtn = el('rematch-btn');
  if (inMatch && match.status !== 'champion') {
    startBtn.hidden = !(isCaptain() && match.status === 'between');
    startBtn.textContent = 'Next round';
    elimBtn.hidden = true;
  } else {
    startBtn.hidden = !(isCaptain() && !running && currentPlayers.length >= 2);
    startBtn.textContent = over || match?.status === 'champion' ? 'New game' : 'Start round';
    elimBtn.hidden = startBtn.hidden || currentPlayers.length < 3;
    elimBtn.textContent = 'Elimination match';
    teamsBtn.hidden = startBtn.hidden;
    teamsBtn.textContent = 'Team match';
    kothBtn.hidden = startBtn.hidden;
    if (kothBtn.hidden) el('koth-n').hidden = true;
  }

  if (iAmEliminated && match.status !== 'champion') {
    banner.textContent = '💀 ELIMINATED';
    label.textContent = '···';
    btn.disabled = true;
    btn.classList.remove('your-turn');
    btn.classList.add('waiting');
    hint.textContent = 'Spectating — watch the TV.';
    return;
  }
  if (iAmChampion) {
    banner.textContent = '👑 CHAMPION!';
    label.textContent = 'PRESS';
    btn.disabled = true;
    btn.classList.remove('your-turn', 'waiting');
    hint.textContent = startBtn.hidden ? '' : 'Run it back?';
    return;
  }
  if (inMatch && match.status === 'champion' && !iAmChampion) {
    banner.textContent = `👑 ${match.champion?.name} wins the match`;
    label.textContent = 'PRESS';
    btn.disabled = true;
    btn.classList.remove('your-turn', 'waiting');
    hint.textContent = startBtn.hidden ? '' : 'Run it back?';
    return;
  }

  if (running && mySlot) {
    const target = (game.targetMs / 1000).toFixed(1);
    if (mySlot.state === 'waiting') {
      banner.textContent = `Target: ${target}s`;
      label.textContent = 'TAP TO START';
      btn.disabled = false;
      hint.textContent = 'Tap again when you think you hit it. No peeking — the TV has the timers.';
    } else if (mySlot.state === 'running') {
      banner.textContent = `Target: ${target}s`;
      label.textContent = 'TAP TO STOP';
      btn.disabled = false;
      hint.textContent = '';
    } else if (mySlot.state === 'stopped') {
      banner.textContent = 'Stopped!';
      label.textContent = '···';
      btn.disabled = true;
      hint.textContent = 'Watch the TV for the reveal.';
    } else { // dnf
      banner.textContent = 'Too slow — DNF';
      label.textContent = '···';
      btn.disabled = true;
      hint.textContent = '';
    }
    btn.classList.toggle('your-turn', mySlot.state === 'waiting' || mySlot.state === 'running');
    btn.classList.toggle('waiting', mySlot.state === 'stopped' || mySlot.state === 'dnf');
  } else if (over) {
    const iWon = game.winner?.playerId === me.playerId;
    const mine = game.players?.[me.playerId];
    banner.textContent = iWon ? '🏆 You won the round!' : (mine?.state === 'dnf' ? 'DNF that round' : 'Round over');
    label.textContent = 'PRESS';
    btn.disabled = true;
    btn.classList.remove('your-turn', 'waiting');
    hint.textContent = startBtn.hidden ? 'Results are on the TV.' : 'Results are on the TV — hit Next round when ready.';
  } else {
    banner.textContent = '';
    label.textContent = 'PRESS';
    btn.disabled = false;
    btn.classList.remove('your-turn', 'waiting');
    hint.textContent = startBtn.hidden ? "You're in — watch the TV!" : 'Everyone in? Start a round!';
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
    sendEvent(dbRef, room, me.playerId, 'start-elim');
    logTransition('player-ui', 'lobby', 'start-elim-sent', me.playerId);
  });
  el('teams-btn').addEventListener('click', () => {
    sendEvent(dbRef, room, me.playerId, 'start-teams');
    logTransition('player-ui', 'lobby', 'start-teams-sent', me.playerId);
  });
  el('koth-btn').addEventListener('click', () => {
    el('koth-n').hidden = !el('koth-n').hidden;
  });
  for (const b of document.querySelectorAll('.koth-n-btn')) {
    b.addEventListener('click', () => {
      el('koth-n').hidden = true;
      sendEvent(dbRef, room, me.playerId, 'start-koth', { n: Number(b.dataset.n) });
      logTransition('player-ui', 'lobby', 'start-koth-sent', `${me.playerId} n=${b.dataset.n}`);
    });
  }
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
  onValue(ref(db, `sessions/${room}/match`), (snap) => {
    match = snap.val();
    renderGame();
  });

  const restored = await restorePlayer(db, room);
  if (restored) {
    me = restored;
    setupPresence(db, room, me.playerId);
    showJoined(restored.name);
    return;
  }

  el('join-form').hidden = false;
  el('team-check').addEventListener('change', () => {
    el('members-input').hidden = !el('team-check').checked;
    el('name-input').placeholder = el('team-check').checked ? 'Team name' : 'e.g. Kepu';
  });
  el('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const check = validateName(el('name-input').value, currentPlayers.map((p) => p.name));
    if (!check.ok) {
      el('join-error').textContent = check.error;
      logTransition('player-ui', 'form', 'rejected', check.error);
      return;
    }
    let members = null;
    if (el('team-check').checked) {
      members = el('members-input').value.split(',').map((m) => m.trim()).filter(Boolean);
      if (members.length === 0) {
        el('join-error').textContent = 'List your team members (comma-separated).';
        return;
      }
    }
    el('join-error').textContent = '';
    el('join-btn').disabled = true;
    try {
      const joined = await joinRoom(db, room, check.name, members);
      me = joined;
      setupPresence(db, room, me.playerId);
      showJoined(joined.name);
    } catch (err) {
      el('join-btn').disabled = false;
      el('join-error').textContent = `Couldn't join: ${err.message}`;
    }
  });
}

start();

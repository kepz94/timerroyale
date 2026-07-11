// TV gameboard (ADR-004). Phase 1 highlight-menu (D-Pad). Phase 2/3: PvE
// (KOTH/LMS) and PvP/Teams tournaments launch on the TV; phones send press,
// host paces rounds with Next Round. TR-52: the party tournament hierarchy runs
// through tournament.js — a GAME is first to 5 round-wins, a MATCH is Best-of-5
// games (first to 3), matches alternate on the board after each completed game,
// and Grand Finals Mode locks onto the final two teams. The board moves through
// distinct STATE SCREENS: Active gameplay -> Reveal (recorded times + winner) ->
// Bracket intermission (between games).
import QRCode from 'qrcode';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
import { initFirebase } from './firebase.js';
import { createSession, logTransition } from './session.js';
import { watchPlayers } from './players.js';
import { consumeEvents } from './engine.js';
import { validatePool, validateCategory, resolveMode, ENVIRONMENTS, KOTH_THRESHOLDS } from './hostconfig.js';
import { createKoth } from './koth.js';
import { createMatch as createElim } from './elimination.js';
import { createBracket, reportGameWin, activeMatches, isComplete, roundLabel } from './bracket.js';
import { createTournament, restoreTournament, serializeTournament, ROUNDS_TO_WIN_GAME } from './tournament.js';
import { createClassicTargets } from './targets.js';
import { createTeamGame, distributeTeams } from './teamgame.js';
import { createDraftState, applyPick, autoPick, draftTeams } from './draft.js';
import { ref as dbRef, set as dbSet, get as dbGet } from 'firebase/database';
import { fmtOff, fmtS2, fmtS, fmtSigned } from './format.js';

const el = (id) => document.getElementById(id);
const fmt = (ms) => (ms / 1000).toFixed(1);
// Stage 1 precision: Classic/Hard targets ARE tenths, so they render to 1
// decimal. (Guess targets are hundredths but never displayed as targets.)
const fmtTarget = (g) => fmt(g.targetMs);
// Ledger-dot strip for a game score (filled / empty out of ROUNDS_TO_WIN_GAME).
const dots = (won, filled, empty) => filled.repeat(Math.min(won, ROUNDS_TO_WIN_GAME)) + empty.repeat(Math.max(0, ROUNDS_TO_WIN_GAME - won));
const db = initFirebase();
const parts = location.pathname.split('/').filter(Boolean);
const lobbyId = parts[1] ? parts[1].toUpperCase() : null;

let players = [];
let hostId = null;
let inGame = false;    // true once a game/tournament starts (gates the menu)
let engine = null;     // active round-composing engine (koth/elim/per-match koth)
let tourney = null;    // TR-52 tournament scheduler (PvP/Teams)
let bracket = null;    // tourney.bracket (kept for the TV bracket render)
let curMatch = null;
let isTeams = false;
let awaitingNextGame = false; // between-games: wait for the host to tap Next
let resumeWins = null;         // one-shot: seed a resumed PvP game's score
let resumeTeam = null;         // one-shot: seed a resumed Team game's score
let draftState = null;
let clockTimer = null;         // live TV clock loop (live-clock screens)
let currentScreen = null;
let audioCtx = null, soundOn = false; // TV audio (unlocked by the Enable-sound tap)
let pickDeadline = 0;
let draftClock = null;

/* ---------------- setup: host phone config, TV mirror (Stage 1) ----------------
   ADR-005 deleted the D-pad remote. The host configures on their PHONE with a
   normal touch UI; the phone sends 'cfg' events carrying the whole config, the
   TV validates, publishes it to sessions/room/config (so the stateless phone
   re-renders from truth), and mirrors the choices on screen. */
const config = { pool: { classic: true, hard: false, guess: false }, category: null, pveMode: 'koth', kothN: 5, numTeams: 2 };

const menuMsg = (t) => (el('tv-menu-msg').textContent = t);

function publishConfig(msg = '') {
  dbSet(dbRef(db, `sessions/${lobbyId}/config`), { ...config, msg, at: Date.now() }).catch(() => {});
}

function applyCfg(c) {
  if (!c || typeof c !== 'object') return;
  if (c.pool && typeof c.pool === 'object') {
    config.pool = { classic: !!c.pool.classic, hard: !!c.pool.hard, guess: !!c.pool.guess };
  }
  if (['pve', 'pvp', 'teams', null].includes(c.category)) config.category = c.category;
  if (c.pveMode === 'koth' || c.pveMode === 'lms') config.pveMode = c.pveMode;
  if (KOTH_THRESHOLDS.includes(c.kothN)) config.kothN = c.kothN;
  if (Number.isInteger(c.numTeams)) config.numTeams = Math.max(2, Math.min(8, c.numTeams));
  publishConfig();
  render();
}

function render() {
  const menu = el('tv-menu');
  if (!hostId || inGame) { menu.hidden = true; return; }
  menu.hidden = false;
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  const catLabel = { pve: `PvE Arcade — ${config.pveMode === 'koth' ? `King of the Hill (first to ${config.kothN})` : 'Last Man Standing'}`, pvp: 'PvP Tournament', teams: `Teams Tournament — ${config.numTeams} teams` };
  const items = [
    `Game pool:  ${pool.length ? pool.join(' + ') : '(none picked)'}`,
    `Category:  ${config.category ? catLabel[config.category] : '(pick on the host phone)'}`,
    'Host — set up the night on your phone.'
  ];
  const list = el('tv-menu-list');
  list.innerHTML = '';
  items.forEach((t) => { const li = document.createElement('li'); li.textContent = t; list.appendChild(li); });
}

/* ---------------- state-screen helpers (TR-52) ---------------- */
// Toggle the three distinct board screens. 'active' = live gameplay,
// 'reveal' = the recorded-times card layout, 'bracket' = the between-games tree.
// Stage 1 (ADR-005): the 3s round-hint splash is DELETED — its job moves to
// the Stage 2 matchup presentation.
function showScreen(s) {
  currentScreen = s;
  el('tv-active').hidden = s !== 'active';
  el('tv-reveal').hidden = s !== 'reveal';
  el('tv-hard').hidden = s !== 'hard';
  el('tv-guess').hidden = s !== 'guess';
  el('tv-bracket').hidden = s !== 'bracket';
  if (s !== 'bracket') el('tv-rotation').textContent = '';
  if (s === 'reveal' || s === 'hard' || s === 'bracket' || s === 'guess') el('tv-standings').hidden = true;
  if (s === 'bracket') { el('tv-ledger').hidden = true; el('tv-turn').hidden = true; }
}

// TR-52 §5: the Hard Classic retry-loop screen — live attempt history while the
// active rep retries, then the "TARGET MATCHED" success layout. teamCtx (Teams)
// supplies team names for the representing / up-next callout.
function renderHard(g, teamCtx) {
  showScreen('hard');
  const target1 = fmtS(g.targetMs);
  const zoneLo = Math.floor(g.targetMs / 100) * 100, zoneHi = zoneLo + 99;
  const teamNameFor = (pid) => {
    if (!teamCtx) return '';
    return pid === teamCtx.activeA.playerId ? teamCtx.teamA.name : pid === teamCtx.activeB.playerId ? teamCtx.teamB.name : '';
  };
  el('tv-match-banner').textContent = `HARD CLASSIC — TARGET ${target1}s`;
  if (g.status === 'over') {
    stopClockLoop(); if (el('hard-clock')) el('hard-clock').hidden = true;
    const w = g.winner;
    const wAtt = w ? (g.attempts[w.playerId] || []) : [];
    const cleanHit = wAtt.some((a) => a.hit);
    const winTime = wAtt.length ? wAtt[wAtt.length - 1].elapsedMs : null;
    el('hard-head').textContent = cleanHit ? '🎯 TARGET MATCHED!' : 'ROUND OVER';
    el('hard-sub').textContent = w
      ? (cleanHit ? `${w.name} hits the zone on attempt #${wAtt.length}` : `${w.name} takes it — closest attempt`)
      : 'No winner — host taps Next Round.';
    el('hard-target').innerHTML = winTime != null ? `${fmtS2(winTime)}<span class="timer-unit">s</span>` : '';
    el('hard-zone').textContent = `MATCH ZONE ${fmtS2(zoneLo)}s – ${fmtS2(zoneHi)}s`;
    el('hard-history').innerHTML = '';
    el('hard-winner').textContent = w ? `🏆 ${teamNameFor(w.playerId) || w.name} wins the round! (+1 ledger dot)` : '';
    if (w && cleanHit) chime(); else slideWhistle();
    el('hard-representing').textContent = '';
  } else {
    // Stage 1 RACE view: both reps attempt simultaneously; first into the zone
    // wins instantly. Show both live clocks and both attempt histories.
    const ids = [g.repA.playerId, g.repB.playerId];
    el('hard-head').textContent = '🏁 RACE TO THE ZONE';
    el('hard-sub').textContent = `First to land in the zone wins — ${ids.map((id) => `${g.players[id]?.name || ''} ${((g.attempts[id] || []).length)}/13`).join('  ·  ')}`;
    el('hard-target').innerHTML = `${target1}<span class="timer-unit">s</span>`;
    el('hard-zone').textContent = `HIT THE ZONE ${fmtS2(zoneLo)}s – ${fmtS2(zoneHi)}s`;
    const hist = el('hard-history'); hist.innerHTML = '';
    ids.forEach((id) => {
      const name = g.players[id]?.name || '';
      (g.attempts[id] || []).slice(-4).forEach((a) => {
        const li = document.createElement('li'); li.className = 'round-row ' + (a.hit ? 'hit' : 'dnf');
        li.innerHTML = `<span class="row-name">${a.hit ? '🎯' : '❌'} ${teamNameFor(id) || name}</span><span class="row-time">${fmtS2(a.elapsedMs)}s ${a.hit ? '(HIT!)' : (a.early ? '(Too Early)' : '(Too Late)')}</span>`;
        hist.appendChild(li);
      });
      if (g.players[id]?.state === 'dnf') {
        const li = document.createElement('li'); li.className = 'round-row dnf';
        li.innerHTML = `<span class="row-name">${teamNameFor(id) || name}</span><span class="row-time">WASHED OUT</span>`;
        hist.appendChild(li);
      }
    });
    const hc = el('hard-clock');
    if (hc) {
      hc.hidden = false;
      hc.removeAttribute('data-clock-start');
      hc.style.fontSize = 'clamp(1.6rem, 4vw, 4rem)';
      hc.innerHTML = ids.map((id) => {
        const p = g.players[id] || {};
        const t = p.state === 'running' && p.startHostTs
          ? `<span data-clock-start="${p.startHostTs}">0.00s</span>`
          : p.state === 'dnf' ? 'washed' : '—';
        return `<span style="margin:0 1.2rem">${p.name || ''}: ${t}</span>`;
      }).join('');
      startClockLoop();
    }
    el('hard-winner').textContent = '';
    el('hard-representing').textContent = teamCtx
      ? `${teamCtx.teamA.name}: ${teamCtx.activeA.name}   vs   ${teamCtx.teamB.name}: ${teamCtx.activeB.name}`
      : '';
  }
}

function showLedger(aName, aWon, bName, bWon) {
  const l = el('tv-ledger');
  l.hidden = false;
  l.innerHTML =
    `<div class="team"><span class="name">${aName}</span><span class="dot-strip">${dots(aWon, '🔵', '⚪')}</span></div>` +
    `<div class="team"><span class="name">${bName}</span><span class="dot-strip">${dots(bWon, '🔴', '⚪')}</span></div>`;
}

// Live TV clocks (Team tournaments): tick any element carrying data-clock-start
// (= the player's host-time start). Active reps face away; the room watches.
function stopClockLoop() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }
function startClockLoop() {
  stopClockLoop();
  clockTimer = setInterval(() => {
    document.querySelectorAll('[data-clock-start]').forEach((elm) => {
      const st = Number(elm.getAttribute('data-clock-start'));
      if (st > 0) elm.textContent = `${((Date.now() - st) / 1000).toFixed(2)}s`;
    });
  }, 60);
}

// Live status rows for the active screen (also used for PvE ranking).
function fillRows(g, labelById) {
  const rows = el('tv-round-rows'); rows.innerHTML = '';
  const order = g.status === 'over' && g.ranking
    ? g.ranking.concat(Object.keys(g.players).filter((id) => !g.ranking.includes(id)))
    : Object.keys(g.players);
  order.forEach((id) => {
    const s = g.players[id];
    const li = document.createElement('li'); li.className = `round-row ${s.state}`;
    // TR-52 blind reveal: keep recorded times hidden until the round is over.
    const time = s.state === 'stopped'
      ? (g.status === 'over'
          ? `${fmtS2(s.elapsedMs)}s <span class="deviation">Δ ${fmtSigned(s.elapsedMs - g.targetMs)}s</span>`
          : '🔒 Locked in')
      : s.state === 'dnf' ? 'DNF' : s.state === 'running' ? '⏱…' : '—';
    const medal = g.status === 'over' && g.ranking?.[0] === id ? '🏆 ' : '';
    const lbl = labelById && labelById[id] ? `${labelById[id]}: ` : '';
    li.innerHTML = `<span class="row-name">${medal}${lbl}${s.name}</span><span class="row-time">${time}</span>`;
    rows.appendChild(li);
  });
}

// TV audio (Web Audio). A passive cast screen can't autoplay sound, so the host
// taps "Enable sound" once to unlock the context; everything is a no-op until then.
function beep(freq, durMs, vol = 0.22) {
  if (!soundOn || !audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'square'; o.frequency.value = freq;
  o.connect(g); g.connect(audioCtx.destination);
  const t = audioCtx.currentTime;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + durMs / 1000);
  o.start(t); o.stop(t + durMs / 1000);
}
function chime() { beep(660, 120); setTimeout(() => beep(990, 200), 130); }

// Scheduled tone (relative start, for rolls/sweeps).
function noteAt(freq, startS, durMs, vol = 0.2, type = 'square') {
  if (!soundOn || !audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  o.connect(g); g.connect(audioCtx.destination);
  const t = audioCtx.currentTime + startS;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + durMs / 1000);
  o.start(t); o.stop(t + durMs / 1000);
}
// Cinematic drum-roll then a hit — for the Guess reveal.
function drumroll() {
  if (!soundOn || !audioCtx) return;
  for (let i = 0; i < 14; i++) noteAt(110 + i * 3, i * 0.055, 50, 0.16, 'triangle');
  setTimeout(chime, 820);
}
// Heavy mechanical latch — for a guess "LOCKED IN".
function latch() { noteAt(190, 0, 35, 0.3, 'square'); noteAt(85, 0.035, 70, 0.28, 'square'); }
// Descending slide-whistle — for a DNF / shattered-glass moment.
function slideWhistle() {
  if (!soundOn || !audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'sine'; o.connect(g); g.connect(audioCtx.destination);
  const t = audioCtx.currentTime;
  o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(200, t + 0.5);
  g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
  o.start(t); o.stop(t + 0.55);
}
let lastGuessedCount = 0; // to fire a latch only on a NEW lock-in
let guessRevealTimer = null, guessRevealKey = null; // reversed-reveal sequencing
function enableSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume(); soundOn = true;
    const b = el('tv-sound'); if (b) { b.textContent = '🔊 Sound on'; b.style.opacity = '.5'; }
    beep(880, 120);
  } catch { /* audio unavailable */ }
}

// Guess Timer start/stop sensory cue: green flash + high beep (start),
// red flash + low beep (stop).
function flashCue(kind) {
  const f = el('tv-flash');
  if (f) { f.classList.remove('green', 'red'); void f.offsetWidth; f.classList.add(kind === 'start' ? 'green' : 'red'); setTimeout(() => f.classList.remove('green', 'red'), 500); }
  beep(kind === 'start' ? 880 : 330, kind === 'start' ? 160 : 260);
}

// Guess Timer phase screens: observation (clock hidden) -> suspense (locking in)
// -> reveal (actual time + each guess + winner). teamCtx supplies team names.
function renderGuess(g, teamCtx) {
  showScreen('guess');
  const ids = Object.keys(g.players);
  const labelFor = (id, i) => teamCtx ? (i === 0 ? teamCtx.teamA.name : teamCtx.teamB.name) : (g.players[id].name);
  el('tv-match-banner').textContent = teamCtx
    ? `${teamCtx.teamA.name}  ${teamCtx.winsA}–${teamCtx.winsB}  ${teamCtx.teamB.name}   ·  GUESS THE CLOCK`
    : 'GUESS THE CLOCK';
  const actual = el('guess-actual'), cards = el('guess-cards');
  if (g.status === 'over') {
    // Stage 1 (ADR-005): the reveal order is REVERSED — guesses show first,
    // the actual time lands last.
    const key = `${g.actualMs}:${ids.map((id) => g.players[id].guessMs).join(',')}`;
    const drawCards = (withDev) => {
      cards.innerHTML = '';
      ids.forEach((id, i) => {
        const s = g.players[id];
        const isWin = withDev && g.winner && g.winner.playerId === id;
        const guess = s.guessMs != null ? `${fmtS2(s.guessMs)}s` : '0.00s';
        const dev = withDev
          ? (s.guessMs != null ? `DEVIATION ${fmtSigned(s.guessMs - g.actualMs)}s` : 'no guess')
          : '';
        const card = document.createElement('div');
        card.className = 'reveal-card' + (isWin ? ' win' : '');
        card.innerHTML = `<div class="rc-team">${labelFor(id, i)}</div><div class="rc-name">${s.name}</div><div class="rc-time">${guess}</div><div class="rc-dev">${dev}</div>`;
        cards.appendChild(card);
      });
    };
    if (guessRevealKey !== key) {
      guessRevealKey = key;
      el('guess-head').textContent = 'THE GUESSES ARE IN';
      actual.hidden = true;
      drawCards(false);
      el('guess-winner').textContent = '…and the actual time was…';
      lastGuessedCount = 0;
      clearTimeout(guessRevealTimer);
      guessRevealTimer = setTimeout(() => {
        el('guess-head').textContent = 'THE REVEAL';
        actual.hidden = false;
        actual.innerHTML = `ACTUAL ${fmtS2(g.actualMs)}<span class="timer-unit">s</span>`;
        drawCards(true);
        el('guess-winner').textContent = g.winner ? `🏆 ${labelFor(g.winner.playerId, ids.indexOf(g.winner.playerId))} wins the round! (+1)` : 'No winner';
        drumroll(); // cinematic reveal (ends on a chime)
      }, 2200);
    }
  } else if (g.status === 'guessing') {
    guessRevealKey = null; clearTimeout(guessRevealTimer);
    el('guess-head').textContent = '🚨 TIME IS UP — SUBMIT YOUR GUESS!';
    actual.hidden = true;
    cards.innerHTML = '';
    ids.forEach((id, i) => {
      const s = g.players[id];
      const locked = s.state === 'guessed';
      const card = document.createElement('div');
      card.className = 'reveal-card' + (locked ? ' win' : '');
      card.innerHTML = `<div class="rc-team">${labelFor(id, i)}</div><div class="rc-name">${s.name}</div><div class="rc-time" style="font-size:clamp(2rem,5vw,5rem)">${locked ? 'LOCKED IN 🔒' : 'THINKING…'}</div>`;
      cards.appendChild(card);
    });
    const guessedNow = ids.filter((id) => g.players[id].state === 'guessed').length;
    if (guessedNow > lastGuessedCount) latch(); // heavy latch on a new lock-in
    lastGuessedCount = guessedNow;
    el('guess-winner').textContent = '';
  } else { // ready | get-ready | interval
    lastGuessedCount = 0;
    guessRevealKey = null; clearTimeout(guessRevealTimer);
    el('guess-head').textContent = g.status === 'interval' ? '⏱️ TIMER RUNNING — clock hidden!' : 'GET READY…';
    actual.hidden = true;
    cards.innerHTML = '';
    el('guess-winner').textContent = ids.length === 2 ? `Representing: ${labelFor(ids[0], 0)}  vs  ${labelFor(ids[1], 1)}` : '';
  }
}

// The Reveal screen: one big card per contender (recorded time + signed
// deviation), clutch highlight (winning deviation within 0.05s) and a
// shattered-glass treatment on a DNF.
function renderReveal(contenders, winnerId) {
  showScreen('reveal');
  const winner = contenders.find((c) => c.playerId === winnerId) || null;
  const clutch = !!(winner && winner.state === 'stopped' && Math.abs(winner.elapsedMs - winner.targetMs) <= 50);
  const wrap = el('reveal-cards'); wrap.innerHTML = '';
  contenders.forEach((c) => {
    const isWin = c.playerId === winnerId;
    const card = document.createElement('div');
    card.className = 'reveal-card' + (isWin ? (clutch ? ' win clutch' : ' win') : '') + (c.state === 'dnf' ? ' dnf' : '');
    const time = c.state === 'stopped' ? `${fmtS2(c.elapsedMs)}s` : c.state === 'dnf' ? 'DNF' : '—';
    const dev = c.state === 'stopped' ? `DEVIATION ${fmtSigned(c.elapsedMs - c.targetMs)}s` : (c.state === 'dnf' ? 'DID NOT FINISH' : '');
    card.innerHTML = `<div class="rc-team">${c.team || ''}</div><div class="rc-name">${c.name}</div><div class="rc-time">${time}</div><div class="rc-dev">${dev}</div>`;
    wrap.appendChild(card);
  });
  el('reveal-head').textContent = 'ROUND COMPLETE';
  el('reveal-sub').textContent = 'Recorded times';
  const banner = el('reveal-winner');
  banner.classList.toggle('clutch', clutch);
  banner.textContent = winner
    ? (clutch ? `🏆 CLUTCH WINNER: ${winner.name} (within 0.05s)` : `🏆 ${winner.name} wins the round! (+1)`)
    : 'No winner — host taps Next Round.';
  if (contenders.some((c) => c.state === 'dnf')) slideWhistle();
  else if (winner) chime();
}

/* ---------------- launch ---------------- */
const activePlayers = () => players.filter((p) => p.connected !== false).map(({ playerId, name, members }) => ({ playerId, name, members }));

/* ---------------- Stage 2 (TR-56): matchup presentation + dual ready-up ----
   Spec B1: before every party round the TV calls the two players to stand
   facing away, presents the matchup (mode + objective — this absorbed the old
   hint splash), and the round fires only when BOTH standing players tap READY
   on their phones. The presentation holds a minimum 6s beat. The host's Next
   acts as a force-start escape hatch if someone wanders off. */
let presenting = null; // { reps, ready:Set, t0, fired }
let nextKind = null;   // mode resolved AT presentation time so the TV can announce it

const KIND_LABEL = {
  classic: ['CLASSIC', 'Land closest to the target — one start, one stop'],
  hard: ['HARD CLASSIC', 'RACE: first to land INSIDE the zone wins'],
  guess: ['GUESS THE CLOCK', 'No clocks. Feel the time, closest guess wins'],
};

function beginRound() {
  if (!engine) return;
  const reps = engine.peekReps ? engine.peekReps() : null;
  if (!reps) { engine.nextRound(); return; } // PvE all-play: no matchup beat
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  nextKind = resolveMode(pool);
  presenting = { reps, ready: new Set(), t0: Date.now(), fired: false };
  // Publish the presentation as the game state so the two phones show READY
  // and everyone else's phone narrates (stateless-phone principle).
  dbSet(dbRef(db, `sessions/${lobbyId}/game`), {
    mode: 'present', status: 'present', kind: nextKind,
    players: {
      [reps.a.playerId]: { playerId: reps.a.playerId, name: reps.a.name, state: 'called' },
      [reps.b.playerId]: { playerId: reps.b.playerId, name: reps.b.name, state: 'called' },
    },
    updatedAt: Date.now(),
  }).catch(() => {});
  renderPresent();
}

function firePresented(trigger) {
  if (!presenting || presenting.fired) return;
  presenting.fired = true;
  const wait = Math.max(0, 6000 - (Date.now() - presenting.t0)); // hold the beat
  logTransition('tv', 'present', 'firing', `${trigger} (in ${wait}ms)`);
  setTimeout(() => { presenting = null; engine?.nextRound(); nextKind = null; }, wait);
}

function onReady(ev) {
  if (!presenting || presenting.fired) return;
  const ids = [presenting.reps.a.playerId, presenting.reps.b.playerId];
  if (!ids.includes(ev.playerId)) return;
  presenting.ready.add(ev.playerId);
  renderPresent();
  if (presenting.ready.size === 2) firePresented('dual ready-up');
}

function renderPresent() {
  if (!presenting) return;
  showScreen('reveal'); // reuse the card layout for the matchup presentation
  const [t, obj] = KIND_LABEL[nextKind] || ['', ''];
  const { reps, ready } = presenting;
  el('reveal-head').innerHTML = `<span class="tv-words">${t}</span>`;
  el('reveal-sub').innerHTML = `<span class="tv-words">${obj}</span>`;
  const wrap = el('reveal-cards'); wrap.innerHTML = '';
  [reps.a, reps.b].forEach((r) => {
    const card = document.createElement('div');
    card.className = 'reveal-card' + (ready.has(r.playerId) ? ' win' : '');
    card.innerHTML = `<div class="rc-team tv-words">${ready.has(r.playerId) ? 'READY' : 'STAND UP'}</div><div class="rc-name">${r.name}</div><div class="rc-dev tv-words">${ready.has(r.playerId) ? '✓' : 'face away from the TV'}</div>`;
    wrap.appendChild(card);
  });
  el('reveal-winner').textContent = ready.size === 2 ? 'Both ready — here we go…' : 'Round starts when BOTH tap READY on their phones.';
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = '';
}

// Setup problems surface BOTH on the TV and on the host phone (via the
// published config's msg field) — the phone is where the host is looking.
const setupMsg = (t) => { menuMsg(t); publishConfig(t); };

function startGame() {
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  const pc = activePlayers().length;
  const pv = validatePool(ENVIRONMENTS.PARTY, pool);
  if (!pv.ok) return setupMsg(pv.reason);
  if (!config.category) return setupMsg('Pick a category first.');
  const cv = validateCategory(config.category, pc);
  if (!cv.ok) return setupMsg(cv.reason);
  if (config.category === 'pve') return launchPve();
  if (config.category === 'pvp') return launchPvp();
  if (config.category === 'teams') return launchTeams();
}

function showGame(on) {
  inGame = on;
  document.body.classList.toggle('playing', on); // TV-first full-screen layout
  el('tv-game').hidden = !on;
  el('tv-menu').hidden = on || !hostId;
  document.querySelector('.join-panel').hidden = on;
  document.querySelector('.players-panel').hidden = on;
  el('status').hidden = on;
}

/* ---- PvE ---- */
function launchPve() {
  const hard = !!config.pool.hard;
  const roster = activePlayers();
  showGame(true);
  el('tv-match-banner').textContent = config.pveMode === 'koth' ? `King of the Hill — first to ${config.kothN}${hard ? ' 🔥' : ''}` : 'Last Man Standing';
  engine = config.pveMode === 'koth'
    ? createKoth({ db, room: lobbyId, players: roster, n: config.kothN, hard, onTv: { state: renderRound }, onMatch: renderKoth })
    : createElim({ db, room: lobbyId, players: roster, onTv: { state: renderRound }, onMatch: renderElim });
  logTransition('tv', 'setup', 'pve-launch', `${config.pveMode} players=${roster.length}`);
  beginRound();
}

/* ---- PvP single-elim tournament (TR-52 hierarchy) ---- */
function launchPvp() {
  const ents = activePlayers().map((p) => ({ id: p.playerId, name: p.name }));
  tourney = createTournament(ents); // MATCH = Best of 5 games (first to 3)
  bracket = tourney.bracket;
  showGame(true);
  logTransition('tv', 'setup', 'pvp-launch', `${ents.length} players`);
  nextTourneyGame();
}

// Persist the whole tournament (bracket + config + current match) so a TV reload
// can RESUME it (see boot) instead of restarting to the menu. Never throws.
function persistTournament() {
  if (!tourney) return;
  try {
    const snapshot = serializeTournament(tourney.bracket, curMatch);
    dbSet(dbRef(db, `sessions/${lobbyId}/match`), {
      type: 'tournament',
      status: tourney.isComplete() ? 'complete' : 'playing',
      teams: !!isTeams, hard: !!config.pool.hard,
      snapshot,
    }).catch(() => {});
  } catch { /* persistence must never break the live game */ }
}

// Keep a Team game's live score in the match node so a mid-game reload resumes
// at the real score (koth already carries its tally). Never throws.
function persistTeamScore(r) {
  if (!tourney) return;
  try {
    dbSet(dbRef(db, `sessions/${lobbyId}/match`), {
      type: 'team', status: 'playing', winsA: r.winsA, winsB: r.winsB, roundNum: r.roundNum,
      teams: true, hard: !!config.pool.hard,
      snapshot: serializeTournament(tourney.bracket, curMatch),
    }).catch(() => {});
  } catch { /* no-op */ }
}

// Rotate onto the next game per the Match Rotation Loop / Grand Finals lock, and
// show the bracket-intermission takeover while the room gets ready.
function nextTourneyGame() {
  engine = null;
  el('tv-ledger').hidden = true;
  if (tourney.isComplete()) {
    renderBracket();
    renderChampion(bracket.champion);
    persistTournament();
    return;
  }
  curMatch = tourney.current();
  persistTournament();
  const gf = tourney.isGrandFinals();
  renderBracket(); // shows the bracket screen
  el('tv-match-banner').textContent = gf ? '🏆 GRAND FINALS — BEST OF 3' : 'TOURNAMENT BRACKET — BEST OF 3';
  el('tv-rotation').textContent = `Next up: ${curMatch.a.name} vs ${curMatch.b.name} — first to ${ROUNDS_TO_WIN_GAME} takes the game`;
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = 'Host — tap Next on your phone to start this game.';
  awaitingNextGame = true; // host paces the jump into the next game
}

function startBracketGame() {
  const two = [{ playerId: curMatch.a.id, name: curMatch.a.name }, { playerId: curMatch.b.id, name: curMatch.b.name }];
  // A GAME = first to ROUNDS_TO_WIN_GAME round-wins (TR-52). Party Classic opts
  // into the dead-heat void + 20s hostage cutoff (Hard runs exact-hit as-is).
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  const matchExtra = { snapshot: serializeTournament(tourney.bracket, curMatch), teams: !!isTeams, hard: !!config.pool.hard };
  engine = createKoth({ db, room: lobbyId, players: two, n: ROUNDS_TO_WIN_GAME, roundKindFn: () => nextKind || resolveMode(pool), deadHeatVoid: true, perPlayerStopMs: 30000, targetFn: createClassicTargets(), onMoment: flashCue, matchExtra, initialWins: resumeWins || {}, onTv: { state: renderRound }, onMatch: onPvpGame });
  resumeWins = null;
  beginRound();
}

function onPvpGame(m) {
  const aWins = (m.tally.find((t) => t.playerId === curMatch.a.id) || {}).wins || 0;
  const bWins = (m.tally.find((t) => t.playerId === curMatch.b.id) || {}).wins || 0;
  showLedger(curMatch.a.name, aWins, curMatch.b.name, bWins);
  if (m.tieVoid) { el('tv-game-msg').classList.remove('final'); el('tv-game-msg').textContent = '🟰 TIE GAME — RESETTING with a new target…'; return; }
  if (m.status === 'king') {
    tourney.reportGame(curMatch.id, m.king.playerId); // credit the game + rotate
    engine = null;
    setTimeout(nextTourneyGame, 2600);
  }
}

/* ---- Teams tournament ---- */
function launchTeams() {
  const roster = activePlayers().map((p) => ({ playerId: p.playerId, name: p.name }));
  if (roster.length < 3) return menuMsg('Teams needs at least 3 players.');
  isTeams = true;
  showGame(true);
  draftState = createDraftState(roster, config.numTeams);
  logTransition('tv', 'setup', 'draft-start', `${draftState.teams.length} teams`);
  publishDraft(true);
  renderDraft();
}

const nameOf = (pid) => (players.find((p) => p.playerId === pid) || {}).name || pid;

function publishDraft(resetClock) {
  if (resetClock && draftState.status === 'drafting') { pickDeadline = Date.now() + 20000; startClock(); }
  if (draftState.status !== 'drafting') stopClock();
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), { ...draftState, deadline: draftState.status === 'drafting' ? pickDeadline : null }).catch(() => {});
}
function startClock() {
  stopClock();
  draftClock = setInterval(() => {
    if (!draftState || draftState.status !== 'drafting') { stopClock(); return; }
    if (Date.now() >= pickDeadline) { autoPick(draftState); publishDraft(true); }
    renderDraft();
  }, 500);
}
function stopClock() { if (draftClock) { clearInterval(draftClock); draftClock = null; } }
function finalizeDraft() {
  stopClock();
  const teams = draftTeams(draftState, nameOf);
  draftState = null;
  tourney = createTournament(teams.map((t) => ({ id: t.id, name: `${t.emoji} ${t.name}`, members: t.members })));
  bracket = tourney.bracket;
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), { type: 'tournament', status: 'playing' }).catch(() => {});
  logTransition('tv', 'draft', 'tournament-start', `${teams.length} teams`);
  nextTourneyGame();
}
function renderDraft() {
  if (!draftState) return;
  showScreen('active');
  el('tv-active').hidden = true; el('tv-reveal').hidden = true; el('tv-bracket').hidden = true;
  el('tv-ledger').hidden = true; el('tv-standings').hidden = false;
  el('tv-match-banner').textContent = draftState.status === 'drafting' ? '📋 CAPTAIN DRAFT' : '🏷️ NAME YOUR TEAMS';
  const st = el('tv-standings'); st.innerHTML = '';
  draftState.teams.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'standing alive';
    const turn = draftState.status === 'drafting' && i === draftState.turn ? '▶ ' : '';
    li.textContent = `${turn}${t.emoji} ${t.name} — cap ${nameOf(t.captainId)}: ${t.members.map(nameOf).join(', ')}`;
    st.appendChild(li);
  });
  if (draftState.pool.length) { const li = document.createElement('li'); li.className = 'standing out'; li.textContent = `Available: ${draftState.pool.map(nameOf).join(', ')}`; st.appendChild(li); }
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = draftState.status === 'drafting'
    ? `${nameOf(draftState.teams[draftState.turn].captainId)} is picking… (auto-pick in ${Math.max(0, Math.ceil((pickDeadline - Date.now()) / 1000))}s)`
    : 'Captains: set team name + emoji on your phone, then the host starts the tournament.';
}

function startTeamMatch() {
  const teamA = curMatch.a, teamB = curMatch.b; // entrants carry {id,name,members}
  // A GAME = first to ROUNDS_TO_WIN_GAME round-wins; active member rotates each
  // round (solo team plays every round — the 2v1 fairness rule in teamgame.js).
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  engine = createTeamGame({
    db, room: lobbyId, teamA, teamB, n: ROUNDS_TO_WIN_GAME,
    roundKindFn: () => nextKind || resolveMode(pool), onMoment: flashCue, deadHeatVoid: true,
    perPlayerStopMs: 30000, targetFn: createClassicTargets(),
    initialWinsA: resumeTeam?.a || 0, initialWinsB: resumeTeam?.b || 0, initialRoundNum: resumeTeam?.roundNum || 0,
    onTv: { state: (g, ctx) => renderTeamRound(g, ctx) },
    onGame: (r) => {
      if (r.status === 'tie-void') { el('tv-game-msg').classList.remove('final'); el('tv-game-msg').textContent = '🟰 TIE GAME — RESETTING with a new target…'; return; }
      if (r.status === 'between') persistTeamScore(r); // keep the live score resumable
      if (r.status === 'over') { tourney.reportGame(curMatch.id, r.winner.id); engine = null; setTimeout(nextTourneyGame, 2600); }
    }
  });
  resumeTeam = null;
  beginRound();
}

function renderTeamRound(g, ctx) {
  showLedger(ctx.teamA.name, ctx.winsA, ctx.teamB.name, ctx.winsB);
  if (g.mode === 'hard') { renderHard(g, ctx); return; }
  if (g.mode === 'guess') { renderGuess(g, ctx); return; }
  el('tv-match-banner').textContent = `${ctx.teamA.name}  ${ctx.winsA}–${ctx.winsB}  ${ctx.teamB.name}   ·  first to ${ctx.n}`;
  const aId = ctx.activeA.playerId, bId = ctx.activeB.playerId;
  if (g.status === 'running') {
    showScreen('active');
    el('tv-target-label').hidden = false;
    el('tv-target').innerHTML = `${fmtTarget(g)}<span class="timer-unit">s</span>`;
    el('tv-turn').hidden = true;
    el('tv-round-rows').innerHTML = '';
    // Live spectator clocks — Team tournaments only: the active reps face away
    // from the TV, so the room watches their clocks tick up in real time.
    const clk = el('tv-clocks'); clk.hidden = false;
    clk.innerHTML = [aId, bId].map((id) => {
      const s = g.players[id];
      const team = id === aId ? ctx.teamA.name : ctx.teamB.name;
      const player = id === aId ? ctx.activeA.name : ctx.activeB.name;
      let cls = '', time;
      if (s.state === 'running' && s.startHostTs) { cls = 'running'; time = `<span class="lc-time" data-clock-start="${s.startHostTs}">0.00s</span>`; }
      else if (s.state === 'stopped') { cls = 'stopped'; time = `<span class="lc-time">${fmtS2(s.elapsedMs)}s</span>`; }
      else if (s.state === 'dnf') { cls = 'dnf'; time = '<span class="lc-time">DNF</span>'; }
      else { time = '<span class="lc-time">—</span>'; }
      return `<div class="live-clock ${cls}"><div class="lc-team">${team}</div><div class="lc-name">${player}</div>${time}</div>`;
    }).join('');
    startClockLoop();
    el('tv-game-msg').classList.remove('final');
    el('tv-game-msg').textContent = 'Active players are timing blind — the room can see the clocks!';
  } else if (g.status === 'over') {
    stopClockLoop();
    el('tv-clocks').hidden = true;
    const contenders = [aId, bId].map((id) => ({ ...g.players[id], playerId: id, team: id === aId ? ctx.teamA.name : ctx.teamB.name, targetMs: g.targetMs }));
    renderReveal(contenders, g.winner?.playerId);
    el('tv-game-msg').classList.remove('final');
    el('tv-game-msg').textContent = 'Host taps Next Round to lock the ledger dot in.';
  }
}

/* ---------------- rendering (PvE round + PvP duel) ---------------- */
function renderRound(g) {
  if (g.mode === 'hard') { renderHard(g, null); return; }
  if (g.mode === 'guess') { renderGuess(g, null); return; }
  const ids = Object.keys(g.players);
  const duel = ids.length === 2;
  if (!(duel && g.status === 'running')) {
    if (el('tv-clocks')) el('tv-clocks').hidden = true;
    stopClockLoop();
  }
  if (g.status === 'running' && duel) {
    // Stage 1 simultaneous Classic (ADR-005): the TV shows BOTH running clocks
    // and each result freezes live the moment that player stops. Phones stay
    // blind — the room watches the race on the board.
    showScreen('active');
    el('tv-target-label').hidden = false;
    el('tv-target').innerHTML = `${fmtTarget(g)}<span class="timer-unit">s</span>`;
    el('tv-turn').hidden = true;
    el('tv-round-rows').innerHTML = '';
    const clk = el('tv-clocks'); clk.hidden = false;
    clk.innerHTML = ids.map((id) => {
      const s = g.players[id];
      let cls = '', time;
      if (s.state === 'running' && s.startHostTs) { cls = 'running'; time = `<span class="lc-time" data-clock-start="${s.startHostTs}">0.00s</span>`; }
      else if (s.state === 'stopped') { cls = 'stopped'; time = `<span class="lc-time">${fmtS2(s.elapsedMs)}s</span>`; }
      else if (s.state === 'dnf') { cls = 'dnf'; time = '<span class="lc-time">DNF</span>'; }
      else { time = '<span class="lc-time">—</span>'; }
      return `<div class="live-clock ${cls}"><div class="lc-team"></div><div class="lc-name">${s.name}</div>${time}</div>`;
    }).join('');
    startClockLoop();
    el('tv-game-msg').classList.remove('final');
    el('tv-game-msg').textContent = 'Timing blind on the phones — the room sees the clocks!';
  } else if (g.status === 'running') {
    showScreen('active');
    el('tv-target-label').hidden = false;
    el('tv-target').innerHTML = `${fmtTarget(g)}<span class="timer-unit">s</span>`;
    el('tv-turn').hidden = true;
    fillRows(g);
    el('tv-game-msg').classList.remove('final');
    el('tv-game-msg').textContent = 'Tap to start your timer, tap again to stop — land on the target!';
  } else if (g.status === 'over' && duel) {
    // PvP head-to-head reveal.
    const contenders = ids.map((id) => ({ ...g.players[id], playerId: id, team: '', targetMs: g.targetMs }));
    renderReveal(contenders, g.winner?.playerId);
    el('tv-game-msg').classList.remove('final');
    el('tv-game-msg').textContent = 'Host taps Next Round to continue the game.';
  } else if (g.status === 'over') {
    // PvE ranking (N players): keep the ranked rows.
    showScreen('active');
    el('tv-target-label').hidden = false;
    el('tv-target').innerHTML = `${fmtTarget(g)}<span class="timer-unit">s</span>`;
    el('tv-turn').hidden = true;
    fillRows(g);
    const msg = el('tv-game-msg'); msg.classList.add('final');
    msg.textContent = g.winner ? `🏆 ${g.winner.name} takes the round!` : 'No winner — host taps Next Round.';
  }
}

function renderKoth(m, pvp = false) {
  if (pvp) return; // PvP uses onPvpGame + the bracket
  el('tv-bracket').hidden = true; el('tv-standings').hidden = false;
  el('tv-match-banner').textContent = m.status === 'king' ? '👑 WE HAVE A KING 👑' : `King of the Hill — first to ${m.n} (round ${m.roundNum})${m.hard ? ' 🔥' : ''}`;
  const st = el('tv-standings');
  st.innerHTML = '';
  (m.tally || []).forEach((t) => { const li = document.createElement('li'); li.className = 'standing alive'; li.textContent = `${t.name} — ${t.wins}/${m.n}${'👑'.repeat(t.wins)}`; st.appendChild(li); });
  if (m.status === 'king') { el('tv-game-msg').classList.add('final'); el('tv-game-msg').textContent = `👑 ${m.king.name} is the King of the Hill!`; }
}

function renderElim(m) {
  el('tv-bracket').hidden = true; el('tv-standings').hidden = false;
  el('tv-match-banner').textContent = m.status === 'champion' ? '👑 CHAMPION 👑' : `Last Man Standing — round ${m.roundNum}`;
  const st = el('tv-standings');
  st.innerHTML = '';
  for (const [id, name] of Object.entries(m.alive || {})) { const li = document.createElement('li'); li.className = 'standing alive'; li.textContent = name; st.appendChild(li); }
  for (const e of [...(m.eliminated || [])].reverse()) { const li = document.createElement('li'); li.className = 'standing out'; li.textContent = `${e.name} — out R${e.round}`; st.appendChild(li); }
  if (m.status === 'champion') { el('tv-game-msg').classList.add('final'); el('tv-game-msg').textContent = `👑 ${m.champion.name} is the last one standing!`; }
}

// TR-52 State 6: the tournament bracket tree (columns per round + a champion
// column). Each slot shows the entrant and its GAME-win count in parentheses.
function renderBracket() {
  showScreen('bracket');
  const host = el('tv-bracket'); host.innerHTML = '';
  bracket.rounds.forEach((round, ri) => {
    const col = document.createElement('div'); col.className = 'bkt-col';
    const h = document.createElement('div'); h.className = 'bkt-col-head'; h.textContent = roundLabel(bracket, ri);
    col.appendChild(h);
    round.forEach((mm) => {
      const box = document.createElement('div');
      box.className = 'bkt-match' + (mm === curMatch && !mm.winner ? ' current' : '');
      const slot = (ent, games, isWinner) => {
        const s = document.createElement('div'); s.className = 'bkt-slot' + (isWinner ? ' winner' : '');
        const name = ent ? ent.name : (mm.bye ? '(bye)' : 'TBD');
        s.innerHTML = `<span class="who">${name}</span><span class="games">(${games})</span>`;
        return s;
      };
      box.appendChild(slot(mm.a, mm.gamesA, !!(mm.winner && mm.a && mm.winner.id === mm.a.id)));
      box.appendChild(slot(mm.b, mm.gamesB, !!(mm.winner && mm.b && mm.winner.id === mm.b.id)));
      col.appendChild(box);
    });
    host.appendChild(col);
  });
  const champCol = document.createElement('div'); champCol.className = 'bkt-col';
  const ch = document.createElement('div'); ch.className = 'bkt-col-head'; ch.textContent = 'Champion'; champCol.appendChild(ch);
  const cbox = document.createElement('div'); cbox.className = 'bkt-champ';
  cbox.innerHTML = `<div class="lbl">🏆</div><div class="who">${bracket.champion ? bracket.champion.name : 'TBD'}</div>`;
  champCol.appendChild(cbox); host.appendChild(champCol);
}

function renderChampion(c) {
  renderBracket();
  el('tv-match-banner').textContent = '🏆 TOURNAMENT CHAMPION 🏆';
  el('tv-rotation').textContent = '';
  el('tv-game-msg').classList.add('final');
  el('tv-game-msg').textContent = `🏆 ${c.name} wins the bracket!`;
}

/* ---------------- boot ---------------- */
async function boot() {
  el('tv-reconnect').addEventListener('click', () => location.reload());
  el('tv-sound')?.addEventListener('click', enableSound);
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
    if (!inGame) el('status').textContent = list.length ? `${list.length} in the lobby${hostId ? '' : ' — waiting for a signed-in host'}` : 'Waiting for players…';
    // Keep the published config fresh so the host phone always has truth to
    // render its touch setup UI from (stateless-phone principle).
    if (!inGame && hostId) publishConfig();
    render();
  });
  consumeEvents(db, lobbyId, (ev) => {
    if (draftState) {
      if (ev.type === 'draft-pick' && ev.pick) { if (applyPick(draftState, ev.playerId, ev.pick).ok) { publishDraft(true); renderDraft(); } return; }
      if (ev.type === 'team-name' && typeof ev.name === 'string') { const t = draftState.teams.find((x) => x.captainId === ev.playerId); if (t && ev.name.trim()) { t.name = ev.name.trim().slice(0, 16); publishDraft(false); renderDraft(); } return; }
      if (ev.type === 'team-emoji' && ev.emoji) { const t = draftState.teams.find((x) => x.captainId === ev.playerId); if (t) { t.emoji = ev.emoji; publishDraft(false); renderDraft(); } return; }
      if (ev.type === 'draft-done' && ev.playerId === hostId && draftState.status === 'naming') { finalizeDraft(); return; }
    }
    if (ev.type === 'cfg' && !inGame && ev.playerId === hostId && ev.config) { applyCfg(ev.config); return; }
    if (ev.type === 'startgame' && !inGame && ev.playerId === hostId) { startGame(); return; }
    if (ev.type === 'ready') { onReady(ev); return; }
    if ((ev.type === 'press' || ev.type === 'guess') && engine) { engine.handleEvent(ev); return; }
    if (ev.type === 'next' && !engine && awaitingNextGame && ev.playerId === hostId) { awaitingNextGame = false; if (isTeams) startTeamMatch(); else startBracketGame(); return; }
    if (ev.type === 'next' && presenting && ev.playerId === hostId) { firePresented('host force-start'); return; }
    if (ev.type === 'next' && engine && ev.playerId === hostId && engine.isBetween()) { beginRound(); return; }
  });
  // Resume a tournament in progress if the TV reloaded mid-game (reconnect).
  // The snapshot rides in the match node from ANY point: persistTournament writes
  // it between games; koth carries it (matchExtra) during a PvP game; teamgame
  // leaves the between-games snapshot intact. The current game restarts 0-0.
  try {
    const m = (await dbGet(dbRef(db, `sessions/${lobbyId}/match`))).val();
    if (m && m.snapshot && m.snapshot.entrants && m.status !== 'complete') {
      isTeams = !!m.teams; config.pool.hard = !!m.hard;
      tourney = restoreTournament(m.snapshot);
      bracket = tourney.bracket;
      // Seed the in-progress game's score so it resumes at the real score.
      if (Array.isArray(m.tally)) { resumeWins = {}; m.tally.forEach((t) => { resumeWins[t.playerId] = t.wins; }); }
      if (m.winsA != null) resumeTeam = { a: m.winsA, b: m.winsB, roundNum: m.roundNum || 0 };
      showGame(true);
      logTransition('tv', 'boot', 'resumed', 'tournament + game score restored');
      nextTourneyGame();
    }
  } catch { /* malformed/absent snapshot -> normal lobby */ }
  logTransition('tv', 'boot', 'lobby', `room ${lobbyId}`);
}
boot();

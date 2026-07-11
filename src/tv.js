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
import { createDraftState, applyPick, autoPick, draftTeams, applyLogo, autoFillCustomization } from './draft.js';
import { blankNight, recordRound, roundEntries, tonightLine, computeAwards } from './stats.js';
import { ref as dbRef, set as dbSet, get as dbGet } from 'firebase/database';
import { fmtOff, fmtS2, fmtS, fmtSigned } from './format.js';

const el = (id) => document.getElementById(id);
const fmt = (ms) => (ms / 1000).toFixed(1);
// Stage 1 precision: Classic/Hard targets ARE tenths, so they render to 1
// decimal. (Guess targets are hundredths but never displayed as targets.)
const fmtTarget = (g) => fmt(g.targetMs);
// Hero LED readout — lit digits only (ghost segments dropped Jul 2026: they
// blurred the numbers; design-system typography law).
const ledHtml = (txt) => `${txt}<span class="timer-unit">s</span>`;
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
  const catLabel = { pve: `PvE Arcade — ${config.pveMode === 'koth' ? 'King of the Hill (winner stays on, first to 7)' : 'Last Man Standing'}`, pvp: 'PvP Tournament', teams: `Teams Tournament — ${config.numTeams} TEAMS` };
  // Config mirror (spec A2): every choice the host makes lands here, bolded,
  // the moment it lands — the phone taps must visibly change the TV.
  const items = [
    `Game pool: <b>${pool.length ? pool.join(' + ').toUpperCase() : '(none picked)'}</b>`,
    `Category: <b>${config.category ? catLabel[config.category] : '(pick on the host phone)'}</b>`,
    'Host — set up the night on your phone.'
  ];
  const list = el('tv-menu-list');
  list.innerHTML = '';
  items.forEach((t) => { const li = document.createElement('li'); li.innerHTML = t; list.appendChild(li); });
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
  el('tv-wheel').hidden = s !== 'wheel';
  el('tv-draft').hidden = s !== 'draft';
  el('tv-bracket').hidden = s !== 'bracket';
  if (s !== 'bracket') el('tv-rotation').textContent = '';
  if (s !== 'active') el('tv-standings').hidden = true;
  if (s === 'bracket' || s === 'wheel' || s === 'draft') { el('tv-ledger').hidden = true; el('tv-turn').hidden = true; }
}

// TR-60 context beat: a full-screen title card + sting BEFORE every spectacle
// (the room must always know what's about to happen). Resolves after `ms`.
function titleCard({ kicker = '', title, hint = '', tone = 'green', ms = 2600 }) {
  return new Promise((resolve) => {
    const t = el('tv-title');
    t.className = `tv-title tone-${tone}`;
    el('tt-kicker').textContent = kicker;
    el('tt-title').textContent = title;
    el('tt-hint').textContent = hint;
    t.hidden = false;
    sting();
    setTimeout(() => t.classList.add('leaving'), Math.max(400, ms - 400));
    setTimeout(() => { t.hidden = true; t.classList.remove('leaving'); resolve(); }, ms);
  });
}

// Team identity: draft team ids are t1..t8 — each gets a design-system color.
const teamColor = (id) => {
  const m = /^t([1-8])$/.exec(id || '');
  return m ? `var(--team-${m[1]})` : '';
};

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
    el('hard-sub').textContent = ids.map((id) => `${g.players[id]?.name || ''} ${((g.attempts[id] || []).length)}/13`).join('  ·  ');
    el('hard-target').innerHTML = ledHtml(target1);
    el('hard-zone').textContent = `HIT THE ZONE ${fmtS2(zoneLo)}s – ${fmtS2(zoneHi)}s`;
    const hist = el('hard-history'); hist.innerHTML = '';
    ids.forEach((id) => {
      const name = g.players[id]?.name || '';
      (g.attempts[id] || []).slice(-3).forEach((a) => {
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
      hc.style.fontSize = 'clamp(1.4rem, 2.6vw, 2.6rem)';
      hc.style.whiteSpace = 'nowrap';
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

function showLedger(aName, aWon, bName, bWon, aColor = '', bColor = '') {
  const l = el('tv-ledger');
  l.hidden = false;
  l.innerHTML =
    `<div class="team"><span class="name"${aColor ? ` style="color:${aColor}"` : ''}>${aName}</span><span class="dot-strip">${dots(aWon, '🔵', '⚪')}</span></div>` +
    `<div class="team"><span class="name"${bColor ? ` style="color:${bColor}"` : ''}>${bName}</span><span class="dot-strip">${dots(bWon, '🔴', '⚪')}</span></div>`;
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
// Title-card / slot-in sting: a bright two-note hit.
function sting() { beep(520, 90, 0.18); setTimeout(() => beep(780, 160, 0.18), 95); }
// Win arpeggio — a wheel landing / celebration beat.
function winArp() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 140, 0.2), i * 110)); }

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
  // Spec B4: LONG sustained start beep (~0.5s), shorter LOWER stop beep.
  beep(kind === 'start' ? 780 : 330, kind === 'start' ? 500 : 240);
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
        actual.innerHTML = `<span class="tv-words">Actual time</span>${ledHtml(fmtS2(g.actualMs))}`;
        drawCards(true);
        el('guess-winner').textContent = g.winner ? `🏆 ${labelFor(g.winner.playerId, ids.indexOf(g.winner.playerId))} wins the round! (+1)` : 'No winner';
        drumroll(); // cinematic reveal (ends on a chime)
      }, 3000);
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
// Tonight-stats ledger (TR-56): accumulates across games AND rematches in this
// lobby; persisted at sessions/room/stats and restored on TV reload.
let night = blankNight();
let lastStatsKey = null;

function noteRoundOver(g) {
  if (!g || g.status !== 'over') return;
  const key = `${g.mode}|${g.targetMs ?? g.actualMs}|${Object.values(g.players || {})
    .map((p) => `${p.playerId}:${p.elapsedMs ?? p.guessMs ?? p.state}`).join(',')}`;
  if (key === lastStatsKey) return; // over-states re-render; record once
  const mapped = roundEntries(g);
  if (!mapped) return; // dead-heat void — the round reruns, nothing counts
  lastStatsKey = key;
  recordRound(night, mapped);
  dbSet(dbRef(db, `sessions/${lobbyId}/stats`), night).catch(() => {});
}
let nextKind = null;   // mode resolved AT presentation time so the TV can announce it

const KIND_LABEL = {
  classic: ['CLASSIC', 'Land closest to the target — one start, one stop'],
  hard: ['HARD CLASSIC', 'RACE: first to land INSIDE the zone wins'],
  guess: ['GUESS THE CLOCK', 'No clocks. Feel the time, closest guess wins'],
};

/* ---- First-play tutorials: the first time a game mode comes up in THIS
   lobby, an in-depth how-to-win walkthrough takes the stage before the
   matchup. The HOST paces it — every step advances on Next. Seen modes
   persist per lobby (sessions/room/tutorials), so rematches and TV reloads
   never replay one. ---- */
let tutorialsSeen = {};
let tutorialActive = null; // { kind, step, onDone }

const TUTORIALS = {
  classic: ['CLASSIC', [
    ['THE TARGET', 'The board shows ONE amber target time — say 12.3 seconds. Your phone shows the same target, so you never need to turn around.'],
    ['TIME IT BLIND', 'Tap once to START your clock. Count the seconds in your head — your phone shows NO running clock. Tap again to STOP right on the target.'],
    ['HOW YOU WIN', 'Closest to the target takes the round. Sit on your clock past 30 seconds and it\'s a DNF — the round goes to your opponent.'],
  ]],
  hard: ['HARD CLASSIC', [
    ['THE ZONE', 'One target, one tiny window. You must land INSIDE the tenth: on target 5.4, anything from 5.40 to 5.49 counts — 5.50 misses.'],
    ['THE RACE', 'Both players attempt at the SAME time, up to 13 tries each. The FIRST clean hit inside the zone wins the round instantly.'],
    ['WASHOUTS', 'Burn all 13 attempts and you wash out. Both wash out? Closest single attempt takes it. Idle for 30 seconds and the round goes to your opponent.'],
  ]],
  guess: ['GUESS THE CLOCK', [
    ['EYES UP, CLOCKS OFF', 'A GREEN flash and a long beep mean a hidden timer just started. The screen goes dark and NOTHING moves — no clock anywhere.'],
    ['FEEL THE TIME', 'Count in your head. A RED flash and a lower beep mean the timer stopped. Nobody knows how long it ran — that IS the game.'],
    ['LOCK IT IN', 'Type how long you think it ran on your phone keypad, down to hundredths — 8.87 beats "about 9". Closest guess takes the round.'],
  ]],
};

function runTutorial(kind, onDone) {
  const t = TUTORIALS[kind];
  if (!t || tutorialsSeen[kind]) { onDone(); return; }
  tutorialsSeen[kind] = true;
  dbSet(dbRef(db, `sessions/${lobbyId}/tutorials`), tutorialsSeen).catch(() => {});
  tutorialActive = { kind, step: 0, onDone };
  // Phones: narrator state; the host phone gets the Next button.
  dbSet(dbRef(db, `sessions/${lobbyId}/game`), { mode: 'tutorial', status: 'tutorial', kind, updatedAt: Date.now() }).catch(() => {});
  sting();
  renderTutorial();
}

function renderTutorial() {
  if (!tutorialActive) return;
  const [title, steps] = TUTORIALS[tutorialActive.kind];
  const [head, body] = steps[tutorialActive.step];
  showScreen('reveal');
  el('tv-ledger').hidden = true;
  el('tv-match-banner').innerHTML = `<span class="tv-words">📖 ${title} — HOW TO WIN</span>`;
  el('reveal-head').innerHTML = `<span class="tv-words">${head}</span>`;
  el('reveal-sub').textContent = '';
  const wrap = el('reveal-cards'); wrap.innerHTML = '';
  const c = document.createElement('div');
  c.className = 'reveal-card tutorial-card';
  c.innerHTML = `<div class="tut-body">${body}</div>`;
  wrap.appendChild(c);
  el('reveal-winner').textContent = `${tutorialActive.step + 1} of ${steps.length}`;
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = 'Host — tap Next ▶';
}

function advanceTutorial() {
  if (!tutorialActive) return;
  tutorialActive.step += 1;
  const steps = TUTORIALS[tutorialActive.kind][1];
  if (tutorialActive.step >= steps.length) {
    const done = tutorialActive.onDone;
    tutorialActive = null;
    done();
    return;
  }
  sting();
  renderTutorial();
}

function beginRound() {
  if (!engine) return;
  const reps = engine.peekReps ? engine.peekReps() : null;
  if (!reps) { engine.nextRound(); return; } // PvE all-play: no matchup beat
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  nextKind = resolveMode(pool);
  runTutorial(nextKind, () => presentMatchup(reps));
}

function presentMatchup(reps) {
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

// Profile lookup for matchup cards (signed-in players get their equipped
// banner + display name; everyone else keeps the default frame). Async with a
// cache — the card re-renders when a profile arrives.
const profileCache = new Map(); // uid -> profile | 'pending'
function profileFor(playerId) {
  const p = players.find((x) => x.playerId === playerId);
  if (!p || !p.uid) return null;
  const hit = profileCache.get(p.uid);
  if (hit && hit !== 'pending') return hit;
  if (!hit) {
    profileCache.set(p.uid, 'pending');
    dbGet(dbRef(db, `users/${p.uid}`)).then((s) => {
      profileCache.set(p.uid, s.val() || {});
      if (presenting) renderPresent();
    }).catch(() => profileCache.set(p.uid, {}));
  }
  return null;
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
    const record = tonightLine(night, r.playerId) || 'first round tonight';
    const prof = profileFor(r.playerId);
    const dispName = (prof && prof.displayName) || r.name;
    const card = document.createElement('div');
    card.className = 'reveal-card'
      + (ready.has(r.playerId) ? ' win' : '')
      + (prof && prof.banner ? ' banner-' + prof.banner : '');
    card.innerHTML = `<div class="rc-team tv-words">${ready.has(r.playerId) ? 'READY' : 'STAND UP'}</div><div class="rc-ava">${(dispName[0] || '?').toUpperCase()}</div><div class="rc-name">${dispName}</div><div class="rc-dev">${record}</div><div class="rc-dev tv-words">${ready.has(r.playerId) ? '✓' : 'face away from the TV'}</div>`;
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
  if (config.pveMode === 'koth') return launchHill();
  const roster = activePlayers();
  showGame(true);
  el('tv-match-banner').textContent = 'Last Man Standing';
  engine = createElim({ db, room: lobbyId, players: roster, onTv: { state: renderRound }, onMatch: renderElim });
  logTransition('tv', 'setup', 'pve-launch', `lms players=${roster.length}`);
  // LMS rounds are classic mechanics.
  runTutorial('classic', () => beginRound());
}

/* ---- King of the Hill (kepu spec Jul 11): two random players open the
   night, everyone else forms THE LINE. Winner stays on, loser rejoins the
   back of the line; first to 7 TOTAL round wins (not consecutive) is crowned
   King. Every duel runs on the full duel machinery — matchup presentation,
   dual ready-up, live clocks, reveals, first-play tutorials — as a
   first-to-1 koth game with this orchestrator on top. ---- */
const HILL_WINS = 7;
let hill = null; // { active:[a,b], queue:[...], wins:{pid:n}, target }

function launchHill() {
  const roster = [...activePlayers()].sort(() => Math.random() - 0.5)
    .map((p) => ({ playerId: p.playerId, name: p.name }));
  if (roster.length < 2) return setupMsg('King of the Hill needs at least 2 players.');
  isTeams = false; tourney = null; bracket = null;
  hill = { active: [roster[0], roster[1]], queue: roster.slice(2), wins: {}, target: HILL_WINS };
  showGame(true);
  logTransition('tv', 'setup', 'hill-launch', `${roster.length} players`);
  (async () => {
    await titleCard({ kicker: 'Tonight', title: 'KING OF THE HILL', hint: `Winner stays on — first to ${HILL_WINS} wins takes the crown`, tone: 'target' });
    startHillDuel();
  })();
}

function publishHill(status) {
  if (!hill) return;
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), {
    type: 'hill', status,
    active: hill.active, queue: hill.queue, wins: hill.wins, target: hill.target,
  }).catch(() => {});
}

function startHillDuel() {
  publishHill('playing');
  const pool = Object.entries(config.pool).filter(([, v]) => v).map(([k]) => k);
  engine = createKoth({
    db, room: lobbyId, players: hill.active, n: 1,
    roundKindFn: () => nextKind || resolveMode(pool), deadHeatVoid: true,
    perPlayerStopMs: 30000, targetFn: createClassicTargets(), onMoment: flashCue,
    onTv: { state: renderRound }, onMatch: onHillDuel,
  });
  beginRound();
}

function onHillDuel(m) {
  if (m.tieVoid) { el('tv-game-msg').classList.remove('final'); el('tv-game-msg').textContent = '🟰 DEAD HEAT — new target…'; return; }
  if (m.status !== 'king' || !hill) return;
  const winner = hill.active.find((p) => p.playerId === m.king.playerId);
  const loser = hill.active.find((p) => p.playerId !== m.king.playerId);
  hill.wins[winner.playerId] = (hill.wins[winner.playerId] || 0) + 1;
  engine = null;
  if (hill.wins[winner.playerId] >= hill.target) {
    publishHill('king');
    setTimeout(() => crownKing(winner), 2600); // let the round reveal breathe
    return;
  }
  hill.queue.push(loser);
  hill.active = [winner, hill.queue.shift()];
  publishHill('between');
  setTimeout(() => {
    if (!hill) return;
    renderHillIntermission(winner);
    awaitingNextGame = true; // host paces the next duel
  }, 2600);
}

// The line, between duels: holder on top with a win meter, challenger called
// up, everyone else numbered in queue order.
function renderHillIntermission(winner) {
  stopClockLoop();
  ['tv-active', 'tv-reveal', 'tv-hard', 'tv-guess', 'tv-wheel', 'tv-draft', 'tv-bracket'].forEach((id) => { el(id).hidden = true; });
  el('tv-ledger').hidden = true; el('tv-turn').hidden = true;
  el('tv-standings').hidden = false;
  el('tv-match-banner').innerHTML = `<span class="tv-words">👑 KING OF THE HILL — FIRST TO ${hill.target}</span>`;
  const meter = (pid) => '●'.repeat(hill.wins[pid] || 0) + '○'.repeat(Math.max(0, hill.target - (hill.wins[pid] || 0)));
  const st = el('tv-standings'); st.innerHTML = '';
  const row = (txt, cls) => { const li = document.createElement('li'); li.className = `standing ${cls}`; li.textContent = txt; st.appendChild(li); };
  row(`👑 ${hill.active[0].name} — holds the hill  ${meter(hill.active[0].playerId)}`, 'alive');
  row(`🥊 ${hill.active[1].name} — steps up  ${meter(hill.active[1].playerId)}`, 'alive');
  hill.queue.forEach((p, i) => row(`#${i + 1} in line — ${p.name}  ${meter(p.playerId)}`, 'queued'));
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = `${winner.name} stays on! Host — tap Next to start the duel.`;
}

// First to 7: the crown is a produced moment, then the rematch menu.
async function crownKing(w) {
  stopClockLoop();
  await titleCard({ kicker: 'The hill is taken', title: 'WE HAVE A KING', hint: `${hill.target} wins — the line never got there`, tone: 'gold' });
  showScreen('reveal');
  el('tv-ledger').hidden = true;
  el('tv-match-banner').innerHTML = '<span class="tv-words">👑 KING OF THE HILL 👑</span>';
  el('reveal-head').innerHTML = '<span style="font-size:2.2em;line-height:1">👑</span>';
  el('reveal-sub').innerHTML = `<span class="tv-words" style="font-size:1.6em;color:var(--win)">${w.name}</span>`;
  const wrap = el('reveal-cards'); wrap.innerHTML = '';
  const c = document.createElement('div');
  c.className = 'reveal-card win';
  c.innerHTML = `<div class="rc-ava">${(w.name[0] || '?').toUpperCase()}</div><div class="rc-name">${w.name}</div><div class="rc-dev">${tonightLine(night, w.playerId) || ''}</div>`;
  wrap.appendChild(c);
  el('reveal-winner').textContent = `${hill.target} round wins — the hill belongs to ${w.name}`;
  el('tv-game-msg').classList.add('final');
  el('tv-game-msg').textContent = 'Host — tap Next for the rematch menu.';
  confettiBurst();
  drumroll();
  awaitingEndNight = 'champion';
  dbSet(dbRef(db, `sessions/${lobbyId}/game`), { mode: 'awards', status: 'champion', updatedAt: Date.now() }).catch(() => {});
}

/* ---- PvP single-elim tournament: every player for themselves. Inherits the
   Teams presentation wholesale (title card, bracket reveal, matchup beats,
   awards, champion, rematch) — no captains/logos, just usernames. ---- */
async function launchPvp() {
  const roster = activePlayers();
  if (roster.length > 16) return setupMsg('PvP bracket caps at 16 players — run Teams for a bigger room.');
  // Random seeding: join order is not a skill ranking.
  const ents = [...roster].sort(() => Math.random() - 0.5).map((p) => ({ id: p.playerId, name: p.name }));
  isTeams = false;
  tourney = createTournament(ents); // MATCH = Best of 3 games
  bracket = tourney.bracket;
  showGame(true);
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), { type: 'tournament', status: 'playing' }).catch(() => {});
  logTransition('tv', 'setup', 'pvp-launch', `${ents.length} players`);
  await titleCard({ kicker: 'Tonight', title: 'PVP TOURNAMENT', hint: `${ents.length} players — one champion`, tone: 'target' });
  revealBracket(() => nextTourneyGame());
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
    persistTournament();
    runAwardsCeremony(() => renderChampion(bracket.champion));
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
  // Rematch (D3): same teams, fresh bracket spin — but ONLY if the roster is
  // unchanged since the draft; a changed room auto-converts to a new draft.
  if (pendingRematch) {
    const nowIds = roster.map((p) => p.playerId).sort().join(',');
    const rematch = pendingRematch; pendingRematch = null;
    if (nowIds === rematch.rosterIds) {
      const shuffled = [...rematch.teams].sort(() => Math.random() - 0.5);
      tourney = createTournament(shuffled.map((t) => ({ id: t.id, name: `${t.emoji} ${t.name}`, members: t.members })));
      bracket = tourney.bracket;
      dbSet(dbRef(db, `sessions/${lobbyId}/match`), { type: 'tournament', status: 'playing' }).catch(() => {});
      logTransition('tv', 'rematch', 'tournament-start', 'same teams, fresh seeds');
      revealBracket(() => nextTourneyGame());
      return;
    }
    logTransition('tv', 'rematch', 'roster-changed', 'auto-converting to new draft');
  }
  runCaptainWheels(roster);
}

/* ---- Stage 3a (TR-57, rebuilt for TR-60): the wheels. A ring of avatar
   nodes; the selector sweeps at least two full loops and DECELERATES onto the
   winner (ease-out ticks, 60→430ms), which then HOLDS with a celebration slam
   before anything advances. Winners are pre-drawn; the wheel is theatre, the
   fairness is real. ---- */
function spinWheelRing({ slotLabel, entries, winnerIdx, takenIdxs = new Set() }, onDone) {
  showScreen('wheel');
  el('tv-match-banner').innerHTML = `<span class="tv-words">${slotLabel}</span>`;
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = '';
  const stage = el('wheel-stage');
  // No hard cuts between consecutive spins: each ring build fades in.
  stage.style.animation = 'none'; void stage.offsetWidth; stage.style.animation = 'stateIn .45s ease-out both';
  const n = entries.length;
  const R = 42; // % radius from center
  stage.innerHTML = '<div class="wh-track"></div>' + entries.map((name, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = 50 + Math.cos(a) * R, y = 50 + Math.sin(a) * R;
    return `<div class="wh-node${takenIdxs.has(i) ? ' taken' : ''}" style="left:${x}%;top:${y}%">${(name[0] || '?').toUpperCase()}</div>`;
  }).join('') + `<div class="wh-center"><div><div class="wh-slot">${slotLabel}</div><div class="wh-name" id="wh-name">…</div></div></div>`;
  const nodes = [...stage.querySelectorAll('.wh-node')];
  const start = Math.floor(Math.random() * n);
  const ticks = 2 * n + ((winnerIdx - start) % n + n) % n; // ≥2 loops, ends ON the winner
  let j = 0;
  const step = () => {
    nodes.forEach((node, i) => node.classList.toggle('sel', i === (start + j) % n));
    beep(520, 26, 0.12);
    if (j >= ticks) {
      const winEl = nodes[winnerIdx];
      winEl.classList.remove('sel'); winEl.classList.add('win');
      const nm = el('wh-name');
      nm.textContent = entries[winnerIdx];
      nm.classList.add('landed');
      nm.style.color = 'var(--win)';
      nm.style.textShadow = 'var(--led-glow-win)';
      winArp();
      setTimeout(onDone, 2800); // the landing HOLDS before anything advances
      return;
    }
    const t = j / ticks;
    j += 1;
    setTimeout(step, 60 + 370 * t * t); // ease-out deceleration
  };
  step();
}

async function runCaptainWheels(roster) {
  const t = Math.max(2, Math.min(config.numTeams, roster.length));
  const capIds = [...roster].sort(() => Math.random() - 0.5).slice(0, t).map((p) => p.playerId);
  const order = [...capIds].sort(() => Math.random() - 0.5);
  // Phones: look-at-screen narrator state while the wheels run.
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), { type: 'wheel', status: 'spinning' }).catch(() => {});
  const rosterNames = roster.map((r) => r.name);
  const capNames = order.map((id) => nameOf(id));
  await titleCard({ kicker: 'Setup', title: 'CAPTAIN SELECTION', hint: `The wheel picks ${t} captains`, tone: 'target' });
  const taken = new Set();
  let slot = 0;
  const nextCap = () => {
    if (slot < capIds.length) {
      const idx = roster.findIndex((r) => r.playerId === capIds[slot]);
      slot += 1;
      spinWheelRing({
        slotLabel: `CAPTAIN ${slot} OF ${capIds.length}`,
        entries: rosterNames, winnerIdx: idx, takenIdxs: new Set(taken),
      }, () => { taken.add(idx); nextCap(); });
      return;
    }
    // Second wheel: draft order among the captains.
    (async () => {
      await titleCard({ kicker: 'Setup', title: 'DRAFT ORDER', hint: 'Who picks first?', tone: 'green' });
      spinWheelRing({ slotLabel: 'FIRST PICK', entries: capNames, winnerIdx: 0 }, async () => {
        draftState = createDraftState(roster, t, Math.random, order);
        logTransition('tv', 'wheels', 'draft-start', `${draftState.teams.length} teams, order ${capNames.join(' > ')}`);
        await titleCard({ kicker: 'Setup', title: 'THE DRAFT', hint: 'Captains, build your squad — 20 seconds a pick', tone: 'green' });
        publishDraft(true);
        renderDraft();
      });
    })();
  };
  nextCap();
}

const nameOf = (pid) => (players.find((p) => p.playerId === pid) || {}).name || pid;

let nameDeadline = null, nameTimer = null, nameTicker = null; // 2-minute customization cap (A6)

function publishDraft(resetClock, announce = null) {
  if (resetClock && draftState.status === 'drafting') { pickDeadline = Date.now() + 20000; startClock(); }
  if (draftState.status !== 'drafting') stopClock();
  // Entering the naming phase arms the 2-minute cap: on expiry, auto-fill
  // "Team {Captain}" + a random unused logo and start the tournament.
  if (draftState.status === 'naming' && !nameDeadline) {
    nameDeadline = Date.now() + 120000;
    nameTicker = setInterval(() => { if (draftState && !draftAnnounce) renderDraft(); }, 1000);
    nameTimer = setTimeout(() => {
      if (!draftState || draftState.status !== 'naming') return;
      autoFillCustomization(draftState, nameOf);
      logTransition('tv', 'naming', 'auto-filled', '2-minute cap');
      finalizeDraft();
    }, 120000);
  }
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), {
    ...draftState,
    announce, // spec A5: every pick announced on every phone
    deadline: draftState.status === 'drafting' ? pickDeadline : (nameDeadline || null),
  }).catch(() => {});
}
function startClock() {
  stopClock();
  draftClock = setInterval(() => {
    if (!draftState || draftState.status !== 'drafting') { stopClock(); return; }
    if (Date.now() >= pickDeadline) {
      const team = draftState.teams[draftState.turn];
      const r = autoPick(draftState);
      if (r.ok) { announcePick(team, r.playerId); return; }
    }
    renderDraft();
  }, 500);
}
function stopClock() { if (draftClock) { clearInterval(draftClock); draftClock = null; } }

// TR-60: every pick is a produced moment — a full-screen announce slam that
// HOLDS ~3.2s (clock paused) before the next pick clock starts. The announce
// also rides on the match node so every phone narrates it (spec A5).
let draftAnnounce = null, draftAnnounceTimer = null;
function announcePick(team, playerId) {
  stopClock();
  clearTimeout(draftAnnounceTimer);
  draftAnnounce = {
    capName: nameOf(team.captainId), playerName: nameOf(playerId), playerId,
    teamId: team.id, color: teamColor(team.id) || 'var(--primary)',
  };
  sting();
  publishDraft(false, { cap: draftAnnounce.capName, player: draftAnnounce.playerName });
  renderDraft();
  draftAnnounceTimer = setTimeout(() => {
    draftAnnounce = null;
    if (!draftState) return;
    publishDraft(draftState.status === 'drafting');
    renderDraft();
  }, 3200);
}
async function finalizeDraft() {
  stopClock();
  clearTimeout(nameTimer); clearInterval(nameTicker); nameDeadline = null;
  clearTimeout(draftAnnounceTimer); draftAnnounce = null;
  const teams = draftTeams(draftState, nameOf);
  lastTeams = teams; // Rematch (D3) reuses these
  draftState = null;
  tourney = createTournament(teams.map((t) => ({ id: t.id, name: `${t.emoji} ${t.name}`, members: t.members })));
  bracket = tourney.bracket;
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), { type: 'tournament', status: 'playing' }).catch(() => {});
  logTransition('tv', 'draft', 'tournament-start', `${teams.length} teams`);
  await titleCard({ kicker: 'Setup', title: 'DRAFT COMPLETE', hint: 'The bracket awaits…', tone: 'gold', ms: 3000 });
  revealBracket(() => nextTourneyGame());
}

// Stage 3a bracket reveal (A7, repaced for TR-60): a title card frames the
// moment, the empty skeleton appears and HOLDS, then each team slots into its
// seed one by one with a sting — every matchup its own moment.
async function revealBracket(done) {
  // ≤8 entrants (Teams): each team slots in individually (A7). Bigger fields
  // (PvP, up to 16): one beat per MATCHUP so the reveal holds ~13s, not 26.
  const beats = bracket.entrants.length > 8
    ? bracket.rounds[0].map((m) => [m.a, m.b].filter(Boolean).map((e) => e.id)).filter((b) => b.length)
    : bracket.entrants.map((e) => [e.id]);
  const shown = new Set();
  await titleCard({ kicker: 'The night takes shape', title: 'THE BRACKET', hint: 'Every matchup, revealed', tone: 'target' });
  el('tv-match-banner').innerHTML = '<span class="tv-words">🏆 THE BRACKET</span>';
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = '';
  renderBracket(shown);
  let i = 0;
  const step = () => {
    if (i >= beats.length) { setTimeout(done, 2400); return; }
    beats[i].forEach((id) => shown.add(id)); i += 1;
    renderBracket(shown, beats[i - 1][0]);
    sting();
    setTimeout(step, 1600);
  };
  setTimeout(step, 1600);
}

// The draft board (rebuilt for TR-60): picker callout + LED pick clock,
// color-accented team cards, pool chips, full-screen announce slam per pick.
function renderDraft() {
  if (!draftState) return;
  showScreen('draft');
  el('tv-match-banner').innerHTML = `<span class="tv-words">${draftState.status === 'drafting' ? '📋 THE DRAFT' : '🏷️ NAME YOUR TEAMS'}</span>`;
  const stage = el('draft-stage');
  const dl = draftState.status === 'drafting' ? pickDeadline : nameDeadline;
  const secs = dl ? Math.max(0, Math.ceil((dl - Date.now()) / 1000)) : 120;
  let head;
  if (draftAnnounce) {
    head = `<div class="df-announce"><span style="color:${draftAnnounce.color}">${draftAnnounce.capName}</span>`
      + '<span style="color:var(--text-dim)">DRAFTS</span>'
      + `<span>${draftAnnounce.playerName}</span></div>`;
  } else if (draftState.status === 'drafting') {
    const capTeam = draftState.teams[draftState.turn];
    const color = teamColor(capTeam.id) || 'var(--primary)';
    head = `<div class="df-header"><span class="df-picker" style="color:${color}">▶ ${nameOf(capTeam.captainId)} PICKS</span>`
      + `<span class="df-clock${secs <= 5 ? ' danger' : ''}">${secs}<span class="timer-unit">s</span></span></div>`;
  } else {
    head = '<div class="df-header"><span class="df-picker">CAPTAINS — NAME YOUR TEAMS</span>'
      + `<span class="df-clock">${secs}<span class="timer-unit">s</span></span></div>`;
  }
  const teams = draftState.teams.map((t, i) => {
    const color = teamColor(t.id) || 'var(--primary)';
    const picking = draftState.status === 'drafting' && i === draftState.turn && !draftAnnounce;
    const members = t.members.map((pid) => {
      const isCap = pid === t.captainId;
      const justPicked = draftAnnounce && draftAnnounce.playerId === pid && draftAnnounce.teamId === t.id;
      return `<div class="df-member${isCap ? ' cap' : ''}${justPicked ? ' new' : ''}"${justPicked ? ` style="color:${color}"` : ''}>${nameOf(pid)}${isCap ? ' · captain' : ''}</div>`;
    }).join('');
    const logoNote = draftState.status === 'naming' && !t.emoji && t.logoPickerId
      ? `<div class="df-member">🎨 ${nameOf(t.logoPickerId)} picks the logo</div>` : '';
    return `<div class="df-team${picking ? ' picking' : ''}" style="border-top-color:${color};--team-c:${color}">`
      + `<div class="df-tname" style="color:${color}">${t.emoji || ''} ${t.name}</div>${members}${logoNote}</div>`;
  }).join('');
  const pool = draftState.pool.length
    ? `<div class="df-pool-label">Still in the pool</div><div class="df-pool">${draftState.pool.map((pid) => `<span class="df-chip">${nameOf(pid)}</span>`).join('')}</div>`
    : '';
  stage.innerHTML = head + `<div class="df-teams">${teams}</div>` + pool;
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = draftState.status === 'drafting'
    ? (draftAnnounce ? '' : 'Captain — tap a player on your phone. Stall and the wheel picks for you.')
    : `Captains type the name · logo pickers tap the icon — auto-locks in ${secs}s (host can start sooner).`;
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
  noteRoundOver(g);
  showLedger(ctx.teamA.name, ctx.winsA, ctx.teamB.name, ctx.winsB, teamColor(ctx.teamA.id), teamColor(ctx.teamB.id));
  if (g.mode === 'hard') { renderHard(g, ctx); return; }
  if (g.mode === 'guess') { renderGuess(g, ctx); return; }
  el('tv-match-banner').textContent = `${ctx.teamA.name}  ${ctx.winsA}–${ctx.winsB}  ${ctx.teamB.name}   ·  first to ${ctx.n}`;
  const aId = ctx.activeA.playerId, bId = ctx.activeB.playerId;
  if (g.status === 'running') {
    showScreen('active');
    el('tv-target-label').hidden = false;
    el('tv-target').innerHTML = ledHtml(fmtTarget(g));
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
    el('tv-game-msg').textContent = ''; // how-to hints live in the first-play tutorial now
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
  noteRoundOver(g);
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
    el('tv-target').innerHTML = ledHtml(fmtTarget(g));
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
    el('tv-game-msg').textContent = ''; // how-to hints live in the first-play tutorial now
  } else if (g.status === 'running') {
    showScreen('active');
    el('tv-target-label').hidden = false;
    el('tv-target').innerHTML = ledHtml(fmtTarget(g));
    el('tv-turn').hidden = true;
    fillRows(g);
    el('tv-game-msg').classList.remove('final');
    el('tv-game-msg').textContent = '';
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
    el('tv-target').innerHTML = ledHtml(fmtTarget(g));
    el('tv-turn').hidden = true;
    fillRows(g);
    const msg = el('tv-game-msg'); msg.classList.add('final');
    msg.textContent = g.winner ? `🏆 ${g.winner.name} takes the round!` : 'No winner — host taps Next Round.';
  }
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
function renderBracket(mask, justRevealedId) {
  // mask (Stage 3a reveal): a Set of entrant ids already revealed — everyone
  // else renders as a mystery slot. Omitted = the normal full bracket.
  // justRevealedId: the entrant landing THIS beat — its match box pops in.
  showScreen('bracket');
  const host = el('tv-bracket'); host.innerHTML = '';
  // Big fields (PvP 9-16 players): compact rows so 8 first-round matches fit.
  host.classList.toggle('bkt-big', bracket.rounds[0].length > 4);
  bracket.rounds.forEach((round, ri) => {
    const col = document.createElement('div'); col.className = 'bkt-col';
    const h = document.createElement('div'); h.className = 'bkt-col-head'; h.textContent = roundLabel(bracket, ri);
    col.appendChild(h);
    round.forEach((mm) => {
      const box = document.createElement('div');
      box.className = 'bkt-match' + (mm === curMatch && !mm.winner && !mask ? ' current' : '');
      if (justRevealedId && ((mm.a && mm.a.id === justRevealedId) || (mm.b && mm.b.id === justRevealedId))) box.classList.add('slot-in');
      const slot = (ent, games, isWinner) => {
        const s = document.createElement('div'); s.className = 'bkt-slot' + (isWinner ? ' winner' : '');
        const revealed = ent && !(mask && !mask.has(ent.id));
        const name = ent ? (revealed ? ent.name : '❓') : (mm.bye ? '(bye)' : 'TBD');
        const color = revealed && !isWinner ? teamColor(ent.id) : '';
        s.innerHTML = `<span class="who"${color ? ` style="color:${color}"` : ''}>${name}</span><span class="games">(${games})</span>`;
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

/* ---- Stage 3b (TR-58): awards ceremony -> champion trophy -> rematch ---- */

// D1: top-4 titles from the tonight ledger, one ~4s auto-advancing card each.
async function runAwardsCeremony(done) {
  const awards = computeAwards(night, 4);
  if (!awards.length) { done(); return; }
  dbSet(dbRef(db, `sessions/${lobbyId}/game`), { mode: 'awards', status: 'awards', updatedAt: Date.now() }).catch(() => {});
  await titleCard({ kicker: 'Ceremony', title: "TONIGHT'S AWARDS", hint: 'Four titles. One night.', tone: 'gold' });
  showScreen('reveal');
  el('tv-ledger').hidden = true;
  el('tv-match-banner').innerHTML = '<span class="tv-words">🏅 TONIGHT\'S AWARDS</span>';
  el('reveal-sub').textContent = '';
  el('reveal-winner').textContent = '';
  let i = 0;
  const card = () => {
    if (i >= awards.length) { setTimeout(done, 800); return; }
    const a = awards[i]; i += 1;
    el('reveal-head').innerHTML = `<span class="tv-words">${a.title}</span>`;
    const wrap = el('reveal-cards'); wrap.innerHTML = '';
    const c = document.createElement('div');
    c.className = 'reveal-card win';
    c.innerHTML = `<div class="rc-ava">${(a.name[0] || '?').toUpperCase()}</div><div class="rc-name">${a.name}</div><div class="rc-dev">${a.statLine}</div>`;
    wrap.appendChild(c);
    el('reveal-winner').textContent = `${i} of ${awards.length}`;
    drumroll();
    setTimeout(card, 4000);
  };
  card();
}

// D2: giant logo, team name, player cards, run record, confetti + sting;
// holds until the host advances into the rematch choice (D3).
function renderChampion(c) {
  showScreen('reveal');
  const matchesWon = bracket.rounds.flat().filter((m) => m.winner && m.winner.id === c.id).length;
  const emoji = (c.name.match(/^\p{Extended_Pictographic}/u) || ['🏆'])[0];
  el('tv-match-banner').innerHTML = '<span class="tv-words">🏆 TOURNAMENT CHAMPION 🏆</span>';
  el('reveal-head').innerHTML = `<span style="font-size:2.2em;line-height:1">${emoji}</span>`;
  el('reveal-sub').innerHTML = `<span class="tv-words" style="font-size:1.6em;color:var(--win)">${c.name.replace(/^\p{Extended_Pictographic}\s*/u, '')}</span>`;
  const wrap = el('reveal-cards'); wrap.innerHTML = '';
  // Teams: one card per member. PvP: the champion IS the card (entrant id = playerId).
  const champCards = c.members || [{ playerId: c.id, name: c.name }];
  champCards.forEach((m) => {
    const pc = document.createElement('div');
    pc.className = 'reveal-card win';
    pc.innerHTML = `<div class="rc-ava">${(m.name[0] || '?').toUpperCase()}</div><div class="rc-name">${m.name}</div><div class="rc-dev">${tonightLine(night, m.playerId) || ''}</div>`;
    wrap.appendChild(pc);
  });
  el('reveal-winner').textContent = `Run: ${matchesWon} match${matchesWon === 1 ? '' : 'es'} won · champions of the night`;
  el('tv-game-msg').classList.add('final');
  el('tv-game-msg').textContent = 'Host — tap Next for the rematch menu.';
  confettiBurst();
  drumroll();
  awaitingEndNight = 'champion';
  dbSet(dbRef(db, `sessions/${lobbyId}/game`), { mode: 'awards', status: 'champion', updatedAt: Date.now() }).catch(() => {});
}

// Emoji confetti over the banners — no libraries, cleans itself up.
function confettiBurst() {
  const bits = ['🎉', '✨', '🎊', '⭐'];
  for (let i = 0; i < 28; i++) {
    const s = document.createElement('span');
    s.textContent = bits[i % bits.length];
    s.style.cssText = `position:fixed;top:-5vh;left:${Math.random() * 100}vw;z-index:70;font-size:${1.2 + Math.random() * 2}rem;pointer-events:none;transition:transform ${2.2 + Math.random() * 2}s ease-in,opacity .5s ease ${3.6}s;`;
    document.body.appendChild(s);
    requestAnimationFrame(() => {
      s.style.transform = `translateY(${108 + Math.random() * 10}vh) rotate(${Math.random() * 720 - 360}deg)`;
      s.style.opacity = '0';
    });
    setTimeout(() => s.remove(), 4600);
  }
}

// D3: the rematch menu lives on the HOST PHONE; the TV narrates. Every path
// routes back through the lobby/QR screen so newcomers can scan in.
let awaitingEndNight = null; // 'champion' -> 'choice'
let pendingRematch = null;   // { teams, rosterIds } — Rematch keeps the teams
let lastTeams = null;        // the drafted teams, kept for Rematch

function showEndNightChoice() {
  awaitingEndNight = 'choice';
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), { type: 'endnight', status: 'choice' }).catch(() => {});
  el('tv-game-msg').classList.remove('final');
  el('tv-game-msg').textContent = 'Host is choosing: Rematch · New Draft · Change Mode · End Night';
}

function backToLobby(msg) {
  engine = null; tourney = null; bracket = null; curMatch = null; hill = null;
  draftState = null; awaitingNextGame = false; awaitingEndNight = null;
  dbSet(dbRef(db, `sessions/${lobbyId}/match`), null).catch(() => {});
  dbSet(dbRef(db, `sessions/${lobbyId}/game`), null).catch(() => {});
  showGame(false);
  publishConfig(msg || '');
  render();
  el('status').hidden = false;
  el('status').textContent = msg || 'Back in the lobby — newcomers can scan in.';
}

function onEndNightChoice(choice) {
  if (choice === 'end') { pendingRematch = null; backToLobby('Night ended — thanks for playing! Start fresh anytime.'); return; }
  if (choice === 'mode') { pendingRematch = null; backToLobby('Change it up — host, adjust the config and start.'); return; }
  if (choice === 'draft') { pendingRematch = null; backToLobby('New draft! Host taps START when everyone is in.'); return; }
  if (choice === 'rematch') {
    pendingRematch = lastTeams
      ? { teams: lastTeams, rosterIds: lastTeams.flatMap((t) => t.members.map((m) => m.playerId)).sort().join(',') }
      : null;
    backToLobby(pendingRematch
      ? 'REMATCH — same teams! Host taps START (roster changes trigger a new draft).'
      : 'REMATCH! Host taps START for a fresh bracket.');
  }
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
      if (ev.type === 'draft-pick' && ev.pick) {
        const team = draftState.status === 'drafting' ? draftState.teams[draftState.turn] : null;
        if (team && applyPick(draftState, ev.playerId, ev.pick).ok) announcePick(team, ev.pick);
        return;
      }
      if (ev.type === 'team-name' && typeof ev.name === 'string') { const t = draftState.teams.find((x) => x.captainId === ev.playerId); if (t && ev.name.trim()) { t.name = ev.name.trim().slice(0, 16); publishDraft(false); renderDraft(); } return; }
      if (ev.type === 'team-emoji' && ev.emoji) { if (applyLogo(draftState, ev.playerId, ev.emoji).ok) { publishDraft(false); renderDraft(); } return; }
      if (ev.type === 'draft-done' && ev.playerId === hostId && draftState.status === 'naming') { finalizeDraft(); return; }
    }
    if (ev.type === 'cfg' && !inGame && ev.playerId === hostId && ev.config) { applyCfg(ev.config); return; }
    if (ev.type === 'startgame' && !inGame && ev.playerId === hostId) { startGame(); return; }
    // First-play tutorial paging — must outrank every other Next handler.
    if (ev.type === 'next' && tutorialActive && ev.playerId === hostId) { advanceTutorial(); return; }
    if (ev.type === 'ready') { onReady(ev); return; }
    if (ev.type === 'next' && awaitingEndNight === 'champion' && ev.playerId === hostId) { showEndNightChoice(); return; }
    if (ev.type === 'endnight-choice' && awaitingEndNight === 'choice' && ev.playerId === hostId && ev.choice) { onEndNightChoice(ev.choice); return; }
    if ((ev.type === 'press' || ev.type === 'guess') && engine) { engine.handleEvent(ev); return; }
    if (ev.type === 'next' && !engine && awaitingNextGame && ev.playerId === hostId) { awaitingNextGame = false; if (hill) startHillDuel(); else if (isTeams) startTeamMatch(); else startBracketGame(); return; }
    if (ev.type === 'next' && presenting && ev.playerId === hostId) { firePresented('host force-start'); return; }
    if (ev.type === 'next' && engine && ev.playerId === hostId && engine.isBetween()) { beginRound(); return; }
  });
  // Resume a tournament in progress if the TV reloaded mid-game (reconnect).
  // The snapshot rides in the match node from ANY point: persistTournament writes
  // it between games; koth carries it (matchExtra) during a PvP game; teamgame
  // leaves the between-games snapshot intact. The current game restarts 0-0.
  // Restore the tonight-stats ledger so records survive a TV reload and keep
  // accumulating across rematches in this lobby (TR-56).
  try {
    const st = (await dbGet(dbRef(db, `sessions/${lobbyId}/stats`))).val();
    if (st && st.players) night = st;
  } catch { /* fresh night */ }
  // Tutorials already shown in this lobby never replay (survives TV reloads).
  try {
    const tut = (await dbGet(dbRef(db, `sessions/${lobbyId}/tutorials`))).val();
    if (tut) tutorialsSeen = tut;
  } catch { /* fresh lobby */ }
  try {
    const m = (await dbGet(dbRef(db, `sessions/${lobbyId}/match`))).val();
    if (m && m.type === 'hill' && m.status !== 'king' && Array.isArray(m.active)) {
      // Resume King of the Hill: the line + win meters survive a TV reload;
      // the interrupted duel restarts fresh (matches the resume pattern).
      hill = { active: m.active, queue: m.queue || [], wins: m.wins || {}, target: m.target || HILL_WINS };
      showGame(true);
      logTransition('tv', 'boot', 'resumed', 'hill restored');
      startHillDuel();
    } else if (m && m.snapshot && m.snapshot.entrants && m.status !== 'complete') {
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

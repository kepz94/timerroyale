// Landing page: single player front and center; Host a Game -> /host.html.
import { createSoloGame, SOLO_ROUNDS } from './solo.js';
import { watchAuth, signInGoogle, signOutUser, getProfile, claimUsername, validUsername } from './auth.js';
import { BANNERS, ACHIEVEMENTS, tierBannerFor } from './cosmetics.js';
import { ref as dbRef2, update as dbUpdate } from 'firebase/database';
import { DAILY_ROUNDS, dateKey, dailyTargets, todayResult, saveResult, msToMidnight, ratingColor } from './daily.js';
import { createGuessSoloGame, GUESS_SOLO_ROUNDS } from './guesssolo.js';
import { validatePool, resolveMode, ENVIRONMENTS } from './hostconfig.js';
import { generateMatchId, seededTargets, createMatchWithId } from './match.js';
import { sfxStart, sfxStop } from './sfx.js';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });

import { initFirebase } from './firebase.js';
const el = (id) => document.getElementById(id);
const db = initFirebase();

let currentUser = null;

async function refreshChip(user) {
  currentUser = user;
  el('auth-btn').hidden = !!user;
  el('auth-name').hidden = !user;
  el('signout-btn').hidden = !user;
  el('username-form').hidden = true;
  if (!user) return;
  const profile = await getProfile(db, user.uid);
  if (profile) {
    el('auth-name').textContent = profile.displayName;
  } else {
    // first sign-in: username required before the profile exists
    el('auth-name').textContent = 'Pick a username…';
    el('username-form').hidden = false;
    el('username-input').focus();
  }
}

watchAuth(refreshChip);

el('auth-name').addEventListener('click', async () => {
  if (!currentUser) return;
  const profile = await getProfile(db, currentUser.uid);
  if (!profile) { el('username-form').hidden = false; el('username-input').focus(); return; }
  renderProfilePanel(profile);
  el('profile-panel').hidden = false;
});

/* ---- Profile tab (TR-38) ---- */
function earnedBanners(profile) {
  const earned = { ...(profile.banners || {}) };
  earned[tierBannerFor(profile.record?.w ?? 0)] = true; // tier banners auto-earn
  earned.rookie = true;
  return earned;
}

function renderProfilePanel(profile) {
  const np = el('nameplate');
  np.className = `nameplate ${BANNERS[profile.banner]?.css ?? 'banner-rookie'}`;
  el('np-name').textContent = profile.displayName;
  const r = profile.record || { w: 0, l: 0, d: 0 };
  el('np-record').textContent = `${r.w}-${r.l}-${r.d}`;

  const earned = earnedBanners(profile);
  const grid = el('banner-grid');
  grid.innerHTML = '';
  for (const [id, def] of Object.entries(BANNERS)) {
    const li = document.createElement('li');
    const isEarned = !!earned[id];
    li.className = `banner-cell ${def.css} ${isEarned ? 'earned' : 'locked'} ${profile.banner === id ? 'active' : ''}`;
    li.innerHTML = `<span class="banner-name">${def.name}</span><small>${isEarned ? (profile.banner === id ? 'Equipped' : 'Tap to equip') : def.source}</small>`;
    if (isEarned && profile.banner !== id) {
      li.addEventListener('click', async () => {
        await dbUpdate(dbRef2(db, `users/${currentUser.uid}`), { banner: id });
        renderProfilePanel({ ...profile, banner: id });
        refreshChip(currentUser);
      });
    }
    grid.appendChild(li);
  }

  const list = el('achievement-list');
  list.innerHTML = '';
  for (const [id, def] of Object.entries(ACHIEVEMENTS)) {
    const li = document.createElement('li');
    const unlocked = !!profile.achievements?.[id];
    li.className = `achievement ${unlocked ? 'unlocked' : 'locked'}`;
    li.innerHTML = `<span class="ach-name">${unlocked ? '🏅' : '🔒'} ${def.name}</span>` +
      `<small>${def.desc}${def.grantsBanner ? ` — unlocks the ${BANNERS[def.grantsBanner].name} banner` : ''}</small>`;
    list.appendChild(li);
  }
}

el('profile-close').addEventListener('click', () => { el('profile-panel').hidden = true; });

el('profile-username-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const check = validUsername(el('profile-username-input').value);
  if (!check.ok) { el('profile-username-error').textContent = check.error; return; }
  el('profile-username-error').textContent = '';
  const result = await claimUsername(db, currentUser, check.name);
  if (!result.ok) { el('profile-username-error').textContent = result.error; return; }
  el('profile-username-input').value = '';
  const profile = await getProfile(db, currentUser.uid);
  renderProfilePanel(profile);
  refreshChip(currentUser);
});

el('username-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const check = validUsername(el('username-input').value);
  if (!check.ok) { el('username-error').textContent = check.error; return; }
  el('username-error').textContent = '';
  const result = await claimUsername(db, currentUser, check.name);
  if (!result.ok) { el('username-error').textContent = result.error; return; }
  el('username-input').value = '';
  refreshChip(currentUser);
});
const fmtS = (ms) => (ms / 1000).toFixed(1);
import { fmtOff, fmtS2 } from './format.js';
let game = null;
let shownTotal = 0;
let mode = 'solo'; // solo | daily
let countdownTimer = null;

function roundsTotal() { return game?.rounds?.() ?? (mode === 'daily' ? DAILY_ROUNDS : SOLO_ROUNDS); }
function roundLabel(n) { return mode === 'daily' ? `Daily Royale — Round ${n} / ${DAILY_ROUNDS}` : `Round ${n} / ${roundsTotal()}`; }

function setYou(ms) {
  const you = el('solo-you');
  if (ms === null) {
    you.classList.add('dim');
    you.innerHTML = `--<span class="timer-unit">s</span>`;
  } else {
    you.classList.remove('dim');
    you.innerHTML = `${fmtS2(ms)}<span class="timer-unit">s</span>`;
  }
}

function renderScore(ms) {
  el('solo-score').innerHTML = `${fmtOff(ms)}<span class="timer-unit">s</span>`;
}

function countUpScore(from, to, durationMs = 600) {
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / durationMs);
    renderScore(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // rAF halts when the page is hidden (phone lock, app switch) — guarantee
  // the final value lands no matter what.
  setTimeout(() => renderScore(to), durationMs + 100);
}

function flyDifference(deviationMs, onArrive) {
  const fromRect = el('solo-you').getBoundingClientRect();
  const toRect = el('solo-score').getBoundingClientRect();
  const chip = document.createElement('span');
  chip.className = 'fly-chip';
  chip.textContent = `+${fmtOff(deviationMs)}s`;
  chip.style.left = `${fromRect.left + fromRect.width / 2}px`;
  chip.style.top = `${fromRect.bottom + 4}px`;
  document.body.appendChild(chip);
  const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
  const dy = (toRect.top + toRect.height / 2) - (fromRect.bottom + 4);
  requestAnimationFrame(() => {
    chip.style.transform = `translate(${dx}px, ${dy}px) scale(0.5)`;
    chip.style.opacity = '0.1';
  });
  setTimeout(() => { chip.remove(); onArrive(); }, 750);
}

function renderRoundStart() {
  renderScore(shownTotal); // re-sync in case an animation was interrupted
  el('solo-round').textContent = roundLabel(game.currentRound());
  el('solo-target').innerHTML = `${fmtS(game.currentTargetMs())}<span class="timer-unit">s</span>`;
  setYou(null);
  el('solo-big-label').textContent = 'TAP TO START';
  el('solo-msg').textContent = 'Count it in your head — no peeking.';
}

function appendResult(attempt, roundNum) {
  const li = document.createElement('li');
  li.className = 'round-row stopped';
  li.innerHTML = `<span class="row-name">R${roundNum}: ${fmtS(attempt.targetMs)}s target</span>` +
    `<span class="row-time">${fmtS2(attempt.elapsedMs)}s <span class="deviation">off by ${fmtOff(attempt.deviationMs)}s</span></span>`;
  el('solo-results').appendChild(li);
}

function startGame(opts) {
  mode = 'solo';
  el('solo-guess-form').hidden = true;
  clearInterval(countdownTimer);
  el('join-code-form').hidden = true;
  el('code-error').textContent = '';
  el('final-score').hidden = true;
  el('daily-countdown').hidden = true;
  el('daily-share').hidden = true;
  game = createSoloGame(opts && opts.targets ? { targets: opts.targets } : undefined);
  shownTotal = 0;
  renderScore(0);
  document.querySelector('.score-wrap').hidden = false;
  document.querySelector('.target-row').hidden = false;
  el('menu').hidden = true;
  el('solo-panel').hidden = false;
  el('solo-results').innerHTML = '';
  el('solo-total').hidden = true;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = true;
  el('solo-big').hidden = false;
  renderRoundStart();
}

function finishGame(totalMs) {
  if (hostCtx) { finishHostChallenge(totalMs); return; }
  el('solo-round').textContent = 'Done!';
  document.querySelector('.target-row').hidden = true;
  document.querySelector('.score-wrap').hidden = true;
  const hero = el('final-score');
  hero.hidden = false;
  hero.innerHTML = `${fmtOff(totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-big').hidden = true;
  el('solo-msg').textContent = '';
  const total = el('solo-total');
  total.hidden = false;
  total.textContent = `Total: ${fmtOff(totalMs)}s off across ${roundsTotal()} rounds — lower is better.`;
  el('solo-again').hidden = mode === 'daily'; // one attempt per day
  el('solo-exit').hidden = false;
  if (mode === 'daily') {
    saveResult({ attempts: game.attempts(), totalMs });
    el('solo-round').textContent = `Daily Royale — ${dateKey()}`;
    el('daily-share').hidden = false;
    startCountdown();
  }
}

/* ---- Daily Royale (TR-23) ---- */
function startCountdown() {
  const tick = () => {
    const ms = msToMidnight();
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    el('daily-countdown').textContent = `Next challenge in ${h}:${m}:${s}`;
    el('daily-countdown').hidden = false;
  };
  tick();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 1000);
}

function showDailyResult(res) {
  mode = 'daily';
  el('join-code-form').hidden = true;
  el('code-error').textContent = '';
  el('menu').hidden = true;
  el('solo-panel').hidden = false;
  document.querySelector('.target-row').hidden = true;
  document.querySelector('.score-wrap').hidden = true;
  el('solo-big').hidden = true;
  el('solo-msg').textContent = "You've played today — come back after midnight!";
  el('solo-round').textContent = `Daily Royale — ${res.dateKey}`;
  const hero = el('final-score');
  hero.hidden = false;
  hero.innerHTML = `${fmtOff(res.totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-results').innerHTML = '';
  res.attempts.forEach((a, idx) => appendResult(a, idx + 1));
  el('solo-total').hidden = false;
  el('solo-total').textContent = `Total: ${fmtOff(res.totalMs)}s off across ${DAILY_ROUNDS} rounds.`;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = false;
  el('daily-share').hidden = false;
  startCountdown();
}

function startDaily() {
  const played = todayResult();
  if (played) { showDailyResult(played); return; }
  mode = 'daily';
  el('solo-guess-form').hidden = true;
  clearInterval(countdownTimer);
  el('join-code-form').hidden = true;
  el('code-error').textContent = '';
  el('final-score').hidden = true;
  el('daily-countdown').hidden = true;
  el('daily-share').hidden = true;
  game = createSoloGame({ targets: dailyTargets() });
  shownTotal = 0;
  renderScore(0);
  document.querySelector('.score-wrap').hidden = false;
  document.querySelector('.target-row').hidden = false;
  el('menu').hidden = true;
  el('solo-panel').hidden = false;
  el('solo-results').innerHTML = '';
  el('solo-total').hidden = true;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = true;
  el('solo-big').hidden = false;
  renderRoundStart();
}

function drawScoreCard(res) {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1080;
  const x = c.getContext('2d');
  x.fillStyle = '#050807'; x.fillRect(0, 0, 1080, 1080);
  x.textAlign = 'center';
  x.shadowColor = 'rgba(34,197,94,0.6)'; x.shadowBlur = 30;
  x.fillStyle = '#22c55e';
  x.font = '700 92px system-ui, sans-serif';
  x.fillText('TIMERROYALE', 540, 150);
  x.shadowBlur = 0;
  x.fillStyle = '#7e967f';
  x.font = '600 44px system-ui, sans-serif';
  x.fillText(`DAILY ROYALE — ${res.dateKey}`, 540, 225);
  res.attempts.forEach((a, i) => {
    const y = 330 + i * 130;
    x.fillStyle = ratingColor(a.deviationMs);
    x.fillRect(240, y - 52, 64, 64);
    x.fillStyle = '#e9f6ec';
    x.textAlign = 'left';
    x.font = '600 52px system-ui, sans-serif';
    x.fillText(`Round ${i + 1}`, 350, y);
    x.textAlign = 'right';
    x.fillText(`off by ${fmtOff(a.deviationMs)}s`, 840, y);
    x.textAlign = 'center';
  });
  x.shadowColor = 'rgba(34,197,94,0.6)'; x.shadowBlur = 24;
  x.fillStyle = '#22c55e';
  x.font = '400 130px "DSEG7-Classic", monospace';
  x.fillText(fmtOff(res.totalMs), 540, 870);
  x.shadowBlur = 0;
  x.fillStyle = '#7e967f';
  x.font = '600 40px system-ui, sans-serif';
  x.fillText('seconds off total', 540, 930);
  x.fillStyle = '#4ade80';
  x.font = '700 44px system-ui, sans-serif';
  x.fillText('timerroyale.web.app', 540, 1010);
  return c;
}

async function shareScoreCard() {
  const res = todayResult();
  if (!res) return;
  await document.fonts.load('130px "DSEG7-Classic"').catch(() => {});
  const canvas = drawScoreCard(res);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  window.__lastCardBlob = blob; // diagnostics
  const file = new File([blob], `timerroyale-daily-${res.dateKey}.png`, { type: 'image/png' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'TimerRoyale Daily' });
      return;
    }
    throw new Error('no file share');
  } catch (err) {
    if (err.name === 'AbortError') return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

el('auth-btn').addEventListener('click', async () => {
  el('auth-btn').disabled = true;
  try { await signInGoogle(); }
  catch (err) { if (err.code !== 'auth/popup-closed-by-user') console.warn('[auth]', err.code); }
  el('auth-btn').disabled = false;
});
el('signout-btn').addEventListener('click', signOutUser);

el('solo-btn').addEventListener('click', startGame);
el('daily-btn').addEventListener('click', startDaily);

/* ---- Solo Guess Timer (TR-29) ---- */
let guessGame = null;

function fireMomentSolo(kind) {
  const f = el('flash');
  f.classList.remove('start', 'stop');
  void f.offsetWidth;
  f.classList.add(kind);
  try { kind === 'start' ? sfxStart() : sfxStop(); } catch { /* audio may be blocked pre-gesture */ }
}

function renderGuessRoundStart() {
  el('solo-round').textContent = `Guess Timer — Round ${guessGame.currentRound()} / ${GUESS_SOLO_ROUNDS}`;
  el('solo-big-label').textContent = 'PLAY IT';
  el('solo-big').hidden = false;
  el('solo-big').disabled = false;
  el('solo-guess-form').hidden = true;
  el('solo-msg').textContent = 'Tap, then feel the gap between the beeps.';
}

function startGuessSolo(opts) {
  mode = 'guess-solo';
  clearInterval(countdownTimer);
  el('join-code-form').hidden = true;
  el('final-score').hidden = true;
  el('daily-countdown').hidden = true;
  el('daily-share').hidden = true;
  guessGame = createGuessSoloGame({ onMoment: fireMomentSolo, targets: opts && opts.targets ? opts.targets : undefined });
  el('menu').hidden = true;
  el('solo-panel').hidden = false;
  document.querySelector('.target-row').hidden = true;
  document.querySelector('.score-wrap').hidden = true;
  el('solo-results').innerHTML = '';
  el('solo-total').hidden = true;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = true;
  renderGuessRoundStart();
}

function finishGuessSolo() {
  const totalMs = guessGame.totalMs();
  if (hostCtx) { finishHostChallenge(totalMs); return; }
  el('solo-round').textContent = 'Done!';
  const hero = el('final-score');
  hero.hidden = false;
  hero.innerHTML = `${fmtOff(totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-big').hidden = true;
  el('solo-guess-form').hidden = true;
  el('solo-msg').textContent = '';
  el('solo-total').hidden = false;
  el('solo-total').textContent = `Total: ${fmtOff(totalMs)}s off across ${GUESS_SOLO_ROUNDS} rounds — lower is better.`;
  el('solo-again').hidden = false;
  el('solo-exit').hidden = false;
}

el('guess-solo-btn').addEventListener('click', startGuessSolo);

el('solo-guess-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = parseFloat(el('solo-guess-input').value.replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0 || v > 99) {
    el('solo-guess-error').textContent = 'Enter seconds, like 4.7';
    return;
  }
  el('solo-guess-error').textContent = '';
  el('solo-guess-input').value = '';
  const attempt = guessGame.submitGuess(Math.round(v * 1000));
  if (!attempt) return;
  appendResult({ targetMs: attempt.actualMs, elapsedMs: attempt.guessMs, deviationMs: attempt.deltaMs },
    guessGame.attempts().length);
  if (guessGame.getState() === 'done') finishGuessSolo();
  else renderGuessRoundStart();
});
el('daily-share').addEventListener('click', shareScoreCard);
el('join-game-btn').addEventListener('click', () => {
  const f = el('join-code-form');
  f.hidden = !f.hidden;
  if (!f.hidden) el('code-input').focus();
});
el('join-code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = el('code-input').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) {
    el('code-error').textContent = 'Codes are 4 letters/numbers — check the TV.';
    return;
  }
  location.href = `/player.html?room=${code}`;
});
el('solo-again').addEventListener('click', () => (mode === 'guess-solo' ? startGuessSolo() : startGame()));
el('solo-exit').addEventListener('click', () => {
  clearInterval(countdownTimer);
  el('final-score').hidden = true;
  el('daily-countdown').hidden = true;
  el('solo-panel').hidden = true;
  el('menu').hidden = false;
});

el('solo-big').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const btn = el('solo-big');
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 150);
  if (mode === 'guess-solo') {
    if (guessGame.getState() !== 'ready') return;
    btn.disabled = true;
    el('solo-big-label').textContent = '👂 …';
    el('solo-msg').textContent = 'Listen…';
    guessGame.arm(() => {
      btn.hidden = true;
      el('solo-guess-form').hidden = false;
      el('solo-guess-submit').disabled = false;
      el('solo-guess-input').focus();
      el('solo-msg').textContent = 'How long was that?';
    });
    return;
  }
  const result = game.press();
  if (result.type === 'started') {
    sfxStart();
    el('solo-big').classList.add('running');
    el('solo-big-label').textContent = 'TAP TO STOP';
    el('solo-msg').textContent = '';
  } else if (result.type === 'stopped') {
    sfxStop();
    el('solo-big').classList.remove('running');
    setYou(result.attempt.elapsedMs);
    appendResult(result.attempt, game.currentRound() - 1);
    el('solo-msg').textContent = `Off by ${fmtOff(result.attempt.deviationMs)}s`;
    btn.disabled = true;
    flyDifference(result.attempt.deviationMs, () => {
      const newTotal = shownTotal + result.attempt.deviationMs;
      countUpScore(shownTotal, newTotal);
      shownTotal = newTotal;
      setTimeout(() => { btn.disabled = false; renderRoundStart(); }, 700);
    });
  } else if (result.type === 'finished') {
    sfxStop();
    el('solo-big').classList.remove('running');
    setYou(result.attempt.elapsedMs);
    appendResult(result.attempt, SOLO_ROUNDS);
    btn.disabled = true;
    flyDifference(result.attempt.deviationMs, () => {
      const newTotal = shownTotal + result.attempt.deviationMs;
      countUpScore(shownTotal, newTotal);
      shownTotal = newTotal;
      setTimeout(() => { btn.disabled = false; finishGame(result.totalMs); }, 800);
    });
  }
});


/* ---- Host branching: Screen-1 environment select + 1v1 invite (TR-46 / TR-34) ---- */
let hostCtx = null;

el('host-link').addEventListener('click', (e) => {
  e.preventDefault();
  el('menu').hidden = true;
  el('host-choice').hidden = false;
});
el('host-choice-back').addEventListener('click', () => {
  el('host-choice').hidden = true;
  el('menu').hidden = false;
});
el('host-party-btn').addEventListener('click', () => { location.href = '/host.html'; });
el('host-1v1-btn').addEventListener('click', () => {
  el('host-choice').hidden = true;
  el('host-1v1-panel').hidden = false;
  el('host-1v1-msg').textContent = currentUser ? '' : 'Tip: sign in (top of screen) so this match counts toward your record.';
});
el('host-1v1-back').addEventListener('click', () => {
  el('host-1v1-panel').hidden = true;
  el('menu').hidden = false;
});
el('host-1v1-play').addEventListener('click', () => {
  const pool = [];
  if (el('pool-classic').checked) pool.push('classic');
  if (el('pool-guess').checked) pool.push('guess');
  const check = validatePool(ENVIRONMENTS.ONEVONE, pool);
  if (!check.ok) { el('host-1v1-msg').textContent = check.reason; return; }
  if (!currentUser) { el('host-1v1-msg').textContent = 'Sign in (top of screen) to create a ranked 1v1.'; return; }
  el('host-1v1-msg').textContent = '';
  const chosen = resolveMode(check.pool);
  hostCtx = { id: generateMatchId(), mode: chosen };
  const targets = seededTargets(chosen, hostCtx.id);
  el('host-1v1-panel').hidden = true;
  if (chosen === 'classic') startGame({ targets });
  else startGuessSolo({ targets });
});

async function finishHostChallenge(totalMs) {
  const ctx = hostCtx;
  hostCtx = null;
  el('solo-round').textContent = `1v1 ${ctx.mode} — your half is in`;
  el('final-score').hidden = false;
  el('final-score').innerHTML = `${fmtOff(totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-big').hidden = true;
  el('solo-guess-form').hidden = true;
  el('solo-again').hidden = true;
  el('solo-exit').hidden = false;
  el('solo-total').hidden = true;
  el('solo-msg').textContent = 'Generating your invite link…';
  try {
    const profile = await getProfile(db, currentUser.uid);
    const res = await createMatchWithId(db, ctx.id, {
      mode: ctx.mode, hard: false,
      host: { uid: currentUser.uid, name: profile?.displayName ?? 'Host', score: totalMs }
    });
    el('solo-total').hidden = false;
    el('solo-total').textContent = res.link;
    el('solo-msg').textContent = 'Send this link to your challenger (valid 48h):';
    try { await navigator.clipboard.writeText(res.link); el('solo-msg').textContent = 'Link copied — send it to your challenger (48h):'; } catch { /* clipboard may be blocked pre-gesture */ }
  } catch (err) {
    el('solo-msg').textContent = 'Could not create the match — online 1v1 needs Google sign-in + server rules enabled.';
  }
}

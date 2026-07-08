// Landing page: single player front and center; Host a Game -> /host.html.
import { createSoloGame, SOLO_ROUNDS } from './solo.js';
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });

const el = (id) => document.getElementById(id);
const fmtS = (ms) => (ms / 1000).toFixed(1);
let game = null;
let shownTotal = 0;

function setYou(ms) {
  const you = el('solo-you');
  if (ms === null) {
    you.classList.add('dim');
    you.innerHTML = `--<span class="timer-unit">s</span>`;
  } else {
    you.classList.remove('dim');
    you.innerHTML = `${fmtS(ms)}<span class="timer-unit">s</span>`;
  }
}

function renderScore(ms) {
  el('solo-score').innerHTML = `${Math.round(ms).toLocaleString()}<span class="timer-unit">ms</span>`;
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
  chip.textContent = `+${deviationMs.toLocaleString()} ms`;
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
  el('solo-round').textContent = `Round ${game.currentRound()} / ${SOLO_ROUNDS}`;
  el('solo-target').innerHTML = `${fmtS(game.currentTargetMs())}<span class="timer-unit">s</span>`;
  setYou(null);
  el('solo-big-label').textContent = 'TAP TO START';
  el('solo-msg').textContent = 'Count it in your head — no peeking.';
}

function appendResult(attempt, roundNum) {
  const li = document.createElement('li');
  li.className = 'round-row stopped';
  li.innerHTML = `<span class="row-name">R${roundNum}: ${fmtS(attempt.targetMs)}s target</span>` +
    `<span class="row-time">${fmtS(attempt.elapsedMs)}s <span class="deviation">off by ${attempt.deviationMs} ms</span></span>`;
  el('solo-results').appendChild(li);
}

function startGame() {
  game = createSoloGame();
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
  el('solo-round').textContent = 'Done!';
  document.querySelector('.target-row').hidden = true;
  document.querySelector('.score-wrap').hidden = true;
  el('solo-target').innerHTML = `${fmtS(totalMs)}<span class="timer-unit">s off</span>`;
  el('solo-big').hidden = true;
  el('solo-msg').textContent = '';
  const total = el('solo-total');
  total.hidden = false;
  total.textContent = `Total: ${totalMs.toLocaleString()} ms off across ${SOLO_ROUNDS} rounds — lower is better.`;
  el('solo-again').hidden = false;
  el('solo-exit').hidden = false;
}

el('solo-btn').addEventListener('click', startGame);
el('solo-again').addEventListener('click', startGame);
el('solo-exit').addEventListener('click', () => {
  el('solo-panel').hidden = true;
  el('menu').hidden = false;
});

el('solo-big').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const btn = el('solo-big');
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 150);
  const result = game.press();
  if (result.type === 'started') {
    el('solo-big-label').textContent = 'TAP TO STOP';
    el('solo-msg').textContent = '';
  } else if (result.type === 'stopped') {
    setYou(result.attempt.elapsedMs);
    appendResult(result.attempt, game.currentRound() - 1);
    el('solo-msg').textContent = `Off by ${result.attempt.deviationMs.toLocaleString()} ms`;
    btn.disabled = true;
    flyDifference(result.attempt.deviationMs, () => {
      const newTotal = shownTotal + result.attempt.deviationMs;
      countUpScore(shownTotal, newTotal);
      shownTotal = newTotal;
      setTimeout(() => { btn.disabled = false; renderRoundStart(); }, 700);
    });
  } else if (result.type === 'finished') {
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

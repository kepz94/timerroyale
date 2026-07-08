// Session lifecycle (TR-2). Host-only module — players never create sessions.
import { ref, get, set, serverTimestamp } from 'firebase/database';

// No 0/O/1/I/L — unambiguous when read off a TV.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const MAX_CODE_ATTEMPTS = 5;

export function generateRoomCode() {
  let code = '';
  const rand = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(rand);
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[rand[i] % CODE_ALPHABET.length];
  }
  return code;
}

// Diagnostic trail (principle: every state change is traceable).
export function logTransition(scope, from, to, trigger) {
  console.info(`[state] ${scope}: ${from} -> ${to} (trigger: ${trigger})`);
}

/**
 * Creates a unique session in RTDB and returns { code }.
 * Collision-checked: regenerates the code if it already exists.
 */
export async function createSession(db) {
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const sessionRef = ref(db, `sessions/${code}`);
    const existing = await get(sessionRef);
    if (existing.exists()) {
      logTransition('session', 'generating', 'collision', `code ${code} taken (attempt ${attempt})`);
      continue;
    }
    await set(sessionRef, {
      createdAt: serverTimestamp(),
      status: 'lobby',
      version: '0.2.0'
    });
    logTransition('session', 'none', 'lobby', `created ${code}`);
    return { code };
  }
  throw new Error(`Could not allocate a unique room code after ${MAX_CODE_ATTEMPTS} attempts`);
}

export function playerJoinUrl(code) {
  return `${location.origin}/player.html?room=${code}`;
}

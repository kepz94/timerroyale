// Identity (TR-33 / ADR-002). Accounts are OPTIONAL — they only gate
// records/achievements, never gameplay. Google provider first.
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { ref, get, set, update, serverTimestamp } from 'firebase/database';
import { logTransition } from './session.js';

export function watchAuth(cb) {
  return onAuthStateChanged(getAuth(), cb);
}

export async function getProfile(db, uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? snap.val() : null;
}

export function validUsername(raw) {
  const name = (raw || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    return { ok: false, error: '3–16 letters, numbers, or _' };
  }
  return { ok: true, name };
}

/**
 * Claims a unique username (usernames/{lower} -> uid, create-or-own only per
 * rules) and creates/updates the profile. Releases the previous username.
 */
export async function claimUsername(db, user, name) {
  const key = name.toLowerCase();
  const existing = await get(ref(db, `usernames/${key}`));
  if (existing.exists() && existing.val() !== user.uid) {
    return { ok: false, error: 'That name is taken.' };
  }
  const profile = await getProfile(db, user.uid);
  const oldKey = profile?.displayName?.toLowerCase();
  await set(ref(db, `usernames/${key}`), user.uid);
  if (profile) {
    await update(ref(db, `users/${user.uid}`), { displayName: name });
    if (oldKey && oldKey !== key) await set(ref(db, `usernames/${oldKey}`), null).catch(() => {});
    logTransition('auth', 'profile', 'username-changed', `${user.uid} -> ${name}`);
  } else {
    await set(ref(db, `users/${user.uid}`), {
      displayName: name,
      record: { w: 0, l: 0, d: 0 },
      banner: 'rookie',
      banners: { rookie: true },
      createdAt: serverTimestamp()
    });
    logTransition('auth', 'first-sign-in', 'profile-created', `${user.uid} as ${name}`);
  }
  return { ok: true, name };
}

export async function signInGoogle() {
  const cred = await signInWithPopup(getAuth(), new GoogleAuthProvider());
  logTransition('auth', 'signed-out', 'signed-in', cred.user.uid);
  return cred.user;
}

export function signOutUser() {
  logTransition('auth', 'signed-in', 'signed-out', 'user action');
  return signOut(getAuth());
}

// Identity (TR-33 / ADR-002). Accounts are OPTIONAL — they only gate
// records/achievements, never gameplay. Google provider first.
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { ref, get, set, serverTimestamp } from 'firebase/database';
import { logTransition } from './session.js';

export function watchAuth(cb) {
  return onAuthStateChanged(getAuth(), cb);
}

export async function ensureProfile(db, user) {
  const profileRef = ref(db, `users/${user.uid}`);
  const snap = await get(profileRef);
  if (snap.exists()) return snap.val();
  const profile = {
    displayName: (user.displayName || 'Player').slice(0, 20),
    record: { w: 0, l: 0, d: 0 },
    banner: 'rookie',
    banners: { rookie: true },
    createdAt: serverTimestamp()
  };
  await set(profileRef, profile);
  logTransition('auth', 'first-sign-in', 'profile-created', user.uid);
  return profile;
}

export async function signInGoogle(db) {
  const cred = await signInWithPopup(getAuth(), new GoogleAuthProvider());
  await ensureProfile(db, cred.user);
  logTransition('auth', 'signed-out', 'signed-in', cred.user.uid);
  return cred.user;
}

export function signOutUser() {
  logTransition('auth', 'signed-in', 'signed-out', 'user action');
  return signOut(getAuth());
}

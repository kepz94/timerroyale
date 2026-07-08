// Firebase initialization — config is filled in during TR-1 Firebase setup.
// The host (TV) is the authoritative timekeeper; phones only write button-press events.
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

// TODO(TR-1): replace with real config from the Firebase console.
export const firebaseConfig = null;

export function initFirebase() {
  if (!firebaseConfig) {
    console.warn('Firebase not configured yet (TR-1 pending).');
    return null;
  }
  const app = initializeApp(firebaseConfig);
  return getDatabase(app);
}

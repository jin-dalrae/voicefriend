import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from './auth.js';

export function db() {
  return getFirestore();
}

export function userRef(uid) {
  return db().collection('users').doc(uid);
}

// Create the user doc on first sign-in; on later sign-ins only touch updatedAt
// (and backfill a name/email if missing) so we never reset createdAt/tier or
// clobber a name the user already has.
export async function ensureUser(uid, fields = {}) {
  const ref = userRef(uid);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      email: fields.email || null,
      profile: fields.profile || {},
      tier: 'free',
      onboarded: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return ref;
  }

  const cur = snap.data();
  const update = { updatedAt: FieldValue.serverTimestamp() };
  if (fields.email) update.email = fields.email;
  if (fields.profile?.name && !cur.profile?.name) update['profile.name'] = fields.profile.name;
  await ref.set(update, { merge: true });
  return ref;
}

export async function getUserProfile(uid) {
  const snap = await userRef(uid).get();
  return snap.exists ? (snap.data().profile || null) : null;
}

export async function saveUserProfile(uid, profile) {
  await userRef(uid).set(
    { profile, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

export async function startSession(uid, sessionId, data = {}) {
  await userRef(uid).collection('sessions').doc(sessionId).set(
    { ...data, startedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

export async function getUserBundle(uid) {
  const [user, coachesSnap] = await Promise.all([
    userRef(uid).get(),
    userRef(uid).collection('coaches').orderBy('order').get(),
  ]);

  return {
    user: user.exists ? user.data() : null,
    coaches: coachesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  };
}

export async function appendSessionMessage(uid, sessionId, message) {
  const ref = userRef(uid).collection('sessions').doc(sessionId).collection('messages').doc();
  await ref.set({
    ...message,
    ts: FieldValue.serverTimestamp(),
  });
  return ref;
}

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

export async function getUserDoc(uid) {
  const snap = await userRef(uid).get();
  return snap.exists ? snap.data() : null;
}

// Resume lives as a top-level field, NOT inside `profile` — the session
// summarizer rewrites `profile` wholesale and would otherwise wipe it.
export async function saveUserResume(uid, resume) {
  await userRef(uid).set(
    { resume, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
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

export async function saveLbdDebrief(uid, data) {
  const ref = userRef(uid).collection('lbd_sessions').doc();
  await ref.set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

export async function getLbdSessions(uid, limit = 60) {
  const snap = await userRef(uid)
    .collection('lbd_sessions')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function tsToMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  return null;
}

// Admin overview: every user plus their LbD usage. Server-only (admin SDK
// bypasses Firestore rules); gate the calling route to admins. Per user this is
// one list read + a count() aggregation + today's usage doc, so it stays cheap.
export async function getAdminOverview({ maxUsers = 500 } = {}) {
  const day = lbdUsageDayKey();
  const snap = await db().collection('users').limit(maxUsers).get();

  const users = await Promise.all(
    snap.docs.map(async (doc) => {
      const u = doc.data() || {};
      let lbdSessions = 0;
      let lbdToday = 0;
      try {
        const cnt = await doc.ref.collection('lbd_sessions').count().get();
        lbdSessions = cnt.data().count || 0;
      } catch { /* subcollection may not exist */ }
      try {
        const usage = await doc.ref.collection('usage').doc(`lbd-${day}`).get();
        lbdToday = usage.exists ? Number(usage.data().lbdSimulations) || 0 : 0;
      } catch { /* no usage today */ }
      return {
        uid: doc.id,
        email: u.email || null,
        name: u.profile?.name || null,
        tier: u.tier || 'free',
        onboarded: Boolean(u.onboarded),
        createdAt: tsToMillis(u.createdAt),
        updatedAt: tsToMillis(u.updatedAt),
        lbdSessions,
        lbdToday,
      };
    }),
  );

  users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const totals = {
    users: users.length,
    onboarded: users.filter((u) => u.onboarded).length,
    lbdSessions: users.reduce((n, u) => n + u.lbdSessions, 0),
    lbdToday: users.reduce((n, u) => n + u.lbdToday, 0),
  };

  return { users, totals, day };
}

export const LBD_DAILY_FREE_CREDITS = 5;

function lbdUsageDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function nextUtcMidnightIso() {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return next.toISOString();
}

export async function getLbdCredits(uid) {
  const day = lbdUsageDayKey();
  const ref = userRef(uid).collection('usage').doc(`lbd-${day}`);
  const snap = await ref.get();
  const used = snap.exists ? Number(snap.data().lbdSimulations) || 0 : 0;
  const limit = LBD_DAILY_FREE_CREDITS;
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    day,
    resetsAt: nextUtcMidnightIso(),
  };
}

// Atomically spend one daily simulation credit. Server-only (Firestore rules block client writes).
export async function consumeLbdCredit(uid) {
  const day = lbdUsageDayKey();
  const ref = userRef(uid).collection('usage').doc(`lbd-${day}`);
  const limit = LBD_DAILY_FREE_CREDITS;

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = snap.exists ? Number(snap.data().lbdSimulations) || 0 : 0;
    if (used >= limit) {
      return { ok: false, limit, used, remaining: 0, day, resetsAt: nextUtcMidnightIso() };
    }
    const nextUsed = used + 1;
    tx.set(
      ref,
      { lbdSimulations: nextUsed, day, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return {
      ok: true,
      limit,
      used: nextUsed,
      remaining: limit - nextUsed,
      day,
      resetsAt: nextUtcMidnightIso(),
    };
  });
}

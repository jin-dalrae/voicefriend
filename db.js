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

async function countSubcollection(ref, name) {
  try {
    const cnt = await ref.collection(name).count().get();
    return cnt.data().count || 0;
  } catch {
    return 0;
  }
}

async function getUserSpeakingStats(docRef, day) {
  const [t2mSessions, lbdSessions, coaches, lbdTodayRaw] = await Promise.all([
    countSubcollection(docRef, 'sessions'),
    countSubcollection(docRef, 'lbd_sessions'),
    countSubcollection(docRef, 'coaches'),
    docRef.collection('usage').doc(`lbd-${day}`).get().catch(() => null),
  ]);
  const lbdToday = lbdTodayRaw?.exists ? Number(lbdTodayRaw.data().lbdSimulations) || 0 : 0;

  const modeCounts = { coaching: 0, interview: 0, free: 0, lbd: 0 };
  const lbdScenarios = {};
  try {
    const snap = await docRef.collection('sessions').orderBy('startedAt', 'desc').limit(40).get();
    for (const d of snap.docs) {
      const mode = d.data().mode || 'coaching';
      modeCounts[mode] = (modeCounts[mode] || 0) + 1;
    }
  } catch { /* index may be missing */ }

  try {
    const snap = await docRef.collection('lbd_sessions').orderBy('createdAt', 'desc').limit(20).get();
    for (const d of snap.docs) {
      const sid = d.data().scenarioId || 'unknown';
      lbdScenarios[sid] = (lbdScenarios[sid] || 0) + 1;
    }
  } catch { /* index may be missing */ }

  const month = day.slice(0, 7);
  let tokensUsed = null;
  let capTokens = null;
  try {
    const usage = await docRef.collection('usage').doc(month).get();
    if (usage.exists) {
      tokensUsed = Number(usage.data().tokensUsed) || 0;
      capTokens = Number(usage.data().capTokens) || null;
    }
  } catch { /* no monthly usage yet */ }

  return { t2mSessions, lbdSessions, coaches, lbdToday, modeCounts, lbdScenarios, tokensUsed, capTokens };
}

function mergeModeTotals(target, source) {
  for (const [mode, n] of Object.entries(source || {})) {
    target[mode] = (target[mode] || 0) + n;
  }
}

function mergeScenarioTotals(target, source) {
  for (const [id, n] of Object.entries(source || {})) {
    target[id] = (target[id] || 0) + n;
  }
}

// Platform admin overview — users, speaking modes, LbD credits. Server-only.
export async function getAdminOverview({ maxUsers = 500, q = '', limit = 25, offset = 0 } = {}) {
  const day = lbdUsageDayKey();
  const snap = await db().collection('users').limit(maxUsers).get();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const users = await Promise.all(
    snap.docs.map(async (doc) => {
      const u = doc.data() || {};
      const stats = await getUserSpeakingStats(doc.ref, day);
      return {
        uid: doc.id,
        email: u.email || null,
        name: u.profile?.name || null,
        tier: u.tier || 'free',
        onboarded: Boolean(u.onboarded),
        createdAt: tsToMillis(u.createdAt),
        updatedAt: tsToMillis(u.updatedAt),
        hasResume: Boolean(u.resume),
        lbdCreditLimit: LBD_DAILY_FREE_CREDITS,
        ...stats,
      };
    }),
  );

  users.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

  const speakingMix = { coaching: 0, interview: 0, free: 0, lbd: 0 };
  const lbdScenarioMix = {};
  let active7d = 0;

  for (const u of users) {
    mergeModeTotals(speakingMix, u.modeCounts);
    mergeScenarioTotals(lbdScenarioMix, u.lbdScenarios);
    if ((u.updatedAt || 0) >= weekAgo) active7d += 1;
  }

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? users.filter(
        (u) =>
          (u.email || '').toLowerCase().includes(needle) ||
          (u.name || '').toLowerCase().includes(needle) ||
          u.uid.toLowerCase().includes(needle),
      )
    : users;

  const page = filtered.slice(offset, offset + limit);

  const totals = {
    users: users.length,
    filtered: filtered.length,
    onboarded: users.filter((u) => u.onboarded).length,
    active7d,
    t2mSessions: users.reduce((n, u) => n + u.t2mSessions, 0),
    lbdSessions: users.reduce((n, u) => n + u.lbdSessions, 0),
    lbdToday: users.reduce((n, u) => n + u.lbdToday, 0),
    speakingMix,
    lbdScenarioMix,
  };

  return {
    users: page,
    totals,
    day,
    lbdCreditLimit: LBD_DAILY_FREE_CREDITS,
    pagination: { limit, offset, total: filtered.length, hasMore: offset + limit < filtered.length },
  };
}

export async function getTalk2MeSessions(uid, limit = 20) {
  try {
    const snap = await userRef(uid)
      .collection('sessions')
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .get();
    const sessions = await Promise.all(
      snap.docs.map(async (doc) => {
        let messageCount = 0;
        try {
          const cnt = await doc.ref.collection('messages').count().get();
          messageCount = cnt.data().count || 0;
        } catch { /* no messages */ }
        const data = doc.data();
        return {
          id: doc.id,
          mode: data.mode || 'coaching',
          startedAt: tsToMillis(data.startedAt),
          messageCount,
        };
      }),
    );
    return sessions;
  } catch {
    return [];
  }
}

async function getLbdCreditHistory(uid, days = 7) {
  const history = [];
  const d = new Date();
  for (let i = 0; i < days; i += 1) {
    const day = lbdUsageDayKey(d);
    try {
      const snap = await userRef(uid).collection('usage').doc(`lbd-${day}`).get();
      history.push({
        day,
        used: snap.exists ? Number(snap.data().lbdSimulations) || 0 : 0,
        limit: LBD_DAILY_FREE_CREDITS,
      });
    } catch {
      history.push({ day, used: 0, limit: LBD_DAILY_FREE_CREDITS });
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return history;
}

export async function getAdminUserDetail(uid) {
  const ref = userRef(uid);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const u = snap.data() || {};
  const day = lbdUsageDayKey();
  const stats = await getUserSpeakingStats(ref, day);
  const [t2mSessions, lbdSessions, lbdCreditHistory] = await Promise.all([
    getTalk2MeSessions(uid, 20),
    getLbdSessions(uid, 20),
    getLbdCreditHistory(uid, 7),
  ]);

  const month = day.slice(0, 7);
  let monthlyUsage = null;
  try {
    const usage = await ref.collection('usage').doc(month).get();
    if (usage.exists) {
      monthlyUsage = {
        period: month,
        tokensUsed: Number(usage.data().tokensUsed) || 0,
        capTokens: Number(usage.data().capTokens) || null,
        secondsUsed: Number(usage.data().secondsUsed) || null,
      };
    }
  } catch { /* not metered */ }

  const coaches = await ref.collection('coaches').orderBy('order').get().catch(() => null);

  return {
    uid,
    email: u.email || null,
    name: u.profile?.name || null,
    tier: u.tier || 'free',
    onboarded: Boolean(u.onboarded),
    hasResume: Boolean(u.resume),
    createdAt: tsToMillis(u.createdAt),
    updatedAt: tsToMillis(u.updatedAt),
    lbdCreditLimit: LBD_DAILY_FREE_CREDITS,
    lbdCreditsToday: {
      used: stats.lbdToday,
      limit: LBD_DAILY_FREE_CREDITS,
      remaining: Math.max(0, LBD_DAILY_FREE_CREDITS - stats.lbdToday),
      day,
    },
    lbdCreditHistory,
    monthlyUsage,
    coaches: coaches ? coaches.docs.map((doc) => ({ id: doc.id, ...doc.data() })) : [],
    modeCounts: stats.modeCounts,
    lbdScenarios: stats.lbdScenarios,
    t2mSessionTotal: stats.t2mSessions,
    lbdSessionTotal: stats.lbdSessions,
    recentT2mSessions: t2mSessions,
    recentLbdSessions: lbdSessions,
  };
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

// --- Minute-based credits (the paid metering primitive) -----------------------
// Talk2Me's COGS is ~$0.015–$0.025 per conversation-minute (native-audio output
// is the driver), so usage is metered in MINUTES. A user's monthly allowance
// comes from their plan; purchased top-up packs add non-expiring minutes on top.
// Server-only — Firestore rules block client writes. See PRICING.md for the cost
// model and plan table. NOTE: defined here as the primitive; not yet wired into
// the live turn loop or Stripe.

export const PLAN_MONTHLY_MINUTES = {
  free: 150, // also gated to ~10 min/day by a separate daily cap
  casual: 100,
  student: 250,
  pro: 600,
};

function usageMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

function planMonthlyMinutes(tier) {
  return PLAN_MONTHLY_MINUTES[tier] ?? PLAN_MONTHLY_MINUTES.free;
}

// Read-only: remaining = (this month's plan allowance − minutes used this month)
// + non-expiring top-up minutes.
export async function getMinuteBalance(uid) {
  const month = usageMonthKey();
  const [userSnap, usageSnap] = await Promise.all([
    userRef(uid).get(),
    userRef(uid).collection('usage').doc(month).get(),
  ]);
  const tier = userSnap.exists ? userSnap.data().tier || 'free' : 'free';
  const allowance = planMonthlyMinutes(tier);
  const used = usageSnap.exists ? Number(usageSnap.data().minutesUsed) || 0 : 0;
  const topup = userSnap.exists ? Number(userSnap.data().topupMinutes) || 0 : 0;
  const planRemaining = Math.max(0, allowance - used);
  return {
    tier,
    month,
    allowanceMinutes: allowance,
    usedMinutes: used,
    planRemaining,
    topupMinutes: topup,
    remaining: planRemaining + topup,
  };
}

// Atomically spend `minutes` of balance: draw from the monthly plan allowance
// first, then from non-expiring top-up minutes. Never goes negative — caps the
// spend at what's available and reports any `shortfall`. Call as a conversation
// accrues time (per turn, or per N seconds).
export async function consumeMinutes(uid, minutes) {
  const spend = Math.max(0, Number(minutes) || 0);
  if (!spend) return { ok: true, spent: 0, shortfall: 0 };
  const month = usageMonthKey();
  const uref = userRef(uid);
  const usageRef = uref.collection('usage').doc(month);

  return db().runTransaction(async (tx) => {
    const [userSnap, usageSnap] = await Promise.all([tx.get(uref), tx.get(usageRef)]);
    const tier = userSnap.exists ? userSnap.data().tier || 'free' : 'free';
    const allowance = planMonthlyMinutes(tier);
    const used = usageSnap.exists ? Number(usageSnap.data().minutesUsed) || 0 : 0;
    const topup = userSnap.exists ? Number(userSnap.data().topupMinutes) || 0 : 0;

    const planRemaining = Math.max(0, allowance - used);
    const remaining = planRemaining + topup;
    if (remaining <= 0) {
      return { ok: false, reason: 'no_balance', spent: 0, shortfall: spend, remaining: 0, tier, month };
    }

    const actual = Math.min(spend, remaining);
    const fromPlan = Math.min(actual, planRemaining);
    const fromTopup = actual - fromPlan;

    tx.set(
      usageRef,
      { minutesUsed: used + fromPlan, month, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    if (fromTopup > 0) {
      tx.set(
        uref,
        { topupMinutes: topup - fromTopup, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    }

    return { ok: true, spent: actual, shortfall: spend - actual, remaining: remaining - actual, tier, month };
  });
}

// Credit purchased, non-expiring top-up minutes (call from a Stripe webhook).
export async function addTopupMinutes(uid, minutes) {
  const add = Math.max(0, Number(minutes) || 0);
  if (!add) return;
  await userRef(uid).set(
    { topupMinutes: FieldValue.increment(add), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

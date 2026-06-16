import { applicationDefault, cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

const REQUIRE_FIREBASE_AUTH = process.env.REQUIRE_FIREBASE_AUTH === '1';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'talk2me-e90b1';
const OPTIONAL_AUTH_TIMEOUT_MS = Number(process.env.OPTIONAL_AUTH_TIMEOUT_MS) || 5000;

let adminApp;

function getCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }
  return applicationDefault();
}

export function getAdminApp() {
  if (!adminApp) {
    adminApp = getApps().length
      ? getApp()
      : initializeApp({
          credential: getCredential(),
          projectId: FIREBASE_PROJECT_ID,
        });
  }
  return adminApp;
}

export function getAuth() {
  return getAdminAuth(getAdminApp());
}

export function getFirestore() {
  return getAdminFirestore(getAdminApp());
}

export function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || '';
}

export async function authenticateWebSocketRequest(req) {
  const token = getBearerToken(req);
  if (!token && !REQUIRE_FIREBASE_AUTH) {
    return { uid: null, anonymous: true };
  }
  if (!token) {
    throw new Error('Missing Firebase ID token.');
  }

  return verifyFirebaseIdToken(token, { required: REQUIRE_FIREBASE_AUTH });
}

export async function verifyFirebaseIdToken(token, { required = REQUIRE_FIREBASE_AUTH } = {}) {
  let decoded;
  try {
    decoded = required
      ? await getAuth().verifyIdToken(token)
      : await withTimeout(getAuth().verifyIdToken(token), OPTIONAL_AUTH_TIMEOUT_MS);
  } catch (err) {
    if (required) throw err;
    console.warn(`Optional Firebase auth skipped: ${err?.message || err}`);
    return { uid: null, anonymous: true };
  }

  return {
    uid: decoded.uid,
    email: decoded.email || null,
    name: decoded.name || null,
    anonymous: false,
  };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Firebase ID token verification timed out after ${ms}ms`)), ms);
    }),
  ]);
}

export { REQUIRE_FIREBASE_AUTH, FIREBASE_PROJECT_ID };

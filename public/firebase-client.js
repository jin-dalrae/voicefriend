import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js';
import {
  getAnalytics,
  isSupported as analyticsSupported,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-analytics.js';
import {
  getAuth,
  GoogleAuthProvider,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js';
import {
  collection,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js';

const app = initializeApp(window.TALK2ME_FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

analyticsSupported()
  .then((supported) => {
    if (supported) getAnalytics(app);
  })
  .catch(() => {});

let currentUser = null;
let menuRoot; // the #account-menu container we render into
let menuOpen = false;
let lastAuthMessage = '';

function escAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  renderAuthState();
  window.dispatchEvent(new CustomEvent('talk2me:auth-changed', { detail: { signedIn: Boolean(user) } }));
});

if (isSignInWithEmailLink(auth, window.location.href)) {
  const email = window.localStorage.getItem('talk2me.emailForSignIn') || window.prompt('Email for sign-in link');
  if (email) {
    signInWithEmailLink(auth, email, window.location.href)
      .then(() => {
        window.localStorage.removeItem('talk2me.emailForSignIn');
        window.history.replaceState({}, document.title, window.location.pathname);
        return ensureDisplayName(auth.currentUser); // email-link has no name; ask once
      })
      .catch((err) => setAuthStatus(err.message));
  }
}

export function initAuthUi() {
  menuRoot = document.getElementById('account-menu');
  if (!menuRoot) return; // page has no account menu (e.g. /about)

  // One delegated handler — the menu is re-rendered on every auth change.
  menuRoot.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'signin') return doGoogleSignIn();
    if (act === 'emaillink') return doEmailLinkSignIn();
    if (act === 'toggle') return toggleMenu();
    if (act === 'signout') {
      closeMenu();
      signOut(auth).catch((err) => setAuthStatus(err.message));
    }
  });

  // Close the dropdown on outside click or Escape.
  document.addEventListener('click', (e) => {
    if (menuOpen && menuRoot && !menuRoot.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuOpen) closeMenu();
  });

  renderAuthState();
}

async function doGoogleSignIn() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    setAuthStatus(err.message);
  }
}

async function doEmailLinkSignIn() {
  const email = window.prompt('Email address');
  if (!email) return;
  try {
    await sendSignInLinkToEmail(auth, email, { url: window.location.href, handleCodeInApp: true });
    window.localStorage.setItem('talk2me.emailForSignIn', email);
    setAuthStatus('Check your email for the sign-in link.');
  } catch (err) {
    setAuthStatus(err.message);
  }
}

function toggleMenu() {
  menuOpen ? closeMenu() : openMenu();
}
function openMenu() {
  menuOpen = true;
  const panel = menuRoot?.querySelector('[data-menu]');
  const btn = menuRoot?.querySelector('[data-act="toggle"]');
  if (panel) panel.hidden = false;
  if (btn) btn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  menuOpen = false;
  const panel = menuRoot?.querySelector('[data-menu]');
  const btn = menuRoot?.querySelector('[data-act="toggle"]');
  if (panel) panel.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

export async function getCurrentIdToken(forceRefresh = false) {
  return currentUser ? currentUser.getIdToken(forceRefresh) : '';
}

export function getDisplayName() {
  return currentUser?.displayName || null;
}

export function getCurrentUid() {
  return currentUser?.uid || null;
}

/** LbD debrief sessions — readable by owner via Firestore rules (no relay required). */
export async function fetchLbdSessions(max = 60) {
  const uid = getCurrentUid();
  if (!uid) return [];
  const q = query(
    collection(db, 'users', uid, 'lbd_sessions'),
    orderBy('createdAt', 'desc'),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// Google provides a name automatically; email-link sign-in does not, so ask once
// and store it on the account (the relay reads it from the verified token's name
// claim and saves it as the user's profile name).
async function ensureDisplayName(user) {
  if (!user || user.displayName) return;
  const name = (window.prompt('What should we call you?') || '').trim();
  if (!name) return;
  try {
    await updateProfile(user, { displayName: name });
    await user.getIdToken(true); // force refresh so the token carries the name
    renderAuthState();
    window.dispatchEvent(new CustomEvent('talk2me:auth-changed', { detail: { signedIn: true } }));
  } catch (err) {
    setAuthStatus(err.message);
  }
}

function renderAuthState() {
  if (!menuRoot) return;
  menuOpen = false;

  if (!currentUser) {
    menuRoot.innerHTML = `
      <button class="lbd-mini-btn" data-act="signin" type="button">Sign in</button>
      ${lastAuthMessage ? `<span class="lbd-auth-status lbd-menu-msg">${escAttr(lastAuthMessage)}</span>` : ''}`;
    return;
  }

  const label = currentUser.displayName || currentUser.email || 'Account';
  const initial = (label.trim()[0] || '?').toUpperCase();
  menuRoot.innerHTML = `
    <button class="lbd-avatar-btn" data-act="toggle" type="button"
      aria-haspopup="true" aria-expanded="false" title="${escAttr(label)}">${escAttr(initial)}</button>
    <div class="lbd-menu" data-menu hidden>
      <span class="lbd-menu-label">Signed in as</span>
      ${currentUser.displayName ? `<p class="lbd-menu-name">${escAttr(currentUser.displayName)}</p>` : ''}
      <p class="lbd-menu-email">${escAttr(currentUser.email || '')}</p>
      <button class="lbd-mini-btn" data-act="signout" type="button">Sign out</button>
    </div>`;
}

function setAuthStatus(message) {
  lastAuthMessage = message || '';
  if (message) console.info('[auth]', message);
  if (!currentUser) renderAuthState();
}

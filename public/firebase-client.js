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
let menuRoot; // welcome sign-in buttons (#account-menu)
let welcomeAccountMenuRoot; // welcome account menu (#welcome-account-menu)
let sessionMenuRoot; // in-call account menu (#call-account-menu)
let activeMenuRoot; // whichever menu receives clicks / dropdown state
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

function bindMenuRoot(root) {
  if (!root || root.dataset.authBound) return;
  root.dataset.authBound = '1';
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'signin') return doGoogleSignIn();
    if (act === 'emaillink') return doEmailLinkSignIn();
    if (act === 'toggle') {
      activeMenuRoot = root;
      return toggleMenu();
    }
    if (act === 'signout') {
      closeMenu();
      signOut(auth).catch((err) => setAuthStatus(err.message));
    }
  });
}

export function initAuthUi() {
  menuRoot = document.getElementById('account-menu');
  welcomeAccountMenuRoot = document.getElementById('welcome-account-menu');
  sessionMenuRoot = document.getElementById('call-account-menu');
  if (!menuRoot && !welcomeAccountMenuRoot && !sessionMenuRoot) return;

  bindMenuRoot(menuRoot);
  bindMenuRoot(welcomeAccountMenuRoot);
  bindMenuRoot(sessionMenuRoot);

  // Close the dropdown on outside click or Escape.
  document.addEventListener('click', (e) => {
    if (menuOpen && activeMenuRoot && !activeMenuRoot.contains(e.target)) closeMenu();
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
  const panel = activeMenuRoot?.querySelector('[data-menu]');
  const btn = activeMenuRoot?.querySelector('[data-act="toggle"]');
  if (panel) panel.hidden = false;
  if (btn) btn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  menuOpen = false;
  const panel = activeMenuRoot?.querySelector('[data-menu]');
  const btn = activeMenuRoot?.querySelector('[data-act="toggle"]');
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

function isWelcomeSignInRoot(root) {
  return Boolean(root?.closest('#welcome-auth, .auth-panel, #welcome'));
}

function isWelcomeAccountRoot(root) {
  return Boolean(root?.closest('#welcome-account, .welcome-account'));
}

function isSessionRoot(root) {
  return Boolean(root?.closest('.call-header-actions, .call-account'));
}

function authBtnClass(root) {
  if (isWelcomeSignInRoot(root)) return 'secondary-action';
  if (isSessionRoot(root)) return 'call-account-btn';
  return 'lbd-mini-btn';
}

function renderSignedOut(root) {
  if (!root) return;
  const btn = authBtnClass(root);
  const statusClass = isWelcomeSignInRoot(root) ? 'auth-status' : 'lbd-auth-status lbd-menu-msg';
  const signInButtons = isWelcomeSignInRoot(root)
    ? `<button class="${btn}" data-act="signin" type="button">Google</button>
       <button class="${btn}" data-act="emaillink" type="button">Email link</button>`
    : `<button class="${btn}" data-act="signin" type="button">Sign in</button>`;
  root.innerHTML = `
    ${signInButtons}
    ${lastAuthMessage ? `<span class="${statusClass}">${escAttr(lastAuthMessage)}</span>` : ''}`;
}

function renderSignedIn(root) {
  if (!root) return;
  if (isWelcomeAccountRoot(root)) return renderWelcomeSignedIn(root);

  const btn = authBtnClass(root);
  const label = currentUser.displayName || currentUser.email || 'Account';
  const initial = (label.trim()[0] || '?').toUpperCase();
  const avatarClass = isSessionRoot(root) ? 'call-avatar-btn' : 'lbd-avatar-btn';
  const menuClass = isSessionRoot(root) ? 'call-account-panel' : 'lbd-menu';
  const labelClass = isSessionRoot(root) ? 'call-account-label' : 'lbd-menu-label';
  const nameClass = isSessionRoot(root) ? 'call-account-name' : 'lbd-menu-name';
  const emailClass = isSessionRoot(root) ? 'call-account-email' : 'lbd-menu-email';
  root.innerHTML = `
    <button class="${avatarClass}" data-act="toggle" type="button"
      aria-haspopup="true" aria-expanded="false" title="${escAttr(label)}">${escAttr(initial)}</button>
    <div class="${menuClass}" data-menu hidden>
      <span class="${labelClass}">Signed in as</span>
      ${currentUser.displayName ? `<p class="${nameClass}">${escAttr(currentUser.displayName)}</p>` : ''}
      <p class="${emailClass}">${escAttr(currentUser.email || '')}</p>
      <button class="${btn}" data-act="signout" type="button">Sign out</button>
    </div>`;
}

function renderWelcomeSignedIn(root) {
  root.innerHTML = `
    <button class="welcome-account-btn" data-act="toggle" type="button"
      aria-haspopup="true" aria-expanded="false">Account</button>
    <div class="welcome-account-panel" data-menu hidden>
      <span class="welcome-account-label">Signed in as</span>
      ${currentUser.displayName ? `<p class="welcome-account-name">${escAttr(currentUser.displayName)}</p>` : ''}
      <p class="welcome-account-email">${escAttr(currentUser.email || '')}</p>
      <button class="welcome-signout-btn" data-act="signout" type="button">Sign out</button>
    </div>`;
}

function renderAuthState() {
  if (!menuRoot && !welcomeAccountMenuRoot && !sessionMenuRoot) return;
  menuOpen = false;

  if (!currentUser) {
    renderSignedOut(menuRoot);
    if (welcomeAccountMenuRoot) welcomeAccountMenuRoot.innerHTML = '';
    if (sessionMenuRoot) sessionMenuRoot.innerHTML = '';
    activeMenuRoot = menuRoot;
    return;
  }

  if (menuRoot) menuRoot.innerHTML = '';
  if (welcomeAccountMenuRoot) renderWelcomeSignedIn(welcomeAccountMenuRoot);
  if (sessionMenuRoot) renderSignedIn(sessionMenuRoot);
  activeMenuRoot = welcomeAccountMenuRoot || sessionMenuRoot || menuRoot;
}

function setAuthStatus(message) {
  lastAuthMessage = message || '';
  if (message) console.info('[auth]', message);
  if (!currentUser) renderAuthState();
}

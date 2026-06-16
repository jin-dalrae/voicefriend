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

const app = initializeApp(window.TALK2ME_FIREBASE_CONFIG);
const auth = getAuth(app);

analyticsSupported()
  .then((supported) => {
    if (supported) getAnalytics(app);
  })
  .catch(() => {});

let currentUser = null;
let authStatusEl;
let googleButton;
let emailButton;
let signOutButton;

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
  authStatusEl = document.getElementById('auth-status');
  googleButton = document.getElementById('google-signin');
  emailButton = document.getElementById('email-link');
  signOutButton = document.getElementById('signout');

  googleButton?.addEventListener('click', async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      setAuthStatus(err.message);
    }
  });

  emailButton?.addEventListener('click', async () => {
    const email = window.prompt('Email address');
    if (!email) return;
    try {
      await sendSignInLinkToEmail(auth, email, {
        url: window.location.href,
        handleCodeInApp: true,
      });
      window.localStorage.setItem('talk2me.emailForSignIn', email);
      setAuthStatus('Check your email for the sign-in link.');
    } catch (err) {
      setAuthStatus(err.message);
    }
  });

  signOutButton?.addEventListener('click', () => {
    signOut(auth).catch((err) => setAuthStatus(err.message));
  });

  renderAuthState();
}

export async function getCurrentIdToken() {
  return currentUser ? currentUser.getIdToken() : '';
}

export function getDisplayName() {
  return currentUser?.displayName || null;
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
  if (!authStatusEl) return;
  if (!currentUser) {
    authStatusEl.textContent = 'Not signed in';
    if (googleButton) googleButton.hidden = false;
    if (emailButton) emailButton.hidden = false;
    if (signOutButton) signOutButton.hidden = true;
    return;
  }

  authStatusEl.textContent = currentUser.email || 'Signed in';
  if (googleButton) googleButton.hidden = true;
  if (emailButton) emailButton.hidden = true;
  if (signOutButton) signOutButton.hidden = false;
}

function setAuthStatus(message) {
  if (authStatusEl) authStatusEl.textContent = message;
}

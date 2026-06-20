import { getCurrentIdToken, initAuthUi } from './firebase-client.js';
import { lbdApiBase } from './lbd-credits.js';

const adminEl = document.getElementById('admin');
const apiBase = lbdApiBase;
let signedIn = false;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function shell(inner) {
  adminEl.innerHTML = `
    <div class="lbd-trends-top">
      <a class="lbd-back" href="/lbd">← Simulator</a>
      <h1 class="lbd-h1">Admin</h1>
    </div>
    ${inner}`;
}

function renderMessage(msg) {
  shell(`<section class="lbd-panel lbd-trends-section"><p class="lbd-hint">${esc(msg)}</p></section>`);
}

function renderOverview(data) {
  const { users = [], totals = {}, admin } = data;

  const rows = users.length
    ? users
        .map(
          (u) => `<tr>
            <td>
              <span class="lbd-admin-email">${esc(u.email || u.uid)}</span>
              ${u.name ? `<span class="lbd-admin-name">${esc(u.name)}</span>` : ''}
            </td>
            <td><span class="lbd-chip">${esc(u.tier || 'free')}</span></td>
            <td class="lbd-admin-num">${u.onboarded ? '✓' : '—'}</td>
            <td class="lbd-admin-num">${u.lbdSessions}</td>
            <td class="lbd-admin-num">${u.lbdToday}</td>
            <td class="lbd-admin-date">${fmtDate(u.createdAt)}</td>
            <td class="lbd-admin-date">${fmtDate(u.updatedAt)}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="lbd-dim">No users yet.</td></tr>';

  shell(`
    <div class="lbd-trends-hero">
      <section class="lbd-panel lbd-hero-stat">
        <p class="lbd-h3">Users</p>
        <p class="lbd-stat">${totals.users ?? 0}</p>
        <p class="lbd-dim">${totals.onboarded ?? 0} onboarded</p>
      </section>
      <section class="lbd-panel lbd-hero-stat">
        <p class="lbd-h3">LbD sessions</p>
        <p class="lbd-stat">${totals.lbdSessions ?? 0}</p>
        <p class="lbd-dim">all-time debriefs</p>
      </section>
      <section class="lbd-panel lbd-hero-stat">
        <p class="lbd-h3">Sims today</p>
        <p class="lbd-stat">${totals.lbdToday ?? 0}</p>
        <p class="lbd-dim">${esc(data.day || '')}</p>
      </section>
    </div>

    <section class="lbd-panel lbd-trends-section">
      <h2 class="lbd-h3">Users</h2>
      <p class="lbd-dim">Signed in as admin: ${esc(admin || '')}. Sorted by newest. LbD = lateral-leadership simulator runs.</p>
      <div class="lbd-admin-table-wrap">
        <table class="lbd-admin-table">
          <thead>
            <tr>
              <th>User</th><th>Tier</th><th>Onb.</th><th>LbD</th><th>Today</th><th>Joined</th><th>Last active</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`);
}

async function loadOverview() {
  if (!signedIn) {
    renderMessage('Sign in (top right) with an admin account to view the dashboard.');
    return;
  }
  shell('<section class="lbd-panel lbd-trends-section"><p class="lbd-dim">Loading…</p></section>');
  try {
    const token = await getCurrentIdToken(true);
    if (!token) return renderMessage('Sign in with an admin account to view the dashboard.');
    const res = await fetch(`${apiBase()}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) {
      return renderMessage('This account is not on the admin allowlist. Sign in with an admin account.');
    }
    if (res.status === 401) {
      return renderMessage('Session expired — sign in again to view the dashboard.');
    }
    if (!res.ok) {
      return renderMessage('Could not load the dashboard. Try again in a moment.');
    }
    renderOverview(await res.json());
  } catch {
    renderMessage('Could not reach the server. Check your connection and try again.');
  }
}

initAuthUi();
window.addEventListener('talk2me:auth-changed', (e) => {
  signedIn = Boolean(e.detail?.signedIn);
  loadOverview();
});
loadOverview();

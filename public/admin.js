import { getCurrentIdToken, initAuthUi } from './firebase-client.js';
import { lbdApiBase } from './lbd-credits.js';
import { scenarioDisplayName } from './lbd-frameworks.js';
import { openSessionPanel, closeSessionPanel, fmtSessionDate } from './lbd-session-panel.js';

const adminEl = document.getElementById('admin');
const apiBase = lbdApiBase;
let signedIn = false;
let overviewData = null;
let activeTab = 'users';
let sortKey = 'updatedAt';
let sortDir = -1;

const MODE_LABELS = {
  coaching: 'Coaching',
  interview: 'Interview',
  free: 'Free chat',
  lbd: 'LbD',
};

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
      <h1 class="lbd-h1">Talk2Me admin</h1>
      <p class="lbd-dim">Users, speaking activity, and credit usage across Talk2Me and LbD.</p>
    </div>
    ${inner}`;
}

function renderMessage(msg) {
  shell(`<section class="lbd-panel lbd-trends-section"><p class="lbd-hint">${esc(msg)}</p></section>`);
}

function speakingChips(modeCounts, lbdScenarios) {
  const modes = Object.entries(modeCounts || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${MODE_LABELS[k] || k}×${n}`);
  const scenarios = Object.entries(lbdScenarios || {})
    .filter(([, n]) => n > 0)
    .slice(0, 2)
    .map(([id, n]) => `${scenarioDisplayName(id)}×${n}`);
  const parts = [...modes, ...scenarios];
  return parts.length ? parts.join(' · ') : '—';
}

function renderMixBar(mix, total) {
  if (!total) return '<p class="lbd-dim">No session data yet.</p>';
  const rows = Object.entries(mix || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return `<div class="lbd-bars compact">${rows
    .map(([mode, n]) => {
      const pct = Math.round((n / total) * 100);
      return `<div class="lbd-bar"><span class="lbd-tag">${esc(MODE_LABELS[mode] || mode)}</span><span class="lbd-bar-track"><span class="lbd-bar-fill" style="width:${pct}%"></span></span><span class="lbd-bar-pct">${n}</span></div>`;
    })
    .join('')}</div>`;
}

function renderScenarioMix(mix) {
  const rows = Object.entries(mix || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<p class="lbd-dim">No LbD scenarios yet.</p>';
  return `<ul class="lbd-outcomes">${rows
    .map(([id, n]) => `<li><span>${esc(scenarioDisplayName(id))}</span><strong>${n}</strong></li>`)
    .join('')}</ul>`;
}

function sortedUsers(users) {
  const list = [...(users || [])];
  list.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === 'string') return sortDir * String(av).localeCompare(String(bv));
    return sortDir * ((Number(av) || 0) - (Number(bv) || 0));
  });
  return list;
}

function renderUserTable(users) {
  const rows = users.length
    ? sortedUsers(users)
        .map(
          (u) => `<tr data-uid="${esc(u.uid)}" class="lbd-admin-row">
            <td>
              <span class="lbd-admin-email">${esc(u.email || u.uid)}</span>
              ${u.name ? `<span class="lbd-admin-name">${esc(u.name)}</span>` : ''}
            </td>
            <td><span class="lbd-chip">${esc(u.tier || 'free')}</span></td>
            <td class="lbd-admin-speaking">${esc(speakingChips(u.modeCounts, u.lbdScenarios))}</td>
            <td class="lbd-admin-num">${u.lbdToday}/${u.lbdCreditLimit ?? 5}</td>
            <td class="lbd-admin-num">${u.tokensUsed != null ? `${u.tokensUsed}${u.capTokens ? `/${u.capTokens}` : ''}` : '—'}</td>
            <td class="lbd-admin-num">${u.t2mSessions}</td>
            <td class="lbd-admin-num">${u.lbdSessions}</td>
            <td class="lbd-admin-date">${fmtDate(u.updatedAt)}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="8" class="lbd-dim">No users match.</td></tr>';

  return `
    <div class="lbd-admin-toolbar">
      <input class="lbd-admin-search" id="admin-search" type="search" placeholder="Search email or name…" />
      <button class="lbd-mini-btn" type="button" id="admin-export">Export CSV</button>
    </div>
    <div class="lbd-admin-table-wrap">
      <table class="lbd-admin-table">
        <thead>
          <tr>
            <th data-sort="email">User</th>
            <th data-sort="tier">Tier</th>
            <th>Speaking</th>
            <th data-sort="lbdToday">LbD today</th>
            <th>T2M tokens</th>
            <th data-sort="t2mSessions">T2M</th>
            <th data-sort="lbdSessions">LbD</th>
            <th data-sort="updatedAt">Last active</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderOverview(data) {
  overviewData = data;
  const { totals = {}, users = [], day, lbdCreditLimit = 5, pagination = {}, admin } = data;
  const mixTotal = Object.values(totals.speakingMix || {}).reduce((n, v) => n + v, 0);

  shell(`
    <div class="lbd-admin-tabs" role="tablist">
      <button class="lbd-seg-btn${activeTab === 'users' ? ' is-on' : ''}" type="button" data-tab="users">Users</button>
      <button class="lbd-seg-btn${activeTab === 'speaking' ? ' is-on' : ''}" type="button" data-tab="speaking">Speaking</button>
      <button class="lbd-seg-btn${activeTab === 'credits' ? ' is-on' : ''}" type="button" data-tab="credits">Credits</button>
    </div>

    <div class="lbd-trends-hero">
      <section class="lbd-panel lbd-hero-stat">
        <p class="lbd-h3">Users</p>
        <p class="lbd-stat">${totals.users ?? 0}</p>
        <p class="lbd-dim">${totals.onboarded ?? 0} onboarded · ${totals.active7d ?? 0} active 7d</p>
      </section>
      <section class="lbd-panel lbd-hero-stat">
        <p class="lbd-h3">Talk2Me sessions</p>
        <p class="lbd-stat">${totals.t2mSessions ?? 0}</p>
        <p class="lbd-dim">voice sessions all-time</p>
      </section>
      <section class="lbd-panel lbd-hero-stat">
        <p class="lbd-h3">LbD credits today</p>
        <p class="lbd-stat">${totals.lbdToday ?? 0}</p>
        <p class="lbd-dim">${totals.lbdSessions ?? 0} debriefs · ${lbdCreditLimit}/user/day</p>
      </section>
    </div>

    ${activeTab === 'speaking' ? `<section class="lbd-panel lbd-trends-section">
      <h2 class="lbd-h3">Platform speaking mix</h2>
      <p class="lbd-dim">From recent session samples per user (coaching, interview, free chat, LbD).</p>
      ${renderMixBar(totals.speakingMix, mixTotal)}
      <h2 class="lbd-h3">LbD scenarios</h2>
      ${renderScenarioMix(totals.lbdScenarioMix)}
    </section>` : ''}

    ${activeTab === 'credits' ? `<section class="lbd-panel lbd-trends-section">
      <h2 class="lbd-h3">LbD daily credits</h2>
      <p class="lbd-dim">${totals.lbdToday ?? 0} simulations used today across all users (${day}). Each user gets ${lbdCreditLimit} free per UTC day.</p>
      <h2 class="lbd-h3">Talk2Me token credits</h2>
      <p class="lbd-dim">Monthly token metering is not enabled yet. The user table shows — until <code>usage/YYYY-MM</code> docs are written by the relay.</p>
    </section>` : ''}

    ${activeTab === 'users' ? `<section class="lbd-panel lbd-trends-section">
      <h2 class="lbd-h3">Users</h2>
      <p class="lbd-dim">Signed in as ${esc(admin || '')}. Click a row for drill-down. Speaking column shows mode counts from recent sessions.</p>
      ${renderUserTable(users)}
      ${pagination.hasMore ? `<p class="lbd-foot"><button class="lbd-mini-btn" type="button" id="admin-more">Load more</button></p>` : ''}
    </section>` : ''}

    <div id="admin-detail"></div>`);

  bindOverviewEvents(data);
}

function bindOverviewEvents(data) {
  adminEl.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      renderOverview(data);
    });
  });

  adminEl.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else {
        sortKey = key;
        sortDir = key === 'email' || key === 'tier' ? 1 : -1;
      }
      renderOverview(data);
    });
  });

  const search = document.getElementById('admin-search');
  if (search) {
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadOverview({ q: search.value.trim() });
    });
  }

  document.getElementById('admin-export')?.addEventListener('click', () => exportCsv(data.users));
  document.getElementById('admin-more')?.addEventListener('click', () => {
    loadOverview({ offset: (data.pagination?.offset || 0) + (data.pagination?.limit || 25), append: true });
  });

  adminEl.querySelectorAll('.lbd-admin-row').forEach((row) => {
    row.addEventListener('click', () => loadUserDetail(row.dataset.uid));
  });
}

function exportCsv(users) {
  const header = ['email', 'name', 'tier', 'lbd_today', 't2m_sessions', 'lbd_sessions', 'speaking', 'last_active'];
  const rows = (users || []).map((u) => [
    u.email || '',
    u.name || '',
    u.tier || '',
    `${u.lbdToday}/${u.lbdCreditLimit ?? 5}`,
    u.t2mSessions,
    u.lbdSessions,
    speakingChips(u.modeCounts, u.lbdScenarios),
    fmtDate(u.updatedAt),
  ]);
  const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `talk2me-admin-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

function renderUserDetail(detail) {
  const el = document.getElementById('admin-detail');
  if (!el) return;

  const modeTotal = Object.values(detail.modeCounts || {}).reduce((n, v) => n + v, 0);
  const t2mRows = (detail.recentT2mSessions || [])
    .map(
      (s) => `<tr>
        <td>${fmtDate(s.startedAt)}</td>
        <td>Talk2Me</td>
        <td>${esc(MODE_LABELS[s.mode] || s.mode)}</td>
        <td>${s.messageCount} messages</td>
      </tr>`,
    )
    .join('');

  const lbdRows = (detail.recentLbdSessions || [])
    .map(
      (s, i) => `<tr class="lbd-admin-lbd-row" data-idx="${i}">
        <td>${fmtSessionDate(s.createdAt)}</td>
        <td>LbD</td>
        <td>${esc(scenarioDisplayName(s.scenarioId, s.scenarioTitle))}</td>
        <td>${s.exchangeCount || '?'} turns · ${esc(s.debrief?.outcome || s.debrief?.headline || '—')}</td>
      </tr>`,
    )
    .join('');

  const creditRows = (detail.lbdCreditHistory || [])
    .map((h) => `<li><span>${esc(h.day)}</span><strong>${h.used}/${h.limit}</strong></li>`)
    .join('');

  el.innerHTML = `
    <section class="lbd-panel lbd-trends-section lbd-admin-detail">
      <button class="lbd-back" type="button" id="admin-detail-close">← Back to users</button>
      <h2 class="lbd-h3">${esc(detail.email || detail.uid)}</h2>
      <p class="lbd-dim">${esc(detail.name || '')} · ${esc(detail.tier)} · ${detail.onboarded ? 'onboarded' : 'not onboarded'} · joined ${fmtDate(detail.createdAt)}</p>

      <div class="lbd-trends-grid">
        <section>
          <h3 class="lbd-h3">Speaking mix</h3>
          ${renderMixBar(detail.modeCounts, modeTotal)}
          <h3 class="lbd-h3">LbD scenarios</h3>
          ${renderScenarioMix(detail.lbdScenarios)}
        </section>
        <section>
          <h3 class="lbd-h3">Credits</h3>
          <p><strong>LbD today:</strong> ${detail.lbdCreditsToday?.used ?? 0}/${detail.lbdCreditsToday?.limit ?? 5}</p>
          <p><strong>Talk2Me tokens:</strong> ${
            detail.monthlyUsage
              ? `${detail.monthlyUsage.tokensUsed}${detail.monthlyUsage.capTokens ? ` / ${detail.monthlyUsage.capTokens}` : ''} (${detail.monthlyUsage.period})`
              : '— (not metered yet)'
          }</p>
          <h3 class="lbd-h3">LbD credit history (7d)</h3>
          <ul class="lbd-outcomes">${creditRows || '<li class="lbd-dim">—</li>'}</ul>
        </section>
      </div>

      <h3 class="lbd-h3">Recent speaking sessions</h3>
      <div class="lbd-admin-table-wrap">
        <table class="lbd-admin-table">
          <thead><tr><th>Date</th><th>Product</th><th>Type</th><th>Detail</th></tr></thead>
          <tbody>${t2mRows}${lbdRows || '<tr><td colspan="4" class="lbd-dim">No sessions yet</td></tr>'}</tbody>
        </table>
      </div>
      ${detail.coaches?.length ? `<p class="lbd-dim">${detail.coaches.length} custom coach(es) configured.</p>` : ''}
    </section>`;

  document.getElementById('admin-detail-close')?.addEventListener('click', () => {
    closeSessionPanel();
    el.innerHTML = '';
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const sessions = detail.recentLbdSessions || [];
  el.querySelectorAll('.lbd-admin-lbd-row').forEach((row) => {
    row.addEventListener('click', () => {
      const idx = Number(row.dataset.idx);
      openSessionPanel(sessions[idx], {
        hasPrev: idx > 0,
        hasNext: idx < sessions.length - 1,
        onPrev: () => openSessionPanel(sessions[idx - 1], { hasPrev: idx > 1, hasNext: true, onPrev: () => {}, onNext: () => {} }),
        onNext: () => openSessionPanel(sessions[idx + 1], { hasPrev: true, hasNext: idx < sessions.length - 2, onPrev: () => {}, onNext: () => {} }),
      });
    });
  });

  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadUserDetail(uid) {
  const token = await getCurrentIdToken(true);
  if (!token) return;
  try {
    const res = await fetch(`${apiBase()}/api/admin/users/${encodeURIComponent(uid)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    renderUserDetail(await res.json());
  } catch {
    /* ignore */
  }
}

async function loadOverview({ q = '', offset = 0, append = false } = {}) {
  if (!signedIn) {
    renderMessage('Sign in (top right) with an admin account to view the dashboard.');
    return;
  }
  if (!append) shell('<section class="lbd-panel lbd-trends-section"><p class="lbd-dim">Loading…</p></section>');
  try {
    const token = await getCurrentIdToken(true);
    if (!token) return renderMessage('Sign in with an admin account to view the dashboard.');
    const params = new URLSearchParams({ limit: '25', offset: String(offset) });
    if (q) params.set('q', q);
    const res = await fetch(`${apiBase()}/api/admin/overview?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) return renderMessage('This account is not on the admin allowlist.');
    if (res.status === 401) return renderMessage('Session expired — sign in again.');
    if (!res.ok) return renderMessage('Could not load the dashboard. Try again in a moment.');
    const data = await res.json();
    if (append && overviewData) {
      data.users = [...overviewData.users, ...data.users];
    }
    renderOverview(data);
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
import { renderDebriefHtml, scenarioDisplayName } from './lbd-frameworks.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtSessionDate(ts) {
  if (!ts) return '—';
  const d = ts._seconds ? new Date(ts._seconds * 1000) : ts.toMillis ? new Date(ts.toMillis()) : new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function renderSessionMeta(session) {
  const title = scenarioDisplayName(session.scenarioId, session.scenarioTitle);
  const mode = session.variant === 'coach' ? 'coach mode' : `${session.parties || 1}:${session.parties || 1}`;
  const outcome = session.debrief?.outcome ? ` · ${session.debrief.outcome}` : '';
  return `${title} · ${fmtSessionDate(session.createdAt)} · ${session.exchangeCount || '?'} turns · ${mode}${outcome}`;
}

let panelEl = null;
let backdropEl = null;

export function closeSessionPanel() {
  panelEl?.remove();
  backdropEl?.remove();
  panelEl = backdropEl = null;
  document.body.classList.remove('lbd-panel-open');
}

export function openSessionPanel(session, { onClose, onPrev, onNext, hasPrev = false, hasNext = false } = {}) {
  closeSessionPanel();
  const debriefHtml = session.debrief
    ? renderDebriefHtml(session.debrief)
    : '<p class="lbd-dim">No debrief saved for this session.</p>';

  backdropEl = document.createElement('div');
  backdropEl.className = 'lbd-panel-backdrop';
  backdropEl.addEventListener('click', () => {
    closeSessionPanel();
    onClose?.();
  });

  panelEl = document.createElement('aside');
  panelEl.className = 'lbd-session-panel';
  panelEl.setAttribute('role', 'dialog');
  panelEl.setAttribute('aria-label', 'Session debrief');
  panelEl.innerHTML = `
    <header class="lbd-session-panel-head">
      <button class="lbd-back" type="button" data-act="close">← Back</button>
      <h2 class="lbd-h3">Session debrief</h2>
      <p class="lbd-dim">${esc(renderSessionMeta(session))}</p>
    </header>
    <div class="lbd-session-panel-body">${debriefHtml || ''}</div>
    <footer class="lbd-session-panel-foot">
      <button class="lbd-mini-btn" type="button" data-act="prev" ${hasPrev ? '' : 'disabled'}>← Prev</button>
      <button class="lbd-mini-btn" type="button" data-act="next" ${hasNext ? '' : 'disabled'}>Next →</button>
    </footer>`;

  panelEl.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') {
      closeSessionPanel();
      onClose?.();
    }
    if (act === 'prev' && hasPrev) onPrev?.();
    if (act === 'next' && hasNext) onNext?.();
  });

  document.body.append(backdropEl, panelEl);
  document.body.classList.add('lbd-panel-open');
}
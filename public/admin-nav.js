import { getCurrentIdToken } from './firebase-client.js';
import { lbdApiBase } from './lbd-credits.js';

export async function maybeShowAdminLink(containerSelector = '.lbd-auth-actions, .auth-actions') {
  const containers = document.querySelectorAll(containerSelector);
  if (!containers.length) return;

  for (const container of containers) {
    if (container.querySelector('[data-admin-link]')) continue;
  }

  try {
    const token = await getCurrentIdToken();
    if (!token) return;
    const res = await fetch(`${lbdApiBase()}/api/admin/check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const { admin } = await res.json();
    if (!admin) return;

    for (const container of containers) {
      if (container.querySelector('[data-admin-link]')) continue;
      const anchor = document.createElement('a');
      anchor.className = container.classList.contains('auth-actions')
        ? 'secondary-action'
        : 'lbd-mini-btn lbd-nav-link';
      anchor.href = '/admin';
      anchor.dataset.adminLink = '1';
      anchor.textContent = 'Admin';
      const account = container.querySelector('#account-menu, .lbd-account');
      if (account) container.insertBefore(anchor, account);
      else container.appendChild(anchor);
    }
  } catch {
    /* not admin or offline */
  }
}
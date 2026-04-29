// Tiny API client. The auth token is per-user, issued by /auth/login or
// /auth/signup, and stored in localStorage. authedFetch reads it on every
// call; if there's no token (or the server returns 401), the UI bumps the
// user back to the AuthForm and clears the cache.

const BASE = (import.meta.env.VITE_EXTRACTOR_URL || '').replace(/\/$/, '');
const TOKEN_KEY = 'batchwise:authToken';

let cachedToken = null;
try { cachedToken = localStorage.getItem(TOKEN_KEY); } catch { /* ignore */ }

export function getAuthToken() {
  return cachedToken;
}

export function setAuthToken(token) {
  cachedToken = token || null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

export const apiEnabled = () => Boolean(cachedToken && BASE);
export const baseUrl = () => BASE;

async function authedFetch(path, opts = {}) {
  if (!BASE) throw new Error('Server URL is not configured');
  if (!cachedToken) throw new Error('Not signed in');
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cachedToken}`
    }
  });
  if (res.status === 401) {
    // Session expired or token invalidated server-side. Clear and surface.
    setAuthToken(null);
    const err = new Error('Session expired — please sign in again');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  enabled: apiEnabled,
  async list() {
    const json = await authedFetch('/batches');
    return Array.isArray(json.batches) ? json.batches : [];
  },
  async upsert(batch) {
    return authedFetch(`/batches/${encodeURIComponent(batch.id)}`, {
      method: 'PUT',
      body: JSON.stringify(batch)
    });
  },
  async remove(id) {
    return authedFetch(`/batches/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
};

export const expensesApi = {
  enabled: apiEnabled,
  async list() {
    const json = await authedFetch('/expenses');
    return Array.isArray(json.expenses) ? json.expenses : [];
  },
  async upsert(expense) {
    return authedFetch(`/expenses/${encodeURIComponent(expense.id)}`, {
      method: 'PUT',
      body: JSON.stringify(expense)
    });
  },
  async remove(id) {
    return authedFetch(`/expenses/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
};

export const auth = {
  async signup(email, password) {
    if (!BASE) throw new Error('Server URL is not configured');
    const res = await fetch(BASE + '/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setAuthToken(body.token);
    return body.user;
  },
  async login(email, password) {
    if (!BASE) throw new Error('Server URL is not configured');
    const res = await fetch(BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setAuthToken(body.token);
    return body.user;
  },
  async logout() {
    if (!cachedToken) return;
    try {
      await authedFetch('/auth/logout', { method: 'POST' });
    } catch (e) {
      // Even if the server rejects, drop local token so the UI doesn't get stuck.
      console.warn('logout call failed; clearing local token anyway', e);
    }
    setAuthToken(null);
  },
  async me() {
    return (await authedFetch('/auth/me')).user;
  },
  async deleteAccount() {
    await authedFetch('/auth/delete-account', { method: 'POST' });
    setAuthToken(null);
  }
};

export const dataApi = {
  async clearAll() {
    return authedFetch('/data/clear', { method: 'POST' });
  }
};

export async function extractMulti(images) {
  if (!BASE) throw new Error('VITE_EXTRACTOR_URL is not set');
  if (!cachedToken) throw new Error('Not signed in');
  const res = await fetch(BASE + '/extract-multi', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cachedToken}`
    },
    body: JSON.stringify({ images })
  });
  if (res.status === 401) {
    setAuthToken(null);
    const err = new Error('Session expired — please sign in again');
    err.status = 401;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `Extraction failed (HTTP ${res.status})`);
  }
  return {
    batches: Array.isArray(json.batches) ? json.batches : [],
    indexFound: !!json.indexFound,
    expectedCount: Number(json.expectedCount) || 0,
    summaryImageIndex: json.summaryImageIndex ?? null,
    unmatchedImages: Array.isArray(json.unmatchedImages) ? json.unmatchedImages : []
  };
}

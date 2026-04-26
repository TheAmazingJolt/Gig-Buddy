// Tiny API client for the batches sync endpoints. The frontend keeps localStorage
// as a synchronous primary cache; this module handles the durable Postgres-backed
// copy living on the Railway backend. Every call requires the Bearer token.

const TOKEN = import.meta.env.VITE_API_TOKEN;
const BASE = (import.meta.env.VITE_EXTRACTOR_URL || '').replace(/\/$/, '');

export const apiEnabled = () => Boolean(TOKEN && BASE);

async function authedFetch(path, opts = {}) {
  if (!apiEnabled()) throw new Error('API not configured');
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`
    }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
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

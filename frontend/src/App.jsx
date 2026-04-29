import React, { useState, useEffect, useMemo } from 'react';
import {
  Plus, Check, X, BarChart2, List, Home, Trash2,
  Loader2, TrendingUp, ArrowLeft, Sparkles, ClipboardPaste, Camera, Cloud, CloudOff,
  DollarSign, Settings as SettingsIcon, Download, Upload
} from 'lucide-react';
import { api, expensesApi, extractMulti, auth, getAuthToken, setAuthToken } from './api';
import { getImages, setImages, deleteImages } from './imageStore';

const EXTRACTOR_URL = import.meta.env.VITE_EXTRACTOR_URL;

function mergeBatchSets(local, remote) {
  const map = new Map();
  for (const b of [...local, ...remote]) {
    const stamp = b.updatedAt || b.loggedAt || 0;
    const existing = map.get(b.id);
    if (!existing || stamp > (existing.updatedAt || existing.loggedAt || 0)) {
      map.set(b.id, b);
    }
  }
  return Array.from(map.values()).sort((a, b) => batchTime(b) - batchTime(a));
}

function parseTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 0 ? v : null;
  // Instacart screen timestamps are ALWAYS wall-clock local time. The model
  // sometimes appends "Z" or a +offset to its ISO output, which JS Date.parse
  // would interpret as UTC and display 4-5 hours off in the user's local
  // zone. Strip any trailing timezone marker so the parse treats the value
  // as local wall-clock — matching the user's actual experience.
  const stripped = String(v).replace(/(?:[Zz]|[+-]\d{2}:?\d{2})$/, '');
  const ms = Date.parse(stripped);
  return Number.isNaN(ms) ? null : ms;
}

// One-time backfill for batches saved before the backend started deriving
// completedAt for shop_only and other no-final-leg batches.
// Returns [maybeUpdatedBatch, didChange].
function backfillBatch(b) {
  if (b.completedAt) return [b, false];
  if (!b.acceptedAt || !b.actualMinutes) return [b, false];
  const completedAt = b.acceptedAt + Math.round(b.actualMinutes * 60_000);
  return [{ ...b, completedAt }, true];
}

// Downscale + JPEG-encode a dataUrl so we can keep batch screenshots inline
// without bloating storage. Targets ~30-80KB per image at quality 0.7.
async function downscaleImage(dataUrl, maxW = 800, maxH = 1600, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

const STORAGE_KEY = 'batches';
const EXPENSES_STORAGE_KEY = 'expenses';

const EXPENSE_CATEGORIES = [
  { val: 'gas',         label: 'Gas',         color: 'shop-deliver',   mileageRelated: true },
  { val: 'maintenance', label: 'Maintenance', color: 'shop-only',      mileageRelated: true },
  { val: 'food',        label: 'Food',        color: 'delivery-only',  mileageRelated: false },
  { val: 'phone',       label: 'Phone',       color: 'mixed',          mileageRelated: false },
  { val: 'insurance',   label: 'Insurance',   color: null,             mileageRelated: true },
  { val: 'tolls',       label: 'Tolls',       color: null,             mileageRelated: true },
  { val: 'parking',     label: 'Parking',     color: null,             mileageRelated: true },
  { val: 'other',       label: 'Other',       color: null,             mileageRelated: false }
];
const CATEGORY_LABELS = Object.fromEntries(EXPENSE_CATEGORIES.map(c => [c.val, c.label]));
const CATEGORY_META = Object.fromEntries(EXPENSE_CATEGORIES.map(c => [c.val, c]));

const GAS_VENDORS = ['Shell', 'Chevron', 'BP', 'Wawa', 'Costco', 'Other'];

const expenseTime = (e) => e.occurredAt || e.loggedAt || 0;

const DEFAULT_STORES = [
  'Costco', 'Aldi', 'Sprouts', 'Publix', 'Wegmans', 'Kroger',
  'Safeway', "Trader Joe's", 'Whole Foods', "Sam's Club",
  "BJ's", 'Target', 'CVS', 'Petco', 'Other'
];

const DECLINE_REASONS = [
  { val: 'too_far_to_store',  label: 'Too far to store' },
  { val: 'delivery_too_far',  label: 'Delivery too far' },
  { val: 'pay_low',           label: 'Pay too low' },
  { val: 'too_many_items',    label: 'Too many items' },
  { val: 'bad_time',          label: 'Bad time' },
  { val: 'cherry_pick',       label: 'Cherry-pick' },
  { val: 'other',             label: 'Other' }
];
const DECLINE_REASON_LABELS = {
  ...Object.fromEntries(DECLINE_REASONS.map(r => [r.val, r.label])),
  too_far: 'Too far' // legacy single-bucket reason from earlier batches
};
// Normalize a batch's declineReason field to an array. Old batches stored a single
// string; new batches store an array; either reads cleanly here.
const reasonList = (b) => {
  const r = b.declineReason;
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
};

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

const fmt$ = (n) => n == null || isNaN(n) ? '—' : `$${n.toFixed(2)}`;
const fmt$$ = (n) => n == null || isNaN(n) ? '—' : `$${n.toFixed(0)}`;
const fmtRate = (n) => n == null || isNaN(n) ? '—' : `$${n.toFixed(2)}`;

const wallClockMinutes = (b) => {
  if (b.acceptedAt && b.completedAt) return (b.completedAt - b.acceptedAt) / 60000;
  return null;
};
const bestMinutes = (b) => b.actualMinutes ?? wallClockMinutes(b) ?? b.estMinutes ?? null;
const dollarsPerHour = (b) => {
  const mins = bestMinutes(b);
  if (!b.pay || !mins) return null;
  return b.pay / (mins / 60);
};
const dollarsPerMile = (b) => {
  if (!b.pay || !b.miles) return null;
  return b.pay / b.miles;
};
const isReconciled = (b) => b.actualPay != null;
const payDelta = (b) => isReconciled(b) ? b.actualPay - b.pay : null;
const actualPerHour = (b) => {
  const mins = b.actualMinutes ?? wallClockMinutes(b) ?? b.estMinutes;
  if (!b.actualPay || !mins) return null;
  return b.actualPay / (mins / 60);
};
// When a batch happened in the world, falling back to logged time when we don't know.
// Preference: the IC-recorded acceptance time > the screenshot's iOS capture time
// > when the user pressed save. Most relevant for declined batches that have no
// acceptedAt but were captured via screenshot — the iOS capture time is ~when
// the offer came in, much closer to truth than the bulk-upload moment.
const batchTime = (b) => b.acceptedAt || b.screenshotTakenAt || b.loggedAt || 0;

const dayName = (ts) => new Date(ts).toLocaleDateString('en-US', { weekday: 'short' });
const hourOf = (ts) => new Date(ts).getHours();
const fmtDate = (ts) => {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const fmtTime = (ts) => {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

// ──────────────────────────────────────────────────────────
// Storage
// ──────────────────────────────────────────────────────────

// Batch metadata lives in localStorage (small, sync read = instant first paint).
// Image arrays live in IndexedDB (much bigger quota, plenty of room for hundreds
// of batches). loadBatches re-joins them; saveBatches splits them.
async function loadBatches() {
  let parsed = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const candidate = JSON.parse(raw);
      if (Array.isArray(candidate)) parsed = candidate;
    }
  } catch (e) { /* corrupt or unavailable — ignore, return [] below */ }

  // Hydrate images from IDB. Legacy batches saved before this split keep their
  // inline images intact and will get migrated on the next saveBatches.
  try {
    return await Promise.all(parsed.map(async b => {
      if (Array.isArray(b.images) && b.images.length) return b;
      const images = await getImages(b.id);
      return images ? { ...b, images } : b;
    }));
  } catch (e) {
    return parsed;
  }
}

// Split storage: metadata to localStorage (without images), images to IDB by id.
// Migrates legacy data on first save: any batch with embedded images here gets
// its images moved to IDB and the field stripped from the localStorage payload.
async function saveBatches(batches) {
  const slim = batches.map(b => {
    if (!('images' in b)) return b;
    const { images: _drop, ...rest } = b;
    return rest;
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch (e) {
    console.error('saveBatches metadata write failed', e);
  }
  // Best-effort image persistence. Failures are logged but don't block
  // the metadata save — images can be re-hydrated from the server.
  await Promise.all(batches.map(async b => {
    if (Array.isArray(b.images) && b.images.length) {
      await setImages(b.id, b.images);
    }
  }));
}

// Same split-storage pattern as batches: metadata to localStorage, the
// receipt image to IDB by expense id (single-element array).
async function loadExpenses() {
  let parsed = [];
  try {
    const raw = localStorage.getItem(EXPENSES_STORAGE_KEY);
    if (raw) {
      const candidate = JSON.parse(raw);
      if (Array.isArray(candidate)) parsed = candidate;
    }
  } catch (e) { /* ignore */ }

  try {
    return await Promise.all(parsed.map(async e => {
      if (e.receiptImage) return e;
      const stored = await getImages(e.id);
      return Array.isArray(stored) && stored[0] ? { ...e, receiptImage: stored[0] } : e;
    }));
  } catch (err) {
    return parsed;
  }
}

async function saveExpenses(expenses) {
  const slim = expenses.map(e => {
    if (!('receiptImage' in e)) return e;
    const { receiptImage: _drop, ...rest } = e;
    return rest;
  });
  try {
    localStorage.setItem(EXPENSES_STORAGE_KEY, JSON.stringify(slim));
  } catch (err) {
    console.error('saveExpenses metadata write failed', err);
  }
  await Promise.all(expenses.map(async e => {
    if (e.receiptImage) {
      await setImages(e.id, [e.receiptImage]);
    }
  }));
}

// ──────────────────────────────────────────────────────────
// Export / Import — single self-contained JSON file
// ──────────────────────────────────────────────────────────

const EXPORT_FORMAT = 'batchwise-export';
const EXPORT_VERSION = 1;

// Pulls everything (metadata + IDB-stored images) into one inline blob so a
// re-import on a fresh browser/device fully reconstructs the user's state.
async function buildExport(batches, expenses) {
  const hydratedBatches = await Promise.all(batches.map(async b => {
    const images = Array.isArray(b.images) && b.images.length
      ? b.images
      : (await getImages(b.id) || null);
    return images && images.length ? { ...b, images } : { ...b, images: null };
  }));
  const hydratedExpenses = await Promise.all(expenses.map(async e => {
    if (e.receiptImage) return e;
    const stored = await getImages(e.id);
    return Array.isArray(stored) && stored[0]
      ? { ...e, receiptImage: stored[0] }
      : { ...e, receiptImage: null };
  }));
  let netMode = 'actual';
  try { netMode = localStorage.getItem(NET_MODE_KEY) || 'actual'; } catch { /* ignore */ }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    exportedBy: null,
    batches: hydratedBatches,
    expenses: hydratedExpenses,
    settings: { netMode }
  };
}

// Returns { addedBatches, updatedBatches, addedExpenses, updatedExpenses,
// nextBatches, nextExpenses } for the caller to surface counts and write back.
// Merge rule: union by id; on conflict the side with the newer updatedAt wins.
async function applyImport(json, currentBatches, currentExpenses) {
  if (!json || typeof json !== 'object') throw new Error('Not a valid export file');
  if (json.format !== EXPORT_FORMAT) throw new Error('Unrecognized export format');
  if (typeof json.version !== 'number') throw new Error('Missing export version');
  const importedBatches = Array.isArray(json.batches) ? json.batches : [];
  const importedExpenses = Array.isArray(json.expenses) ? json.expenses : [];

  const mergeById = (current, imported) => {
    const map = new Map();
    let added = 0;
    let updated = 0;
    for (const item of current) map.set(item.id, item);
    for (const item of imported) {
      if (!item || !item.id) continue;
      const existing = map.get(item.id);
      if (!existing) {
        map.set(item.id, item);
        added++;
      } else {
        const a = item.updatedAt || item.loggedAt || 0;
        const b = existing.updatedAt || existing.loggedAt || 0;
        if (a >= b) {
          map.set(item.id, item);
          updated++;
        }
      }
    }
    return { merged: Array.from(map.values()), added, updated };
  };

  const bResult = mergeById(currentBatches, importedBatches);
  const eResult = mergeById(currentExpenses, importedExpenses);

  // Push images back into IDB so the rest of the app finds them on the
  // existing per-id key. Both metadata-with-images-stripped (saved by
  // saveBatches/saveExpenses) and image-rich import payloads stay consistent.
  await Promise.all(bResult.merged.map(async b => {
    if (Array.isArray(b.images) && b.images.length) await setImages(b.id, b.images);
  }));
  await Promise.all(eResult.merged.map(async e => {
    if (e.receiptImage) await setImages(e.id, [e.receiptImage]);
  }));

  if (json.settings && typeof json.settings === 'object') {
    if (json.settings.netMode === 'irs' || json.settings.netMode === 'actual') {
      try { localStorage.setItem(NET_MODE_KEY, json.settings.netMode); } catch { /* ignore */ }
    }
  }

  return {
    addedBatches: bResult.added,
    updatedBatches: bResult.updated,
    addedExpenses: eResult.added,
    updatedExpenses: eResult.updated,
    nextBatches: bResult.merged,
    nextExpenses: eResult.merged
  };
}

// ──────────────────────────────────────────────────────────
// Paste parser — accepts JSON or key=value pairs
// ──────────────────────────────────────────────────────────

function parsePaste(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Try JSON first
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const lower = {};
      for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
      return lower;
    }
  } catch {}

  // Fallback: key=value or key:value, whitespace/comma separated
  // Values may be quoted to allow spaces ("Trader Joe's")
  const result = {};
  const re = /(\w+)\s*[=:]\s*("[^"]*"|'[^']*'|[^,\s]+)/g;
  let m;
  while ((m = re.exec(trimmed)) !== null) {
    const key = m[1].toLowerCase();
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return Object.keys(result).length ? result : null;
}

// ──────────────────────────────────────────────────────────
// Theme
// ──────────────────────────────────────────────────────────

const Theme = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');

    :root {
      /* Surfaces */
      --bg: #f4f6f8;
      --surface: #ffffff;
      --surface-2: #f8fafc;

      /* Ink */
      --ink: #0f172a;
      --ink-soft: #334155;
      --muted: #64748b;
      --muted-soft: #94a3b8;

      /* Brand */
      --accent: #b8401f;
      --accent-soft: #fde2c4;

      /* Status */
      --green: #10b981;
      --green-soft: #d1fae5;
      --red: #ef4444;
      --red-soft: #fee2e2;

      /* Lines */
      --border: #e2e8f0;
      --border-soft: #f1f5f9;

      /* Elevation */
      --shadow-card: 0 1px 3px rgba(15,23,42,0.04), 0 1px 2px rgba(15,23,42,0.06);
      --shadow-card-strong: 0 4px 16px rgba(15,23,42,0.06), 0 1px 3px rgba(15,23,42,0.05);
      --shadow-fab: 0 6px 20px rgba(184,64,31,0.32);

      /* Type colors — for BatchRow left borders + tinted pills */
      --type-shop-deliver: #b8401f;
      --type-shop-deliver-soft: #fde2c4;
      --type-shop-only: #3b82f6;
      --type-shop-only-soft: #dbeafe;
      --type-delivery-only: #8b5cf6;
      --type-delivery-only-soft: #ede9fe;
      --type-mixed: #f59e0b;
      --type-mixed-soft: #fef3c7;
    }

    * { -webkit-tap-highlight-color: transparent; }
    body { margin: 0; }

    .app {
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100vh;
      padding-bottom: calc(env(safe-area-inset-bottom, 0) + 110px);
      -webkit-font-smoothing: antialiased;
    }

    .display {
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .mono {
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
    }
    .uppercase-label {
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 600;
    }

    .card {
      background: var(--surface);
      border: 1px solid transparent;
      border-radius: 16px;
      box-shadow: var(--shadow-card);
    }
    .card-strong {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: var(--shadow-card);
    }
    .card-ink {
      background: var(--ink);
      color: var(--surface);
      border-radius: 16px;
      box-shadow: var(--shadow-card-strong);
    }

    .chip {
      display: inline-flex;
      align-items: center;
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--ink-soft);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.12s;
    }
    .chip-active {
      background: var(--ink);
      color: var(--surface);
      border-color: var(--ink);
    }
    .chip:active { transform: scale(0.96); }

    .btn-primary {
      background: var(--ink);
      color: var(--surface);
      border: none;
      padding: 14px 22px;
      border-radius: 999px;
      font-size: 15px;
      font-weight: 700;
      width: 100%;
      cursor: pointer;
      font-family: inherit;
      transition: transform 0.1s ease;
    }
    .btn-primary:active { transform: scale(0.98); }
    .btn-primary:disabled { opacity: 0.4; }

    .btn-ghost {
      background: var(--surface);
      color: var(--ink-soft);
      border: 1px solid var(--border);
      padding: 12px 20px;
      border-radius: 999px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: transform 0.1s ease;
    }
    .btn-ghost:active { transform: scale(0.98); }

    .btn-accept {
      background: var(--green);
      color: #ffffff;
      border: none;
      padding: 16px 22px;
      border-radius: 999px;
      font-size: 16px;
      font-weight: 700;
      flex: 1;
      cursor: pointer;
      font-family: inherit;
      transition: transform 0.1s ease;
    }
    .btn-accept:active { transform: scale(0.98); }
    .btn-decline {
      background: var(--surface);
      color: var(--red);
      border: 1px solid var(--red);
      padding: 16px 22px;
      border-radius: 999px;
      font-size: 16px;
      font-weight: 700;
      flex: 1;
      cursor: pointer;
      font-family: inherit;
      transition: transform 0.1s ease;
    }
    .btn-decline:active { transform: scale(0.98); }

    .input {
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 14px;
      font-size: 16px;
      color: var(--ink);
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      box-sizing: border-box;
      -webkit-appearance: none;
    }
    .input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

    .nav {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: var(--surface);
      box-shadow: 0 -1px 0 var(--border);
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      padding: 8px 0 calc(env(safe-area-inset-bottom, 0) + 8px);
      z-index: 30;
    }
    .nav-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 10px;
      color: var(--muted);
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
    }
    .nav-item-active { color: var(--accent); }

    .fab {
      position: fixed;
      bottom: calc(env(safe-area-inset-bottom, 0) + 88px);
      right: 20px;
      width: 60px;
      height: 60px;
      border-radius: 30px;
      background: var(--accent);
      color: white;
      border: none;
      box-shadow: var(--shadow-fab);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 20;
      transition: transform 0.1s ease;
    }
    .fab:active { transform: scale(0.94); }

    .pill {
      display: inline-flex;
      align-items: center;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .pill-accept { background: var(--green-soft); color: var(--green); }
    .pill-decline { background: var(--red-soft); color: var(--red); }

    .pill-type-shop-deliver { background: var(--type-shop-deliver-soft); color: var(--type-shop-deliver); }
    .pill-type-shop-only    { background: var(--type-shop-only-soft);    color: var(--type-shop-only); }
    .pill-type-delivery-only{ background: var(--type-delivery-only-soft);color: var(--type-delivery-only); }
    .pill-type-mixed        { background: var(--type-mixed-soft);        color: var(--type-mixed); }

    .bar {
      height: 8px;
      background: var(--border-soft);
      border-radius: 4px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      background: var(--accent);
    }

    .divider {
      height: 1px;
      background: var(--border-soft);
    }

    .modal-bg {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.5);
      z-index: 50;
    }
    .modal {
      position: fixed;
      inset: 0;
      background: var(--bg);
      z-index: 51;
      overflow-y: auto;
      animation: slideUp 0.25s ease-out;
    }
    @keyframes slideUp {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .fade-in { animation: fadeIn 0.3s ease-out; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .animate-spin { animation: spin 1s linear infinite; }
  `}</style>
);

// ──────────────────────────────────────────────────────────
// Components
// ──────────────────────────────────────────────────────────

function SyncIndicator({ status }) {
  if (status === 'synced') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)' }}>
      <Cloud size={12} /> Synced
    </span>
  );
  if (status === 'syncing') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)' }}>
      <Loader2 size={12} className="animate-spin" /> Syncing
    </span>
  );
  if (status === 'error') return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--red)' }}>
      <CloudOff size={12} /> Offline
    </span>
  );
  // local-only: API not configured
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)' }}>
      <CloudOff size={12} /> Local only
    </span>
  );
}

function Header({ batches, expenses, syncStatus, onOpenSettings }) {
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const todayBatches = batches.filter(b => batchTime(b) >= startOfDay);
  const todayAccepted = todayBatches.filter(b => b.accepted);
  const todayPay = todayAccepted.reduce((s, b) => s + (b.pay || 0), 0);
  const todayMiles = todayAccepted.reduce((s, b) => s + (b.miles || 0), 0);
  const todayExpenses = (expenses || [])
    .filter(e => expenseTime(e) >= startOfDay)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const todayNet = todayPay - todayExpenses;

  return (
    <div className="px-5 pt-8 pb-4">
      <div className="flex items-center justify-between">
        <div className="uppercase-label">{todayStr}</div>
        <div className="flex items-center" style={{ gap: 12 }}>
          <SyncIndicator status={syncStatus} />
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              aria-label="Settings"
              style={{ background: 'none', border: 'none', padding: 4, color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
            >
              <SettingsIcon size={18} />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-baseline gap-3 mt-1 flex-wrap">
        <span className="display" style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>
          {fmt$$(todayPay)}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 14 }}>
          today · {todayAccepted.length} accepted · {todayBatches.length - todayAccepted.length} declined
          {todayMiles > 0 && <> · {todayMiles.toFixed(1)}mi</>}
        </span>
      </div>
      {todayExpenses > 0 && (
        <div className="mono mt-2" style={{ fontSize: 12, color: 'var(--muted)' }}>
          − {fmt$(todayExpenses)} expenses · <span style={{ color: 'var(--ink-soft)', fontWeight: 600 }}>net {fmt$(todayNet)}</span>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub }) {
  return (
    <div className="card p-4">
      <div className="uppercase-label">{label}</div>
      <div className="display mt-1" style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// IRS standard mileage rate for self-employed (2026). Used as an alternative
// to summing actual gas/maintenance/insurance/tolls/parking expenses — many
// shoppers prefer this for taxes, and it captures depreciation that "actual
// gas only" tracking misses.
const IRS_MILEAGE_RATE = 0.67;
const NET_MODE_KEY = 'batchwise:netMode';

// YYYY-MM-DD in the user's local timezone, used as a stable bucket key for
// grouping batches and expenses by calendar day.
function ymdLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayBoundsFromYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  return { start, end };
}

function shiftYmd(ymd, dayDelta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const next = new Date(y, m - 1, d + dayDelta);
  return ymdLocal(next.getTime());
}

function summarizeDay(batches, expenses, netMode = 'actual') {
  const accepted = batches.filter(b => b.accepted);
  const declined = batches.filter(b => !b.accepted);
  const totalPay = accepted.reduce((s, b) => s + (b.pay || 0), 0);
  const totalMin = accepted.reduce((s, b) => s + (bestMinutes(b) || 0), 0);
  const totalMiles = accepted.reduce((s, b) => s + (b.miles || 0), 0);
  const allExp = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const nonMileageExp = expenses.filter(e => !e.mileageRelated).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const irsCost = totalMiles * IRS_MILEAGE_RATE;
  const cost = netMode === 'irs' ? nonMileageExp + irsCost : allExp;
  const net = totalPay - cost;
  return {
    accepted: accepted.length,
    declined: declined.length,
    totalPay,
    totalMin,
    totalMiles,
    allExp,
    irsCost,
    cost,
    net,
    perHour: totalMin ? totalPay / (totalMin / 60) : null,
    netPerHour: totalMin ? net / (totalMin / 60) : null
  };
}

function DayDetailModal({ ymd, batches, expenses, netMode, onClose, onReconcile, onViewImages, onEditExpense, onDeleteExpense }) {
  const [activeYmd, setActiveYmd] = useState(ymd);

  const { dayBatches, dayExpenses, summary, dateLabel } = useMemo(() => {
    const { start, end } = dayBoundsFromYmd(activeYmd);
    const dayBatches = batches
      .filter(b => batchTime(b) >= start && batchTime(b) <= end)
      .sort((a, b) => batchTime(a) - batchTime(b));
    const dayExpenses = expenses
      .filter(e => expenseTime(e) >= start && expenseTime(e) <= end)
      .sort((a, b) => expenseTime(a) - expenseTime(b));
    const summary = summarizeDay(dayBatches, dayExpenses, netMode);
    const [y, m, d] = activeYmd.split('-').map(Number);
    const dateLabel = new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    return { dayBatches, dayExpenses, summary, dateLabel };
  }, [activeYmd, batches, expenses, netMode]);

  const isFuture = (() => {
    const tomorrow = shiftYmd(ymdLocal(Date.now()), 0);
    return activeYmd >= tomorrow;
  })();

  return (
    <div className="modal">
      <div className="px-5 pt-6 pb-4 flex items-center justify-between" style={{ background: 'var(--bg)' }}>
        <button onClick={onClose} className="btn-ghost" style={{ padding: '8px 14px', fontSize: 14 }}>
          <ArrowLeft size={16} style={{ display: 'inline', marginRight: 4 }} /> Close
        </button>
        <div className="display" style={{ fontSize: 18, fontWeight: 700, textAlign: 'center', flex: 1 }}>
          {dateLabel}
        </div>
        <div style={{ width: 80 }} />
      </div>

      <div className="px-5">
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setActiveYmd(shiftYmd(activeYmd, -1))}
            className="btn-ghost"
            style={{ flex: 1, padding: '10px', fontSize: 13 }}
          >
            ← Previous day
          </button>
          <button
            onClick={() => setActiveYmd(shiftYmd(activeYmd, 1))}
            className="btn-ghost"
            style={{ flex: 1, padding: '10px', fontSize: 13, opacity: isFuture ? 0.4 : 1 }}
            disabled={isFuture}
          >
            Next day →
          </button>
        </div>

        <div className="card-ink p-5 mb-4">
          <div className="flex items-baseline justify-between">
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Earned
              </div>
              <div className="display" style={{ fontSize: 36, fontWeight: 600, lineHeight: 1 }}>
                {fmt$$(summary.totalPay)}
              </div>
              {summary.cost > 0 && (
                <div className="mono mt-1" style={{ fontSize: 12, color: 'var(--muted-soft)' }}>
                  − {fmt$(summary.cost)} {netMode === 'irs' ? 'cost (IRS)' : 'expenses'}
                </div>
              )}
            </div>
            <div className="text-right">
              <div style={{ color: 'var(--muted-soft)', fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Batches
              </div>
              <div className="mono" style={{ fontSize: 28, fontWeight: 500 }}>
                {summary.accepted}<span style={{ color: 'var(--muted-soft)' }}>/{summary.accepted + summary.declined}</span>
              </div>
            </div>
          </div>
          {summary.cost > 0 && (
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <div className="flex items-baseline justify-between">
                <span style={{ color: 'var(--muted-soft)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Net</span>
                <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                  {fmt$(summary.net)}
                  {summary.netPerHour != null && (
                    <span style={{ color: 'var(--muted-soft)', fontWeight: 400, marginLeft: 8 }}>
                      · {fmtRate(summary.netPerHour)}/hr
                    </span>
                  )}
                </span>
              </div>
            </div>
          )}
          <div className="divider my-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                $/hr
              </div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
                {fmtRate(summary.perHour)}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Miles
              </div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
                {summary.totalMiles ? summary.totalMiles.toFixed(1) : '—'}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Active
              </div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
                {summary.totalMin ? `${(summary.totalMin / 60).toFixed(1)}h` : '—'}
              </div>
            </div>
          </div>
        </div>

        {dayBatches.length > 0 && (
          <>
            <div className="uppercase-label mb-2">Batches</div>
            <div className="space-y-2 mb-6">
              {dayBatches.map(b => (
                <BatchRow
                  key={b.id}
                  batch={b}
                  onReconcile={onReconcile}
                  onViewImages={onViewImages}
                />
              ))}
            </div>
          </>
        )}

        {dayExpenses.length > 0 && (
          <>
            <div className="uppercase-label mb-2">Expenses</div>
            <div className="space-y-2 mb-8">
              {dayExpenses.map(e => (
                <ExpenseRow
                  key={e.id}
                  expense={e}
                  onEdit={onEditExpense}
                  onDelete={onDeleteExpense}
                  onViewImage={(images) => onViewImages?.({ images })}
                />
              ))}
            </div>
          </>
        )}

        {dayBatches.length === 0 && dayExpenses.length === 0 && (
          <div className="card p-8 text-center mb-8" style={{ color: 'var(--muted)' }}>
            No activity logged for this day
          </div>
        )}
      </div>
    </div>
  );
}

function DaysList({ batches, expenses, netMode, limit = 14, onPickDay }) {
  const days = useMemo(() => {
    const map = new Map();
    for (const b of batches) {
      const k = ymdLocal(batchTime(b));
      if (!map.has(k)) map.set(k, { ymd: k, batches: [], expenses: [] });
      map.get(k).batches.push(b);
    }
    for (const e of expenses) {
      const k = ymdLocal(expenseTime(e));
      if (!map.has(k)) map.set(k, { ymd: k, batches: [], expenses: [] });
      map.get(k).expenses.push(e);
    }
    return Array.from(map.values())
      .map(d => ({ ...d, summary: summarizeDay(d.batches, d.expenses, netMode) }))
      .sort((a, b) => b.ymd.localeCompare(a.ymd))
      .slice(0, limit);
  }, [batches, expenses, netMode, limit]);

  if (days.length === 0) return null;

  return (
    <div className="mb-6">
      <div className="uppercase-label mb-2">Days</div>
      <div className="space-y-2">
        {days.map(d => {
          const [y, m, dd] = d.ymd.split('-').map(Number);
          const dt = new Date(y, m - 1, dd);
          const label = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
          const hasNet = d.summary.cost > 0;
          return (
            <button
              key={d.ymd}
              onClick={() => onPickDay(d.ymd)}
              className="card p-3"
              style={{ width: '100%', display: 'block', textAlign: 'left', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              <div className="flex items-baseline justify-between">
                <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
                <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
                  {fmt$(d.summary.totalPay)}
                  {hasNet && (
                    <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>
                      → {fmt$(d.summary.net)}
                    </span>
                  )}
                </span>
              </div>
              <div className="mono mt-1" style={{ fontSize: 11, color: 'var(--muted)' }}>
                {d.summary.accepted} accepted
                {d.summary.declined > 0 && ` · ${d.summary.declined} declined`}
                {d.summary.totalMin > 0 && ` · ${(d.summary.totalMin / 60).toFixed(1)}h`}
                {d.summary.totalMiles > 0 && ` · ${d.summary.totalMiles.toFixed(1)}mi`}
                {d.expenses.length > 0 && ` · ${d.expenses.length} expense${d.expenses.length === 1 ? '' : 's'}`}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Dashboard({ batches, expenses, onLog, onReconcile, onViewImages, onPickDay, onOpenSettings, syncStatus }) {
  const [rangeFilter, setRangeFilter] = useState('week'); // 'day' | 'week' | 'month' | 'year'
  const [netMode, setNetMode] = useState(() => {
    try { return localStorage.getItem(NET_MODE_KEY) || 'actual'; }
    catch { return 'actual'; }
  });
  useEffect(() => {
    try { localStorage.setItem(NET_MODE_KEY, netMode); } catch { /* ignore */ }
  }, [netMode]);
  const RANGES = [
    { val: 'day',   label: 'Day',   days: 1 },
    { val: 'week',  label: 'Week',  days: 7 },
    { val: 'month', label: 'Month', days: 30 },
    { val: 'year',  label: 'Year',  days: 365 }
  ];
  const rangeDays = (RANGES.find(r => r.val === rangeFilter) || RANGES[1]).days;

  const stats = useMemo(() => {
    // Day uses calendar boundary (today since midnight) to match the daily header;
    // Week / Month / Year use rolling lookbacks ("how am I doing lately").
    const since = rangeFilter === 'day'
      ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      : Date.now() - rangeDays * 24 * 60 * 60 * 1000;
    const inRange = batches.filter(b => batchTime(b) >= since);
    const accepted = inRange.filter(b => b.accepted);
    const totalPay = accepted.reduce((s, b) => s + (b.pay || 0), 0);
    const totalMin = accepted.reduce((s, b) => s + (bestMinutes(b) || 0), 0);
    const totalMiles = accepted.reduce((s, b) => s + (b.miles || 0), 0);
    const inRangeExpenses = (expenses || []).filter(e => expenseTime(e) >= since);

    // Two ways to compute net:
    //   actual: gross - sum of every logged expense (gas, maintenance, food, ...)
    //   irs:    gross - non-mileage expenses - (totalMiles × IRS standard rate)
    // The IRS path swaps out vehicle-related expenses for the standard $0.67/mi
    // rate, which most shoppers use for taxes since it captures depreciation.
    const allExpensesTotal = inRangeExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const nonMileageExpensesTotal = inRangeExpenses
      .filter(e => !e.mileageRelated)
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const irsCost = totalMiles * IRS_MILEAGE_RATE;
    const totalCost = netMode === 'irs'
      ? nonMileageExpensesTotal + irsCost
      : allExpensesTotal;
    const net = totalPay - totalCost;

    return {
      acceptRate: inRange.length ? (accepted.length / inRange.length) * 100 : null,
      perHour: totalMin ? totalPay / (totalMin / 60) : null,
      netPerHour: totalMin ? net / (totalMin / 60) : null,
      perMile: totalMiles ? totalPay / totalMiles : null,
      totalPay,
      totalExpenses: totalCost,
      allExpensesTotal,
      irsCost,
      net,
      totalMiles,
      count: accepted.length,
      offered: inRange.length
    };
  }, [batches, expenses, rangeFilter, rangeDays, netMode]);

  const recent = batches.slice(0, 5);

  return (
    <div>
      <Header batches={batches} expenses={expenses} syncStatus={syncStatus} onOpenSettings={onOpenSettings} />

      <div className="px-5">
        <div className="flex items-baseline justify-between mb-2">
          <div className="flex gap-2">
            {RANGES.map(r => (
              <button
                key={r.val}
                onClick={() => setRangeFilter(r.val)}
                className={`chip ${rangeFilter === r.val ? 'chip-active' : ''}`}
                style={{ padding: '6px 14px', fontSize: 13 }}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="uppercase-label">{rangeFilter === 'day' ? 'Today' : `Last ${rangeDays} days`}</div>
        </div>
        <div className="card-ink p-5 mb-4">
          <div className="flex items-baseline justify-between">
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Earned
              </div>
              <div className="display" style={{ fontSize: 40, fontWeight: 600, lineHeight: 1 }}>
                {fmt$$(stats.totalPay)}
              </div>
              {stats.totalExpenses > 0 && (
                <div className="mono mt-1" style={{ fontSize: 12, color: 'var(--muted-soft)' }}>
                  − {fmt$(stats.totalExpenses)} {netMode === 'irs' ? 'cost (IRS)' : 'expenses'}
                </div>
              )}
            </div>
            <div className="text-right">
              <div style={{ color: 'var(--muted-soft)', fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Batches
              </div>
              <div className="mono" style={{ fontSize: 28, fontWeight: 500 }}>
                {stats.count}<span style={{ color: 'var(--muted-soft)' }}>/{stats.offered}</span>
              </div>
            </div>
          </div>
          {stats.totalExpenses > 0 && (
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <div className="flex items-baseline justify-between mb-2">
                <span style={{ color: 'var(--muted-soft)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Net</span>
                <span className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                  {fmt$(stats.net)}
                  {stats.netPerHour != null && (
                    <span style={{ color: 'var(--muted-soft)', fontWeight: 400, marginLeft: 8 }}>
                      · {fmtRate(stats.netPerHour)}/hr
                    </span>
                  )}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setNetMode('actual')}
                  className={`chip ${netMode === 'actual' ? 'chip-active' : ''}`}
                  style={{ flex: 1, justifyContent: 'center', padding: '6px 12px', fontSize: 11, background: netMode === 'actual' ? 'var(--surface)' : 'transparent', color: netMode === 'actual' ? 'var(--ink)' : 'var(--muted-soft)', borderColor: 'rgba(255,255,255,0.2)' }}
                >
                  Actual
                </button>
                <button
                  type="button"
                  onClick={() => setNetMode('irs')}
                  className={`chip ${netMode === 'irs' ? 'chip-active' : ''}`}
                  style={{ flex: 1, justifyContent: 'center', padding: '6px 12px', fontSize: 11, background: netMode === 'irs' ? 'var(--surface)' : 'transparent', color: netMode === 'irs' ? 'var(--ink)' : 'var(--muted-soft)', borderColor: 'rgba(255,255,255,0.2)' }}
                >
                  IRS rate
                </button>
              </div>
              <div className="mono mt-2" style={{ fontSize: 10, color: 'var(--muted-soft)' }}>
                {netMode === 'irs'
                  ? `${stats.totalMiles.toFixed(1)}mi × $${IRS_MILEAGE_RATE.toFixed(2)} = ${fmt$(stats.irsCost)} (replaces gas/maint/insurance/tolls/parking)`
                  : 'Subtracts every logged expense'}
              </div>
            </div>
          )}
          <div className="divider my-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
          <div className="grid grid-cols-4 gap-2">
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                $/hr
              </div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 2 }}>
                {fmtRate(stats.perHour)}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                $/mi
              </div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 2 }}>
                {fmtRate(stats.perMile)}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Miles
              </div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 2 }}>
                {stats.totalMiles ? stats.totalMiles.toFixed(1) : '—'}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Accept
              </div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 2 }}>
                {stats.acceptRate != null ? `${stats.acceptRate.toFixed(0)}%` : '—'}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-baseline justify-between mb-2">
          <div className="uppercase-label">Recent</div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>{batches.length} total</div>
        </div>
        {recent.length === 0 ? (
          <div className="card p-8 text-center">
            <Sparkles size={28} style={{ color: 'var(--muted)', margin: '0 auto 12px' }} />
            <div style={{ fontSize: 15, fontWeight: 500 }}>No batches yet</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              Tap the + button to log your first one
            </div>
          </div>
        ) : (
          <div className="space-y-2 mb-6">
            {recent.map(b => <BatchRow key={b.id} batch={b} onReconcile={onReconcile} onViewImages={onViewImages} />)}
          </div>
        )}

        <DaysList
          batches={batches}
          expenses={expenses}
          netMode={netMode}
          onPickDay={onPickDay}
        />
      </div>
    </div>
  );
}

function BatchRow({ batch, onDelete, onReconcile, onViewImages }) {
  const typeLabel = {
    shop_deliver: 'Shop & deliver',
    shop_only: 'Shop only',
    delivery_only: 'Delivery only',
    mixed: 'Mixed'
  }[batch.type] || null;
  const typeKey = (batch.type || 'shop_deliver').replace(/_/g, '-');
  const typeColor = `var(--type-${typeKey})`;
  const milesLabel = batch.type === 'shop_only'
    ? `${batch.miles}mi to store`
    : `${batch.miles}mi total`;

  const reconciled = isReconciled(batch);
  const delta = payDelta(batch);
  const tipBait = delta != null && delta < 0;
  // Hide the "Final" pill when the actual matches the offer exactly — no new info to show.
  const showReconciledPill = reconciled && delta != null && Math.abs(delta) > 0.01;
  const images = Array.isArray(batch.images) ? batch.images : [];

  return (
    <div className="card p-4 fade-in" style={{ borderLeft: `4px solid ${typeColor}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`pill ${batch.accepted ? 'pill-accept' : 'pill-decline'}`}>
              {batch.accepted ? 'ACCEPTED' : 'DECLINED'}
            </span>
            {typeLabel && (
              <span className={`pill pill-type-${typeKey}`}>
                {typeLabel}
              </span>
            )}
            {!batch.accepted && reasonList(batch).length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                · {reasonList(batch).map(r => DECLINE_REASON_LABELS[r] || r).join(' · ')}
              </span>
            )}
          </div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, marginBottom: 4 }}>
            {batch.acceptedAt ? (
              <>
                {fmtDate(batch.acceptedAt)} · {fmtTime(batch.acceptedAt)}
                {batch.completedAt && <>{' – '}{fmtTime(batch.completedAt)}</>}
              </>
            ) : batch.screenshotTakenAt ? (
              <>{fmtDate(batch.screenshotTakenAt)} · {fmtTime(batch.screenshotTakenAt)}</>
            ) : (
              <>{fmtDate(batch.loggedAt)} · {fmtTime(batch.loggedAt)}</>
            )}
          </div>
          <div className="display" style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>
            {fmt$(batch.pay)} <span style={{ color: 'var(--muted)', fontSize: 15, fontWeight: 400 }}>· {batch.store || '—'}{Array.isArray(batch.additionalStores) && batch.additionalStores.length > 0 && (
              <> + {batch.additionalStores.join(' + ')}</>
            )}</span>
          </div>
          <div className="mono mt-1" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {batch.miles != null && <>{milesLabel}</>}
            {batch.estMinutes != null && <> · {batch.estMinutes}min</>}
            {batch.items != null && <> · {batch.items}i</>}
            {batch.units != null && <>/{batch.units}u</>}
            {batch.stops != null && batch.stops > 1 && <> · {batch.stops} stops</>}
            {batch.orders != null && batch.orders > 1 && <> · {batch.orders} orders</>}
          </div>
          {(dollarsPerHour(batch) != null || dollarsPerMile(batch) != null) && (
            <div className="mono mt-1" style={{ fontSize: 12 }}>
              {dollarsPerHour(batch) != null && (
                <span style={{ color: 'var(--ink-soft)' }}>
                  {fmtRate(dollarsPerHour(batch))}/hr
                </span>
              )}
              {dollarsPerHour(batch) != null && dollarsPerMile(batch) != null && (
                <span style={{ color: 'var(--muted)' }}>  ·  </span>
              )}
              {dollarsPerMile(batch) != null && (
                <span style={{ color: 'var(--ink-soft)' }}>
                  {fmtRate(dollarsPerMile(batch))}/mi
                </span>
              )}
            </div>
          )}

          {batch.accepted && showReconciledPill && (
            <div
              className="mono mt-2"
              style={{
                fontSize: 12,
                padding: '6px 10px',
                borderRadius: 8,
                background: tipBait ? 'var(--red-soft)' : 'var(--green-soft)',
                color: tipBait ? 'var(--red)' : 'var(--green)',
                cursor: onReconcile ? 'pointer' : 'default'
              }}
              onClick={onReconcile ? () => onReconcile(batch) : undefined}
            >
              Final {fmt$(batch.actualPay)} · Δ {delta >= 0 ? '+' : '−'}{fmt$(Math.abs(delta))}
              {actualPerHour(batch) != null && <> · {fmtRate(actualPerHour(batch))}/hr actual</>}
            </div>
          )}
          {batch.accepted && !reconciled && onReconcile && (
            <button
              onClick={() => onReconcile(batch)}
              style={{
                marginTop: 8, padding: 0, background: 'none', border: 'none',
                color: 'var(--accent)', fontSize: 12, fontWeight: 500,
                cursor: 'pointer', fontFamily: 'inherit'
              }}
            >
              + Add actual earnings
            </button>
          )}

          {images.length > 0 && (
            <div
              style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto' }}
              onClick={() => onViewImages?.(batch)}
              role={onViewImages ? 'button' : undefined}
            >
              {images.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt={`screenshot ${i + 1}`}
                  style={{
                    height: 56, width: 'auto', borderRadius: 6,
                    border: '1px solid var(--border-soft)', flex: '0 0 auto',
                    cursor: onViewImages ? 'pointer' : 'default'
                  }}
                />
              ))}
            </div>
          )}
        </div>
        {onDelete && (
          <button
            onClick={() => onDelete(batch.id)}
            style={{ background: 'none', border: 'none', padding: 6, color: 'var(--muted)', cursor: 'pointer' }}
            aria-label="Delete"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function ReconcileForm({ batch, onSave, onCancel }) {
  const [actualPay, setActualPay] = useState(batch.actualPay != null ? String(batch.actualPay) : '');
  const [actualTip, setActualTip] = useState(batch.actualTip != null ? String(batch.actualTip) : '');
  const [actualMinutes, setActualMinutes] = useState(batch.actualMinutes != null ? String(batch.actualMinutes) : '');

  const canSave = actualPay && !isNaN(parseFloat(actualPay));

  const submit = () => {
    onSave({
      ...batch,
      actualPay: parseFloat(actualPay),
      actualTip: actualTip ? parseFloat(actualTip) : null,
      actualMinutes: actualMinutes ? parseFloat(actualMinutes) : null,
      reconciledAt: Date.now()
    });
  };

  const clear = () => {
    onSave({
      ...batch,
      actualPay: null,
      actualTip: null,
      actualMinutes: null,
      reconciledAt: null
    });
  };

  const offerSummary = `Offer: ${fmt$(batch.pay)}${batch.tipAmount != null ? ` (incl. ${fmt$(batch.tipAmount)} tip)` : ''} · ${batch.estMinutes ?? '—'}min · ${batch.store || '—'}`;

  return (
    <div className="modal">
      <div className="px-5 pt-6 pb-4 flex items-center justify-between" style={{ background: 'var(--bg)' }}>
        <button onClick={onCancel} className="btn-ghost" style={{ padding: '8px 14px', fontSize: 14 }}>
          <ArrowLeft size={16} style={{ display: 'inline', marginRight: 4 }} /> Cancel
        </button>
        <div className="display" style={{ fontSize: 22, fontWeight: 600 }}>Reconcile</div>
        <div style={{ width: 80 }} />
      </div>

      <div className="px-5">
        <div className="card p-3 mb-4" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {offerSummary}
        </div>

        <div className="space-y-4">
          <div>
            <div className="uppercase-label mb-2">Actual pay (total)</div>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 14, top: 14, color: 'var(--muted-soft)', fontSize: 16, fontWeight: 600 }}>$</span>
              <input
                className="input"
                type="number"
                inputMode="decimal"
                step="0.01"
                placeholder="0.00"
                value={actualPay}
                onChange={e => setActualPay(e.target.value)}
                style={{ paddingLeft: 28 }}
                autoFocus
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="uppercase-label mb-2">Actual tip</div>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 14, top: 14, color: 'var(--muted-soft)', fontSize: 16, fontWeight: 600 }}>$</span>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  placeholder="—"
                  value={actualTip}
                  onChange={e => setActualTip(e.target.value)}
                  style={{ paddingLeft: 28 }}
                />
              </div>
            </div>
            <div>
              <div className="uppercase-label mb-2">Actual minutes</div>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="—"
                value={actualMinutes}
                onChange={e => setActualMinutes(e.target.value)}
              />
            </div>
          </div>
        </div>

        <button
          onClick={submit}
          className="btn-primary mt-6"
          disabled={!canSave}
          style={{ opacity: canSave ? 1 : 0.4 }}
        >
          Save
        </button>

        {isReconciled(batch) && (
          <button
            onClick={clear}
            className="btn-ghost mt-3 mb-8"
            style={{ width: '100%', color: 'var(--red)', borderColor: 'var(--red-soft)' }}
          >
            Clear reconciliation
          </button>
        )}
      </div>
    </div>
  );
}

function ImageViewer({ batch, onClose }) {
  const images = Array.isArray(batch.images) ? batch.images : [];
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)',
        zIndex: 60, overflowY: 'auto', padding: '20px 12px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12
      }}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        style={{
          position: 'sticky', top: 0, alignSelf: 'flex-end',
          width: 36, height: 36, borderRadius: 18,
          background: 'rgba(255,255,255,0.15)', color: 'white', border: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          padding: 0
        }}
      >
        <X size={20} />
      </button>
      {images.map((src, i) => (
        <img
          key={i}
          src={src}
          alt={`screenshot ${i + 1}`}
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: '100%', height: 'auto', borderRadius: 8, display: 'block' }}
        />
      ))}
    </div>
  );
}

function BulkImportForm({ onSave, onCancel }) {
  const [shots, setShots] = useState([]); // [{ name, dataUrl, base64, mediaType, takenAt }]
  const [phase, setPhase] = useState('upload'); // 'upload' | 'extracting' | 'review'
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState(null);
  const [candidates, setCandidates] = useState([]); // [{ ...batch, imageIndices, _accepted, _kept }]
  const [meta, setMeta] = useState({ indexFound: false, expectedCount: 0, summaryImageIndex: null, unmatchedImages: [] });
  const [defaultDeclined, setDefaultDeclined] = useState(false);
  const [viewerImages, setViewerImages] = useState(null); // array of dataUrls for the inline ImageViewer

  const TYPE_LABELS = {
    shop_deliver: 'Shop & deliver',
    shop_only: 'Shop only',
    delivery_only: 'Delivery only',
    mixed: 'Mixed'
  };

  const handleFiles = async (e) => {
    const incoming = Array.from(e.target.files || []);
    e.target.value = '';
    if (!incoming.length) return;
    const room = 20 - shots.length;
    const files = incoming.slice(0, room);

    const next = await Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const comma = dataUrl.indexOf(',');
        const meta = dataUrl.slice(5, comma);
        const mediaType = meta.split(';')[0] || file.type || 'image/jpeg';
        const base64 = dataUrl.slice(comma + 1);
        const takenAt = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
        resolve({ name: file.name, dataUrl, base64, mediaType, takenAt });
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    })));

    // Sort by capture time so the order in thumbnails matches the order sent to the model
    // Stable sort: takenAt first, then numeric portion of filename as tiebreaker.
    // iOS Safari often rounds lastModified to whole seconds when picked from
    // Photos, so two back-to-back screenshots can tie. iOS screenshots have
    // sequential filenames (IMG_1234, IMG_1235) which is a reliable secondary
    // ordering signal.
    const nameOrder = (name) => {
      const m = String(name || '').match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    };
    setShots(prev => [...prev, ...next].slice(0, 20).sort((a, b) => {
      const ta = Date.parse(a.takenAt);
      const tb = Date.parse(b.takenAt);
      if (ta !== tb) return ta - tb;
      return nameOrder(a.name) - nameOrder(b.name);
    }));
  };

  const removeShot = (idx) => setShots(prev => prev.filter((_, i) => i !== idx));

  // If too many images go in one request, the Anthropic call can take 60-120s
  // and the connection drops. Cap each chunk's image count and run sequentially
  // with a progress bar. Each chunk also includes the daily summary (heuristic:
  // the latest-taken screenshot is almost always the daily summary in our data),
  // so the index pattern still anchors per-batch totals.
  const CHUNK_DETAIL_CAP = 6; // detail screenshots per chunk; +1 summary = 7 images per call

  const compressShots = async (shotList) => Promise.all(shotList.map(async s => {
    const dataUrl = await downscaleImage(s.dataUrl, 1080, 2400, 0.85);
    const comma = dataUrl.indexOf(',');
    return {
      data: dataUrl.slice(comma + 1),
      mediaType: 'image/jpeg',
      takenAt: s.takenAt
    };
  }));

  const handleExtract = async () => {
    if (!shots.length) return;
    setError(null);
    setProgress({ done: 0, total: 1 });
    setPhase('extracting');
    try {
      // Single-shot when small enough — keep the simpler, faster path.
      if (shots.length <= CHUNK_DETAIL_CAP + 1) {
        const compressed = await compressShots(shots);
        const result = await extractMulti(compressed);
        finishExtraction(result, shots);
        setProgress({ done: 1, total: 1 });
        setPhase('review');
        return;
      }

      // For declined-default imports, there's no daily summary — declined offers
      // never appear in it. Chunk plain detail screenshots without the summary.
      // For accepted-default, heuristically use the latest-taken screenshot as
      // the daily summary anchor and include it in every chunk.
      const summaryShot = defaultDeclined
        ? null
        : [...shots].sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt))[0];
      const detailShots = summaryShot ? shots.filter(s => s !== summaryShot) : shots;

      // Cluster-aware chunking: shots taken within 5 min of each other belong
      // to the same batch (typically the offer + the post-trip summary
      // screenshot pair). Group them into clusters first, then bin-pack
      // clusters into chunks without splitting any cluster across a boundary.
      const CLUSTER_GAP_MS = 5 * 60 * 1000;
      const sorted = [...detailShots].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
      const clusters = [];
      for (const s of sorted) {
        const last = clusters[clusters.length - 1];
        if (last && (Date.parse(s.takenAt) - Date.parse(last[last.length - 1].takenAt)) < CLUSTER_GAP_MS) {
          last.push(s);
        } else {
          clusters.push([s]);
        }
      }
      const chunks = [];
      let current = [];
      for (const cluster of clusters) {
        if (current.length > 0 && current.length + cluster.length > CHUNK_DETAIL_CAP) {
          chunks.push(current);
          current = [];
        }
        current.push(...cluster);
      }
      if (current.length > 0) chunks.push(current);
      setProgress({ done: 0, total: chunks.length });

      const allBatches = [];
      const allUnmatched = [];
      // The heuristic-picked summary plus whatever each chunk's response
      // identifies as the summary — anything in this set must NEVER appear
      // in a batch's imageIndices.
      const summaryIndices = new Set();
      if (summaryShot) summaryIndices.add(shots.indexOf(summaryShot) + 1);
      let indexFound = false;
      let expectedCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunkShots = summaryShot ? [summaryShot, ...chunks[i]] : chunks[i];
        const compressed = await compressShots(chunkShots);
        const result = await extractMulti(compressed);

        // Map chunk-local imageIndices (1-indexed in chunkShots) back to global
        // shots array indices so the review UI shows the right thumbnails.
        // The model also reports its own summaryImageIndex — record that as a
        // global index for stripping later. Anything in summaryIndices must
        // NEVER appear in a batch's imageIndices.
        const chunkToGlobal = chunkShots.map(s => shots.indexOf(s) + 1);
        if (Number.isFinite(result.summaryImageIndex)) {
          const g = chunkToGlobal[result.summaryImageIndex - 1];
          if (g) summaryIndices.add(g);
        }
        const remappedBatches = result.batches.map(b => ({
          ...b,
          imageIndices: Array.isArray(b.imageIndices)
            ? b.imageIndices.map(idx => chunkToGlobal[idx - 1]).filter(g => g && !summaryIndices.has(g))
            : []
        }));

        // Dedup against the running accumulator: if a daily-summary entry
        // matched in multiple chunks, MERGE — union the image indices and
        // fill in any fields the previous chunk couldn't see (e.g. one chunk
        // had the offer screenshot with estMinutes, another had the summary
        // with actualMinutes + journey timestamps).
        const mergeFields = [
          'pay', 'tipAmount', 'miles', 'mileLegs', 'items', 'units',
          'estMinutes', 'actualMinutes', 'acceptedAt', 'completedAt',
          'store', 'additionalStores', 'stops', 'orders', 'notes',
          'screenType', 'type'
        ];
        for (const b of remappedBatches) {
          const key = b.fromIndex && b.indexEntryTime ? b.indexEntryTime : null;
          if (key) {
            const existingIdx = allBatches.findIndex(x => x.fromIndex && x.indexEntryTime === key);
            if (existingIdx >= 0) {
              const existing = allBatches[existingIdx];
              const mergedIndices = Array.from(new Set([
                ...(existing.imageIndices || []),
                ...(b.imageIndices || [])
              ]));
              const merged = { ...existing, imageIndices: mergedIndices };
              for (const f of mergeFields) {
                // Only fill in if the existing version is missing/null and the new chunk has a value.
                const empty = merged[f] == null || (Array.isArray(merged[f]) && merged[f].length === 0);
                const incoming = b[f];
                const has = incoming != null && !(Array.isArray(incoming) && incoming.length === 0);
                if (empty && has) merged[f] = incoming;
              }
              allBatches[existingIdx] = merged;
              continue;
            }
          }
          allBatches.push(b);
        }

        if (result.indexFound) indexFound = true;
        if (result.expectedCount > expectedCount) expectedCount = result.expectedCount;
        for (const u of (result.unmatchedImages || [])) {
          const g = chunkToGlobal[u - 1];
          if (g) allUnmatched.push(g);
        }

        setProgress({ done: i + 1, total: chunks.length });
      }

      // After all chunks have run, do a final sweep stripping any newly-
      // discovered summary indices from batches saved earlier. (A summary
      // index detected by chunk 3 won't have been stripped from a batch
      // accumulated during chunk 1.) Also remove duplicate global indices.
      for (const b of allBatches) {
        b.imageIndices = Array.from(new Set((b.imageIndices || []).filter(g => !summaryIndices.has(g))));
      }

      // Orphan rescue: attach any input image the model never assigned (not in
      // any batch's imageIndices, not in unmatchedImages, not the summary) to
      // the nearest-by-takenAt batch. The user took these screenshots in pairs
      // back-to-back; if one was missed, its closest neighbor in time almost
      // certainly belongs to the same batch.
      const summaryGlobalIdx = summaryShot ? shots.indexOf(summaryShot) + 1 : null;
      const claimed = new Set();
      for (const b of allBatches) (b.imageIndices || []).forEach(i => claimed.add(i));
      for (const u of allUnmatched) claimed.add(u);
      // All known summary indices count as "claimed" so the orphan rescue
      // doesn't accidentally drag a daily-summary screenshot into some batch.
      for (const idx of summaryIndices) claimed.add(idx);
      if (summaryGlobalIdx) claimed.add(summaryGlobalIdx);

      const orphans = [];
      for (let g = 1; g <= shots.length; g++) {
        if (!claimed.has(g)) orphans.push(g);
      }

      const orphansStillUnmatched = [];
      for (const orphanIdx of orphans) {
        const orphanShot = shots[orphanIdx - 1];
        const orphanT = Date.parse(orphanShot.takenAt);
        // Find the batch whose existing image was taken closest in time.
        let bestBatch = null;
        let bestDelta = Infinity;
        for (const b of allBatches) {
          for (const claimedIdx of (b.imageIndices || [])) {
            const claimedT = Date.parse(shots[claimedIdx - 1]?.takenAt);
            const delta = Math.abs(orphanT - claimedT);
            if (delta < bestDelta) {
              bestDelta = delta;
              bestBatch = b;
            }
          }
        }
        // Only auto-attach when the time gap is tight (<= 90s = same scroll session).
        if (bestBatch && bestDelta <= 90_000) {
          bestBatch.imageIndices = [...(bestBatch.imageIndices || []), orphanIdx];
        } else {
          orphansStillUnmatched.push(orphanIdx);
        }
      }

      const finalUnmatched = Array.from(new Set([...allUnmatched, ...orphansStillUnmatched]));

      finishExtraction({
        batches: allBatches,
        indexFound,
        expectedCount,
        summaryImageIndex: summaryGlobalIdx,
        unmatchedImages: finalUnmatched
      }, shots);
      setPhase('review');
    } catch (err) {
      const raw = err?.message || '';
      const isNetwork = err?.name === 'TypeError' || raw === 'Load failed' || raw.includes('Failed to fetch') || raw.includes('NetworkError');
      setError(isNetwork
        ? "Couldn't reach server. Check your connection and try again."
        : (raw || 'Extraction failed'));
      setPhase('upload');
    }
  };

  const finishExtraction = (result, originalShots) => {
    const lowered = result.batches.map(b => {
      const out = {};
      for (const k of Object.keys(b || {})) out[k.toLowerCase()] = b[k];
      return out;
    });
    const prepared = lowered.map((b, i) => {
      const screen = String(b.screentype || '').toLowerCase();
      const isPostTrip = b.fromindex === true
        || screen === 'summary'
        || b.actualminutes != null
        || b.actualpay != null;
      return {
        ...b,
        _accepted: isPostTrip ? true : !defaultDeclined,
        _kept: true,
        _declineReasons: [],
        _idx: i
      };
    });
    setCandidates(prepared);
    setMeta({
      indexFound: result.indexFound,
      expectedCount: result.expectedCount,
      summaryImageIndex: result.summaryImageIndex,
      unmatchedImages: result.unmatchedImages
    });
  };

  const toggleAccept = (idx) => {
    setCandidates(prev => prev.map(c => {
      if (c._idx !== idx) return c;
      const nextAccepted = !c._accepted;
      // Clear the reasons when flipping back to accepted, so they don't get saved.
      return { ...c, _accepted: nextAccepted, _declineReasons: nextAccepted ? [] : c._declineReasons };
    }));
  };

  const toggleReason = (idx, reason) => {
    setCandidates(prev => prev.map(c => {
      if (c._idx !== idx) return c;
      const has = c._declineReasons.includes(reason);
      return { ...c, _declineReasons: has ? c._declineReasons.filter(x => x !== reason) : [...c._declineReasons, reason] };
    }));
  };

  const discard = (idx) => {
    setCandidates(prev => prev.map(c => c._idx === idx ? { ...c, _kept: false } : c));
  };

  const restore = (idx) => {
    setCandidates(prev => prev.map(c => c._idx === idx ? { ...c, _kept: true } : c));
  };

  const num = (v) => {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v));
    return isNaN(n) ? null : n;
  };

  const candidateToBatch = async (c) => {
    const screenType = String(c.screentype || c.screen_type || '').toLowerCase();
    const total = num(c.pay ?? c.total);
    const tipPart = num(c.tip ?? c.tipamount);
    const estMins = num(c.estminutes ?? c.estminute);
    const actualMins = num(c.actualminutes ?? c.activeminutes);
    const miles = num(c.miles ?? c.mi ?? c.distance);
    const items = num(c.items);
    const units = num(c.units);
    const stops = num(c.stops);
    const orders = num(c.orders);
    const t = String(c.type || '').toLowerCase().replace(/[\s\-&]+/g, '_');
    let type = null;
    if (t === 'shop_deliver' || t === 'shop_and_deliver') type = 'shop_deliver';
    else if (t === 'shop_only') type = 'shop_only';
    else if (t === 'delivery_only') type = 'delivery_only';
    else if (t === 'mixed' || t === 'hybrid') type = 'mixed';

    const fromSummary = screenType === 'summary';
    const hasActual = actualMins != null || (fromSummary && total != null);

    const sourceShots = (c.imageindices || []).map(i => shots[i - 1]).filter(Boolean);
    let images = null;
    let screenshotTakenAt = null;
    if (sourceShots.length) {
      try {
        images = await Promise.all(sourceShots.map(s => downscaleImage(s.dataUrl)));
      } catch (e) {
        console.error('image downscale failed', e);
      }
      const tsList = sourceShots
        .map(s => Date.parse(s.takenAt))
        .filter(n => Number.isFinite(n) && n > 0);
      if (tsList.length) screenshotTakenAt = Math.min(...tsList);
    }

    return {
      id: crypto.randomUUID(),
      loggedAt: Date.now(),
      screenshotTakenAt,
      acceptedAt: parseTs(c.acceptedat ?? c.accepted_at),
      completedAt: parseTs(c.completedat ?? c.completed_at),
      type: type || 'shop_deliver',
      pay: total,
      tipAmount: tipPart,
      miles: miles,
      estMinutes: estMins != null ? Math.round(estMins) : null,
      items: items != null ? Math.round(items) : null,
      units: units != null ? Math.round(units) : null,
      stops: stops != null ? Math.round(stops) : 1,
      orders: orders != null ? Math.round(orders) : 1,
      store: c.store || null,
      additionalStores: Array.isArray(c.additionalstores) && c.additionalstores.length ? c.additionalstores.map(String) : null,
      accepted: c._accepted,
      declineReason: !c._accepted && c._declineReasons.length ? c._declineReasons : null,
      notes: c.notes || null,
      source: 'bulk',
      images,
      actualPay: fromSummary && total != null ? total : null,
      actualTip: null,
      actualMinutes: actualMins != null ? Math.round(actualMins) : null,
      reconciledAt: hasActual ? Date.now() : null
    };
  };

  const saveAll = async () => {
    const kept = await Promise.all(
      candidates.filter(c => c._kept).map(candidateToBatch)
    );
    onSave(kept);
  };

  const keptCount = candidates.filter(c => c._kept).length;

  return (
    <div className="modal">
      <div className="px-5 pt-6 pb-4 flex items-center justify-between" style={{ background: 'var(--bg)' }}>
        <button onClick={onCancel} className="btn-ghost" style={{ padding: '8px 14px', fontSize: 14 }}>
          <ArrowLeft size={16} style={{ display: 'inline', marginRight: 4 }} /> Cancel
        </button>
        <div className="display" style={{ fontSize: 22, fontWeight: 600 }}>Bulk import</div>
        <div style={{ width: 80 }} />
      </div>

      <div className="px-5">
        {phase === 'upload' && (
          <>
            {!defaultDeclined && (
              <div
                className="card mb-3 p-3"
                style={{ background: 'var(--accent-soft)', borderColor: 'transparent' }}
              >
                <div className="uppercase-label" style={{ color: 'var(--accent)', marginBottom: 6 }}>
                  Required: daily summary
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.4 }}>
                  Include a screenshot of your <strong>day summary</strong> screen — the one that lists every batch with its time and total (e.g. "Sun, Apr 26 · Total $184.06 · 7 batches"). Without it, batches won't group reliably.
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                  Then add the offer / batch-summary screenshots for each batch.
                </div>
              </div>
            )}

            <div className="card mb-3 p-3">
              <div className="uppercase-label mb-2">Default state</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDefaultDeclined(false)}
                  className={`chip ${!defaultDeclined ? 'chip-active' : ''}`}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  Accepted
                </button>
                <button
                  type="button"
                  onClick={() => setDefaultDeclined(true)}
                  className={`chip ${defaultDeclined ? 'chip-active' : ''}`}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  Declined
                </button>
              </div>
              <div className="mono mt-2" style={{ fontSize: 11, color: 'var(--muted)' }}>
                Each candidate starts with this state — flip individual cards on the next screen if needed. Post-trip summary screenshots are always Accepted regardless.
              </div>
            </div>

            <div className="card-strong p-3">
              <div className="flex items-baseline justify-between mb-2">
                <div className="uppercase-label">Screenshots</div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{shots.length}/20</div>
              </div>

              <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
                Order doesn't matter — the app sorts and groups automatically.
              </div>

              {shots.length > 0 && (
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6, marginBottom: 8 }}>
                  {shots.map((s, i) => (
                    <div key={i} style={{ position: 'relative', flex: '0 0 auto' }}>
                      <img
                        src={s.dataUrl}
                        alt={`shot ${i + 1}`}
                        onClick={() => setViewerImages(shots.map(x => x.dataUrl))}
                        style={{ height: 88, width: 'auto', borderRadius: 8, border: '1px solid var(--border)', display: 'block', cursor: 'pointer' }}
                      />
                      <button
                        onClick={(e) => { e.stopPropagation(); removeShot(i); }}
                        aria-label="Remove"
                        style={{
                          position: 'absolute', top: -6, right: -6, width: 22, height: 22,
                          borderRadius: 11, border: 'none', background: 'var(--ink)', color: 'var(--surface)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {shots.length < 20 && (
                <label
                  className="btn-ghost"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', fontSize: 13, cursor: 'pointer' }}
                >
                  <Camera size={14} />
                  {shots.length === 0 ? 'Choose images (1–20)' : 'Add more'}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFiles}
                    style={{ display: 'none' }}
                  />
                </label>
              )}

              <button
                onClick={handleExtract}
                className="btn-primary mt-3"
                disabled={!shots.length}
                style={{ opacity: shots.length ? 1 : 0.4 }}
              >
                Extract all
              </button>

              {error && (
                <div className="mt-2 p-2" style={{ background: 'var(--red-soft)', borderRadius: 6, fontSize: 12, color: 'var(--red)' }}>
                  {error}
                </div>
              )}
            </div>
          </>
        )}

        {phase === 'extracting' && (
          <div className="card p-6 text-center">
            <Loader2 size={28} className="animate-spin" style={{ color: 'var(--muted)', margin: '0 auto 12px' }} />
            <div style={{ fontSize: 15, fontWeight: 600 }}>Extracting…</div>
            <div className="mono mt-1" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {progress.total > 1
                ? `Chunk ${progress.done} of ${progress.total} · ${shots.length} images total`
                : `Grouping ${shots.length} images into batches`}
            </div>
            {progress.total > 1 && (
              <div className="bar mt-3" style={{ width: '100%' }}>
                <div
                  className="bar-fill"
                  style={{ width: `${(progress.done / progress.total) * 100}%`, transition: 'width 0.3s' }}
                />
              </div>
            )}
          </div>
        )}

        {phase === 'review' && (
          <>
            {!defaultDeclined && meta.indexFound && (
              <div
                className="card mb-3 p-3"
                style={{ background: 'var(--green-soft)', borderColor: 'transparent' }}
              >
                <div style={{ fontSize: 13, color: 'var(--green)', fontWeight: 500 }}>
                  ✓ Day summary detected — {candidates.length} of {meta.expectedCount} batch{meta.expectedCount === 1 ? '' : 'es'} matched
                </div>
                {meta.unmatchedImages?.length > 0 && (
                  <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    {meta.unmatchedImages.length} image{meta.unmatchedImages.length === 1 ? '' : 's'} couldn't be matched to a batch.
                  </div>
                )}
              </div>
            )}
            {!defaultDeclined && !meta.indexFound && (
              <div
                className="card mb-3 p-3"
                style={{ background: 'var(--red-soft)', borderColor: 'transparent' }}
              >
                <div style={{ fontSize: 13, color: 'var(--red)', fontWeight: 500, marginBottom: 4 }}>
                  No day summary detected
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)', lineHeight: 1.4 }}>
                  Without the summary screen, batch grouping is unreliable — totals and stores below may be wrong. Cancel, take a screenshot of the day summary, and re-import.
                </div>
              </div>
            )}

            <div className="uppercase-label mb-3">{candidates.length} batch{candidates.length === 1 ? '' : 'es'} found</div>
            <div className="space-y-3 mb-6">
              {candidates.map(c => {
                const sources = (c.imageindices || []).map(i => shots[i - 1]).filter(Boolean);
                const isPostTrip = c.fromindex === true
                  || String(c.screentype || '').toLowerCase() === 'summary'
                  || c.actualminutes != null
                  || c.actualpay != null;
                return (
                  <div
                    key={c._idx}
                    className="card p-4"
                    style={{ opacity: c._kept ? 1 : 0.4 }}
                  >
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className={`pill ${c._accepted ? 'pill-accept' : 'pill-decline'}`}>
                        {c._accepted ? 'ACCEPTED' : 'DECLINED'}
                      </span>
                      {c.type && (
                        <span className={`pill pill-type-${String(c.type).toLowerCase().replace(/_/g, '-')}`}>
                          {TYPE_LABELS[String(c.type).toLowerCase()] || c.type}
                        </span>
                      )}
                      {c.screentype && (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>· {c.screentype}</span>
                      )}
                    </div>
                    <div className="display" style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2 }}>
                      {c.pay != null ? fmt$(c.pay) : '—'} <span style={{ color: 'var(--muted)', fontSize: 15, fontWeight: 400 }}>· {c.store || '—'}</span>
                    </div>
                    <div className="mono mt-1" style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {c.miles != null && <>{c.miles}mi</>}
                      {c.actualminutes != null && <> · {c.actualminutes}min actual</>}
                      {c.actualminutes == null && c.estminutes != null && <> · {c.estminutes}min est</>}
                      {c.items != null && <> · {c.items}i</>}
                      {c.units != null && <>/{c.units}u</>}
                      {c.stops != null && c.stops > 1 && <> · {c.stops} stops</>}
                      {c.orders != null && c.orders > 1 && <> · {c.orders} orders</>}
                    </div>
                    {sources.length > 0 && (
                      <div
                        style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 10, cursor: 'pointer' }}
                        onClick={() => setViewerImages(sources.map(s => s.dataUrl))}
                        role="button"
                      >
                        {sources.map((s, i) => (
                          <img
                            key={i}
                            src={s.dataUrl}
                            alt=""
                            style={{ height: 48, width: 'auto', borderRadius: 4, border: '1px solid var(--border-soft)' }}
                          />
                        ))}
                      </div>
                    )}
                    {c._kept && !c._accepted && !isPostTrip && (
                      <div className="mt-3">
                        <div className="uppercase-label mb-2">Decline reasons (pick all that apply)</div>
                        <div className="flex flex-wrap gap-2">
                          {DECLINE_REASONS.map(r => {
                            const active = c._declineReasons.includes(r.val);
                            return (
                              <button
                                key={r.val}
                                type="button"
                                onClick={() => toggleReason(c._idx, r.val)}
                                className={`chip ${active ? 'chip-active' : ''}`}
                                style={{ fontSize: 12, padding: '6px 12px' }}
                              >
                                {r.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-2 mt-3">
                      {c._kept && (
                        <>
                          {!isPostTrip && (
                            <button
                              onClick={() => toggleAccept(c._idx)}
                              className="btn-ghost"
                              style={{ flex: 1, padding: '8px', fontSize: 12 }}
                            >
                              Mark {c._accepted ? 'declined' : 'accepted'}
                            </button>
                          )}
                          <button
                            onClick={() => discard(c._idx)}
                            className="btn-ghost"
                            style={{ flex: isPostTrip ? 1 : undefined, padding: '8px 14px', fontSize: 12, color: 'var(--red)', borderColor: 'var(--red-soft)' }}
                          >
                            Discard
                          </button>
                        </>
                      )}
                      {!c._kept && (
                        <button
                          onClick={() => restore(c._idx)}
                          className="btn-ghost"
                          style={{ flex: 1, padding: '8px', fontSize: 12 }}
                        >
                          Restore
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              onClick={saveAll}
              className="btn-primary mb-8"
              disabled={!keptCount}
              style={{ opacity: keptCount ? 1 : 0.4 }}
            >
              Save {keptCount} batch{keptCount === 1 ? '' : 'es'}
            </button>
          </>
        )}
      </div>

      {viewerImages && (
        <ImageViewer
          batch={{ images: viewerImages }}
          onClose={() => setViewerImages(null)}
        />
      )}
    </div>
  );
}

function LogForm({ onSave, onCancel, onBulk }) {
  const [pay, setPay] = useState('');
  const [tipAmount, setTipAmount] = useState(null); // hidden, only set by extraction
  const [miles, setMiles] = useState('');
  const [minutes, setMinutes] = useState('');         // estimated (offer time)
  const [actualMinutes, setActualMinutes] = useState(''); // from summary "Active hours"
  const [actualPay, setActualPay] = useState('');     // final pay if from summary
  const [items, setItems] = useState('');
  const [units, setUnits] = useState('');
  const [stops, setStops] = useState('1');
  const [orders, setOrders] = useState('1');
  const [store, setStore] = useState('');
  const [storeOther, setStoreOther] = useState('');
  const [additionalStores, setAdditionalStores] = useState([]);
  const [showMultiStore, setShowMultiStore] = useState(false);
  const [notes, setNotes] = useState('');
  const [type, setType] = useState('shop_deliver');
  const [declineReasons, setDeclineReasons] = useState([]);
  const [acceptedAt, setAcceptedAt] = useState(null);
  const [completedAt, setCompletedAt] = useState(null);
  const [fromSummary, setFromSummary] = useState(false); // set by extraction when screenType === 'summary'
  const [mode, setMode] = useState(null); // null | 'paste' | 'shots'
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState(null);
  const [extractSuccess, setExtractSuccess] = useState(false);
  const [shots, setShots] = useState([]); // [{ name, dataUrl, base64, mediaType }]
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState(null);

  const canSave = pay && miles && (store || storeOther);

  const applyExtracted = (data) => {
    const num = (v) => {
      if (v == null || v === '') return null;
      const n = parseFloat(String(v));
      return isNaN(n) ? null : n;
    };

    // Pay: prefer "pay" or "total"; if only batch+tip given, sum them
    const totalKey = num(data.pay ?? data.total);
    const batchPart = num(data.batch ?? data.batchpay);
    const tipPart = num(data.tip ?? data.tipamount);
    let total = totalKey;
    if (total == null && batchPart != null) total = batchPart + (tipPart || 0);
    if (total != null) setPay(String(total));
    if (tipPart != null) setTipAmount(tipPart);

    const miles_ = num(data.miles ?? data.mi ?? data.distance);
    if (miles_ != null) setMiles(String(miles_));

    // Time: prefer estimated for offer screens, actual for summary screens
    const screenType = String(data.screentype || data.screen_type || data.screen || '').toLowerCase();
    const estMins = num(data.estminutes ?? data.estminute ?? data.estimatedminutes);
    const actualMins = num(data.actualminutes ?? data.activeminutes ?? data.activetime);
    const genericMins = num(data.minutes ?? data.min ?? data.time);

    if (estMins != null) setMinutes(String(Math.round(estMins)));
    else if (screenType === 'offer' && genericMins != null) setMinutes(String(Math.round(genericMins)));

    if (actualMins != null) setActualMinutes(String(Math.round(actualMins)));
    else if (screenType === 'summary' && genericMins != null) setActualMinutes(String(Math.round(genericMins)));

    // If summary screen, the displayed pay IS the actual pay; mirror it for reconciliation
    if (screenType === 'summary' && total != null) {
      setActualPay(String(total));
      setFromSummary(true);
    }

    const items_ = num(data.items);
    if (items_ != null) setItems(String(Math.round(items_)));

    const units_ = num(data.units);
    if (units_ != null) setUnits(String(Math.round(units_)));

    const stops_ = num(data.stops);
    if (stops_ != null) setStops(String(Math.round(stops_)));

    const orders_ = num(data.orders);
    if (orders_ != null) setOrders(String(Math.round(orders_)));

    const accAt = parseTs(data.acceptedat ?? data.accepted_at);
    if (accAt != null) setAcceptedAt(accAt);
    const compAt = parseTs(data.completedat ?? data.completed_at);
    if (compAt != null) setCompletedAt(compAt);

    const storeName = data.store;
    if (storeName) {
      const match = DEFAULT_STORES.find(s => s.toLowerCase() === String(storeName).toLowerCase());
      if (match) { setStore(match); setStoreOther(''); }
      else { setStore('Other'); setStoreOther(String(storeName)); }
    }

    const extras = data.additionalstores ?? data.additional_stores;
    if (Array.isArray(extras) && extras.length) {
      const mapped = extras
        .map(name => DEFAULT_STORES.find(s => s.toLowerCase() === String(name).toLowerCase()) || String(name))
        .filter(Boolean);
      if (mapped.length) {
        setAdditionalStores(mapped);
        setShowMultiStore(true);
      }
    }

    if (data.notes) setNotes(String(data.notes));

    if (data.type) {
      const t = String(data.type).toLowerCase().replace(/[\s\-&]+/g, '_');
      if (t === 'shop_deliver' || t === 'shop_and_deliver' || t === 'sad' || t === 'shopanddeliver' || t === 'shop+deliver') {
        setType('shop_deliver');
      } else if (t === 'shop_only' || t === 'shoponly' || t === 'so' || t === 'pickup' || t === 'shop') {
        setType('shop_only');
      } else if (t === 'delivery_only' || t === 'deliveryonly' || t === 'do' || t === 'delivery' || t === 'last_mile') {
        setType('delivery_only');
      } else if (t === 'mixed' || t === 'hybrid' || t === 'combo' || t === 'combined' || t === 'mix') {
        setType('mixed');
      }
    }
  };

  const flashSuccess = () => {
    setExtractSuccess(true);
    setTimeout(() => setExtractSuccess(false), 2500);
  };

  const handleParse = () => {
    setPasteError(null);
    setExtractSuccess(false);
    const data = parsePaste(pasteText);
    if (!data) {
      setPasteError("Couldn't parse — expected JSON or key=value pairs");
      return;
    }
    applyExtracted(data);
    setPasteText('');
    setMode(null);
    flashSuccess();
  };

  const handleFiles = async (e) => {
    const incoming = Array.from(e.target.files || []);
    e.target.value = '';
    if (!incoming.length) return;
    const room = 8 - shots.length;
    const files = incoming.slice(0, room);

    const next = await Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const comma = dataUrl.indexOf(',');
        const meta = dataUrl.slice(5, comma); // strip "data:"
        const mediaType = meta.split(';')[0] || file.type || 'image/jpeg';
        const base64 = dataUrl.slice(comma + 1);
        resolve({ name: file.name, dataUrl, base64, mediaType });
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    })));

    setShots(prev => [...prev, ...next].slice(0, 8));
  };

  const removeShot = (idx) => {
    setShots(prev => prev.filter((_, i) => i !== idx));
  };

  const handleExtract = async () => {
    setExtractError(null);
    if (!EXTRACTOR_URL) {
      setExtractError('VITE_EXTRACTOR_URL is not set — check frontend env config');
      return;
    }
    if (!shots.length) return;

    setExtracting(true);
    try {
      // Downscale before upload — full-res iPhone screenshots make request bodies
      // big enough to fail with Safari's "Load failed" on flaky cellular.
      const compressed = await Promise.all(shots.map(async s => {
        const dataUrl = await downscaleImage(s.dataUrl, 1080, 2400, 0.85);
        const comma = dataUrl.indexOf(',');
        return { data: dataUrl.slice(comma + 1), mediaType: 'image/jpeg' };
      }));
      const token = getAuthToken();
      if (!token) throw new Error('Not signed in');
      const url = EXTRACTOR_URL.replace(/\/$/, '') + '/extract';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ images: compressed })
      });
      if (res.status === 401) {
        setAuthToken(null);
        throw new Error('Session expired — please sign in again');
      }
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `Extraction failed (HTTP ${res.status})`);
      }
      // Backend returns camelCase keys; lowercase them so applyExtracted's aliases match.
      const lowered = {};
      for (const k of Object.keys(json.data || {})) lowered[k.toLowerCase()] = json.data[k];
      applyExtracted(lowered);
      // Keep shots — they'll attach to the saved batch.
      setMode(null);
      flashSuccess();
    } catch (err) {
      const raw = err?.message || '';
      const isNetwork = err?.name === 'TypeError' || raw === 'Load failed' || raw.includes('Failed to fetch') || raw.includes('NetworkError');
      setExtractError(isNetwork
        ? "Couldn't reach server. Check your connection and try again — if it keeps failing, try fewer images at once."
        : (raw || 'Extraction failed'));
    } finally {
      setExtracting(false);
    }
  };

  const submit = async (accepted) => {
    const finalStore = store === 'Other' ? storeOther : store;
    const hasActual = (actualPay !== '' && !isNaN(parseFloat(actualPay))) ||
                       (actualMinutes !== '' && !isNaN(parseFloat(actualMinutes)));

    let images = null;
    let screenshotTakenAt = null;
    if (shots.length) {
      try {
        const compressed = await Promise.all(shots.map(s => downscaleImage(s.dataUrl)));
        images = compressed;
      } catch (e) {
        console.error('image downscale failed', e);
      }
      const tsList = shots
        .map(s => Date.parse(s.takenAt))
        .filter(n => Number.isFinite(n) && n > 0);
      if (tsList.length) screenshotTakenAt = Math.min(...tsList);
    }

    const batch = {
      id: crypto.randomUUID(),
      loggedAt: Date.now(),
      screenshotTakenAt,
      acceptedAt: acceptedAt,
      completedAt: completedAt,
      type,
      pay: parseFloat(pay),
      tipAmount: tipAmount,
      miles: parseFloat(miles),
      estMinutes: minutes ? parseFloat(minutes) : null,
      items: items ? parseInt(items) : null,
      units: units ? parseInt(units) : null,
      stops: stops ? parseInt(stops) : 1,
      orders: orders ? parseInt(orders) : 1,
      store: finalStore || null,
      additionalStores: additionalStores.length ? additionalStores : null,
      accepted,
      declineReason: !accepted && declineReasons.length ? declineReasons : null,
      notes: notes || null,
      source: 'quick',
      images,
      actualPay: actualPay !== '' ? parseFloat(actualPay) : null,
      actualTip: null,
      actualMinutes: actualMinutes !== '' ? parseFloat(actualMinutes) : null,
      reconciledAt: hasActual ? Date.now() : null
    };
    onSave(batch);
  };

  return (
    <div className="modal">
      <div className="px-5 pt-6 pb-4 flex items-center justify-between" style={{ background: 'var(--bg)' }}>
        <button onClick={onCancel} className="btn-ghost" style={{ padding: '8px 14px', fontSize: 14 }}>
          <ArrowLeft size={16} style={{ display: 'inline', marginRight: 4 }} /> Cancel
        </button>
        <div className="display" style={{ fontSize: 22, fontWeight: 600 }}>Log batch</div>
        <div style={{ width: 80 }} />
      </div>

      <div className="px-5">
        <div className="mb-4">
          {mode === null && (
            <>
              <div className="flex gap-2">
                <button
                  onClick={() => { setMode('shots'); setExtractError(null); }}
                  className="btn-ghost"
                  style={{ flex: 1, padding: '12px', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                >
                  <Camera size={14} />
                  Screenshots
                </button>
                <button
                  onClick={() => { setMode('paste'); setPasteError(null); }}
                  className="btn-ghost"
                  style={{ flex: 1, padding: '12px', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                >
                  <ClipboardPaste size={14} />
                  Paste data
                </button>
              </div>
              {onBulk && (
                <button
                  onClick={onBulk}
                  className="btn-ghost mt-2"
                  style={{ width: '100%', padding: '10px', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                >
                  <Camera size={13} />
                  Bulk import (multiple batches)
                </button>
              )}
            </>
          )}

          {mode === 'paste' && (
            <div className="card-strong p-3">
              <div className="uppercase-label mb-2">Paste from chat</div>
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                placeholder='pay=19.61 miles=5.3 items=49 units=69 store=Publix stops=2 minutes=53'
                className="input"
                style={{ minHeight: 70, fontSize: 13, resize: 'vertical' }}
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => { setMode(null); setPasteText(''); setPasteError(null); }}
                  className="btn-ghost"
                  style={{ flex: 1, padding: '10px', fontSize: 13 }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleParse}
                  className="btn-primary"
                  style={{ flex: 1, padding: '10px', fontSize: 13 }}
                  disabled={!pasteText.trim()}
                >
                  Parse
                </button>
              </div>
              {pasteError && (
                <div className="mt-2 p-2" style={{ background: 'var(--red-soft)', borderRadius: 6, fontSize: 12, color: 'var(--red)' }}>
                  {pasteError}
                </div>
              )}
            </div>
          )}

          {mode === 'shots' && (
            <div className="card-strong p-3">
              <div className="flex items-baseline justify-between mb-2">
                <div className="uppercase-label">Screenshots</div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{shots.length}/8</div>
              </div>

              {shots.length > 0 && (
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6, marginBottom: 8 }}>
                  {shots.map((s, i) => (
                    <div key={i} style={{ position: 'relative', flex: '0 0 auto' }}>
                      <img
                        src={s.dataUrl}
                        alt={`shot ${i + 1}`}
                        style={{ height: 88, width: 'auto', borderRadius: 8, border: '1px solid var(--border)', display: 'block' }}
                      />
                      <button
                        onClick={() => removeShot(i)}
                        aria-label="Remove"
                        style={{
                          position: 'absolute', top: -6, right: -6, width: 22, height: 22,
                          borderRadius: 11, border: 'none', background: 'var(--ink)', color: 'var(--surface)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                          padding: 0
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {shots.length < 8 && (
                <label
                  className="btn-ghost"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', fontSize: 13, cursor: 'pointer' }}
                >
                  <Camera size={14} />
                  {shots.length === 0 ? 'Choose images (1–8)' : 'Add more'}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFiles}
                    style={{ display: 'none' }}
                  />
                </label>
              )}

              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => { setMode(null); setShots([]); setExtractError(null); }}
                  className="btn-ghost"
                  style={{ flex: 1, padding: '10px', fontSize: 13 }}
                  disabled={extracting}
                >
                  Cancel
                </button>
                <button
                  onClick={handleExtract}
                  className="btn-primary"
                  style={{ flex: 1, padding: '10px', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  disabled={!shots.length || extracting}
                >
                  {extracting ? <><Loader2 size={14} className="animate-spin" /> Extracting…</> : 'Extract'}
                </button>
              </div>

              {extractError && (
                <div className="mt-2 p-2" style={{ background: 'var(--red-soft)', borderRadius: 6, fontSize: 12, color: 'var(--red)' }}>
                  {extractError}
                </div>
              )}
            </div>
          )}

          {extractSuccess && mode === null && (
            <div className="mt-2 p-2 fade-in" style={{ background: 'var(--green-soft)', borderRadius: 6, fontSize: 12, color: 'var(--green)' }}>
              <Check size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
              Parsed — review fields below
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <div className="uppercase-label mb-2">Type</div>
            <div className="flex flex-wrap gap-2">
              {[
                { val: 'shop_deliver', label: 'Shop & deliver' },
                { val: 'shop_only', label: 'Shop only' },
                { val: 'delivery_only', label: 'Delivery only' },
                { val: 'mixed', label: 'Mixed' }
              ].map(t => (
                <button
                  key={t.val}
                  onClick={() => setType(t.val)}
                  className={`chip ${type === t.val ? 'chip-active' : ''}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="uppercase-label mb-2">Store</div>
            <div className="flex flex-wrap gap-2">
              {DEFAULT_STORES.map(s => (
                <button
                  key={s}
                  onClick={() => setStore(s)}
                  className={`chip ${store === s ? 'chip-active' : ''}`}
                >
                  {s}
                </button>
              ))}
            </div>
            {store === 'Other' && (
              <input
                className="input mt-2"
                placeholder="Store name"
                value={storeOther}
                onChange={e => setStoreOther(e.target.value)}
              />
            )}

            {!showMultiStore ? (
              <button
                type="button"
                onClick={() => setShowMultiStore(true)}
                style={{
                  marginTop: 8, padding: 0, background: 'none', border: 'none',
                  color: 'var(--accent)', fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit'
                }}
              >
                + Multi-store batch
              </button>
            ) : (
              <div className="mt-3">
                <div className="flex items-baseline justify-between mb-2">
                  <div className="uppercase-label">Additional stores</div>
                  <button
                    type="button"
                    onClick={() => { setShowMultiStore(false); setAdditionalStores([]); }}
                    style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Clear
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {DEFAULT_STORES.filter(s => s !== 'Other' && s !== store).map(s => {
                    const active = additionalStores.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setAdditionalStores(prev => active ? prev.filter(x => x !== s) : [...prev, s])}
                        className={`chip ${active ? 'chip-active' : ''}`}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="uppercase-label mb-2">Pay</div>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 14, top: 14, color: 'var(--muted-soft)', fontSize: 16, fontWeight: 600 }}>$</span>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  placeholder="0.00"
                  value={pay}
                  onChange={e => setPay(e.target.value)}
                  style={{ paddingLeft: 28 }}
                />
              </div>
            </div>
            <div>
              <div className="uppercase-label mb-2">Miles</div>
              <input
                className="input"
                type="number"
                inputMode="decimal"
                step="0.1"
                placeholder="0"
                value={miles}
                onChange={e => setMiles(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="uppercase-label mb-2">Est. minutes</div>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="—"
                value={minutes}
                onChange={e => setMinutes(e.target.value)}
              />
            </div>
            <div>
              <div className="uppercase-label mb-2">Actual minutes</div>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="—"
                value={actualMinutes}
                onChange={e => setActualMinutes(e.target.value)}
              />
            </div>
          </div>

          {fromSummary && (
            <div>
              <div className="uppercase-label mb-2">Actual pay</div>
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 14, top: 14, color: 'var(--muted-soft)', fontSize: 16, fontWeight: 600 }}>$</span>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  placeholder="—"
                  value={actualPay}
                  onChange={e => setActualPay(e.target.value)}
                  style={{ paddingLeft: 28 }}
                />
              </div>
              <div className="mono mt-1" style={{ fontSize: 11, color: 'var(--muted)' }}>
                Logging from summary — saving as already-reconciled.
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="uppercase-label mb-2">Stops</div>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="1"
                value={stops}
                onChange={e => setStops(e.target.value)}
              />
              <div className="mono mt-1" style={{ fontSize: 10, color: 'var(--muted)' }}>physical destinations</div>
            </div>
            <div>
              <div className="uppercase-label mb-2">Orders</div>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="1"
                value={orders}
                onChange={e => setOrders(e.target.value)}
              />
              <div className="mono mt-1" style={{ fontSize: 10, color: 'var(--muted)' }}>customer count</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="uppercase-label mb-2">Items</div>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="—"
                value={items}
                onChange={e => setItems(e.target.value)}
              />
            </div>
            <div>
              <div className="uppercase-label mb-2">Units</div>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="—"
                value={units}
                onChange={e => setUnits(e.target.value)}
              />
            </div>
          </div>

          <div>
            <div className="uppercase-label mb-2">Notes (optional)</div>
            <input
              className="input"
              placeholder="Anything notable…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              style={{ fontFamily: 'inherit' }}
            />
          </div>
        </div>

        {!fromSummary && (
          <div className="mt-5">
            <div className="uppercase-label mb-2">Decline reasons (if declining — pick all that apply)</div>
            <div className="flex flex-wrap gap-2">
              {DECLINE_REASONS.map(r => {
                const active = declineReasons.includes(r.val);
                return (
                  <button
                    key={r.val}
                    type="button"
                    onClick={() => setDeclineReasons(prev => active ? prev.filter(x => x !== r.val) : [...prev, r.val])}
                    className={`chip ${active ? 'chip-active' : ''}`}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex gap-3 mt-6 mb-8">
          {!fromSummary && (
            <button
              className="btn-decline"
              onClick={() => submit(false)}
              disabled={!canSave}
              style={{ opacity: canSave ? 1 : 0.4 }}
            >
              <X size={18} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
              Declined
            </button>
          )}
          <button
            className="btn-accept"
            onClick={() => submit(true)}
            disabled={!canSave}
            style={{ opacity: canSave ? 1 : 0.4 }}
          >
            <Check size={18} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            Accepted
          </button>
        </div>
      </div>
    </div>
  );
}

function BatchList({ batches, onDelete, onReconcile, onViewImages }) {
  const [filter, setFilter] = useState('all'); // 'all' | 'accepted' | 'declined'

  const filtered = useMemo(() => {
    if (filter === 'accepted') return batches.filter(b => b.accepted);
    if (filter === 'declined') return batches.filter(b => !b.accepted);
    return batches;
  }, [batches, filter]);

  return (
    <div>
      <div className="px-5 pt-8 pb-4">
        <div className="uppercase-label">All batches</div>
        <div className="display mt-1" style={{ fontSize: 36, fontWeight: 600, lineHeight: 1 }}>
          {batches.length}
        </div>
      </div>
      <div className="px-5 mb-4 flex gap-2">
        {['all', 'accepted', 'declined'].map(f => (
          <button
            key={f}
            className={`chip ${filter === f ? 'chip-active' : ''}`}
            onClick={() => setFilter(f)}
            style={{ textTransform: 'capitalize' }}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="px-5 space-y-2">
        {filtered.length === 0 ? (
          <div className="card p-8 text-center" style={{ color: 'var(--muted)' }}>
            Nothing here yet
          </div>
        ) : (
          filtered.map(b => <BatchRow key={b.id} batch={b} onDelete={onDelete} onReconcile={onReconcile} onViewImages={onViewImages} />)
        )}
      </div>
    </div>
  );
}

const TYPE_FILTERS = [
  { val: 'all', label: 'All', short: 'All' },
  { val: 'shop_deliver', label: 'Shop & deliver', short: 'SAD' },
  { val: 'shop_only', label: 'Shop only', short: 'SO' },
  { val: 'delivery_only', label: 'Delivery only', short: 'DO' },
  { val: 'mixed', label: 'Mixed', short: 'Mix' }
];

// ──────────────────────────────────────────────────────────
// Expense components
// ──────────────────────────────────────────────────────────

function SettingsModal({ batches, expenses, user, onCancel, onImported, onSignOut }) {
  const [busy, setBusy] = useState(null); // 'export' | 'import' | null
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // { json, summary } awaiting confirm

  const handleExport = async () => {
    setError(null); setMessage(null); setBusy('export');
    try {
      const payload = await buildExport(batches, expenses);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `batchwise-export-${ymd}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`Exported ${payload.batches.length} batch${payload.batches.length === 1 ? '' : 'es'} and ${payload.expenses.length} expense${payload.expenses.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setError(e.message || 'Export failed');
    } finally {
      setBusy(null);
    }
  };

  const handlePickFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null); setMessage(null); setBusy('import');
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      // Compute counts for the confirmation prompt without mutating anything yet.
      if (!json || json.format !== EXPORT_FORMAT) {
        throw new Error('Not a Batchwise export file');
      }
      const importedBatches = Array.isArray(json.batches) ? json.batches : [];
      const importedExpenses = Array.isArray(json.expenses) ? json.expenses : [];
      const existingBatchIds = new Set(batches.map(b => b.id));
      const existingExpenseIds = new Set(expenses.map(e => e.id));
      const summary = {
        totalBatches: importedBatches.length,
        totalExpenses: importedExpenses.length,
        newBatches: importedBatches.filter(b => b && b.id && !existingBatchIds.has(b.id)).length,
        newExpenses: importedExpenses.filter(e => e && e.id && !existingExpenseIds.has(e.id)).length
      };
      setPending({ json, summary });
    } catch (e) {
      setError(e.message || 'Could not read that file');
    } finally {
      setBusy(null);
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    setError(null); setBusy('import');
    try {
      const result = await applyImport(pending.json, batches, expenses);
      await onImported(result);
      const updated = result.updatedBatches + result.updatedExpenses;
      const added = result.addedBatches + result.addedExpenses;
      setMessage(`Imported. ${added} added, ${updated} updated.`);
      setPending(null);
    } catch (e) {
      setError(e.message || 'Import failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal">
      <div className="px-5 pt-6 pb-4 flex items-center justify-between" style={{ background: 'var(--bg)' }}>
        <button onClick={onCancel} className="btn-ghost" style={{ padding: '8px 14px', fontSize: 14 }}>
          <ArrowLeft size={16} style={{ display: 'inline', marginRight: 4 }} /> Close
        </button>
        <div className="display" style={{ fontSize: 22, fontWeight: 700 }}>Settings</div>
        <div style={{ width: 80 }} />
      </div>

      <div className="px-5">
        {user && (
          <div className="card p-4 mb-4">
            <div className="uppercase-label mb-2">Account</div>
            <div style={{ fontSize: 14, color: 'var(--ink)', fontWeight: 600 }}>{user.email}</div>
            <button
              onClick={onSignOut}
              className="btn-ghost mt-3"
              style={{ width: '100%', color: 'var(--red)', borderColor: 'var(--red-soft)' }}
            >
              Sign out
            </button>
          </div>
        )}
        <div className="card p-4 mb-4">
          <div className="uppercase-label mb-2">Backup &amp; transfer</div>
          <div style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.4, marginBottom: 12 }}>
            Export downloads a single JSON file with every batch and expense (including images) so you can keep your own backups, switch devices, or restore data after a sign-in. Re-importing the same file is safe — entries merge by id, newer wins.
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleExport}
              className="btn-primary"
              disabled={busy !== null}
              style={{ flex: 1, background: 'var(--accent)', minWidth: 140, opacity: busy ? 0.5 : 1 }}
            >
              <Download size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
              {busy === 'export' ? 'Exporting…' : 'Export data'}
            </button>
            <label
              className="btn-ghost"
              style={{ flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '12px', fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
            >
              <Upload size={14} />
              {busy === 'import' && !pending ? 'Reading…' : 'Import data'}
              <input
                type="file"
                accept="application/json,.json"
                onChange={handlePickFile}
                disabled={busy !== null}
                style={{ display: 'none' }}
              />
            </label>
          </div>
          <div className="mono mt-2" style={{ fontSize: 11, color: 'var(--muted)' }}>
            {batches.length} batch{batches.length === 1 ? '' : 'es'} · {expenses.length} expense{expenses.length === 1 ? '' : 's'} currently on this device.
          </div>
        </div>

        {pending && (
          <div className="card p-4 mb-4" style={{ background: 'var(--accent-soft)', borderColor: 'transparent' }}>
            <div className="uppercase-label mb-2" style={{ color: 'var(--accent)' }}>Confirm import</div>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.4 }}>
              Found {pending.summary.totalBatches} batch{pending.summary.totalBatches === 1 ? '' : 'es'} and {pending.summary.totalExpenses} expense{pending.summary.totalExpenses === 1 ? '' : 's'} in the file.
              {' '}{pending.summary.newBatches + pending.summary.newExpenses > 0
                ? `${pending.summary.newBatches + pending.summary.newExpenses} are new to this device.`
                : 'All entries already exist locally; the import will refresh any with newer timestamps.'}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => setPending(null)}
                className="btn-ghost"
                style={{ flex: 1, padding: '10px', fontSize: 13 }}
                disabled={busy !== null}
              >
                Cancel
              </button>
              <button
                onClick={confirmImport}
                className="btn-primary"
                style={{ flex: 1, padding: '10px', fontSize: 13, background: 'var(--accent)', opacity: busy ? 0.5 : 1 }}
                disabled={busy !== null}
              >
                {busy === 'import' ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        )}

        {message && (
          <div className="card p-3 mb-4" style={{ background: 'var(--green-soft)', borderColor: 'transparent', color: 'var(--green)', fontSize: 13 }}>
            <Check size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
            {message}
          </div>
        )}
        {error && (
          <div className="card p-3 mb-8" style={{ background: 'var(--red-soft)', borderColor: 'transparent', color: 'var(--red)', fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function LogChooser({ onPickBatch, onPickBulk, onPickExpense, onCancel }) {
  return (
    <>
      <div className="modal-bg" onClick={onCancel} />
      <div
        style={{
          position: 'fixed', left: 0, right: 0,
          bottom: 'calc(env(safe-area-inset-bottom, 0) + 16px)',
          zIndex: 52, padding: '0 16px',
          animation: 'slideUp 0.18s ease-out'
        }}
      >
        <div className="card-strong p-3" style={{ background: 'var(--surface)' }}>
          <div className="uppercase-label mb-2" style={{ textAlign: 'center' }}>What are you logging?</div>
          <div className="space-y-2">
            <button onClick={onPickBatch} className="btn-primary" style={{ background: 'var(--accent)' }}>
              Log batch
            </button>
            <button onClick={onPickExpense} className="btn-ghost" style={{ width: '100%' }}>
              Log expense
            </button>
            <button onClick={onPickBulk} className="btn-ghost" style={{ width: '100%' }}>
              Bulk import
            </button>
            <button onClick={onCancel} className="btn-ghost" style={{ width: '100%', borderColor: 'transparent', color: 'var(--muted)' }}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function ExpenseRow({ expense, onEdit, onDelete, onViewImage }) {
  const meta = CATEGORY_META[expense.category] || CATEGORY_META.other;
  const borderColor = meta.color
    ? `var(--type-${meta.color})`
    : 'var(--border)';
  const dt = new Date(expenseTime(expense));
  const dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="card p-4 fade-in" style={{ borderLeft: `4px solid ${borderColor}` }}>
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex-1 min-w-0"
          onClick={onEdit ? () => onEdit(expense) : undefined}
          style={{ cursor: onEdit ? 'pointer' : 'default' }}
        >
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={meta.color ? `pill pill-type-${meta.color}` : 'pill'} style={!meta.color ? { background: 'var(--surface-2)', color: 'var(--ink-soft)' } : undefined}>
              {meta.label}
            </span>
            <span style={{ fontSize: 13, color: 'var(--muted)', marginLeft: 'auto' }}>
              {dateStr} · {timeStr}
            </span>
          </div>
          <div className="display" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2 }}>
            {fmt$(expense.amount)}
            {expense.vendor && <span style={{ color: 'var(--muted)', fontSize: 15, fontWeight: 400 }}> · {expense.vendor}</span>}
          </div>
          {expense.notes && (
            <div className="mono mt-1" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {expense.notes}
            </div>
          )}
          {expense.receiptImage && (
            <div
              style={{ display: 'flex', gap: 6, marginTop: 10, cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); onViewImage?.([expense.receiptImage]); }}
              role="button"
            >
              <img
                src={expense.receiptImage}
                alt="receipt"
                style={{ height: 56, width: 'auto', borderRadius: 6, border: '1px solid var(--border-soft)' }}
              />
            </div>
          )}
        </div>
        {onDelete && (
          <button
            onClick={() => onDelete(expense.id)}
            style={{ background: 'none', border: 'none', padding: 6, color: 'var(--muted)', cursor: 'pointer' }}
            aria-label="Delete"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function ExpenseForm({ initialExpense, onSave, onCancel }) {
  const isEdit = !!initialExpense;
  const [category, setCategory] = useState(initialExpense?.category || 'gas');
  const [amount, setAmount] = useState(initialExpense ? String(initialExpense.amount) : '');
  const [vendor, setVendor] = useState(initialExpense?.vendor || '');
  const [notes, setNotes] = useState(initialExpense?.notes || '');
  const [receiptImage, setReceiptImage] = useState(initialExpense?.receiptImage || null);

  const initialDt = initialExpense ? new Date(initialExpense.occurredAt || Date.now()) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const localIsoString = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const [occurredLocal, setOccurredLocal] = useState(localIsoString(initialDt));

  const canSave = amount && !isNaN(parseFloat(amount)) && parseFloat(amount) >= 0;

  const handleReceipt = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const compressed = await downscaleImage(String(reader.result));
        setReceiptImage(compressed);
      } catch (err) {
        console.error('receipt compress failed', err);
      }
    };
    reader.readAsDataURL(file);
  };

  const submit = () => {
    const occurredAt = Date.parse(occurredLocal) || Date.now();
    const expense = {
      id: initialExpense?.id || crypto.randomUUID(),
      occurredAt,
      loggedAt: initialExpense?.loggedAt || Date.now(),
      category,
      amount: parseFloat(amount),
      vendor: vendor || null,
      notes: notes || null,
      mileageRelated: !!CATEGORY_META[category]?.mileageRelated,
      receiptImage
    };
    onSave(expense);
  };

  return (
    <div className="modal">
      <div className="px-5 pt-6 pb-4 flex items-center justify-between" style={{ background: 'var(--bg)' }}>
        <button onClick={onCancel} className="btn-ghost" style={{ padding: '8px 14px', fontSize: 14 }}>
          <ArrowLeft size={16} style={{ display: 'inline', marginRight: 4 }} /> Cancel
        </button>
        <div className="display" style={{ fontSize: 22, fontWeight: 700 }}>{isEdit ? 'Edit expense' : 'Log expense'}</div>
        <div style={{ width: 80 }} />
      </div>

      <div className="px-5 space-y-4">
        <div>
          <div className="uppercase-label mb-2">Category</div>
          <div className="flex flex-wrap gap-2">
            {EXPENSE_CATEGORIES.map(c => (
              <button
                key={c.val}
                onClick={() => setCategory(c.val)}
                className={`chip ${category === c.val ? 'chip-active' : ''}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="uppercase-label mb-2">Amount</div>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 14, top: 14, color: 'var(--muted-soft)', fontSize: 16, fontWeight: 600 }}>$</span>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              style={{ paddingLeft: 28 }}
            />
          </div>
        </div>

        <div>
          <div className="uppercase-label mb-2">When</div>
          <input
            className="input"
            type="datetime-local"
            value={occurredLocal}
            onChange={e => setOccurredLocal(e.target.value)}
          />
        </div>

        <div>
          <div className="uppercase-label mb-2">Vendor (optional)</div>
          {category === 'gas' && (
            <div className="flex flex-wrap gap-2 mb-2">
              {GAS_VENDORS.map(v => (
                <button
                  key={v}
                  onClick={() => setVendor(v === 'Other' ? '' : v)}
                  className={`chip ${vendor === v ? 'chip-active' : ''}`}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          <input
            className="input"
            placeholder={category === 'gas' ? 'Or type a station name…' : 'e.g. Walmart, McDonald\'s'}
            value={vendor}
            onChange={e => setVendor(e.target.value)}
            style={{ fontFamily: 'inherit' }}
          />
        </div>

        <div>
          <div className="uppercase-label mb-2">Notes (optional)</div>
          <input
            className="input"
            placeholder="Anything notable…"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            style={{ fontFamily: 'inherit' }}
          />
        </div>

        <div>
          <div className="uppercase-label mb-2">Receipt (optional)</div>
          {receiptImage ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <img
                src={receiptImage}
                alt="receipt"
                style={{ height: 88, width: 'auto', borderRadius: 8, border: '1px solid var(--border)' }}
              />
              <button
                onClick={() => setReceiptImage(null)}
                className="btn-ghost"
                style={{ padding: '8px 14px', fontSize: 12 }}
              >
                Remove
              </button>
            </div>
          ) : (
            <label className="btn-ghost" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', fontSize: 13, cursor: 'pointer', width: '100%' }}>
              <Camera size={14} />
              Add receipt photo
              <input
                type="file"
                accept="image/*"
                onChange={handleReceipt}
                style={{ display: 'none' }}
              />
            </label>
          )}
        </div>

        <button
          className="btn-primary mt-4 mb-8"
          onClick={submit}
          disabled={!canSave}
          style={{ opacity: canSave ? 1 : 0.4, background: 'var(--accent)' }}
        >
          {isEdit ? 'Save changes' : 'Save expense'}
        </button>
      </div>
    </div>
  );
}

function ExpenseList({ expenses, onEdit, onDelete, onViewImage }) {
  const [filter, setFilter] = useState('all'); // 'all' | category val
  const filtered = useMemo(() => {
    if (filter === 'all') return expenses;
    return expenses.filter(e => e.category === filter);
  }, [expenses, filter]);

  const total = useMemo(
    () => filtered.reduce((s, e) => s + (Number(e.amount) || 0), 0),
    [filtered]
  );

  return (
    <div>
      <div className="px-5 pt-8 pb-4">
        <div className="uppercase-label">All expenses</div>
        <div className="display mt-1" style={{ fontSize: 36, fontWeight: 700, lineHeight: 1 }}>
          {fmt$(total)}
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
          {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
        </div>
      </div>
      <div className="px-5 mb-4 flex gap-2 flex-wrap">
        <button
          className={`chip ${filter === 'all' ? 'chip-active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All <span style={{ opacity: 0.6, marginLeft: 4 }}>{expenses.length}</span>
        </button>
        {EXPENSE_CATEGORIES.map(c => {
          const count = expenses.filter(e => e.category === c.val).length;
          if (count === 0) return null;
          return (
            <button
              key={c.val}
              className={`chip ${filter === c.val ? 'chip-active' : ''}`}
              onClick={() => setFilter(c.val)}
            >
              {c.label} <span style={{ opacity: 0.6, marginLeft: 4 }}>{count}</span>
            </button>
          );
        })}
      </div>
      <div className="px-5 space-y-2">
        {filtered.length === 0 ? (
          <div className="card p-8 text-center" style={{ color: 'var(--muted)' }}>
            {expenses.length === 0 ? 'No expenses logged yet' : 'Nothing in this category'}
          </div>
        ) : (
          filtered.map(e => (
            <ExpenseRow
              key={e.id}
              expense={e}
              onEdit={onEdit}
              onDelete={onDelete}
              onViewImage={onViewImage}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Insights({ batches, expenses }) {
  const [typeFilter, setTypeFilter] = useState('all');
  const [rangeFilter, setRangeFilter] = useState('all');
  const [showMoreBuckets, setShowMoreBuckets] = useState(false);

  const RANGES = [
    { val: 'all',   label: 'All',   days: null },
    { val: 'day',   label: 'Day',   days: 1 },
    { val: 'week',  label: 'Week',  days: 7 },
    { val: 'month', label: 'Month', days: 30 },
    { val: 'year',  label: 'Year',  days: 365 }
  ];

  const rangeSince = useMemo(() => {
    if (rangeFilter === 'all') return null;
    if (rangeFilter === 'day') return new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const days = (RANGES.find(r => r.val === rangeFilter) || {}).days || 0;
    return Date.now() - days * 24 * 60 * 60 * 1000;
  }, [rangeFilter]);

  const typeCounts = useMemo(() => {
    const counts = { shop_deliver: 0, shop_only: 0, delivery_only: 0, mixed: 0 };
    batches.forEach(b => { if (b.type && counts[b.type] != null) counts[b.type]++; });
    return counts;
  }, [batches]);

  const filtered = useMemo(() => {
    let pool = rangeSince == null ? batches : batches.filter(b => batchTime(b) >= rangeSince);
    if (typeFilter === 'all') return pool;
    return pool.filter(b => b.type === typeFilter);
  }, [batches, typeFilter, rangeSince]);

  const filteredExpenses = useMemo(() => {
    if (rangeSince == null) return expenses || [];
    return (expenses || []).filter(e => expenseTime(e) >= rangeSince);
  }, [expenses, rangeSince]);

  const insights = useMemo(() => {
    if (filtered.length < 3) return null;


    const buckets = showMoreBuckets ? [
      { label: '< $10', min: 0, max: 10 },
      { label: '$10–15', min: 10, max: 15 },
      { label: '$15–20', min: 15, max: 20 },
      { label: '$20–25', min: 20, max: 25 },
      { label: '$25–30', min: 25, max: 30 },
      { label: '$30–40', min: 30, max: 40 },
      { label: '$40–50', min: 40, max: 50 },
      { label: '$50+', min: 50, max: Infinity }
    ] : [
      { label: '< $10', min: 0, max: 10 },
      { label: '$10–15', min: 10, max: 15 },
      { label: '$15–20', min: 15, max: 20 },
      { label: '$20–25', min: 20, max: 25 },
      { label: '$25–30', min: 25, max: 30 },
      { label: '$30+', min: 30, max: Infinity }
    ];
    const bucketStats = buckets.map(b => {
      const inBucket = filtered.filter(x => x.pay >= b.min && x.pay < b.max);
      const accepted = inBucket.filter(x => x.accepted).length;
      return {
        ...b,
        offered: inBucket.length,
        accepted,
        rate: inBucket.length ? accepted / inBucket.length : 0
      };
    }).filter(b => b.offered > 0);

    const byDay = {};
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => byDay[d] = { totalPay: 0, totalMin: 0, count: 0 });
    filtered.filter(b => b.accepted && bestMinutes(b) != null).forEach(b => {
      const day = dayName(batchTime(b));
      byDay[day].totalPay += b.pay || 0;
      byDay[day].totalMin += bestMinutes(b);
      byDay[day].count++;
    });
    const dayStats = Object.entries(byDay).map(([day, s]) => ({
      day,
      perHour: s.totalMin ? s.totalPay / (s.totalMin / 60) : null,
      count: s.count
    }));

    // Decline reasons — a batch can have multiple, so the per-reason counts may
    // sum to more than the number of declined batches. Each rate is "fraction
    // of declines tagged with this reason" and rates can sum > 100%.
    const reasonCounts = {};
    const declinedBatches = filtered.filter(b => !b.accepted);
    declinedBatches.forEach(b => {
      const reasons = reasonList(b);
      if (reasons.length === 0) {
        reasonCounts['unspecified'] = (reasonCounts['unspecified'] || 0) + 1;
      } else {
        reasons.forEach(r => {
          reasonCounts[r] = (reasonCounts[r] || 0) + 1;
        });
      }
    });
    const totalDeclined = declinedBatches.length;
    const reasonStats = Object.entries(reasonCounts)
      .map(([reason, count]) => ({
        reason,
        label: reason === 'unspecified' ? 'No reason given' : (DECLINE_REASON_LABELS[reason] || reason),
        count,
        rate: totalDeclined ? count / totalDeclined : 0
      }))
      .sort((a, b) => b.count - a.count);

    return { bucketStats, dayStats, reasonStats, totalDeclined };
  }, [filtered, showMoreBuckets]);

  const FilterChips = () => (
    <div className="px-5 mb-4 flex gap-2 flex-wrap">
      {TYPE_FILTERS.map(t => {
        const count = t.val === 'all' ? batches.length : (typeCounts[t.val] || 0);
        return (
          <button
            key={t.val}
            onClick={() => setTypeFilter(t.val)}
            className={`chip ${typeFilter === t.val ? 'chip-active' : ''}`}
            style={{ opacity: count === 0 && t.val !== 'all' ? 0.5 : 1 }}
          >
            {t.short} <span style={{ opacity: 0.6, marginLeft: 4 }}>{count}</span>
          </button>
        );
      })}
    </div>
  );

  const RangeChips = () => (
    <div className="px-5 mb-4 flex gap-2 flex-wrap">
      {RANGES.map(r => (
        <button
          key={r.val}
          onClick={() => setRangeFilter(r.val)}
          className={`chip ${rangeFilter === r.val ? 'chip-active' : ''}`}
          style={{ padding: '6px 14px', fontSize: 13 }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );

  const Header = () => (
    <div className="px-5 pt-8 pb-4">
      <div className="uppercase-label">Insights</div>
      <div className="display mt-1" style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.2 }}>
        What the data says
      </div>
    </div>
  );

  if (batches.length === 0) {
    return (
      <div>
        <Header />
        <div className="px-5">
          <div className="card p-8 text-center mt-4">
            <TrendingUp size={28} style={{ color: 'var(--muted)', margin: '0 auto 12px' }} />
            <div style={{ fontSize: 15, fontWeight: 500 }}>No batches yet</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              Log a few to see patterns
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!insights) {
    return (
      <div>
        <Header />
        <FilterChips />
        <RangeChips />
        <div className="px-5">
          <div className="card p-8 text-center">
            <TrendingUp size={28} style={{ color: 'var(--muted)', margin: '0 auto 12px' }} />
            <div style={{ fontSize: 15, fontWeight: 500 }}>Not enough data yet</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
              Need at least 3 batches{typeFilter !== 'all' ? ` of type ${TYPE_FILTERS.find(t => t.val === typeFilter)?.label}` : ''} to see patterns
            </div>
          </div>
        </div>
      </div>
    );
  }

  const maxDay = Math.max(...insights.dayStats.map(d => d.perHour || 0), 0.01);

  return (
    <div>
      <Header />
      <FilterChips />
      <RangeChips />

      {typeFilter === 'all' && (
        <div className="px-5 mb-4">
          <div className="card p-3" style={{ background: 'var(--accent-soft)', borderColor: 'transparent', fontSize: 12, color: 'var(--ink-soft)' }}>
            Mixed types: $/hr and $/mile averages combine shop, deliver, and shop-only batches. Pick a single type above for comparable stats.
          </div>
        </div>
      )}

      <div className="px-5 mb-6">
        <div className="uppercase-label mb-3">Accept rate by pay</div>
        <div className="card p-4 space-y-3">
          {insights.bucketStats.map((b, i) => (
            <div
              key={b.label}
              className={i >= 6 ? 'fade-in' : ''}
            >
              <div className="flex justify-between items-baseline mb-1">
                <span style={{ fontSize: 14, fontWeight: 500 }}>{b.label}</span>
                <span className="mono" style={{ fontSize: 13 }}>
                  {(b.rate * 100).toFixed(0)}% <span style={{ color: 'var(--muted)' }}>· {b.offered}</span>
                </span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${b.rate * 100}%`, background: 'var(--green)' }} />
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setShowMoreBuckets(v => !v)}
            style={{
              marginTop: 4, padding: '4px 0', background: 'none', border: 'none',
              color: 'var(--accent)', fontSize: 12, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit', alignSelf: 'flex-start'
            }}
          >
            {showMoreBuckets ? 'Show fewer brackets' : 'Show more brackets ($30–40, $40–50, $50+)'}
          </button>
        </div>
      </div>

      <div className="px-5 mb-6">
        <div className="uppercase-label mb-3">$/hr by day</div>
        <div className="card p-4">
          <div className="flex items-end gap-2" style={{ height: 200 }}>
            {insights.dayStats.map(d => (
              <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, height: '100%' }}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%', minHeight: 0 }}>
                  <div style={{
                    width: '100%',
                    height: d.perHour ? `${Math.max(6, (d.perHour / maxDay) * 100)}%` : '4px',
                    background: d.perHour ? 'var(--accent)' : 'var(--border)',
                    borderRadius: '6px 6px 0 0',
                    transition: 'height 0.25s ease'
                  }} />
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{d.day}</div>
                <div className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
                  {d.perHour ? `$${d.perHour.toFixed(0)}` : '—'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {insights.totalDeclined > 0 && (
        <div className="px-5 mb-6">
          <div className="uppercase-label mb-3">
            Why you decline · {insights.totalDeclined} total
          </div>
          <div className="card p-4 space-y-3">
            {insights.reasonStats.map(r => (
              <div key={r.reason}>
                <div className="flex justify-between items-baseline mb-1">
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{r.label}</span>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {r.count} <span style={{ color: 'var(--muted)' }}>· {(r.rate * 100).toFixed(0)}%</span>
                  </span>
                </div>
                <div className="bar">
                  <div className="bar-fill" style={{ width: `${r.rate * 100}%`, background: 'var(--red)' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ExpensesInsightPanel expenses={filteredExpenses} />
    </div>
  );
}

function ExpensesInsightPanel({ expenses }) {
  const stats = useMemo(() => {
    if (!expenses || expenses.length === 0) return null;
    const total = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const byCat = {};
    for (const e of expenses) {
      const k = e.category || 'other';
      if (!byCat[k]) byCat[k] = { amount: 0, count: 0 };
      byCat[k].amount += Number(e.amount) || 0;
      byCat[k].count += 1;
    }
    const rows = Object.entries(byCat)
      .map(([cat, s]) => ({ cat, ...s, share: total ? s.amount / total : 0 }))
      .sort((a, b) => b.amount - a.amount);
    return { total, rows, count: expenses.length };
  }, [expenses]);

  if (!stats) return null;

  return (
    <div className="px-5 mb-6">
      <div className="uppercase-label mb-3">
        Expenses · {stats.count} {stats.count === 1 ? 'entry' : 'entries'} · {fmt$$(stats.total)} total
      </div>
      <div className="card p-4 space-y-3">
        {stats.rows.map(r => {
          const meta = CATEGORY_META[r.cat] || CATEGORY_META.other;
          const fillColor = meta.color ? `var(--type-${meta.color})` : 'var(--muted)';
          return (
            <div key={r.cat}>
              <div className="flex justify-between items-baseline mb-1">
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {meta.label}
                </span>
                <span className="mono" style={{ fontSize: 13 }}>
                  {fmt$(r.amount)} <span style={{ color: 'var(--muted)' }}>· {(r.share * 100).toFixed(0)}% · {r.count}</span>
                </span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${r.share * 100}%`, background: fillColor }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Auth form
// ──────────────────────────────────────────────────────────

function AuthForm({ onAuthed }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!email.includes('@')) { setError('Enter a valid email'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setBusy(true);
    try {
      const user = mode === 'signup'
        ? await auth.signup(email, password)
        : await auth.login(email, password);
      onAuthed(user);
    } catch (err) {
      setError(err.message || 'Something went wrong');
      setBusy(false);
    }
  };

  return (
    <>
      <Theme />
      <div className="app" style={{ paddingBottom: 24 }}>
        <div className="px-5 pt-8" style={{ maxWidth: 480, margin: '0 auto' }}>
          <div className="display" style={{ fontSize: 36, fontWeight: 700, marginBottom: 4 }}>
            Batchwise
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 24 }}>
            {mode === 'login' ? 'Sign in to your account.' : 'Create your account to start tracking.'}
          </div>

          <form onSubmit={submit} className="card-strong p-4 space-y-4">
            <div>
              <div className="uppercase-label mb-2">Email</div>
              <input
                className="input"
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={busy}
              />
            </div>
            <div>
              <div className="uppercase-label mb-2">Password</div>
              <input
                className="input"
                type="password"
                placeholder={mode === 'signup' ? '8 characters minimum' : '••••••••'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={busy}
              />
            </div>
            {error && (
              <div className="card p-3" style={{ background: 'var(--red-soft)', borderColor: 'transparent', color: 'var(--red)', fontSize: 13 }}>
                {error}
              </div>
            )}
            <button
              type="submit"
              className="btn-primary"
              disabled={busy}
              style={{ background: 'var(--accent)', opacity: busy ? 0.5 : 1 }}
            >
              {busy
                ? (mode === 'signup' ? 'Creating account…' : 'Signing in…')
                : (mode === 'signup' ? 'Create account' : 'Sign in')}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button
              type="button"
              onClick={() => { setMode(m => m === 'login' ? 'signup' : 'login'); setError(null); }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              disabled={busy}
            >
              {mode === 'login' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────

export default function App() {
  // Auth state. 'pending' on first paint while we validate any stored token.
  // 'anonymous' shows the AuthForm. 'authenticated' renders the app.
  const [authStatus, setAuthStatus] = useState(getAuthToken() ? 'pending' : 'anonymous');
  const [user, setUser] = useState(null);

  const [batches, setBatches] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState('home'); // 'home' | 'list' | 'expenses' | 'insights'
  const [showLog, setShowLog] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [showLogChooser, setShowLogChooser] = useState(false);
  const [showExpenseLog, setShowExpenseLog] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [reconcilingBatch, setReconcilingBatch] = useState(null);
  const [viewingImagesBatch, setViewingImagesBatch] = useState(null);
  const [viewerImages, setViewerImages] = useState(null);
  const [viewingDayYmd, setViewingDayYmd] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [syncStatus, setSyncStatus] = useState(api.enabled() ? 'syncing' : 'local-only'); // 'syncing' | 'synced' | 'error' | 'local-only'

  // On mount, if there's a saved token, validate it. If valid, we're in.
  // If not (revoked, expired, server reset), drop to AuthForm.
  useEffect(() => {
    if (authStatus !== 'pending') return;
    let cancelled = false;
    (async () => {
      try {
        const me = await auth.me();
        if (cancelled) return;
        setUser(me);
        setAuthStatus('authenticated');
      } catch (e) {
        if (cancelled) return;
        setAuthToken(null);
        setUser(null);
        setAuthStatus('anonymous');
      }
    })();
    return () => { cancelled = true; };
  }, [authStatus]);

  const dashboardNetMode = (() => {
    try { return localStorage.getItem(NET_MODE_KEY) || 'actual'; }
    catch { return 'actual'; }
  })();

  // Snap to top whenever the user switches between top-level tabs.
  // Without this, scrolling down on Batches and tapping Insights lands you
  // mid-page with no context.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [view]);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    (async () => {
      // Local first, so the UI lights up instantly even on a slow network.
      const rawExpenses = await loadExpenses();
      const localExpenses = rawExpenses
        .map(e => ({ ...e, updatedAt: e.updatedAt || e.loggedAt || 0 }))
        .sort((a, b) => expenseTime(b) - expenseTime(a));
      setExpenses(localExpenses);

      const raw = await loadBatches();
      let local = raw.map(b => ({ ...b, updatedAt: b.updatedAt || b.loggedAt || 0 }));

      // Local-side backfill so we get the fix immediately even before sync.
      let localFixedCount = 0;
      local = local.map(b => {
        const [next, changed] = backfillBatch(b);
        if (changed) localFixedCount++;
        return changed ? { ...next, updatedAt: Date.now() } : b;
      });

      local = [...local].sort((a, b) => batchTime(b) - batchTime(a));
      setBatches(local);
      setLoaded(true);

      if (localFixedCount && !api.enabled()) {
        await saveBatches(local);
      }

      if (!api.enabled()) return;
      try {
        const remote = await api.list();
        let merged = mergeBatchSets(local, remote);

        // One-time client-side backfill of completedAt for any batches that
        // pre-date the backend's reconcileTimes pass. Captures everything
        // pulled from the server too, then pushes the fixes back up so other
        // devices stay consistent.
        const fixed = [];
        merged = merged.map(b => {
          const [next, changed] = backfillBatch(b);
          if (changed) fixed.push({ ...next, updatedAt: Date.now() });
          return changed ? { ...next, updatedAt: Date.now() } : b;
        });

        setBatches(merged);
        await saveBatches(merged);

        // Push any local-only batches up to the server (one-time per missing id).
        const remoteIds = new Set(remote.map(b => b.id));
        const toPush = merged.filter(b => !remoteIds.has(b.id));
        await Promise.all(toPush.map(b => api.upsert(b).catch(e => console.error('initial push', b.id, e))));

        // Push any backfill fixes up to the server too.
        if (fixed.length) {
          await Promise.all(fixed.map(b => api.upsert(b).catch(e => console.error('backfill push', b.id, e))));
        }

        // Pull and merge expenses with the same union-by-updatedAt strategy.
        try {
          const remoteExpenses = await expensesApi.list();
          const expenseMap = new Map();
          for (const e of [...localExpenses, ...remoteExpenses]) {
            const stamp = e.updatedAt || e.loggedAt || 0;
            const existing = expenseMap.get(e.id);
            if (!existing || stamp > (existing.updatedAt || existing.loggedAt || 0)) {
              expenseMap.set(e.id, e);
            }
          }
          const mergedExpenses = Array.from(expenseMap.values())
            .sort((a, b) => expenseTime(b) - expenseTime(a));
          setExpenses(mergedExpenses);
          await saveExpenses(mergedExpenses);

          const remoteExpenseIds = new Set(remoteExpenses.map(e => e.id));
          const toPushExpenses = mergedExpenses.filter(e => !remoteExpenseIds.has(e.id));
          await Promise.all(toPushExpenses.map(e =>
            expensesApi.upsert(e).catch(err => console.error('initial expense push', e.id, err))
          ));
        } catch (err) {
          console.error('expense sync on load failed', err);
        }

        setSyncStatus('synced');
      } catch (e) {
        console.error('sync on load failed', e);
        setSyncStatus('error');
      }
    })();
  }, [authStatus]);

  const pushOne = (b) => {
    if (!api.enabled()) return;
    setSyncStatus('syncing');
    api.upsert(b)
      .then(() => setSyncStatus('synced'))
      .catch(e => { console.error('push failed', e); setSyncStatus('error'); });
  };

  const removeOne = (id) => {
    if (!api.enabled()) return;
    setSyncStatus('syncing');
    api.remove(id)
      .then(() => setSyncStatus('synced'))
      .catch(e => { console.error('delete failed', e); setSyncStatus('error'); });
  };

  const sortBatches = (arr) => [...arr].sort((a, b) => batchTime(b) - batchTime(a));

  const addBatch = async (b) => {
    const stamped = { ...b, updatedAt: Date.now() };
    const next = sortBatches([stamped, ...batches]);
    setBatches(next);
    setShowLog(false);
    await saveBatches(next);
    pushOne(stamped);
  };

  const addBatchesBulk = async (incoming) => {
    if (!incoming.length) {
      setShowBulk(false);
      return;
    }
    const stamped = incoming.map(b => ({ ...b, updatedAt: Date.now() }));
    const next = sortBatches([...stamped, ...batches]);
    setBatches(next);
    setShowBulk(false);
    await saveBatches(next);
    if (api.enabled()) {
      setSyncStatus('syncing');
      Promise.all(stamped.map(b => api.upsert(b)))
        .then(() => setSyncStatus('synced'))
        .catch(e => { console.error('bulk push failed', e); setSyncStatus('error'); });
    }
  };

  const updateBatch = async (updated) => {
    const stamped = { ...updated, updatedAt: Date.now() };
    const next = sortBatches(batches.map(b => b.id === stamped.id ? stamped : b));
    setBatches(next);
    setReconcilingBatch(null);
    await saveBatches(next);
    pushOne(stamped);
  };

  const deleteBatch = async (id) => {
    const next = batches.filter(b => b.id !== id);
    setBatches(next);
    await saveBatches(next);
    deleteImages(id).catch(e => console.warn('delete IDB images failed', e));
    removeOne(id);
  };

  const sortExpenses = (arr) => [...arr].sort((a, b) => expenseTime(b) - expenseTime(a));

  const pushExpense = (e) => {
    if (!expensesApi.enabled()) return;
    setSyncStatus('syncing');
    expensesApi.upsert(e)
      .then(() => setSyncStatus('synced'))
      .catch(err => { console.error('expense push failed', err); setSyncStatus('error'); });
  };

  const removeExpenseRemote = (id) => {
    if (!expensesApi.enabled()) return;
    setSyncStatus('syncing');
    expensesApi.remove(id)
      .then(() => setSyncStatus('synced'))
      .catch(err => { console.error('expense delete failed', err); setSyncStatus('error'); });
  };

  const addExpense = async (e) => {
    const stamped = { ...e, updatedAt: Date.now() };
    const next = sortExpenses([stamped, ...expenses]);
    setExpenses(next);
    setShowExpenseLog(false);
    setEditingExpense(null);
    await saveExpenses(next);
    pushExpense(stamped);
  };

  const updateExpense = async (e) => {
    const stamped = { ...e, updatedAt: Date.now() };
    const next = sortExpenses(expenses.map(x => x.id === stamped.id ? stamped : x));
    setExpenses(next);
    setShowExpenseLog(false);
    setEditingExpense(null);
    await saveExpenses(next);
    pushExpense(stamped);
  };

  const deleteExpense = async (id) => {
    const next = expenses.filter(e => e.id !== id);
    setExpenses(next);
    await saveExpenses(next);
    deleteImages(id).catch(err => console.warn('delete IDB receipt failed', err));
    removeExpenseRemote(id);
  };

  if (authStatus === 'pending') {
    return (
      <>
        <Theme />
        <div className="app">
          <div className="flex items-center justify-center" style={{ minHeight: '60vh' }}>
            <Loader2 size={24} className="animate-spin" style={{ color: 'var(--muted)' }} />
          </div>
        </div>
      </>
    );
  }

  if (authStatus === 'anonymous') {
    return <AuthForm onAuthed={(u) => { setUser(u); setAuthStatus('authenticated'); }} />;
  }

  return (
    <>
      <Theme />
      <div className="app">
        {!loaded ? (
          <div className="flex items-center justify-center" style={{ minHeight: '60vh' }}>
            <Loader2 size={24} className="animate-spin" style={{ color: 'var(--muted)' }} />
          </div>
        ) : (
          <>
            {view === 'home' && <Dashboard batches={batches} expenses={expenses} onLog={() => setShowLog(true)} onReconcile={setReconcilingBatch} onViewImages={setViewingImagesBatch} onPickDay={setViewingDayYmd} onOpenSettings={() => setShowSettings(true)} syncStatus={syncStatus} />}
            {view === 'list' && <BatchList batches={batches} onDelete={deleteBatch} onReconcile={setReconcilingBatch} onViewImages={setViewingImagesBatch} />}
            {view === 'expenses' && (
              <ExpenseList
                expenses={expenses}
                onEdit={(e) => { setEditingExpense(e); setShowExpenseLog(true); }}
                onDelete={deleteExpense}
                onViewImage={(images) => setViewerImages(images)}
              />
            )}
            {view === 'insights' && <Insights batches={batches} expenses={expenses} />}
          </>
        )}

        {showLog && (
          <LogForm
            onSave={addBatch}
            onCancel={() => setShowLog(false)}
            onBulk={() => { setShowLog(false); setShowBulk(true); }}
          />
        )}

        {showBulk && (
          <BulkImportForm
            onSave={addBatchesBulk}
            onCancel={() => setShowBulk(false)}
          />
        )}

        {viewingImagesBatch && (
          <ImageViewer
            batch={viewingImagesBatch}
            onClose={() => setViewingImagesBatch(null)}
          />
        )}

        {reconcilingBatch && (
          <ReconcileForm
            batch={reconcilingBatch}
            onSave={updateBatch}
            onCancel={() => setReconcilingBatch(null)}
          />
        )}

        {showExpenseLog && (
          <ExpenseForm
            initialExpense={editingExpense}
            onSave={editingExpense ? updateExpense : addExpense}
            onCancel={() => { setShowExpenseLog(false); setEditingExpense(null); }}
          />
        )}

        {showLogChooser && (
          <LogChooser
            onPickBatch={() => { setShowLogChooser(false); setShowLog(true); }}
            onPickExpense={() => { setShowLogChooser(false); setEditingExpense(null); setShowExpenseLog(true); }}
            onPickBulk={() => { setShowLogChooser(false); setShowBulk(true); }}
            onCancel={() => setShowLogChooser(false)}
          />
        )}

        {viewerImages && (
          <ImageViewer
            batch={{ images: viewerImages }}
            onClose={() => setViewerImages(null)}
          />
        )}

        {viewingDayYmd && (
          <DayDetailModal
            ymd={viewingDayYmd}
            batches={batches}
            expenses={expenses}
            netMode={dashboardNetMode}
            onClose={() => setViewingDayYmd(null)}
            onReconcile={setReconcilingBatch}
            onViewImages={(b) => setViewingImagesBatch(b)}
            onEditExpense={(e) => { setEditingExpense(e); setShowExpenseLog(true); setViewingDayYmd(null); }}
            onDeleteExpense={deleteExpense}
          />
        )}

        {showSettings && (
          <SettingsModal
            batches={batches}
            expenses={expenses}
            user={user}
            onCancel={() => setShowSettings(false)}
            onSignOut={async () => {
              await auth.logout();
              setShowSettings(false);
              setBatches([]);
              setExpenses([]);
              setLoaded(false);
              setUser(null);
              setAuthStatus('anonymous');
              try {
                localStorage.removeItem(STORAGE_KEY);
                localStorage.removeItem(EXPENSES_STORAGE_KEY);
              } catch { /* ignore */ }
            }}
            onImported={async ({ nextBatches, nextExpenses }) => {
              const sortedBatches = [...nextBatches].sort((a, b) => batchTime(b) - batchTime(a));
              const sortedExpenses = [...nextExpenses].sort((a, b) => expenseTime(b) - expenseTime(a));
              setBatches(sortedBatches);
              setExpenses(sortedExpenses);
              await saveBatches(sortedBatches);
              await saveExpenses(sortedExpenses);
              if (api.enabled()) {
                setSyncStatus('syncing');
                await Promise.all(sortedBatches.map(b => api.upsert(b).catch(e => console.error('post-import push', b.id, e))))
                  .catch(() => {});
                await Promise.all(sortedExpenses.map(e => expensesApi.upsert(e).catch(err => console.error('post-import push expense', e.id, err))))
                  .catch(() => {});
                setSyncStatus('synced');
              }
            }}
          />
        )}

        {!showLog && !showBulk && !showExpenseLog && !showLogChooser && !viewingDayYmd && !showSettings && (
          <button className="fab" onClick={() => setShowLogChooser(true)} aria-label="Log">
            <Plus size={28} />
          </button>
        )}

        <nav className="nav">
          <div
            className={`nav-item ${view === 'home' ? 'nav-item-active' : ''}`}
            onClick={() => setView('home')}
          >
            <Home size={20} />
            <span>Home</span>
          </div>
          <div
            className={`nav-item ${view === 'list' ? 'nav-item-active' : ''}`}
            onClick={() => setView('list')}
          >
            <List size={20} />
            <span>Batches</span>
          </div>
          <div
            className={`nav-item ${view === 'expenses' ? 'nav-item-active' : ''}`}
            onClick={() => setView('expenses')}
          >
            <DollarSign size={20} />
            <span>Expenses</span>
          </div>
          <div
            className={`nav-item ${view === 'insights' ? 'nav-item-active' : ''}`}
            onClick={() => setView('insights')}
          >
            <BarChart2 size={20} />
            <span>Insights</span>
          </div>
        </nav>
      </div>
    </>
  );
}

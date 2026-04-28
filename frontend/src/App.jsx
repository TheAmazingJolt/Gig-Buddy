import React, { useState, useEffect, useMemo } from 'react';
import {
  Plus, Check, X, BarChart2, List, Home, Trash2,
  Loader2, TrendingUp, ArrowLeft, Sparkles, ClipboardPaste, Camera, Cloud, CloudOff
} from 'lucide-react';
import { api, extractMulti } from './api';

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
  const ms = Date.parse(v);
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

const DEFAULT_STORES = [
  'Costco', 'Aldi', 'Sprouts', 'Publix', 'Wegmans', 'Kroger',
  'Safeway', "Trader Joe's", 'Whole Foods', "Sam's Club",
  "BJ's", 'Target', 'CVS', 'Petco', 'Other'
];

const DECLINE_REASONS = [
  { val: 'too_far',         label: 'Too far' },
  { val: 'pay_low',         label: 'Pay too low' },
  { val: 'too_many_items',  label: 'Too many items' },
  { val: 'bad_time',        label: 'Bad time' },
  { val: 'cherry_pick',     label: 'Cherry-pick' },
  { val: 'other',           label: 'Other' }
];
const DECLINE_REASON_LABELS = Object.fromEntries(DECLINE_REASONS.map(r => [r.val, r.label]));
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

async function loadBatches() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { /* corrupt or unavailable */ }
  return [];
}

async function saveBatches(batches) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(batches));
  } catch (e) {
    console.error('save failed', e);
  }
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

function Header({ batches, syncStatus }) {
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const todayBatches = batches.filter(b => batchTime(b) >= startOfDay);
  const todayAccepted = todayBatches.filter(b => b.accepted);
  const todayPay = todayAccepted.reduce((s, b) => s + (b.pay || 0), 0);
  const todayMiles = todayAccepted.reduce((s, b) => s + (b.miles || 0), 0);

  return (
    <div className="px-5 pt-8 pb-4">
      <div className="flex items-center justify-between">
        <div className="uppercase-label">{todayStr}</div>
        <SyncIndicator status={syncStatus} />
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

function Dashboard({ batches, onLog, onReconcile, onViewImages, syncStatus }) {
  const [rangeFilter, setRangeFilter] = useState('week'); // 'week' | 'month' | 'year'
  const RANGES = [
    { val: 'week',  label: 'Week',  days: 7 },
    { val: 'month', label: 'Month', days: 30 },
    { val: 'year',  label: 'Year',  days: 365 }
  ];
  const rangeDays = (RANGES.find(r => r.val === rangeFilter) || RANGES[0]).days;

  const stats = useMemo(() => {
    const since = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
    const inRange = batches.filter(b => batchTime(b) >= since);
    const accepted = inRange.filter(b => b.accepted);
    const totalPay = accepted.reduce((s, b) => s + (b.pay || 0), 0);
    const totalMin = accepted.reduce((s, b) => s + (bestMinutes(b) || 0), 0);
    const totalMiles = accepted.reduce((s, b) => s + (b.miles || 0), 0);

    return {
      acceptRate: inRange.length ? (accepted.length / inRange.length) * 100 : null,
      perHour: totalMin ? totalPay / (totalMin / 60) : null,
      perMile: totalMiles ? totalPay / totalMiles : null,
      totalPay,
      totalMiles,
      count: accepted.length,
      offered: inRange.length
    };
  }, [batches, rangeDays]);

  const recent = batches.slice(0, 5);

  return (
    <div>
      <Header batches={batches} syncStatus={syncStatus} />

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
          <div className="uppercase-label">Last {rangeDays} days</div>
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
          <div className="space-y-2">
            {recent.map(b => <BatchRow key={b.id} batch={b} onReconcile={onReconcile} onViewImages={onViewImages} />)}
          </div>
        )}
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
            {fmt$(batch.pay)} <span style={{ color: 'var(--muted)', fontSize: 15, fontWeight: 400 }}>· {batch.store || '—'}</span>
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
    setShots(prev => [...prev, ...next].slice(0, 20).sort((a, b) => new Date(a.takenAt) - new Date(b.takenAt)));
  };

  const removeShot = (idx) => setShots(prev => prev.filter((_, i) => i !== idx));

  const handleExtract = async () => {
    if (!shots.length) return;
    setError(null);
    setPhase('extracting');
    try {
      const result = await extractMulti(shots.map(s => ({
        data: s.base64,
        mediaType: s.mediaType,
        takenAt: s.takenAt
      })));
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
      setPhase('review');
    } catch (err) {
      setError(err.message || 'Extraction failed');
      setPhase('upload');
    }
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
          <div className="card p-8 text-center">
            <Loader2 size={28} className="animate-spin" style={{ color: 'var(--muted)', margin: '0 auto 12px' }} />
            <div style={{ fontSize: 15, fontWeight: 500 }}>Extracting…</div>
            <div className="mono mt-1" style={{ fontSize: 12, color: 'var(--muted)' }}>
              Grouping {shots.length} images into batches
            </div>
          </div>
        )}

        {phase === 'review' && (
          <>
            {meta.indexFound ? (
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
            ) : (
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
      const url = EXTRACTOR_URL.replace(/\/$/, '') + '/extract';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: shots.map(s => ({ data: s.base64, mediaType: s.mediaType }))
        })
      });
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
      setExtractError(err.message || 'Extraction failed');
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

function Insights({ batches }) {
  const [typeFilter, setTypeFilter] = useState('all');

  const typeCounts = useMemo(() => {
    const counts = { shop_deliver: 0, shop_only: 0, delivery_only: 0, mixed: 0 };
    batches.forEach(b => { if (b.type && counts[b.type] != null) counts[b.type]++; });
    return counts;
  }, [batches]);

  const filtered = useMemo(() => {
    if (typeFilter === 'all') return batches;
    return batches.filter(b => b.type === typeFilter);
  }, [batches, typeFilter]);

  const insights = useMemo(() => {
    if (filtered.length < 3) return null;

    const byStore = {};
    filtered.forEach(b => {
      if (!b.store) return;
      if (!byStore[b.store]) byStore[b.store] = { offered: 0, accepted: 0, totalPay: 0, totalMiles: 0, totalMin: 0 };
      byStore[b.store].offered++;
      if (b.accepted) {
        byStore[b.store].accepted++;
        byStore[b.store].totalPay += b.pay || 0;
        byStore[b.store].totalMiles += b.miles || 0;
        byStore[b.store].totalMin += bestMinutes(b) || 0;
      }
    });
    const storeStats = Object.entries(byStore)
      .map(([store, s]) => ({
        store,
        offered: s.offered,
        accepted: s.accepted,
        acceptRate: s.offered ? s.accepted / s.offered : 0,
        perHour: s.totalMin ? s.totalPay / (s.totalMin / 60) : null,
        perMile: s.totalMiles ? s.totalPay / s.totalMiles : null,
        avgPay: s.accepted ? s.totalPay / s.accepted : null
      }))
      .sort((a, b) => (b.perHour || 0) - (a.perHour || 0));

    const buckets = [
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

    return { storeStats, bucketStats, dayStats, reasonStats, totalDeclined };
  }, [filtered]);

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

  const maxPerHour = Math.max(...insights.storeStats.map(s => s.perHour || 0), 0.01);
  const maxDay = Math.max(...insights.dayStats.map(d => d.perHour || 0), 0.01);
  const showPerMile = typeFilter !== 'shop_only'; // $/mi is misleading for shop_only

  return (
    <div>
      <Header />
      <FilterChips />

      {typeFilter === 'all' && (
        <div className="px-5 mb-4">
          <div className="card p-3" style={{ background: 'var(--accent-soft)', borderColor: 'transparent', fontSize: 12, color: 'var(--ink-soft)' }}>
            Mixed types: $/hr and $/mile averages combine shop, deliver, and shop-only batches. Pick a single type above for comparable stats.
          </div>
        </div>
      )}

      <div className="px-5 mb-6">
        <div className="uppercase-label mb-3">$/hr by store</div>
        <div className="card p-4 space-y-3">
          {insights.storeStats.filter(s => s.perHour != null).slice(0, 6).map(s => (
            <div key={s.store}>
              <div className="flex justify-between items-baseline mb-1">
                <span style={{ fontSize: 14, fontWeight: 500 }}>{s.store}</span>
                <span className="mono" style={{ fontSize: 13 }}>{fmtRate(s.perHour)}/hr</span>
              </div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${(s.perHour / maxPerHour) * 100}%` }} />
              </div>
              <div className="mono mt-1" style={{ fontSize: 11, color: 'var(--muted)' }}>
                {s.accepted}/{s.offered} accepted · {fmtRate(s.perMile)}/mi · avg {fmt$(s.avgPay)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="px-5 mb-6">
        <div className="uppercase-label mb-3">Accept rate by pay</div>
        <div className="card p-4 space-y-3">
          {insights.bucketStats.map(b => (
            <div key={b.label}>
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
        </div>
      </div>

      <div className="px-5 mb-6">
        <div className="uppercase-label mb-3">$/hr by day</div>
        <div className="card p-4">
          <div className="flex items-end gap-2" style={{ height: 120 }}>
            {insights.dayStats.map(d => (
              <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                  <div style={{
                    width: '100%',
                    height: d.perHour ? `${(d.perHour / maxDay) * 100}%` : '2px',
                    background: d.perHour ? 'var(--accent)' : 'var(--border)',
                    borderRadius: '4px 4px 0 0',
                    minHeight: 2
                  }} />
                </div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>{d.day}</div>
                <div className="mono" style={{ fontSize: 10 }}>
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
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────

export default function App() {
  const [batches, setBatches] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState('home'); // 'home' | 'list' | 'insights'
  const [showLog, setShowLog] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [reconcilingBatch, setReconcilingBatch] = useState(null);
  const [viewingImagesBatch, setViewingImagesBatch] = useState(null);
  const [syncStatus, setSyncStatus] = useState(api.enabled() ? 'syncing' : 'local-only'); // 'syncing' | 'synced' | 'error' | 'local-only'

  useEffect(() => {
    (async () => {
      // Local first, so the UI lights up instantly even on a slow network.
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

        setSyncStatus('synced');
      } catch (e) {
        console.error('sync on load failed', e);
        setSyncStatus('error');
      }
    })();
  }, []);

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
    removeOne(id);
  };

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
            {view === 'home' && <Dashboard batches={batches} onLog={() => setShowLog(true)} onReconcile={setReconcilingBatch} onViewImages={setViewingImagesBatch} syncStatus={syncStatus} />}
            {view === 'list' && <BatchList batches={batches} onDelete={deleteBatch} onReconcile={setReconcilingBatch} onViewImages={setViewingImagesBatch} />}
            {view === 'insights' && <Insights batches={batches} />}
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

        {!showLog && (
          <button className="fab" onClick={() => setShowLog(true)} aria-label="Log batch">
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
            className={`nav-item ${view === 'insights' ? 'nav-item-active' : ''}`}
            onClick={() => setView('insights')}
          >
            <BarChart2 size={20} />
            <span>Insights</span>
          </div>
          <div
            className="nav-item"
            onClick={() => setShowLog(true)}
          >
            <Plus size={20} />
            <span>Log</span>
          </div>
        </nav>
      </div>
    </>
  );
}

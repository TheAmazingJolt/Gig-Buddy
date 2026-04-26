import React, { useState, useEffect, useMemo } from 'react';
import {
  Plus, Check, X, BarChart2, List, Home, Trash2,
  Loader2, TrendingUp, ArrowLeft, Sparkles, ClipboardPaste, Camera
} from 'lucide-react';

const EXTRACTOR_URL = import.meta.env.VITE_EXTRACTOR_URL;

const STORAGE_KEY = 'batches';

const DEFAULT_STORES = [
  'Costco', 'Aldi', 'Sprouts', 'Publix', 'Wegmans', 'Kroger',
  'Safeway', "Trader Joe's", 'Whole Foods', "Sam's Club",
  "BJ's", 'Target', 'CVS', 'Petco', 'Other'
];

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

const fmt$ = (n) => n == null || isNaN(n) ? '—' : `$${n.toFixed(2)}`;
const fmt$$ = (n) => n == null || isNaN(n) ? '—' : `$${n.toFixed(0)}`;
const fmtRate = (n) => n == null || isNaN(n) ? '—' : `$${n.toFixed(2)}`;

const dollarsPerHour = (b) => {
  if (!b.pay || !b.estMinutes) return null;
  return b.pay / (b.estMinutes / 60);
};
const dollarsPerMile = (b) => {
  if (!b.pay || !b.miles) return null;
  return b.pay / b.miles;
};

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
    const r = await window.storage.get(STORAGE_KEY);
    if (r && r.value) return JSON.parse(r.value);
  } catch (e) { /* not found */ }
  return [];
}

async function saveBatches(batches) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(batches));
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
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

    :root {
      --bg: #efe7d6;
      --surface: #faf5e8;
      --surface-2: #f5ecd9;
      --ink: #1a1612;
      --ink-soft: #3a3128;
      --muted: #7d6b52;
      --muted-soft: #a89a82;
      --accent: #b8401f;
      --accent-soft: #fde2c4;
      --green: #3f6212;
      --green-soft: #d9e8b8;
      --red: #991b1b;
      --red-soft: #fcd7d7;
      --border: #d4c8b0;
      --border-soft: #e6dcc4;
    }

    * { -webkit-tap-highlight-color: transparent; }
    body { margin: 0; }

    .app {
      font-family: 'IBM Plex Sans', system-ui, sans-serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100vh;
      padding-bottom: 80px;
    }

    .display {
      font-family: 'Fraunces', Georgia, serif;
      font-feature-settings: 'ss01' on;
      letter-spacing: -0.02em;
    }
    .mono { font-family: 'IBM Plex Mono', monospace; }
    .uppercase-label {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 500;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border-soft);
      border-radius: 14px;
    }
    .card-strong {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
    }
    .card-ink {
      background: var(--ink);
      color: var(--surface);
      border-radius: 14px;
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
      font-weight: 500;
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
      padding: 16px 20px;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      width: 100%;
      cursor: pointer;
      font-family: inherit;
    }
    .btn-primary:active { transform: scale(0.98); }
    .btn-primary:disabled { opacity: 0.4; }

    .btn-ghost {
      background: transparent;
      color: var(--ink-soft);
      border: 1px solid var(--border);
      padding: 14px 20px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
    }

    .btn-accept {
      background: var(--green);
      color: var(--surface);
      border: none;
      padding: 18px;
      border-radius: 12px;
      font-size: 17px;
      font-weight: 600;
      flex: 1;
      cursor: pointer;
      font-family: inherit;
    }
    .btn-decline {
      background: var(--surface);
      color: var(--red);
      border: 1px solid var(--red);
      padding: 18px;
      border-radius: 12px;
      font-size: 17px;
      font-weight: 600;
      flex: 1;
      cursor: pointer;
      font-family: inherit;
    }

    .input {
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 14px;
      font-size: 17px;
      color: var(--ink);
      font-family: 'IBM Plex Mono', monospace;
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
      border-top: 1px solid var(--border);
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
      font-weight: 500;
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
      box-shadow: 0 8px 24px rgba(184, 64, 31, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 20;
    }

    .pill {
      display: inline-flex;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .pill-accept { background: var(--green-soft); color: var(--green); }
    .pill-decline { background: var(--red-soft); color: var(--red); }

    .bar {
      height: 8px;
      background: var(--surface-2);
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
      background: rgba(26, 22, 18, 0.5);
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

function Header({ batches }) {
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const todayBatches = batches.filter(b => b.loggedAt >= startOfDay);
  const todayAccepted = todayBatches.filter(b => b.accepted);
  const todayPay = todayAccepted.reduce((s, b) => s + (b.pay || 0), 0);

  return (
    <div className="px-5 pt-8 pb-4">
      <div className="uppercase-label">{todayStr}</div>
      <div className="flex items-baseline gap-3 mt-1">
        <span className="display" style={{ fontSize: 44, fontWeight: 600, lineHeight: 1 }}>
          {fmt$$(todayPay)}
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 14 }}>
          today · {todayAccepted.length} accepted · {todayBatches.length - todayAccepted.length} declined
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

function Dashboard({ batches, onLog }) {
  const stats = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekBatches = batches.filter(b => b.loggedAt >= weekAgo);
    const accepted = weekBatches.filter(b => b.accepted);
    const totalPay = accepted.reduce((s, b) => s + (b.pay || 0), 0);
    const totalMin = accepted.reduce((s, b) => s + (b.estMinutes || 0), 0);
    const totalMiles = accepted.reduce((s, b) => s + (b.miles || 0), 0);

    return {
      acceptRate: weekBatches.length ? (accepted.length / weekBatches.length) * 100 : null,
      perHour: totalMin ? totalPay / (totalMin / 60) : null,
      perMile: totalMiles ? totalPay / totalMiles : null,
      totalPay,
      count: accepted.length,
      offered: weekBatches.length
    };
  }, [batches]);

  const recent = batches.slice(0, 5);

  return (
    <div>
      <Header batches={batches} />

      <div className="px-5">
        <div className="uppercase-label mb-2">Last 7 days</div>
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
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                $/hr
              </div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 500, marginTop: 2 }}>
                {fmtRate(stats.perHour)}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                $/mi
              </div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 500, marginTop: 2 }}>
                {fmtRate(stats.perMile)}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--muted-soft)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Accept
              </div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 500, marginTop: 2 }}>
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
            {recent.map(b => <BatchRow key={b.id} batch={b} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function BatchRow({ batch, onDelete }) {
  const typeLabel = {
    shop_deliver: 'Shop & deliver',
    shop_only: 'Shop only',
    delivery_only: 'Delivery only'
  }[batch.type] || null;
  const milesLabel = batch.type === 'shop_only'
    ? `${batch.miles}mi to store`
    : `${batch.miles}mi`;

  return (
    <div className="card p-4 fade-in">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`pill ${batch.accepted ? 'pill-accept' : 'pill-decline'}`}>
              {batch.accepted ? 'ACCEPTED' : 'DECLINED'}
            </span>
            {typeLabel && (
              <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'IBM Plex Mono, monospace', letterSpacing: '0.04em' }}>
                {typeLabel}
              </span>
            )}
            <span style={{ fontSize: 13, color: 'var(--muted)', marginLeft: 'auto' }}>
              {fmtDate(batch.loggedAt)} · {fmtTime(batch.loggedAt)}
            </span>
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

function LogForm({ onSave, onCancel }) {
  const [pay, setPay] = useState('');
  const [miles, setMiles] = useState('');
  const [minutes, setMinutes] = useState('');
  const [items, setItems] = useState('');
  const [units, setUnits] = useState('');
  const [stops, setStops] = useState('1');
  const [store, setStore] = useState('');
  const [storeOther, setStoreOther] = useState('');
  const [notes, setNotes] = useState('');
  const [type, setType] = useState('shop_deliver');
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

    const miles_ = num(data.miles ?? data.mi ?? data.distance);
    if (miles_ != null) setMiles(String(miles_));

    const mins = num(data.minutes ?? data.min ?? data.time ?? data.estminutes ?? data.activeminutes);
    if (mins != null) setMinutes(String(Math.round(mins)));

    const items_ = num(data.items);
    if (items_ != null) setItems(String(Math.round(items_)));

    const units_ = num(data.units);
    if (units_ != null) setUnits(String(Math.round(units_)));

    const stops_ = num(data.stops ?? data.orders);
    if (stops_ != null) setStops(String(Math.round(stops_)));

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
      setShots([]);
      setMode(null);
      flashSuccess();
    } catch (err) {
      setExtractError(err.message || 'Extraction failed');
    } finally {
      setExtracting(false);
    }
  };

  const submit = (accepted) => {
    const finalStore = store === 'Other' ? storeOther : store;
    const batch = {
      id: crypto.randomUUID(),
      loggedAt: Date.now(),
      type,
      pay: parseFloat(pay),
      miles: parseFloat(miles),
      estMinutes: minutes ? parseFloat(minutes) : null,
      items: items ? parseInt(items) : null,
      units: units ? parseInt(units) : null,
      stops: stops ? parseInt(stops) : 1,
      store: finalStore || null,
      accepted,
      notes: notes || null,
      source: 'quick'
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
          )}

          {mode === 'paste' && (
            <div className="card-strong p-3">
              <div className="uppercase-label mb-2">Paste from chat</div>
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                placeholder='pay=19.61 miles=5.3 items=49 units=69 store=Publix stops=2 minutes=53'
                className="input"
                style={{ minHeight: 70, fontSize: 13, fontFamily: 'IBM Plex Mono, monospace', resize: 'vertical' }}
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
                { val: 'delivery_only', label: 'Delivery only' }
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
                <span style={{ position: 'absolute', left: 14, top: 14, color: 'var(--muted)', fontSize: 17, fontFamily: 'IBM Plex Mono, monospace' }}>$</span>
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
              <div className="uppercase-label mb-2">Stops</div>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                placeholder="1"
                value={stops}
                onChange={e => setStops(e.target.value)}
              />
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

        <div className="flex gap-3 mt-6 mb-8">
          <button
            className="btn-decline"
            onClick={() => submit(false)}
            disabled={!canSave}
            style={{ opacity: canSave ? 1 : 0.4 }}
          >
            <X size={18} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
            Declined
          </button>
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

function BatchList({ batches, onDelete }) {
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
          filtered.map(b => <BatchRow key={b.id} batch={b} onDelete={onDelete} />)
        )}
      </div>
    </div>
  );
}

function Insights({ batches }) {
  const insights = useMemo(() => {
    if (batches.length < 3) return null;

    // By store
    const byStore = {};
    batches.forEach(b => {
      if (!b.store) return;
      if (!byStore[b.store]) byStore[b.store] = { offered: 0, accepted: 0, totalPay: 0, totalMiles: 0, totalMin: 0 };
      byStore[b.store].offered++;
      if (b.accepted) {
        byStore[b.store].accepted++;
        byStore[b.store].totalPay += b.pay || 0;
        byStore[b.store].totalMiles += b.miles || 0;
        byStore[b.store].totalMin += b.estMinutes || 0;
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

    // By pay bucket — accept rate
    const buckets = [
      { label: '< $10', min: 0, max: 10 },
      { label: '$10–15', min: 10, max: 15 },
      { label: '$15–20', min: 15, max: 20 },
      { label: '$20–25', min: 20, max: 25 },
      { label: '$25–30', min: 25, max: 30 },
      { label: '$30+', min: 30, max: Infinity }
    ];
    const bucketStats = buckets.map(b => {
      const inBucket = batches.filter(x => x.pay >= b.min && x.pay < b.max);
      const accepted = inBucket.filter(x => x.accepted).length;
      return {
        ...b,
        offered: inBucket.length,
        accepted,
        rate: inBucket.length ? accepted / inBucket.length : 0
      };
    }).filter(b => b.offered > 0);

    // By day-of-week (accepted only, $/hr)
    const byDay = {};
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => byDay[d] = { totalPay: 0, totalMin: 0, count: 0 });
    batches.filter(b => b.accepted && b.estMinutes).forEach(b => {
      const day = dayName(b.loggedAt);
      byDay[day].totalPay += b.pay || 0;
      byDay[day].totalMin += b.estMinutes;
      byDay[day].count++;
    });
    const dayStats = Object.entries(byDay).map(([day, s]) => ({
      day,
      perHour: s.totalMin ? s.totalPay / (s.totalMin / 60) : null,
      count: s.count
    }));

    return { storeStats, bucketStats, dayStats };
  }, [batches]);

  if (!insights) {
    return (
      <div className="px-5 pt-8">
        <div className="uppercase-label">Insights</div>
        <div className="card p-8 text-center mt-4">
          <TrendingUp size={28} style={{ color: 'var(--muted)', margin: '0 auto 12px' }} />
          <div style={{ fontSize: 15, fontWeight: 500 }}>Not enough data yet</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            Log a few more batches to see patterns
          </div>
        </div>
      </div>
    );
  }

  const maxPerHour = Math.max(...insights.storeStats.map(s => s.perHour || 0), 0.01);
  const maxDay = Math.max(...insights.dayStats.map(d => d.perHour || 0), 0.01);

  return (
    <div>
      <div className="px-5 pt-8 pb-4">
        <div className="uppercase-label">Insights</div>
        <div className="display mt-1" style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.2 }}>
          What the data says
        </div>
      </div>

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

  useEffect(() => {
    (async () => {
      const b = await loadBatches();
      setBatches(b);
      setLoaded(true);
    })();
  }, []);

  const addBatch = async (b) => {
    const next = [b, ...batches];
    setBatches(next);
    setShowLog(false);
    await saveBatches(next);
  };

  const deleteBatch = async (id) => {
    const next = batches.filter(b => b.id !== id);
    setBatches(next);
    await saveBatches(next);
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
            {view === 'home' && <Dashboard batches={batches} onLog={() => setShowLog(true)} />}
            {view === 'list' && <BatchList batches={batches} onDelete={deleteBatch} />}
            {view === 'insights' && <Insights batches={batches} />}
          </>
        )}

        {showLog && (
          <LogForm onSave={addBatch} onCancel={() => setShowLog(false)} />
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

import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';

const app = express();
app.use(cors());                          // allow calls from the artifact
app.use(express.json({ limit: '25mb' })); // images can be a few MB each base64'd

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001';
// Swap to 'claude-sonnet-4-6' if Haiku ever misreads a screenshot.

// Postgres — single-table, JSONB-blob model. Schema flexes as the batch shape evolves.
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL
  ? new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL unset — /batches endpoints will return 503');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS batches (
      id          TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      logged_at   BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL DEFAULT 0
    )
  `);
  console.log('db schema ready');
}

// Auth — single shared bearer token, set as API_TOKEN on the server and VITE_API_TOKEN on the client.
const API_TOKEN = process.env.API_TOKEN;
function requireAuth(req, res, next) {
  if (!API_TOKEN) {
    return res.status(500).json({ error: 'API_TOKEN not configured on server' });
  }
  const header = req.header('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (token !== API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Database not configured (DATABASE_URL missing)' });
  next();
}

// Trust the model's per-leg enumeration over its arithmetic. If mileLegs is
// a non-empty array of numbers, overwrite miles with the actual sum.
function reconcileMileage(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const legs = obj.mileLegs;
  if (Array.isArray(legs) && legs.length) {
    const nums = legs.map(Number).filter(n => Number.isFinite(n));
    if (nums.length) {
      const sum = Math.round(nums.reduce((a, b) => a + b, 0) * 10) / 10;
      obj.miles = sum;
    }
  }
  return obj;
}

// Derive completedAt when the timeline doesn't show a final drop (e.g.
// shop_only batches end at the store, not a customer address). IC's
// "Active hours" runs from acceptance to completion, so:
//   completedAt = acceptedAt + actualMinutes
function reconcileTimes(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.completedAt) return obj;
  if (!obj.acceptedAt || !obj.actualMinutes) return obj;
  const start = Date.parse(obj.acceptedAt);
  if (Number.isNaN(start)) return obj;
  const endMs = start + Math.round(Number(obj.actualMinutes) * 60_000);
  obj.completedAt = new Date(endMs).toISOString();
  return obj;
}

const reconcileBatch = (obj) => reconcileTimes(reconcileMileage(obj));

const EXTRACT_PROMPT = `You will see one or more screenshots from the Instacart Shopper app. Identify the screen type for each, then extract data accordingly.

Screen types:
- "offer": pre-acceptance offer with a prominent green "Accept" button, batch pay/tip breakdown, "X shop and deliver" / "X shop only" / "X delivery only" lines, and a map showing pins around the store. Times here are ESTIMATED.
- "summary": post-completion "Batch summary" screen with a header titled "Batch summary", a "Batch pay" / "Tips" / "Total" breakdown, an "Active hours" line, and a journey timeline (Accepted at Your location → Arrival at Store [→ delivery legs]). Times here are ACTUAL.
- "item_detail": single-item view, less commonly useful.
- "unknown": anything else.

Return ONLY a valid JSON object — no markdown, no code fences, no prose. Use null for any field not visible across the images.

The "store" field is important and on OFFER screens the store may only be identifiable from a colored map-pin logo (no text label). Use these visual cues:
- Publix: green circle with white "P"
- Aldi: orange/red "ALDI" wordmark
- Costco: red "Costco" wordmark on white
- Target: red bullseye
- Trader Joe's: red script wordmark
- Sprouts: green leaf, "Sprouts Farmers Market"
- Whole Foods: dark green "WF" leaf
- Kroger: blue cursive wordmark
- Wegmans: red wordmark
- Safeway: red "S" / red wordmark
- Sam's Club: dark blue rectangle with yellow
- BJ's: red and white "BJ's"
- CVS: red wordmark
- Petco: blue wordmark
If the logo color and shape don't match any of the above, do your best from any visible text or pin styling.

For "type", use the FIRST applicable rule in priority order:
  1. SUMMARY SCREEN: the journey timeline is the ONLY authoritative type signal. Count its visible legs:
     - Exactly ONE leg ("Your location → Store") with NO further legs to customer addresses: type = "shop_only". This holds even if the screen also says "2 orders" or any order count — multiple orders at one store is still ONE stop and shop_only.
     - TWO OR MORE legs ("Your location → Store → Customer address(es)"): type = "shop_deliver".
     - Journey starts at a non-retail pickup point and goes to customer addresses with no shopping leg: type = "delivery_only".
  2. OFFER SCREEN with explicit text labels: "X shop and deliver" → "shop_deliver", "X shop only" → "shop_only", "X delivery only" → "delivery_only".
  3. HYBRID OFFER (offer screen showing two different category lines, e.g. "1 shop and deliver" + "1 shop only"): type = "mixed". Capture the per-category breakdown in notes.
  4. OFFER SCREEN with no text labels: only a store pin and the user's location → likely shop_only; store + multiple home pins around it → likely shop_deliver.

For "stops" — the number of PHYSICAL DESTINATIONS the shopper visits, NOT the count of orders/customers:
  - shop_only at one store = 1 (the store is the only stop, regardless of order count)
  - shop_deliver = 1 (the store) + the number of distinct customer addresses delivered to
  - delivery_only = the number of distinct customer addresses
  - mixed = unique physical locations (store + delivery addresses)
  - default 1

For "orders" — the count of CUSTOMERS or distinct orders. "2 orders" at one Publix means orders: 2 even though stops: 1. Read directly from "X orders", "X shop and deliver", "X shop only" lines.

For TIME fields:
  - "estMinutes": ONLY set when reading an OFFER screen (estimated time before acceptance). Convert "52 min" or "52 min 37 sec" to a single integer.
  - "actualMinutes": ONLY set when reading a SUMMARY screen — read from "Active hours" or the equivalent completion-time field. Convert "52 min 37 sec" to 53.

For TIMELINE timestamps on summary screens, look at the journey timeline (the vertical list with location pins showing "Accepted: HH:MMam/pm Your location", "Arrival: HH:MMam/pm Store", "Drop off: HH:MMam/pm Order A", etc.):
  - "acceptedAt": ISO 8601 datetime built from the "Accepted: HH:MMam/pm" entry combined with the date visible on the screen. The screen header usually shows "Sunday, April 26, 5:44pm" or similar — use that date. On a daily summary screen the day is in the title (e.g., "Sun, Apr 26") and applies to every batch in that summary. Null if no acceptance time is visible.
  - "completedAt": ISO 8601 datetime built from the LAST "Drop off: HH:MMam/pm" entry combined with the date. For shop_only batches whose timeline ends at the store with no delivery legs, set null. Null if the batch hasn't completed.

{
  "screenType": "offer" | "summary" | "item_detail" | "unknown",
  "type": "shop_deliver" | "shop_only" | "delivery_only" | "mixed" | null,
  "pay": number — pay shown on the screen (offer total or summary total). If batch and tip are shown separately, sum them.,
  "tipAmount": number — tip portion if shown separately,
  "miles": number — sum of all "Distance: N miles" legs in the journey. Compute by summing every leg distance shown.,
  "mileLegs": array of numbers — every "Distance: N miles" leg in journey order. To-store distance first, then each delivery leg. For shop_only with no delivery legs, this is a one-element array with just the to-store distance. Example: a 3-order shop&deliver batch shows "Distance: 3.4 miles" to the store, then "Distance: 2.8 miles" + "Distance: 5.4 miles" + "Distance: 1.7 miles" for the three deliveries → mileLegs: [3.4, 2.8, 5.4, 1.7]. miles MUST equal the sum of mileLegs.,
  "items": number — total item count summed across all orders,
  "units": number — unit count summed across all orders,
  "estMinutes": number — set ONLY on offer screens,
  "actualMinutes": number — set ONLY on summary screens (from "Active hours"),
  "acceptedAt": ISO 8601 datetime string — from journey "Accepted: HH:MMam/pm" + screen date,
  "completedAt": ISO 8601 datetime string — from last "Drop off: HH:MMam/pm" + screen date, or null for shop-only,
  "store": string — primary store name. For multi-store batches, this is the FIRST store the shopper visits.,
  "additionalStores": array of strings — any OTHER stores the shopper visits on the same batch, in journey order. Multi-stage offers ("Stage 1 / Stage 2") and offer maps with distinct store pins from different chains (e.g. Dollar Tree + Target, Publix + CVS) populate this. Empty array or null when only one store is involved.,
  "stops": number — physical destinations,
  "orders": number — customer/order count,
  "notes": string — guaranteed earnings note, mixed-batch breakdown, anything else worth keeping
}`;

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'batch-extractor',
    model: MODEL,
    db: !!pool,
    auth: !!API_TOKEN
  });
});

// ── Batches CRUD ──────────────────────────────────────────────────
// All /batches routes require Bearer auth and a configured DB.

app.get('/batches', requireAuth, requireDb, async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM batches ORDER BY logged_at DESC');
    res.json({ batches: r.rows.map(row => row.data) });
  } catch (e) {
    console.error('GET /batches:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/batches/:id', requireAuth, requireDb, async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    if (!data || typeof data !== 'object' || data.id !== id) {
      return res.status(400).json({ error: 'Body must be the batch object with matching id' });
    }
    const loggedAt = Number(data.loggedAt) || Date.now();
    const updatedAt = Number(data.updatedAt) || Date.now();
    await pool.query(
      `INSERT INTO batches (id, data, logged_at, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             logged_at = EXCLUDED.logged_at,
             updated_at = EXCLUDED.updated_at`,
      [id, data, loggedAt, updatedAt]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /batches/:id:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/batches/:id', requireAuth, requireDb, async (req, res) => {
  try {
    await pool.query('DELETE FROM batches WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /batches/:id:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/extract', async (req, res) => {
  try {
    const { images } = req.body;
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'images: [{data, mediaType}, ...] required' });
    }
    if (images.length > 8) {
      return res.status(400).json({ error: 'max 8 images per request' });
    }

    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const content = [];
    for (const [i, img] of images.entries()) {
      if (!img?.data || !img?.mediaType) {
        return res.status(400).json({ error: `image ${i}: missing data or mediaType` });
      }
      if (!validTypes.includes(img.mediaType)) {
        return res.status(400).json({ error: `image ${i}: unsupported mediaType ${img.mediaType}` });
      }
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data }
      });
    }
    content.push({ type: 'text', text: EXTRACT_PROMPT });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content }]
    });

    const text = message.content.map(c => c.text || '').join('');
    const stripped = text.replace(/```json|```/g, '');
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first < 0 || last <= first) {
      return res.status(502).json({ error: 'No JSON in model response', raw: text.slice(0, 200) });
    }

    let parsed;
    try {
      parsed = JSON.parse(stripped.slice(first, last + 1));
    } catch {
      return res.status(502).json({ error: 'JSON parse failed', raw: stripped.slice(first, last + 1).slice(0, 200) });
    }

    reconcileBatch(parsed);
    res.json({ ok: true, data: parsed, model: MODEL, imageCount: images.length });
  } catch (e) {
    console.error('Extract error:', e);
    res.status(500).json({ error: e.message || 'extraction failed' });
  }
});

// ── Bulk extraction with timestamp-aware grouping ───────────────────
// POST /extract-multi
// body: { images: [{ data, mediaType, takenAt: ISOString }] }
// returns: { ok: true, batches: [{ ...fields, imageIndices: [1,2,...] }] }

app.post('/extract-multi', async (req, res) => {
  try {
    const { images } = req.body;
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'images: [{data, mediaType, takenAt}, ...] required' });
    }
    if (images.length > 20) {
      return res.status(400).json({ error: 'max 20 images per multi-extract request' });
    }

    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const content = [];
    const tsLines = [];
    for (const [i, img] of images.entries()) {
      if (!img?.data || !img?.mediaType) {
        return res.status(400).json({ error: `image ${i}: missing data or mediaType` });
      }
      if (!validTypes.includes(img.mediaType)) {
        return res.status(400).json({ error: `image ${i}: unsupported mediaType ${img.mediaType}` });
      }
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data }
      });
      const ts = img.takenAt || 'unknown';
      tsLines.push(`Image ${i + 1}: ${ts}`);
    }

    const multiPrompt = `You will see ${images.length} screenshot(s) from the Instacart Shopper app. Your job is to identify each individual batch and extract structured data per batch.

CRITICAL FIRST STEP — find the DAILY SUMMARY screenshot:

The daily summary is the single most reliable source. Identify it by these markers:
  - A title showing day-of-week + date (e.g. "Sun, Apr 26") near the top
  - A bold "Total" label with the day's total earnings (e.g. "$184.06")
  - An "Active hours" line with a duration (e.g. "5 hr 47 min 34 sec")
  - A "Batches" label with a count (e.g. "Batches" → "7")
  - A list of individual batch entries below "Batches", each row showing: a start time (e.g. "11:23am"), a dollar total (e.g. "$19.61"), and an order count (e.g. "2 orders" or "1 order")

If you find a daily summary:
  1. Extract its index — list every batch entry with its start time, total $, and order count.
  2. The number of batches you return MUST EQUAL the number of entries in the daily summary's batch list.
  3. For EACH index entry, find the detail screenshots (offer / summary / item-detail) that match. BE GENEROUS in matching: any of these signals is enough — the visible total $ within ~$0.50, the accepted/start time within ~5 minutes, the store name, the item count. You do NOT need all signals to match; one or two strong ones is plenty.
  3a. CROSS-REFERENCE IN-APP TIMES across screenshots aggressively. Each batch summary screen prints the batch's start time in MULTIPLE in-app locations, and the same batch is often captured in TWO OR MORE summary screenshots (one of the top earnings/tips area, one of the journey/items area). All of those screenshots share the same start time. The signals to look for, in priority order:
      - The header date+time below "Batch summary" — e.g. "Tuesday, April 28, 2:55pm". Always present on a summary's top portion.
      - The "Accepted: HH:MMam/pm" line in the journey timeline (e.g. "Accepted: 2:55pm  Your location"). Present on a summary's bottom portion.
      - Drop-off times in the journey ("Drop off: 3:56pm Order A") — these all belong to the same batch as the matching Accepted time.
      - As a weak fallback only: the iOS status bar clock at the top of an OFFER screenshot (since the user often took it right when the offer landed).
      RULE: any two detail screenshots that share a visible start time (within a few minutes) belong to the SAME batch. Add ALL of their indices into that batch's imageIndices array. This is true even when one screenshot shows the earnings breakdown and the other shows the journey — they're the same batch viewed at different scroll positions.
  4. The "pay" field for each batch MUST equal the total $ from the matching daily summary entry — that is the authoritative final amount. Do not pull pay from the detail screenshots when an index entry exists.
  5. Set "fromIndex": true and "indexEntryTime": the matching index time on every batch.
  6. If an index entry has NO matching detail screenshots, still return a batch object using only the index data (time, total, order count). Set imageIndices to [] and screenType to "unknown".
  7. The daily summary screenshot itself is NOT a batch — do not include it in the batches array. Add its image index to "summaryImageIndex". The summary image must NEVER appear in unmatchedImages.
  8. The user may be uploading screenshots in chunks, so the daily summary (with N entries) may be present even when only a SUBSET of detail screenshots is in this view. That's expected and fine — return all N batches; the ones without matching details simply have imageIndices=[].
  9. unmatchedImages should be RARE. Only put an image there when it is clearly NOT a batch-related screenshot (e.g. a stray photo of something else, a settings page, a notification). If a detail screenshot has any plausible signal pointing to a summary entry, MATCH IT to that entry rather than flagging it as unmatched.

If NO daily summary is present (indexFound: false):
  Fall back to grouping by content + timestamps:
    - Same store + similar items + similar pay + close timestamps = same batch
    - Different store / mismatched items / distant timestamps = different batches
    - When time and content disagree, content wins. Lean "same batch" if both are within reasonable bounds.

Image timestamps (when each image was taken — note: timestamps are unreliable when the user takes all screenshots back-to-back at end of day):
${tsLines.join('\n')}

Per-batch field rules:

${EXTRACT_PROMPT.split('Return ONLY')[1].split('{')[0]}

Each batch object has these fields PLUS:
  - "imageIndices": 1-indexed array of source detail screenshots
  - "fromIndex": true if matched to a daily summary entry, false otherwise
  - "indexEntryTime": the matching index entry's time string, or null

Return ONLY a valid JSON object — no markdown, no code fences, no prose:

{
  "indexFound": true | false,
  "expectedCount": number,           // batch count from daily summary, or 0
  "summaryImageIndex": number | null,// 1-indexed image position of the daily summary screenshot
  "batches": [
    {
      "screenType": "offer" | "summary" | "item_detail" | "unknown",
      "type": "shop_deliver" | "shop_only" | "delivery_only" | "mixed" | null,
      "pay": number,
      "tipAmount": number | null,
      "miles": number | null,
      "mileLegs": [number, ...],
      "items": number | null,
      "units": number | null,
      "estMinutes": number | null,
      "actualMinutes": number | null,
      "acceptedAt": string | null,    // ISO 8601, from journey "Accepted: HH:MMam/pm" + date
      "completedAt": string | null,   // ISO 8601, from last "Drop off: HH:MMam/pm" + date
      "store": string | null,
      "additionalStores": [string, ...],
      "stops": number,
      "orders": number,
      "notes": string | null,
      "imageIndices": [number, ...],
      "fromIndex": boolean,
      "indexEntryTime": string | null
    }
  ],
  "unmatchedImages": [number, ...]   // 1-indexed images that are clearly NOT batch-related. Should usually be empty. Never includes the daily summary image. Detail screenshots that plausibly belong to a summary entry should be MATCHED, not flagged here.
}`;

    content.push({ type: 'text', text: multiPrompt });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: 'user', content }]
    });

    const text = message.content.map(c => c.text || '').join('');
    const stripped = text.replace(/```json|```/g, '');
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first < 0 || last <= first) {
      return res.status(502).json({ error: 'No JSON in model response', raw: text.slice(0, 200) });
    }

    let parsed;
    try {
      parsed = JSON.parse(stripped.slice(first, last + 1));
    } catch {
      return res.status(502).json({ error: 'JSON parse failed', raw: stripped.slice(first, last + 1).slice(0, 200) });
    }

    const batches = (Array.isArray(parsed?.batches) ? parsed.batches : []).map(reconcileBatch);
    res.json({
      ok: true,
      batches,
      indexFound: !!parsed?.indexFound,
      expectedCount: Number(parsed?.expectedCount) || 0,
      summaryImageIndex: parsed?.summaryImageIndex ?? null,
      unmatchedImages: Array.isArray(parsed?.unmatchedImages) ? parsed.unmatchedImages : [],
      model: MODEL,
      imageCount: images.length
    });
  } catch (e) {
    console.error('Extract-multi error:', e);
    res.status(500).json({ error: e.message || 'extraction failed' });
  }
});

const port = process.env.PORT || 3000;
initDb()
  .catch(err => console.error('initDb failed; continuing without /batches:', err))
  .finally(() => app.listen(port, () => console.log(`batch-extractor listening on :${port}`)));

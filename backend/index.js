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

{
  "screenType": "offer" | "summary" | "item_detail" | "unknown",
  "type": "shop_deliver" | "shop_only" | "delivery_only" | "mixed" | null,
  "pay": number — pay shown on the screen (offer total or summary total). If batch and tip are shown separately, sum them.,
  "tipAmount": number — tip portion if shown separately,
  "miles": number — miles. For shop_only batches, this is the distance from acceptance to the store (no delivery leg).,
  "items": number — total item count summed across all orders,
  "units": number — unit count summed across all orders,
  "estMinutes": number — set ONLY on offer screens,
  "actualMinutes": number — set ONLY on summary screens (from "Active hours"),
  "store": string,
  "stops": number — physical destinations,
  "orders": number — customer/order count,
  "notes": string — guaranteed earnings note, mixed-batch breakdown, accepted/arrival timestamps from a summary's journey
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

    const multiPrompt = `You will see ${images.length} screenshot(s) from the Instacart Shopper app. They may represent ONE batch or SEVERAL batches. Your job is to GROUP images that belong to the same batch, then extract structured data per group.

Each image has a "taken at" timestamp:
${tsLines.join('\n')}

Grouping rules — combine BOTH cues:
- Time: images taken within ~15 minutes of each other are LIKELY the same batch. Images separated by hours are LIKELY different batches.
- Content: the SAME batch will share the same store, the same items count, the same approximate pay, and screen progression makes sense (offer → items list → summary). DIFFERENT batches have distinct stores, mismatched item counts, or contradictory data (e.g. two different "Active hours" times).

When time and content disagree, content wins for grouping decisions, but lean toward "same batch" if BOTH are within reasonable bounds.

For each batch, extract using ALL the rules below.

${EXTRACT_PROMPT.split('Return ONLY')[1].split('{')[0]}

Each batch object has these fields PLUS an "imageIndices" field — a 1-indexed array listing which images belong to that batch.

Return ONLY a valid JSON object with key "batches" — no markdown, no code fences, no prose. Example:

{
  "batches": [
    {
      "screenType": "summary",
      "type": "shop_only",
      "pay": 19.61,
      "tipAmount": 0,
      "miles": 5.3,
      "items": 49,
      "units": 69,
      "estMinutes": null,
      "actualMinutes": 53,
      "store": "Publix",
      "stops": 1,
      "orders": 2,
      "notes": "Active hours 52 min 37 sec",
      "imageIndices": [1, 2]
    },
    {
      "screenType": "offer",
      "type": "shop_deliver",
      ...
      "imageIndices": [3, 4]
    }
  ]
}`;

    content.push({ type: 'text', text: multiPrompt });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
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

    const batches = Array.isArray(parsed?.batches) ? parsed.batches : [];
    res.json({ ok: true, batches, model: MODEL, imageCount: images.length });
  } catch (e) {
    console.error('Extract-multi error:', e);
    res.status(500).json({ error: e.message || 'extraction failed' });
  }
});

const port = process.env.PORT || 3000;
initDb()
  .catch(err => console.error('initDb failed; continuing without /batches:', err))
  .finally(() => app.listen(port, () => console.log(`batch-extractor listening on :${port}`)));

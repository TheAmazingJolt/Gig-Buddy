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

const EXTRACT_PROMPT = `You will see one or more screenshots from the Instacart Shopper app — they may show an offer screen, a batch summary, an item detail panel, or other batch-related views. Combine information across all images to extract structured data.

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

For "type", use these cues in order of priority:
  1. Authoritative text on offer screens: "X shop and deliver" → shop_deliver, "X shop only" → shop_only, "X delivery only" → delivery_only.
  2. HYBRID batches: if the offer screen shows BOTH a "shop and deliver" line AND a "shop only" line (or any combination of two different categories) → set type to "mixed". Capture the breakdown in notes (e.g. "1 shop-and-deliver, 1 shop-only").
  3. Journey timeline on batch-summary screens (most reliable when offer text isn't present):
     - "Your location → Store" with NO further legs to customer addresses → shop_only
     - "Your location → Store → Customer address(es)" → shop_deliver
     - "Your location → Pickup point → Customer address(es)" with no shopping leg at a retail store → delivery_only
  4. Map pin pattern on offer screens: only a store pin and the user's location → likely shop_only; multiple home/destination pins around the store → likely shop_deliver.
The total number of "shop and deliver" / "shop only" / "delivery only" lines in the offer text summed together is the "stops" count.

{
  "type": "shop_deliver" | "shop_only" | "delivery_only" | "mixed" | null,
  "pay": number — total pay shown (batch + tip) in dollars. If batch and tip are shown separately, sum them.,
  "tipAmount": number — tip portion if shown separately,
  "miles": number — miles traveled or estimated. For shop_only batches, this is the distance from acceptance to the store (no delivery leg).,
  "items": number — total item count summed across all orders (e.g. "23 items" if breakdown is 2 + 21),
  "units": number — unit count summed across all orders (e.g. "32 units" if breakdown is 5 + 27),
  "estMinutes": number — estimated or actual minutes (convert "52 min 37 sec" to 53),
  "store": string — primary store name (read from logo or text, e.g. "Aldi", "Publix"),
  "stops": number — total number of orders/customers across all categories (e.g. "1 shop and deliver" + "1 shop only" = 2; default 1),
  "notes": string — any salient detail worth remembering. Include "guaranteed earnings applied" if you see that badge, the per-category breakdown for mixed batches, plus any timestamps or shop/deliver time splits.
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

const port = process.env.PORT || 3000;
initDb()
  .catch(err => console.error('initDb failed; continuing without /batches:', err))
  .finally(() => app.listen(port, () => console.log(`batch-extractor listening on :${port}`)));

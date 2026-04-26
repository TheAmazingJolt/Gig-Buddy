import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(cors());                          // allow calls from the artifact
app.use(express.json({ limit: '25mb' })); // images can be a few MB each base64'd

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001';
// Swap to 'claude-sonnet-4-6' if Haiku ever misreads a screenshot.

const EXTRACT_PROMPT = `You will see one or more screenshots from the Instacart Shopper app — they may show an offer screen, a batch summary, an item detail panel, or other batch-related views. Combine information across all images to extract structured data.

Return ONLY a valid JSON object — no markdown, no code fences, no prose. Use null for any field not visible across the images.

{
  "type": "shop_deliver" | "shop_only" | "delivery_only" | null,
  "pay": number — total pay shown (batch + tip) in dollars. If batch and tip are shown separately, sum them.,
  "tipAmount": number — tip portion if shown separately,
  "miles": number — miles traveled or estimated. For shop-only batches, the only mileage shown is usually distance to the store; use that.,
  "items": number — total item count (e.g. "42 items"),
  "units": number — unit count if shown separately from items (e.g. "72 units"),
  "estMinutes": number — estimated or actual minutes (convert "52 min 37 sec" to 53),
  "store": string — primary store name (read from logo or text, e.g. "Aldi", "Publix"),
  "stops": number — number of orders/customers (e.g. "2 shop and deliver" or "2 orders" = 2; default 1),
  "notes": string — any salient detail worth remembering (optional)
}`;

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'batch-extractor', model: MODEL });
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
app.listen(port, () => console.log(`batch-extractor listening on :${port}`));

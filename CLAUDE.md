# Batch Tracker

Personal Instacart shopper analytics tool. Tracks offered batches (accepted **and** declined), surfaces real $/hr and $/mile by store, type, and time block, and helps the shopper make better accept/decline decisions over time.

This file captures decisions made during initial design so the next Claude Code session has full context.

---

## Architecture

Two-part system:

- **`frontend/`** — React PWA (Vite). Mobile-first, designed to add to the iPhone home screen and feel like a native app. Single user, no auth.
- **`backend/`** — Express service deployed on Railway. One job: receive 1-8 base64 screenshots, call the Anthropic API to extract structured batch data, return JSON. Holds the Anthropic API key. CORS open (`*`) since it's single-user and the API key is the only secret.

Frontend and backend communicate over a single endpoint: `POST /extract` with `{images: [{data, mediaType}]}`.

## Why this exists (and what was deliberately rejected)

The user originally asked for an iOS app to **auto-accept Instacart batches** with **bot-detection bypass**. Both rejected — auto-acceptors violate Instacart Shopper ToS and risk deactivation; bypassing bot detection crosses into CFAA territory. **Do not add these features back under any framing.**

Pivoted to the layer no existing tool captures: **decline data and offer-time decision quality**. Apps like Gridwise sync earnings via Argyle/Pinwheel-style credential aggregators (which also violate Instacart's ToS and aren't accessible to indie devs anyway), but they only see *accepted* batches. The interesting analytics are: which offers did you decline, what were the decline patterns, what was your real $/hr at offer time, and which batches were tip-baited.

Related rejections:
- **Don't reverse-engineer the Instacart Shopper app's private API.** Same ToS/CFAA concerns.
- **Don't scrape the shopper portal with stored session cookies.** Same.
- **Don't build a credential-aggregator like Argyle.** Out of scope, legally fraught for solo dev.

Sanctioned data sources only: manual entry, screenshots taken by the user, and (future) Instacart's in-app earnings PDF export.

## Data model

Each batch is:

```ts
{
  id: string,              // crypto.randomUUID()
  loggedAt: number,        // Date.now() at log time
  type: 'shop_deliver' | 'shop_only' | 'delivery_only',
  pay: number,             // total — batch base + tip combined
  miles: number,           // always tracked, regardless of type (real cost basis)
  estMinutes: number | null,
  items: number | null,
  units: number | null,    // e.g. 49 items / 69 units
  stops: number,           // default 1
  store: string | null,
  accepted: boolean,
  notes: string | null,
  source: 'quick' | 'screenshot' | 'paste'
}
```

**Key invariant: miles are always recorded regardless of batch type.** Even on shop-only batches where the only mileage is "distance to store," that's still real cost (gas, wear, IRS deduction). What changes by type is the *interpretation* of $/mile, not whether to capture it.

## Insights logic

Critical: `$/hr` and `$/mile` averages **must be split by batch type** before being shown. A great shop-only week and a bad delivery week, mixed together, produce a meaningless average. The dashboard summary card mixes for now (placeholder); the Insights tab should always segment by type.

Current insights implemented: $/hr by store, accept rate by pay bucket, $/hr by day of week. **Not yet split by type — this is the next priority.**

## Current state

Working:
- Quick entry form (chips for type and store, numeric inputs for everything else)
- Paste-data flow: artifact accepts JSON or `key=value` pairs and auto-fills the form. Aliases handled (mi/miles, min/minutes, sad/shop_deliver, etc.)
- Local-first storage via `window.storage` (artifact context only — needs to become IndexedDB or localStorage in the real PWA)
- Dashboard with last-7-day card, recent batches list
- Batch list with filter (all/accepted/declined) and delete
- Insights page with by-store, by-pay-bucket, by-day-of-week breakdowns
- Backend extraction service (Express + Anthropic SDK) accepts 1-8 images, returns parsed JSON. Default model `claude-haiku-4-5-20251001`, swappable via `MODEL` env var.

Not yet done (in priority order):
1. **Wire the frontend to the backend.** Replace the removed `extractFromScreenshot` with a fetch to the Railway URL. Add a Screenshot mode back to the LogForm with **multi-image upload** (`<input type="file" multiple>`), a thumbnail strip, and one-tap extraction.
2. **Split insights by batch type** so shop-only and shop-deliver are tracked as separate baselines.
3. **Convert the artifact to a real Vite PWA** with manifest + service worker, replace `window.storage` with IndexedDB (via `idb` or similar). Deploy to Railway, Cloudflare Pages, or Vercel — user's choice.
4. **Earnings reconciliation** — paste weekly Instacart earnings, match to accepted batches, surface tip-bait (offer-time pay vs. final pay).
5. **Voice-note logging** for hands-free entry while driving.

## Conventions

- React functional components with hooks. No class components.
- Inline styles + a single `<style>` block for the theme. No Tailwind config (the artifact constraint that drove this can be lifted in the real Vite app — Tailwind is fine to add).
- Custom CSS variables for the palette (defined at top of theme block). Warm cream / ink / saffron-rust accent. Avoid generic fintech blue.
- Display font: Fraunces (serif). Body: IBM Plex Sans. Mono: IBM Plex Mono for numbers.
- File names kebab-case. React components PascalCase.
- Storage keys lowercase with colons as separators (e.g. `batches`, `settings:user`).

## Things that have already been ruled out — do not re-suggest

- Auto-accepting batches (any form, any framing).
- Bypassing or working around Instacart's bot detection.
- Scraping Instacart APIs, the shopper portal, or app-internal endpoints.
- Storing the user's Instacart credentials.
- Calling the Anthropic API directly from the artifact runtime — it's blocked in the Claude mobile app environment. Always go through the backend service.
- Categorizing shop-only batches by $/mile alone — the metric works differently per type. Always factor in type.

## Open questions for the user

- Hosting choice for the frontend PWA (Railway Static, Cloudflare Pages, Vercel).
- Whether to store accepted-batch reconciliation data alongside offer-time data in one record or split into two linked records.
- Whether to add a "shift" concept (start/stop times bracketing a session of work) for better $/hr-per-shift analytics.

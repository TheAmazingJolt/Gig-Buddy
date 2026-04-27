# Batchwise

Personal Instacart shopper analytics tool. Tracks offered batches (accepted **and** declined), surfaces real $/hr and $/mile by store, type, and time block, and helps the shopper make better accept/decline decisions over time. Lives at **batchwise.org** (Cloudflare Pages, custom domain pointing at the same project that was originally `gig-buddy.pages.dev`).

The repo and local working directory are still named `Gig-Buddy` for historical reasons — fine to leave alone unless we deliberately rename. The user-facing brand is Batchwise everywhere (PWA name, manifest, home-screen icon, browser title).

This file captures decisions made during design and the running state so the next Claude Code session has full context without needing to re-read the entire chat history.

---

## Architecture

Three-part system:

- **`frontend/`** — React PWA (Vite + Tailwind v4). Mobile-first, designed to add to the iPhone home screen and feel like a native app. Single user, no auth at the page level.
- **`backend/`** — Express service deployed on Railway. Holds the Anthropic API key and the Postgres connection. CORS open (`*`).
- **Postgres** — Railway plugin. Single `batches` table with `(id PRIMARY KEY, data JSONB, logged_at BIGINT, updated_at BIGINT)`. JSONB blob lets the schema flex without migrations.

### Endpoints

- `POST /extract` — single-batch extraction; up to 8 images per call. Open (no auth).
- `POST /extract-multi` — bulk extraction; up to 20 images per call. Open. Detects a daily-summary screenshot and uses it as authoritative ground truth for batch count + per-batch totals; falls back to content+timestamp grouping when no summary is included.
- `GET /batches`, `PUT /batches/:id`, `DELETE /batches/:id` — Bearer-auth-gated CRUD via shared secret `API_TOKEN` (matching `VITE_API_TOKEN` on Cloudflare).
- `GET /` — healthcheck reporting `model`, `db`, `auth`.

### Sync model

Local-first. Frontend hydrates from `localStorage` instantly on load, then pulls `/batches`, merges by `updatedAt` (newest wins), and pushes any local-only batches up. Every add/update/delete writes to localStorage immediately and pushes to Postgres in the background. A small `SyncIndicator` in the dashboard header surfaces synced / syncing / offline / local-only state. Offline writes queue locally and flush on next successful sync.

## Why this exists (and what was deliberately rejected)

The user originally asked for an iOS app to **auto-accept Instacart batches** with **bot-detection bypass**. Both rejected — auto-acceptors violate Instacart Shopper ToS and risk deactivation; bypassing bot detection crosses into CFAA territory. **Do not add these features back under any framing.**

Pivoted to the layer no existing tool captures: **decline data and offer-time decision quality**. Apps like Gridwise sync earnings via Argyle/Pinwheel-style credential aggregators (which violate Instacart's ToS and aren't accessible to indie devs anyway), and they only see *accepted* batches. The interesting analytics are: which offers did you decline, what were the decline patterns, what was your real $/hr at offer time, and which batches were tip-baited.

Related rejections — do not re-suggest:
- Reverse-engineering the Instacart Shopper app's private API.
- Scraping the shopper portal with stored session cookies.
- Building a credential-aggregator like Argyle.
- Storing the user's Instacart credentials.
- Calling the Anthropic API directly from the browser/PWA — it goes through the Railway backend so the key isn't exposed.
- Naming anything in the "Batch[Grabber/Finder/Scanner]" family — that brand neighborhood is owned by ToS-violating bots and we deliberately stay clear of it.

Sanctioned data sources only: manual entry, screenshots taken by the user, and (future) Instacart's in-app earnings PDF export.

## Data model

Each batch is a JSONB blob with this shape (additive — not all fields are present on every batch; missing means `null`):

```ts
{
  id: string,                  // crypto.randomUUID()
  loggedAt: number,            // Date.now() at log time
  updatedAt: number,           // Date.now() on every save; used for sync merge

  // Offer-time data
  type: 'shop_deliver' | 'shop_only' | 'delivery_only' | 'mixed',
  pay: number,                 // total — batch base + tip combined (offer-time)
  tipAmount: number | null,    // tip portion if extraction saw it separately
  miles: number,               // total miles for the entire batch (sum of legs for delivery)
  estMinutes: number | null,   // estimated minutes — set ONLY from offer screens
  items: number | null,
  units: number | null,        // e.g. 49 items / 69 units
  stops: number,               // physical destinations: 1 for shop_only, N+1 for shop_deliver
  orders: number,              // customer/order count (semantically distinct from stops)
  store: string | null,
  accepted: boolean,
  notes: string | null,
  source: 'quick' | 'paste' | 'bulk',

  // Timeline — populated on summary-screen extractions
  acceptedAt: number | null,   // ms epoch from "Accepted: HH:MMam/pm" + screen date
  completedAt: number | null,  // ms epoch from last "Drop off: ..." + screen date.
                               // For shop_only batches with no delivery legs, derived as
                               // acceptedAt + actualMinutes (server-side reconcileTimes).

  // Reconciliation (final paid amounts, post-tip-window)
  actualPay: number | null,
  actualTip: number | null,
  actualMinutes: number | null,
  reconciledAt: number | null,

  // Source images — ~30-80KB downscaled JPEG dataURLs, kept inline
  images: string[] | null,
}
```

**Key invariants:**
- Miles are always the **total** distance for the entire batch. On multi-leg batches the model returns `mileLegs: [3.4, 2.8, 5.4, 1.7]` and the backend `reconcileMileage` helper computes `miles = sum(mileLegs)`. Trust the model to read; do the arithmetic ourselves.
- `stops` ≠ `orders`. A 2-order shop-only batch at one Publix is `stops: 1, orders: 2`. A 3-order shop-and-deliver is `stops: 4 (1 store + 3 deliveries), orders: 3`.
- For shop-only batches `miles` is just acceptance-to-store distance (single leg). For shop-deliver/mixed it's acceptance + every delivery leg.
- IC's "Active hours" runs **acceptance → last drop-off**, confirmed empirically (e.g. Accepted 1:56pm + Active 1h11m20s ≈ 3:07pm last drop). Same formula generalizes to shop_only via `reconcileTimes`.

## Helpers (frontend)

- `batchTime(b) = b.acceptedAt || b.loggedAt` — used for sort, "today" filter, "last 7 days" filter, by-day insights.
- `wallClockMinutes(b) = (completedAt - acceptedAt) / 60000`.
- `bestMinutes(b) = actualMinutes ?? wallClockMinutes ?? estMinutes` — used in $/hr and any "how long did this take" computation. Always prefer this over raw `estMinutes` so bulk-imported summaries get correct rates.
- `dollarsPerHour(b)` and `actualPerHour(b)` both call `bestMinutes`.
- `isReconciled(b)` = `actualPay != null`. The dashboard "Final" pill on a row is hidden when `Math.abs(actualPay - pay) < 0.01` — no new info to show. It only appears when there's a meaningful delta (tip-bait or surplus).

## Insights logic

`$/hr` and `$/mile` averages **must be split by batch type** before being shown. The Insights page has a top-row chip filter (`All / SAD / SO / DO / Mix`) with batch counts per type. Default is `All` with a saffron banner warning that mixed-type averages aren't comparable. By-store, by-pay-bucket, and by-day-of-week stats all recompute from the type-filtered set. The dashboard's "Last 7 days" card stays mixed (placeholder) — it's a global summary card, not an analytical surface.

## Bulk import

Driven by the daily-summary-as-index pattern. The user is told upfront (in a saffron banner on the upload phase) that they MUST include the daily summary screenshot — it's the only screen with the authoritative batch count and per-batch totals. With it, the model is given explicit rules: "the number of batches you return MUST equal the entry count; pay MUST equal the entry's total." Without it, the review screen shows a red warning and grouping is unreliable.

The review step lets the user keep/discard candidates and toggle accept/decline per offer-screen candidate (declined toggle is hidden for obviously-post-trip candidates — `fromIndex` or `screenType: 'summary'` or any actual data set). On "Save N", all kept candidates write to localStorage and push to Postgres in parallel.

Source screenshots ride through to the saved batch's `images` field, downscaled in-browser to ~30-80KB JPEG before storage. The BatchRow renders a thumbnail strip; tap any thumbnail and an `ImageViewer` modal stacks the screenshots vertically (close enough to "stitching" for now).

## Conventions

- React functional components with hooks. No class components.
- **Tailwind v4** via `@tailwindcss/vite` zero-config. Inline styles + a `<style>` block for the theme are still used liberally for one-off styling (theme variables, animations, complex layouts).
- Custom CSS variables for the palette (defined at the top of the theme block in App.jsx). Warm cream / ink / saffron-rust accent. Avoid generic fintech blue.
- Display font: Fraunces (serif). Body: IBM Plex Sans. Mono: IBM Plex Mono for numbers.
- File names kebab-case. React components PascalCase.
- Storage key: `batches` (plain string in localStorage; JSON-encoded array).
- Service worker: `selfDestroying: true` on the VitePWA plugin, so any cached old SW unregisters itself on next visit. Re-enable a real caching SW once the app is feature-stable.
- All git pushes go to `main` only — confirmed durable instruction from the user. No feature branches unless explicitly requested.

## Deployment

- **Frontend**: Cloudflare Pages, Vite preset, root directory `frontend`, build command `npm run build`, output `dist`. Production env vars: `VITE_EXTRACTOR_URL` (Railway URL), `VITE_API_TOKEN` (matching the server's `API_TOKEN`).
- **Backend**: Railway, root directory `backend`. Env vars: `ANTHROPIC_API_KEY`, `MODEL` (defaults to Haiku 4.5), `API_TOKEN`, `DATABASE_URL` (auto-injected from the Postgres plugin via Railway's `${{Postgres.DATABASE_URL}}` reference).
- Custom domain `batchwise.org` lives in the same Cloudflare account as the Pages project; CF auto-provisions DNS + TLS.
- Icons are generated from `frontend/public/icon.svg` via `npm run gen-icons` (uses `sharp` as a devDependency). Saffron-rust gradient with cream "BW" monogram and a small underline. Run after any branding tweak.

## Open questions

- Whether to add a "shift" concept (start/stop session brackets) for $/hr-per-shift analytics. Probably useful once we have a few weeks of data.
- Whether to add an "Edit existing batch" affordance (currently only delete + ReconcileForm). Real gap when bulk extraction misses a field.
- Whether to expose mileage-leg breakdown in the UI (we capture `mileLegs` from the model but don't render them).
- Whether to add image-overlap stitching for true scroll-capture screenshots (currently we just stack, which works fine 95% of the time).
- Voice-note logging for hands-free entry while driving — still on the wishlist.
- Cost / model trade-off: default is `claude-haiku-4-5-20251001` for cost; user is currently running `claude-sonnet-4-6` via the `MODEL` env var. Bulk extraction at 15+ images per call is the most expensive path; can consider chunking or model-routing later.

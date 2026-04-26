# batch-extractor

Tiny Express service that accepts Instacart Shopper screenshots and returns structured JSON via the Anthropic API. Used as the backend for the batch tracker artifact.

## Endpoint

`POST /extract`

```json
{
  "images": [
    { "data": "<base64 image data, no data: prefix>", "mediaType": "image/png" },
    { "data": "...", "mediaType": "image/png" }
  ]
}
```

Returns:
```json
{
  "ok": true,
  "data": {
    "type": "shop_deliver",
    "pay": 34.19,
    "tipAmount": 9.23,
    "miles": 46.1,
    "items": 42,
    "units": 72,
    "estMinutes": null,
    "store": "Aldi",
    "stops": 2,
    "notes": null
  },
  "model": "...",
  "imageCount": 2
}
```

Up to 8 images per request.

## Deploy on Railway

1. New Project → Deploy from GitHub repo (push these files first), or Empty Service + `railway up` from this folder via CLI.
2. Variables → add `ANTHROPIC_API_KEY=sk-ant-...`
3. Optional: add `MODEL=claude-sonnet-4-6` if Haiku misreads anything.
4. Settings → Networking → Generate Domain. Copy the URL.
5. Test it: `curl https://<your-url>.up.railway.app/` should return `{"ok":true,...}`.

## Run locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# in another terminal
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"images":[{"data":"<base64>","mediaType":"image/png"}]}'
```

# Azure AI Foundry Model Browser

A local-first, dependency-light single-page app for browsing the Azure AI Foundry
model catalog together with regional deployment availability and Azure Retail
pricing. Heavy data collection happens **only on explicit Refresh**; results are
written to a JSON disk cache and served from memory afterward.

It is built to answer questions like:

- Which models are available in Azure AI Foundry, and who publishes them?
- I want model `xy` in a **Data Zone EU** deployment — where is it available, and
  what are the deployment type, scope, SKU, and pricing?
- I have a Foundry resource in region `xy` — what models are available there?
- I need models `x`, `y`, `z` — which region supports all of them?

## Architecture

```
foundry-models/
  server.js                  # entry point (honors PORT)
  scripts/check.js           # `npm run check` syntax validation
  src/server/
    app.js                   # http server + routes + static serving
    config.js                # .env + env resolution (no hard-coded project values)
    cache.js                 # disk + in-memory cache, metadata
    azureCli.js              # az wrapper (execFile, no shell)
    refresh.js               # refresh orchestration
    constants.js             # region geo, SKU map, abbreviations
    sources/
      foundryCatalog.js      # ai.azure.com asset-gallery (HF excluded by default)
      directModels.js        # az cognitiveservices account list-models
      regionalAvailability.js# ARM locations/{region}/models
      retailPrices.js        # prices.azure.com (follows NextPageLink)
    normalize/
      models.js              # catalog -> ModelRecord + matching index
      availability.js        # SKU -> deployment type/scope rows
      pricing.js             # alias matching with family guardrails
      text.js                # shared text helpers
  public/
    index.html  app.js  styles.css
  data/
    cache.json               # generated locally (git-ignored)
```

Data-source logic is isolated from the server/UI so the (observed) Foundry portal
backend or Retail matching can change without touching the rest of the app.

## Requirements

- Node.js 18+ (uses the built-in `http` module and global `fetch`; **zero npm
  dependencies**).
- Azure CLI (`az`) logged in (`az login`) for Refresh. Browsing a pre-built cache
  needs no Azure access.

## Setup

```bash
cp .env.example .env   # then edit with your local values
npm start              # or: PORT=3024 node server.js
```

Open http://localhost:3000 (or your `PORT`). If `data/cache.json` exists it loads
immediately. Otherwise click **Refresh data**.

## Configuration (`.env`, git-ignored)

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 3000) |
| `AZURE_FOUNDRY_PROJECT_NAME` | Foundry AI Services / OpenAI account |
| `AZURE_RESOURCE_GROUP` | Resource group of that account |
| `AZURE_FOUNDRY_REGION` / `AZURE_REGION` / `AZURE_LOCATION` | Catalog region (resolved in this order) |
| `AZURE_AI_SERVICES_ACCOUNT_NAME` / `AZURE_OPENAI_ACCOUNT_NAME` | Optional explicit account overrides |
| `AZURE_LOCATIONS` | Comma-separated regions to scan for availability. If unset, a curated list is scanned and results are flagged **sampled** |
| `AZURE_ML_REGISTRIES` | Reserved for future registry enrichment |

No project, resource group, subscription, or tenant IDs are hard-coded in source.
Missing optional settings degrade gracefully and are reported in source status.

## API

- `GET /api/models` — in-memory cache → disk cache → empty payload with a refresh
  prompt.
- `GET /api/cache` — cache metadata and source status.
- `POST /api/refresh` — body `{ "includeHuggingFace": false }`. Fetches all
  sources, normalizes/merges, attaches prices, writes the disk cache, updates
  memory, and returns the payload. One source failing never blocks the others;
  every outcome is recorded in `status`.

## Decision helpers

- **Model availability** — pick one model + optional scope (incl. Data Zone EU),
  deployment type, route; see matching regions with SKU and pricing.
- **Region inventory** — enter a region; see available models grouped by vendor,
  category, deployment type, and scope.
- **Best region for models** — enter multiple required models; get deterministic,
  explainable region rankings, including partial matches when no region covers
  every model.

## Notes & limitations

- **Hugging Face** models are optional and **off by default** (≈10k+ entries).
- **Pricing is not exhaustive.** Azure Retail Prices does not expose clean model
  IDs for every catalog entry, so some models legitimately show *"No pricing found
  in cache"* — this is distinct from an app failure. Matching uses
  abbreviation-normalized aliases with publisher/family guardrails and never
  attaches generic family prices broadly.
- **Regional availability may be sampled** when `AZURE_LOCATIONS` is not set; the
  UI and status say so. Decision workflows use regional availability rows, not
  mere catalog membership.

## Validation

```bash
npm run check
node --check public/app.js
PORT=3024 node server.js
curl -fsS http://localhost:3024/api/models
curl -fsS -X POST http://localhost:3024/api/refresh \
  -H 'content-type: application/json' \
  -d '{"includeHuggingFace":false}'
```

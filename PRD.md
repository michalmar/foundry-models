# Azure AI Foundry Model Browser PRD

## 1. Purpose

Build a simple, fast, local-first single page application for browsing Azure AI Foundry models. The app must help users answer:

- Which models are available in Azure AI Foundry?
- Which vendor or model lab publishes each model?
- Which route/category applies: direct Foundry deployment, managed compute/VM deployment, or 3rd party marketplace offer?
- Where is each model available?
- Which deployment types and scopes are supported?
- What pricing is available from Azure Retail Prices?
- I want to use model `xy` in a Data Zone EU deployment; where is the model available by region, and what are the additional details such as pricing, deployment type, scope, and SKU?
- I have an Azure AI Foundry resource in region `xy`; what models are available there, grouped or filtered by vendor, deployment type, route/category, and scope?
- I need models `x`, `y`, and `z`; what is the best Azure region to choose if all selected models must be available there?

The application should favor quick navigation and readable summaries over exhaustive raw payload display. Expensive data collection must happen only on explicit refresh, then data must be stored on disk and served from cache.

### PRD fit analysis for these decision questions

The base PRD already supports the first two questions through model search, region filtering, scope filtering, deployment filtering, and expandable pricing/availability details. However, it needs explicit requirements for:

- **model-centric availability lookup:** a focused way to pick one model and see only matching region/deployment/scope combinations, especially Data Zone EU;
- **region-centric inventory:** a focused way to enter a Foundry region and see available models grouped by vendor/category/deployment;
- **multi-model region recommendation:** a comparison workflow that intersects availability across multiple selected models and ranks candidate regions.

These requirements are now treated as first-class workflows and acceptance criteria below, not just incidental outcomes of generic filters.

## 2. Background and lessons learned

The first implementation assumed Azure CLI model commands and public registry lists would provide a complete model catalog. That was incorrect.

Important lessons:

1. **Azure CLI alone is incomplete.** `az cognitiveservices account list-models` returns useful direct deployment data, but not the full Foundry catalog. Azure ML registry commands return only a subset and do not match the 11k+ Foundry portal catalog.
2. **The Foundry portal uses a private catalog API.** The portal model discovery page is backed by `https://ai.azure.com/api/{region}/asset-gallery/v1.0/models`, authenticated with an `https://ai.azure.com` token.
3. **Hugging Face dominates catalog size.** Hugging Face models account for roughly 10k+ entries. They must be optional and disabled by default.
4. **Retail pricing is not model-name normalized.** Azure Retail Prices often exposes product-family names and abbreviated meter names, for example `Azure Mistral Models` and `Codestral Inp glbl Tokens`. Exact full model name matching misses most prices.
5. **Some models genuinely have no Retail API match.** Examples observed: `AI21-Jamba-*` and `Meta-Llama-3.1-405B-Instruct`. The UI must distinguish “no pricing found in cache” from app failure.
6. **Rendering and search must be indexed and paginated.** Searching several hundred to 11k+ models gets slow if nested text is rebuilt on each keystroke or if all cards are rendered at once.
7. **List view should be information-dense.** A condensed single-row list with expandable details works better than full cards for large catalogs.

## 3. Goals

### Functional goals

- Show cached model catalog immediately when `data/cache.json` exists.
- Provide a **Refresh data** action that fetches model, availability, and pricing data, writes disk cache, and updates in-memory cache.
- Support optional inclusion of Hugging Face models with checkbox defaulting to off.
- Support fast search and filters:
  - model name / canonical model name
  - vendor / model lab
  - category
  - deployment type
  - scope
  - region
- Support decision helpers for:
  - model + deployment scope -> available regions and details
  - region -> available model inventory
  - multiple required models -> best candidate regions
- Provide grid and list views:
  - grid view for visual browsing
  - list view as one compact row per model, expandable for availability and pricing
- Show summary metrics:
  - total matches
  - current page
  - rendered rows/cards
  - availability rows
  - pricing rows
  - category counts
- Surface refresh source failures clearly instead of hiding them.

### Non-functional goals

- Local-first and dependency-light.
- Readable, simple UI.
- Fast startup from disk cache.
- Fast client filtering after cache load.
- Avoid direct browser calls to Azure APIs; keep Azure auth and refresh logic server-side.
- Avoid hard-coded user project settings; use `.env`.

## 4. Non-goals

- Do not build a production multi-user hosted service.
- Do not require a database for the first version; JSON disk cache is sufficient.
- Do not guarantee perfect pricing coverage for every Foundry model because Azure Retail Prices does not expose clean model IDs for all catalog entries.
- Do not scrape rendered portal pages. It is acceptable to use the observed portal backend API, but the implementation should isolate it behind a data source module because it may change.
- Do not render all 11k+ models at once.

## 5. Users and primary workflows

### User personas

- **AI platform engineer:** needs to compare available models, regions, deployment types, and pricing.
- **Solution architect:** needs to find which models fit deployment and regional constraints.
- **Developer experimenting in Foundry:** needs quick browsing and search without repeatedly using portal navigation.

### Primary workflows

1. User opens the app.
2. If cache exists, app displays cached models immediately.
3. User optionally toggles **Include Hugging Face models**.
4. User clicks **Refresh data** only when a fresh catalog is needed.
5. User searches and filters.
6. User switches between grid/list view.
7. User expands a list row or grid details to inspect availability and pricing.

### Decision workflows

1. **Model in deployment scope lookup**
   - User searches for a model such as `xy`.
   - User filters deployment scope to `EU` or `Data zone`.
   - App shows every matching region and each row's route, deployment type, scope, SKU, and pricing.
   - If no region matches, app says no cached availability matches the selected model/scope combination.
2. **Region inventory lookup**
   - User enters a Foundry resource region such as `swedencentral`.
   - App shows models available in that region.
   - User can further group/filter by vendor, deployment route/category, deployment type, and scope.
   - Summary metrics update to describe that region-specific inventory.
3. **Best region for multiple required models**
   - User selects or enters multiple model names.
   - App computes the intersection of regions where all selected models are available.
   - App ranks candidate regions by completeness and usefulness:
     - all required models available;
     - preferred scope/deployment match if filters are set;
     - pricing coverage count;
     - number of matching deployment options;
     - optionally user-preferred region list/order.
   - App shows why each candidate region qualifies and which model/deployment rows contributed.

## 6. Data sources

### 6.1 Foundry catalog source

Primary catalog source:

```http
POST https://ai.azure.com/api/{region}/asset-gallery/v1.0/models
Authorization: Bearer <token for https://ai.azure.com>
Content-Type: application/json
x-ms-use-full-service-contracts: true
```

Token command:

```bash
az account get-access-token --resource https://ai.azure.com -o json
```

Request body baseline:

```json
{
  "filters": [
    { "field": "type", "operator": "eq", "values": ["models"] },
    { "field": "kind", "operator": "eq", "values": ["Versioned"] },
    { "field": "properties/isAnonymous", "operator": "ne", "values": ["true"] },
    { "field": "annotations/archived", "operator": "ne", "values": ["true"] },
    { "field": "properties/userProperties/is-promptflow", "operator": "notexists" },
    { "field": "labels", "operator": "eq", "values": ["latest"] }
  ],
  "searchParameters": {
    "freeTextSearch": "",
    "freeTextSearchColumns": [
      { "name": "annotations/systemCatalogData/publisher" },
      { "name": "properties/name" },
      { "name": "annotations/systemCatalogData/inferenceTasks" }
    ]
  },
  "order": [{ "field": "usage/popularity", "direction": "Desc" }],
  "pageSize": 100,
  "facets": [],
  "includeTotalResultCount": true,
  "searchBuilder": "AppendPrefix"
}
```

Important constraints:

- `pageSize` must be at most `100`.
- Continue until `continuationToken` is empty.
- Region should come from `AZURE_FOUNDRY_REGION`, then `AZURE_REGION`, then `AZURE_LOCATION`, then a safe default.
- Hugging Face exclusion is required by default:

```json
{
  "field": "annotations/systemCatalogData/publisher",
  "operator": "ne",
  "values": ["Hugging Face"]
}
```

Observed counts:

- Non-Hugging-Face catalog in `swedencentral`: roughly 500-700 normalized models after enrichment/deduplication.
- Full catalog with Hugging Face: 11k+ entries.

### 6.2 Direct deployment availability source

Use Azure CLI for the configured Foundry AI Services/OpenAI account:

```bash
az cognitiveservices account show --name <account> --resource-group <group> -o json
az cognitiveservices account list-models --name <account> --resource-group <group> -o json
```

Configuration:

- `AZURE_RESOURCE_GROUP`
- `AZURE_FOUNDRY_PROJECT_NAME`
- optional overrides:
  - `AZURE_AI_SERVICES_ACCOUNT_NAME`
  - `AZURE_OPENAI_ACCOUNT_NAME`

The app must not hard-code project names or resource groups. Example local development values may be stored in ignored `.env`, not committed.

Direct model records should enrich existing catalog models with:

- region
- SKU
- deployment type
- scope
- route/category

### 6.3 Regional availability source

Region-specific availability is required for the decision workflows. The app must not infer that a model is available in a user region only because it appears in the global/catalog list.

Known useful direct availability endpoint:

```http
GET https://management.azure.com/subscriptions/{subscriptionId}/providers/Microsoft.CognitiveServices/locations/{region}/models?api-version=2024-10-01
```

This endpoint can expose deployment SKUs such as:

- `Standard`
- `GlobalStandard`
- `DataZoneStandard`
- `ProvisionedManaged`

Implementation requirements:

- Use this endpoint, or an equivalent validated source, to enrich model availability by region.
- Scan configured regions from `AZURE_LOCATIONS` when provided.
- If `AZURE_LOCATIONS` is not provided, scan a curated list of common AI regions and clearly record that the result is a sampled regional view.
- Preserve which source produced each region/deployment row.
- Mark region inventory results as cache-based and only as complete as the scanned region set.

This requirement exists because the user workflows depend on questions like “what can I deploy in `xy`?” and “which region supports all required models?” A catalog-only implementation is insufficient.

### 6.4 Azure Retail Prices API

Retail Prices API documentation:

```text
https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
```

Base endpoint:

```http
GET https://prices.azure.com/api/retail/prices?$filter=<OData filter>
```

Required filters:

```text
serviceName eq 'Foundry Models'
contains(productName, 'Azure AI')
serviceName eq 'Azure Machine Learning' and productName eq 'Managed Model Hosting Service'
```

Implementation requirements:

- Follow `NextPageLink` until empty. Do not cap pages at an arbitrary low number.
- Deduplicate price rows.
- Preserve original price fields:
  - `serviceName`
  - `productName`
  - `meterName`
  - `skuName`
  - `armRegionName`
  - `retailPrice`
  - `currencyCode`
  - `unitOfMeasure`
- Derive normalized app fields:
  - deployment type
  - scope
  - region

Pricing matching rules:

- Do not rely on exact model-name substring matching.
- Normalize common abbreviations:
  - `input` -> `inp`
  - `output` -> `outp`
  - `global` -> `glbl`
  - `regional` -> `regnl`
  - `data zone` / `datazone` -> `dzone`
- Match against:
  - display model name
  - canonical model name
  - aliases without publisher prefix
  - aliases without suffixes such as `instruct`, `preview`, `chat`, `base`
  - compact identifiers with punctuation removed
- Use publisher/product family guardrails to avoid false positives.
- Do not attach generic family prices to every model in a family unless model-specific evidence exists.
- **Match prices to the specific model, not the whole family.** Meter names usually keep
  the version (`GPT 5.1 ...`, `GPT 5.2 ...`), so each model attaches only meters that
  carry its own version. The following precision rules enforce this:
  - **Broad family roots.** A name root shared by more than three catalog models
    (e.g. `gpt`, `llama`, `deepseek`, `mistral`, `phi`) is "broad". A version-stripped
    alias is dropped when it collapses to just a broad root plus numbers/structural words
    (`gpt-5.5` -> `gpt 5` -> `gpt`), since such an alias would match every meter in the
    family. The model then matches on its full name only (`gpt 5 5`), so it attaches
    nothing when no meter for that exact version exists (e.g. no `GPT 5.5` meter).
  - **Distinctive reduced aliases are kept.** A version-stripped alias that still holds a
    distinctive word is retained, because the meter often omits the exact version:
    `Mistral-large-2407` -> `mistral large` (matches `Large 3 ...`), `DeepSeek-R1-0528`
    -> `deepseek r1` (matches `R1 ...`). Distinctive roots used by one or two models
    (`codestral`, `codex`) likewise keep their reduced alias.
  - **Version boundary.** A base alias ending in a number does not match a longer version:
    `gpt 5` will not grab `GPT 5.1` (`-> gpt 5 1`), but `large` still matches `Large 3`
    (the trailing alias token is a word, so the rule does not apply).

Effect: cross-family and whole-family bleed is eliminated (e.g. `gpt-5.5` no longer
attaches gpt-4 / gpt-4o / gpt-image / gpt-oss meters); sibling versions are separated;
and a model with no exact-version meter correctly shows no pricing.

Known Retail API gaps:

- Some Foundry models do not have clear Retail API meters.
- AI21 Jamba prices were not found through `productName` or `meterName` probes during this work.
- Some older Llama catalog names do not map to Retail meters.

## 7. Data model

### 7.1 Cache file

Cache path:

```text
data/cache.json
```

Top-level shape:

```ts
interface CachePayload {
  generatedAt: string;
  startedAt: string;
  options: RefreshOptions;
  locations: string[];
  status: RefreshStatus;
  meta?: CacheMeta;
  models: ModelRecord[];
}
```

### 7.2 Model record

```ts
interface ModelRecord {
  key: string;
  name: string;
  modelName?: string;
  publisher: string;
  summary: string;
  category: 'direct' | 'managed-vm' | 'marketplace' | 'unknown';
  source: string;
  catalog?: {
    registry?: string;
    task?: string;
    source?: string;
  };
  versions: string[];
  availability: AvailabilityRecord[];
  prices: PriceRecord[];
}
```

### 7.3 Availability record

```ts
interface AvailabilityRecord {
  region: string;
  deploymentType: 'pay-as-you-go' | 'provisioned-throughput' | 'managed-vm' | 'marketplace';
  scope: 'regional' | 'zonal' | 'eu' | 'us' | 'data-zone' | 'global';
  route: 'direct' | 'managed-vm' | 'marketplace' | 'unknown';
  sku: string;
}
```

### 7.4 Price record

```ts
interface PriceRecord {
  region: string;
  deploymentType: 'pay-as-you-go' | 'provisioned-throughput' | 'managed-vm' | 'marketplace';
  scope: 'regional' | 'zonal' | 'eu' | 'us' | 'data-zone' | 'global';
  productName: string;
  meterName: string;
  skuName: string;
  unit: string;
  currency: string;
  retailPrice: number;
}
```

### 7.5 Region fit record

The implementation should derive region fit records from availability and pricing data. These records do not need to be stored in the disk cache initially; they can be computed in memory from `ModelRecord[]`.

```ts
interface RegionFitRecord {
  region: string;
  selectedModels: string[];
  availableModels: string[];
  missingModels: string[];
  allRequiredModelsAvailable: boolean;
  matchingAvailability: AvailabilityRecord[];
  matchingPrices: PriceRecord[];
  deploymentTypes: string[];
  scopes: string[];
  vendors: string[];
  score: number;
  reasons: string[];
}
```

Scoring should prioritize:

1. all required models available;
2. requested scope match, for example Data Zone EU;
3. requested deployment type match;
4. pricing coverage;
5. number of available deployment options;
6. user-preferred region order if configured.

### 7.6 Refresh status

```ts
interface RefreshStatus {
  catalog: SourceStatus[];
  commands: SourceStatus[];
  pricing: SourceStatus[];
}

interface SourceStatus {
  ok: boolean;
  command?: string;
  source?: string;
  filter?: string;
  pages?: number;
  totalCount?: number;
  loaded?: number;
  includeHuggingFace?: boolean;
  message?: string;
}
```

## 8. Cache architecture

Use three cache layers:

1. **Disk cache:** `data/cache.json`
   - persistent across server restarts
   - source of truth for UI startup
2. **Server in-memory cache:**
   - hydrated from disk on first `/api/models`
   - replaced immediately after refresh
   - computes metadata such as vendor list
3. **Client in-memory index:**
   - built after load/refresh
   - stores normalized search/filter fields per model
   - never rebuild nested searchable text on every keystroke

Cache behavior:

- `GET /api/models`
  - if memory cache exists, return it
  - else load disk cache
  - if no disk cache, return empty payload with message telling user to refresh
- `GET /api/cache`
  - return cache metadata/status
- `POST /api/refresh`
  - fetch all configured sources
  - normalize and merge models
  - fetch and attach prices
  - write disk cache
  - update memory cache
  - return refreshed payload

## 9. API requirements

### 9.1 `GET /api/models`

Returns:

```json
{
  "generatedAt": "...",
  "options": { "includeHuggingFace": false },
  "status": { "catalog": [], "commands": [], "pricing": [] },
  "meta": {
    "vendors": ["OpenAI", "Mistral AI"],
    "vendorCount": 2
  },
  "models": []
}
```

### 9.2 `POST /api/refresh`

Request:

```json
{
  "includeHuggingFace": false
}
```

Behavior:

- Refresh must be explicit.
- Button should be disabled while refresh is running.
- Status text should say what is being fetched.
- Failures from one source should not prevent returning data from other sources.
- Failures must be recorded in `status`.

## 10. UI requirements

### 10.1 Layout

The app should have:

- header with title/subtitle
- refresh controls
- Hugging Face checkbox default false
- source/cache status panel
- filter toolbar
- summary metrics
- result area
- pagination controls

### 10.2 Filters

Filters:

- Search model
- Category
- Vendor / model lab
- Deployment type
- Scope
- Region

Vendor dropdown must be populated from cache metadata, not hard-coded.

The generic filters are necessary but not sufficient for the target decision workflows. The app should also provide a compact **Decision helper** area with three modes:

- **Model availability:** pick one model and optional deployment constraints such as scope `EU` / `Data zone`, deployment type, and route/category.
- **Region inventory:** enter or select a Foundry region and show all models available there.
- **Best region for models:** enter/select multiple required models and compute candidate regions where all are available.

Search/filter behavior:

- Debounce text inputs around 150-250ms.
- Reset to page 1 when filters change.
- Search should include:
  - model display name
  - canonical model name
  - publisher
  - registry
  - task
  - version
  - availability region/route/deployment/scope/SKU
- Search should not include long descriptions or all pricing text by default because this slows filtering.

### 10.3 Model availability decision mode

This mode answers: “I want to use model `xy` in Data Zone EU deployment; where is it available and what are the details?”

Inputs:

- required model selector/search
- optional scope selector, default `All`
- optional deployment type selector, default `All`
- optional route/category selector, default `All`

Output:

- table grouped by region
- route/category
- deployment type
- scope
- SKU
- matching price rows
- clear empty state when no matching availability is in cache

For Data Zone EU, the app must match both explicit `eu` scope and source records whose SKU/text indicates EU data zone semantics.

### 10.4 Region inventory decision mode

This mode answers: “I have an Azure AI Foundry resource in region `xy`; what models are available there?”

Inputs:

- required region selector/search
- optional vendor filter
- optional category filter
- optional deployment type filter
- optional scope filter

Output:

- summary by vendor
- summary by category/route
- summary by deployment type and scope
- model list/grid constrained to that region
- each row should show only region-relevant availability/pricing details first, with full model details still expandable

### 10.5 Best region for multiple models decision mode

This mode answers: “I need models `x`, `y`, and `z`; what region should I choose if all models must be available there?”

Inputs:

- multi-select model picker or comma/newline-separated model names
- optional required scope
- optional required deployment type
- optional allowed regions
- optional preferred regions order

Output:

- ranked candidate regions where all selected models are available
- for each region, show:
  - selected models covered
  - any missing models
  - deployment types and scopes available per model
  - pricing coverage per model
  - score/reason text
- if no region satisfies all models, show the closest partial matches and identify missing models per region

The ranking algorithm must be deterministic and explainable. Do not hide partial matches, because they are useful for tradeoff decisions.

### 10.6 View mode

Provide an icon-like segmented switch, not plain radio text buttons:

- grid icon
- list icon

Radio inputs should remain accessible but visually hidden.

### 10.7 Grid view

Grid view is the default.

Each card shows:

- model name
- publisher and versions
- category badge
- clamped description
- selectable badge filters for regions, deployment types, and scopes — each group is prefixed with its label (`Region` / `Deployment` / `Scope`) and the badges double as the filter control (§10.7.1)
- expandable availability table
- expandable pricing table

Descriptions must be line-clamped to avoid very tall cards.

#### 10.7.1 In-card detail filters (selectable badges)

Each card provides Region / Deployment / Scope filters rendered as multi-select badges (not dropdowns) that apply to that card's own availability and pricing tables:

- Each facet (Region, Deployment, Scope) is a labeled group of badge buttons whose values come from the model's **availability** rows — i.e. where/how the model can actually be deployed — so regions the model is not available in are never offered as badges. (Pricing is published for many more regions than a model is deployable in; for the few models that have pricing but no availability, the badge values fall back to the pricing rows so they remain filterable.)
- Badges are toggle controls: clicking a badge selects it (highlighted, `aria-pressed="true"`); clicking it again deselects it. Any number of badges may be selected per facet.
- Selection semantics: OR within a facet (a row matches if its value equals any selected badge) and AND across facets (region AND deployment AND scope). A facet with no selected badges imposes no constraint.
- Toggling a badge re-renders both tables in place and updates the section counts, for example `Pricing (300 of 600)`.
- A facet that has no values for a model is omitted.

#### 10.7.2 Expand-on-select and large tables

- A card's availability and pricing tables are collapsed by default.
- When either section is opened, the card grows to span a full grid row so the wide tables fit, and it returns to normal width when all of its sections are closed.
- Detail tables are wrapped in a horizontal-scroll container so they never overflow the card or the page.
- Each detail table renders at most a capped number of rows (initially 250) and, when truncated, shows a note with the total row count that prompts the user to narrow with the in-card badge filters. This keeps heavy models (several thousand pricing rows) responsive.

### 10.8 List view

List view must be one row per model in collapsed state.

Collapsed row columns:

- expand indicator
- model name
- vendor/version
- category
- region count
- deployment type summary
- scope summary

Alignment:

- Rows should align like a table.
- Text must be left-aligned, not centered.
- Column widths should be consistent across rows.

Expanded row content:

- clamped description
- labeled, selectable badge filters (region, deployment type, scope), as in grid view (§10.7.1)
- availability table
- pricing table

Expanded list rows reuse the same in-card filters, row cap, and horizontal-scroll behavior described in §10.7.1–10.7.2.

### 10.9 Pagination

Pagination is required by default.

Initial page size:

```text
100 models per page
```

Controls:

- Previous
- Page X of Y
- Next

Pagination must apply to filtered results.

## 11. Performance requirements

- App should render cached non-Hugging-Face catalog quickly.
- Filtering should feel immediate for hundreds of models and acceptable for 11k+ models.
- Use client-side precomputed indexes.
- Debounce text filters.
- Do not render more than the current page.
- Avoid virtualization unless pagination is insufficient; virtualization was tried and then removed.
- Avoid including long summaries/pricing text in the default search index.

## 12. Error handling and status

The app must not silently swallow source failures.

Status should expose:

- catalog source failures
- Azure CLI command failures
- pricing source failures
- number of pages fetched for pricing
- catalog loaded count vs total count
- whether Hugging Face was included

Expected partial-failure behavior:

- If pricing fails, still show catalog and availability.
- If direct CLI fails, still show Foundry catalog.
- If catalog auth fails but disk cache exists, keep serving disk cache.
- If no cache exists and refresh fails, show clear empty state.

## 13. Configuration

Supported `.env` variables:

```text
PORT=3000
AZURE_FOUNDRY_PROJECT_NAME=<foundry-project-or-ai-services-account>
AZURE_RESOURCE_GROUP=<resource-group>
AZURE_FOUNDRY_REGION=<catalog-region>
AZURE_REGION=<fallback-region>
AZURE_LOCATION=<fallback-region>
AZURE_AI_SERVICES_ACCOUNT_NAME=<optional-explicit-account>
AZURE_OPENAI_ACCOUNT_NAME=<optional-explicit-account>
AZURE_LOCATIONS=eastus,eastus2,swedencentral
AZURE_ML_REGISTRIES=azureml,azureml-meta,azureml-mistral
```

Rules:

- `.env` is local and ignored by git.
- Never hard-code user project, resource group, subscription, or tenant IDs.
- Missing optional settings should degrade gracefully and record status messages.

## 14. Suggested implementation structure

Recommended clean reimplementation structure:

```text
foundry-models/
  package.json
  README.md
  .gitignore
  data/
    .gitkeep
  src/
    server/
      index.js
      config.js
      cache.js
      azureCli.js
      sources/
        foundryCatalog.js
        directModels.js
        retailPrices.js
      normalize/
        models.js
        availability.js
        pricing.js
    public/
      index.html
      app.js
      styles.css
```

Keep data-source logic separated from UI/server routing so future changes to Foundry catalog API or Retail matching are isolated.

## 15. Acceptance criteria

### Initial load

- With `data/cache.json` present, app loads without clicking refresh.
- Vendor dropdown is populated from cache.
- Summary shows model, availability, and pricing counts.

### Refresh

- Refresh writes `data/cache.json`.
- Refresh updates in-memory cache immediately.
- Refresh status records catalog, CLI, and pricing outcomes.
- Hugging Face is excluded by default.
- Enabling Hugging Face loads the larger catalog.

### Catalog correctness

- Foundry catalog source returns counts comparable to portal discovery.
- Non-Hugging-Face catalog is a manageable subset.
- Full catalog can show 11k+ models when enabled.

### Search/filter

- Search does not lag on non-Hugging-Face cache.
- Filters combine correctly.
- Region filter matches availability/pricing regions.
- Vendor filter is case-insensitive.

### Decision workflows

- Model availability mode can answer: model `xy` + Data Zone EU -> matching regions, deployment type, scope, SKU, and pricing where available.
- Region inventory mode can answer: Foundry region `xy` -> models available there, with vendor/category/deployment/scope summaries.
- Best region mode can answer: models `x`, `y`, `z` -> ranked regions where all selected models are available.
- Best region mode shows partial matches when no region satisfies all selected models.
- Decision workflow outputs are based on regional availability rows, not only catalog membership.
- If regional coverage is sampled because `AZURE_LOCATIONS` is not exhaustive, the UI/status clearly says so.

### Views

- Grid is default.
- Icon switch changes between grid/list.
- List view collapsed rows are single-line and table-aligned.
- Expanded list rows show availability and pricing.
- Cards and expanded rows show labeled, selectable Region / Deployment / Scope badge groups.
- Selecting badges (multi-select; OR within a facet, AND across facets) narrows that card/row's own availability and pricing tables and updates the section counts; clicking a selected badge deselects it.
- Opening a grid card's availability or pricing section grows the card to a full grid row so the wide tables fit; closing all sections restores its width.
- Detail tables never overflow the card/page (horizontal scroll) and cap rendered rows with a note when truncated.

### Pricing

- Retail API fetch follows all pages.
- Foundry Models and Managed Model Hosting prices are included.
- Known examples should attach:
  - `Mistral-large`
  - `Codestral 25.01`
  - `Cohere Command A`
  - `codex-mini`
  - `DeepSeek-V3`
  - `DeepSeek-R1`
  - `Llama 4 Scout 17B 16E Instruct`
  - `Phi-4-mini-reasoning`
- Known no-match examples should display no pricing without implying app failure:
  - `AI21-Jamba-*`
  - `Meta-Llama-3.1-405B-Instruct`
- Prices are filtered to the specific model, not the whole family:
  - `gpt-5.5` attaches no gpt-4 / gpt-4o / gpt-image / gpt-oss meters (and, with no
    `GPT 5.5` meter published, shows no pricing).
  - Sibling versions stay separate: `gpt-5`, `gpt-5.1`, and `gpt-5.2` each show only
    their own meters.
  - Versioned snapshots still match version-agnostic meters: `Mistral-large-2407`
    attaches `Large 3 ...`; `DeepSeek-R1-0528` attaches `R1 ...`.

## 16. Validation commands

Use existing project scripts only.

```bash
npm run check
node --check public/app.js
PORT=3024 node server.js
curl -fsS http://localhost:3024/api/models
curl -fsS -X POST http://localhost:3024/api/refresh \
  -H 'content-type: application/json' \
  -d '{"includeHuggingFace":false}'
```

Expected refreshed non-Hugging-Face cache after current implementation:

- roughly 600-700 models
- around 50-60 vendors
- hundreds of models may still have no pricing because Retail API coverage is uneven
- pricing source status should include `Foundry Models` pages and `Managed Model Hosting Service`

## 17. Open questions and future improvements

- Should pricing matching display confidence/source, e.g. `exact`, `alias`, `family`, `generic`?
- Should users be able to hide models with no pricing?
- Should availability use the ARM location model endpoint across all regions instead of only configured/common regions?
- Should full Hugging Face mode use server-side paging or precomputed search indexes on disk?
- Should cache be split into separate catalog, availability, and pricing files for faster incremental refresh?
- Should refresh be cancellable?
- Should pricing tables group input/output/cached/fine-tuning meters for readability?
- Should there be a details page per model for deep comparison?

## 18. Implementation cautions

- Do not assume portal model counts from Azure CLI.
- Do not cap Retail API pagination prematurely.
- Do not inject catalog descriptions with `innerHTML`; use text content to avoid unsafe rendering.
- Do not index huge descriptions/pricing rows for every search keystroke.
- Do not attach generic family prices too broadly.
- Do not hard-code `my-project`, `my-resource-group`, subscription IDs, or region values in source.
- Do not silently return empty results when auth or CLI commands fail; record source status.

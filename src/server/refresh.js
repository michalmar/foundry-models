'use strict';

// Refresh orchestration (PRD §8, §9.2). Fetches every configured source, merges
// and normalizes them, attaches prices, writes the disk cache, and updates the
// in-memory cache. A failure in one source never blocks the others; every
// outcome is recorded in status (PRD §12).

const config = require('./config');
const cache = require('./cache');
const { fetchFoundryCatalog } = require('./sources/foundryCatalog');
const { fetchDirectModels } = require('./sources/directModels');
const { fetchRegionalAvailability } = require('./sources/regionalAvailability');
const { fetchRetailPrices } = require('./sources/retailPrices');
const { mergeCatalog } = require('./normalize/models');
const { attachAvailability, finalize } = require('./normalize/availability');
const { attachPricing } = require('./normalize/pricing');

let refreshing = false;

function isRefreshing() {
  return refreshing;
}

async function settle(promise, label) {
  try {
    return await promise;
  } catch (err) {
    return { __error: true, label, message: err && err.message };
  }
}

async function refresh(options) {
  const includeHuggingFace = !!(options && options.includeHuggingFace);
  const startedAt = new Date().toISOString();
  const status = { catalog: [], commands: [], pricing: [] };

  // Run independent sources concurrently; isolate failures.
  const [catalogResult, directResult, regionalResult, pricingResult] = await Promise.all([
    settle(fetchFoundryCatalog({ includeHuggingFace }), 'catalog'),
    settle(fetchDirectModels(), 'direct'),
    settle(fetchRegionalAvailability(), 'regional'),
    settle(fetchRetailPrices(), 'pricing'),
  ]);

  // Catalog
  const catalogEntries =
    catalogResult && !catalogResult.__error ? catalogResult.entries || [] : [];
  if (catalogResult && catalogResult.status) status.catalog.push(catalogResult.status);
  else status.catalog.push({ ok: false, source: 'asset-gallery', message: catalogResult && catalogResult.message });

  // Build model index from catalog, then enrich with availability.
  const index = mergeCatalog(catalogEntries, { includeHuggingFace });

  // Direct CLI
  if (directResult && !directResult.__error) {
    for (const s of directResult.statuses || []) status.commands.push(s);
  } else {
    status.commands.push({ ok: false, command: 'direct models', message: directResult && directResult.message });
  }

  // Regional ARM
  let sampledLocations = true;
  let locations = [];
  if (regionalResult && !regionalResult.__error) {
    for (const s of regionalResult.statuses || []) status.commands.push(s);
    sampledLocations = !!regionalResult.sampled;
    locations = regionalResult.locations || [];
  } else {
    status.commands.push({ ok: false, source: 'regional availability', message: regionalResult && regionalResult.message });
    const resolved = config.resolveLocations();
    locations = resolved.locations;
    sampledLocations = resolved.sampled;
  }

  attachAvailability(
    index,
    directResult && !directResult.__error ? directResult : null,
    regionalResult && !regionalResult.__error ? regionalResult : null
  );

  // Pricing
  const priceRows =
    pricingResult && !pricingResult.__error ? pricingResult.rows || [] : [];
  if (pricingResult && !pricingResult.__error) {
    for (const s of pricingResult.statuses || []) status.pricing.push(s);
  } else {
    status.pricing.push({ ok: false, source: 'prices.azure.com', message: pricingResult && pricingResult.message });
  }
  attachPricing(index.models, priceRows);

  finalize(index.models);

  const models = index.models;
  const meta = cache.computeMeta(models);

  const payload = {
    generatedAt: new Date().toISOString(),
    startedAt,
    options: { includeHuggingFace },
    locations,
    sampledLocations,
    status,
    meta,
    models,
  };

  cache.writeDisk(payload);
  cache.setMemory(payload);
  return payload;
}

async function runRefresh(options) {
  if (refreshing) {
    const err = new Error('A refresh is already in progress.');
    err.code = 'REFRESH_IN_PROGRESS';
    throw err;
  }
  refreshing = true;
  try {
    return await refresh(options);
  } finally {
    refreshing = false;
  }
}

module.exports = { runRefresh, isRefreshing };

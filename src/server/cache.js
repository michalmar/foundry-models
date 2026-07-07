'use strict';

// Three-layer cache (PRD §8): disk cache (data/cache.json) is the startup source
// of truth; an in-memory copy is served once hydrated; the client builds its own
// search index. This module owns the disk + server-memory layers.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_PATH = path.join(DATA_DIR, 'cache.json');

let memory = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDisk() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeDisk(payload) {
  ensureDataDir();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2));
}

function getMemory() {
  return memory;
}

function setMemory(payload) {
  memory = payload;
}

// Hydrate memory from disk on first read (PRD §8 cache behavior).
function load() {
  if (memory) return memory;
  const disk = readDisk();
  if (disk) memory = disk;
  return memory;
}

function addAll(map, values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const key = String(value);
    map.set(key.toLowerCase(), key);
  }
}

// Compute filter/summary metadata from the model list. Vendors and filter option
// lists are derived here (never hard-coded) so the UI can populate dropdowns.
function computeMeta(models) {
  const list = Array.isArray(models) ? models : [];
  const vendors = new Map();
  const categories = {};
  const deploymentTypes = new Map();
  const scopes = new Map();
  const regions = new Map();
  let availabilityRows = 0;
  let pricingRows = 0;
  let modelsWithPricing = 0;

  for (const model of list) {
    if (model.publisher) vendors.set(model.publisher.toLowerCase(), model.publisher);
    const category = model.category || 'unknown';
    categories[category] = (categories[category] || 0) + 1;

    const availability = Array.isArray(model.availability) ? model.availability : [];
    const prices = Array.isArray(model.prices) ? model.prices : [];
    availabilityRows += availability.length;
    pricingRows += prices.length;
    if (prices.length) modelsWithPricing += 1;

    for (const row of availability) {
      addAll(deploymentTypes, [row.deploymentType]);
      addAll(scopes, [row.scope]);
      addAll(regions, [row.region]);
    }
    // Region options come from availability only: pricing is published for far
    // more regions than a model is deployable in, so unioning pricing regions
    // would list regions no model is actually available in. Deployment/scope
    // fall back to pricing only for models with no availability rows.
    const facetPrices = availability.length ? [] : prices;
    for (const price of facetPrices) {
      addAll(deploymentTypes, [price.deploymentType]);
      addAll(scopes, [price.scope]);
    }
  }

  const sortedVendors = Array.from(vendors.values()).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  return {
    vendors: sortedVendors,
    vendorCount: sortedVendors.length,
    categories,
    deploymentTypes: Array.from(deploymentTypes.values()).sort(),
    scopes: Array.from(scopes.values()).sort(),
    regions: Array.from(regions.values()).sort(),
    modelCount: list.length,
    availabilityRows,
    pricingRows,
    modelsWithPricing,
    modelsWithoutPricing: list.length - modelsWithPricing,
  };
}

function emptyPayload() {
  return {
    generatedAt: null,
    startedAt: null,
    options: { includeHuggingFace: false },
    locations: [],
    sampledLocations: true,
    status: { catalog: [], commands: [], pricing: [] },
    meta: computeMeta([]),
    models: [],
    message:
      'No cache found. Click "Refresh data" to fetch the Foundry catalog, availability, and pricing.',
  };
}

module.exports = {
  CACHE_PATH,
  readDisk,
  writeDisk,
  getMemory,
  setMemory,
  load,
  computeMeta,
  emptyPayload,
};

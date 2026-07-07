'use strict';

// Model normalization (PRD §7.2). Turns raw Foundry catalog entries into
// ModelRecord skeletons and provides a matching index used to merge direct/
// regional availability and Retail prices. Catalog-shape quirks are isolated
// here (PRD §4).

const { DIRECT_PUBLISHERS } = require('../constants');
const { normalizeText, compact, slugify, lower } = require('./text');

// Read a value by a dotted OR slash-delimited path (the PRD uses slash paths).
function get(obj, pathStr) {
  if (!obj) return undefined;
  let cur = obj;
  for (const part of String(pathStr).split(/[./]/)) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstDefined() {
  for (const value of arguments) {
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function extractRegistry(entry) {
  const explicit = firstDefined(
    get(entry, 'annotations/systemCatalogData/registry'),
    get(entry, 'registryName')
  );
  if (explicit) return String(explicit);
  const id = firstDefined(entry.id, get(entry, 'properties/id'), entry.assetId);
  if (id) {
    const match = String(id).match(/registries\/([^/]+)\//i);
    if (match) return match[1];
  }
  return undefined;
}

function extractTask(entry) {
  const tasks = firstDefined(
    get(entry, 'annotations/systemCatalogData/inferenceTasks'),
    get(entry, 'properties/inferenceTasks'),
    get(entry, 'annotations/systemCatalogData/task')
  );
  if (Array.isArray(tasks)) return tasks.filter(Boolean).join(', ');
  return tasks ? String(tasks) : undefined;
}

function inferCategory(entry, publisherLower) {
  if (publisherLower === 'hugging face') return 'managed-vm';

  const scd = get(entry, 'annotations/systemCatalogData') || {};
  const hintParts = [];
  const opts = scd.deploymentOptions || scd.deploymentTypes;
  if (Array.isArray(opts)) hintParts.push(opts.join(' '));
  else if (opts && typeof opts === 'object') hintParts.push(Object.keys(opts).join(' '));
  if (typeof scd.assetType === 'string') hintParts.push(scd.assetType);
  if (typeof scd.modelType === 'string') hintParts.push(scd.modelType);
  const hints = hintParts.join(' ').toLowerCase();

  if (
    hints.includes('serverless') ||
    hints.includes('maas') ||
    hints.includes('payg') ||
    hints.includes('pay-as-you-go')
  ) {
    return 'direct';
  }
  if (hints.includes('marketplace')) return 'marketplace';
  if (
    hints.includes('managedcompute') ||
    hints.includes('managed-compute') ||
    hints.includes('managedonline') ||
    hints.includes('online endpoint') ||
    hints.includes('virtualmachine')
  ) {
    return 'managed-vm';
  }
  if (DIRECT_PUBLISHERS.has(publisherLower)) return 'direct';
  return 'unknown';
}

function normalizeCatalogEntry(entry) {
  const publisher = String(
    firstDefined(
      get(entry, 'annotations/systemCatalogData/publisher'),
      get(entry, 'properties/publisher'),
      entry.publisher,
      'Unknown'
    )
  );
  const modelName = firstDefined(
    get(entry, 'properties/name'),
    entry.name,
    get(entry, 'annotations/systemCatalogData/modelName')
  );
  const displayName = firstDefined(
    entry.displayName,
    get(entry, 'annotations/displayName'),
    get(entry, 'properties/displayName'),
    modelName,
    entry.name
  );
  const summary = String(
    firstDefined(
      get(entry, 'annotations/description'),
      entry.description,
      get(entry, 'properties/description'),
      get(entry, 'annotations/systemCatalogData/summary'),
      ''
    )
  );
  const version = firstDefined(get(entry, 'properties/version'), entry.version);
  const registry = extractRegistry(entry);
  const task = extractTask(entry);
  const publisherLower = lower(publisher);

  const name = String(displayName || modelName || 'Unknown model');

  return {
    key: slugify(publisher + ' ' + name) || slugify(name) || compact(name),
    name,
    modelName: modelName ? String(modelName) : undefined,
    publisher,
    summary,
    category: inferCategory(entry, publisherLower),
    source: 'foundry-catalog',
    catalog: {
      registry: registry || undefined,
      task: task || undefined,
      source: 'asset-gallery',
    },
    versions: version ? [String(version)] : [],
    availability: [],
    prices: [],
  };
}

// Build alias compact keys used to match a model against direct/regional/pricing.
function modelMatchKeys(model) {
  const keys = new Set();
  const names = [model.name, model.modelName].filter(Boolean);
  const publisherCompact = compact(model.publisher);
  for (const raw of names) {
    const norm = normalizeText(raw);
    if (!norm) continue;
    keys.add(compact(norm));
    // Drop a leading publisher token if present (e.g. "OpenAI gpt 4o").
    if (publisherCompact && compact(norm).startsWith(publisherCompact)) {
      keys.add(compact(norm).slice(publisherCompact.length));
    }
    const parts = norm.split(' ');
    if (parts.length > 1 && compact(parts[0]) === publisherCompact) {
      keys.add(compact(parts.slice(1).join(' ')));
    }
  }
  keys.delete('');
  return keys;
}

// Index of models keyed by compact alias for O(1) availability/price merging.
function createModelIndex() {
  const byKey = new Map();
  const models = [];

  function register(model) {
    models.push(model);
    for (const key of modelMatchKeys(model)) {
      if (!byKey.has(key)) byKey.set(key, model);
    }
  }

  function find(name, format) {
    if (!name) return null;
    const candidates = [compact(name)];
    if (format) {
      candidates.push(compact(String(format) + name));
      candidates.push(compact(name + String(format)));
    }
    for (const candidate of candidates) {
      if (candidate && byKey.has(candidate)) return byKey.get(candidate);
    }
    return null;
  }

  function indexKeysFor(model) {
    for (const key of modelMatchKeys(model)) {
      if (!byKey.has(key)) byKey.set(key, model);
    }
  }

  return { models, register, find, indexKeysFor };
}

function mergeCatalog(entries, options) {
  const index = createModelIndex();
  const seen = new Map();
  for (const entry of entries || []) {
    const record = normalizeCatalogEntry(entry);
    const existing = seen.get(record.key);
    if (existing) {
      for (const version of record.versions) {
        if (!existing.versions.includes(version)) existing.versions.push(version);
      }
      if (!existing.summary && record.summary) existing.summary = record.summary;
      continue;
    }
    seen.set(record.key, record);
    index.register(record);
  }
  return index;
}

module.exports = {
  get,
  firstDefined,
  inferCategory,
  normalizeCatalogEntry,
  modelMatchKeys,
  createModelIndex,
  mergeCatalog,
};

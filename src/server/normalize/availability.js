'use strict';

// Availability normalization (PRD §7.3, §6.2, §6.3). Derives AvailabilityRecord
// rows from direct CLI models (account region) and ARM regional models, mapping
// deployment SKU names to deployment type + scope. Unmatched models are added as
// new direct records so region inventory is complete (PRD §6.3).

const { mapSku } = require('../constants');
const { slugify } = require('./text');

function extractModel(item) {
  if (!item) return null;
  const model = item.model || item;
  const name = model.name || item.name;
  if (!name) return null;
  const format = model.format || item.format || item.kind;
  const version = model.version || item.version;
  let skus = model.skus || item.skus || [];
  if (!Array.isArray(skus)) skus = [];
  return { name: String(name), format: format ? String(format) : '', version, skus };
}

function availabilityKey(row) {
  return [row.region, row.deploymentType, row.scope, row.route, row.sku].join('|');
}

function makeRecord(name, format) {
  const publisher = format || 'Unknown';
  return {
    key: slugify(publisher + ' ' + name) || slugify(name),
    name: String(name),
    modelName: String(name),
    publisher,
    summary: '',
    category: 'direct',
    source: 'direct',
    catalog: { source: 'direct' },
    versions: [],
    availability: [],
    prices: [],
    _availKeys: undefined,
  };
}

function addAvailability(model, row) {
  if (!model._availKeys) {
    model._availKeys = new Set(model.availability.map(availabilityKey));
  }
  const key = availabilityKey(row);
  if (model._availKeys.has(key)) return;
  model._availKeys.add(key);
  model.availability.push(row);
}

function applyModel(index, parsed, region, route) {
  if (!parsed || !region) return;
  let model = index.find(parsed.name, parsed.format);
  if (!model) {
    model = makeRecord(parsed.name, parsed.format);
    index.register(model);
  }
  if (model.category === 'unknown') model.category = route === 'managed-vm' ? 'managed-vm' : 'direct';
  if (parsed.version && !model.versions.includes(String(parsed.version))) {
    model.versions.push(String(parsed.version));
  }
  const skuList = parsed.skus.length ? parsed.skus : [{ name: 'Standard' }];
  for (const sku of skuList) {
    const skuName = (sku && (sku.name || sku.skuName)) || 'Standard';
    const mapped = mapSku(skuName);
    addAvailability(model, {
      region,
      deploymentType: mapped.deploymentType,
      scope: mapped.scope,
      route,
      sku: String(skuName),
    });
  }
}

function attachAvailability(index, directResult, regionalResult) {
  if (directResult && directResult.region && Array.isArray(directResult.models)) {
    for (const item of directResult.models) {
      applyModel(index, extractModel(item), directResult.region, 'direct');
    }
  }

  if (regionalResult && regionalResult.byRegion) {
    for (const region of Object.keys(regionalResult.byRegion)) {
      const items = regionalResult.byRegion[region] || [];
      for (const item of items) {
        applyModel(index, extractModel(item), region, 'direct');
      }
    }
  }
}

// Remove transient bookkeeping before the records are cached/serialized.
function finalize(models) {
  for (const model of models) {
    delete model._availKeys;
  }
}

module.exports = { attachAvailability, finalize, extractModel };

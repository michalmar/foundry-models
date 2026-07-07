'use strict';

// Azure Retail Prices source (PRD §6.4). Public endpoint (no auth). Follows
// NextPageLink to completion (never caps pages low), deduplicates rows, and
// preserves original price fields. Normalization/matching happens later in
// normalize/pricing.js.

const ENDPOINT = 'https://prices.azure.com/api/retail/prices';

const FILTERS = [
  "serviceName eq 'Foundry Models'",
  "serviceName eq 'Azure Machine Learning' and productName eq 'Managed Model Hosting Service'",
  "contains(productName, 'Azure AI')",
];

function rowKey(item) {
  return [
    item.meterId,
    item.skuId,
    item.armRegionName,
    item.meterName,
    item.productName,
    item.skuName,
    item.unitOfMeasure,
    item.retailPrice,
  ].join('|');
}

async function fetchRetailPrices() {
  const statuses = [];
  const rowsByKey = new Map();

  for (const filter of FILTERS) {
    const status = {
      ok: false,
      source: 'prices.azure.com',
      filter,
      pages: 0,
      loaded: 0,
    };
    let added = 0;
    let url = ENDPOINT + '?$filter=' + encodeURIComponent(filter);

    try {
      while (url) {
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          status.message = 'HTTP ' + response.status + ': ' + text.slice(0, 200);
          break;
        }
        const json = await response.json();
        const items = (json && json.Items) || [];
        for (const item of items) {
          const key = rowKey(item);
          if (!rowsByKey.has(key)) {
            rowsByKey.set(key, item);
            added += 1;
          }
        }
        status.pages += 1;
        url = (json && json.NextPageLink) || null;
        if (status.pages > 5000) break;
      }
      status.ok = !status.message;
      status.loaded = added;
    } catch (err) {
      status.message = err.message;
    }

    statuses.push(status);
  }

  return { rows: Array.from(rowsByKey.values()), statuses };
}

module.exports = { fetchRetailPrices };

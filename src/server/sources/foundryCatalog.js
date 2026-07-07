'use strict';

// Foundry catalog source (PRD §6.1). Backed by the portal asset-gallery API.
// Isolated here because the endpoint is a private/observed backend that may
// change (PRD §4). Hugging Face is excluded by default (PRD §6.1).

const config = require('../config');
const { getAccessToken } = require('../azureCli');

const RESOURCE = 'https://ai.azure.com';

const BASE_FILTERS = [
  { field: 'type', operator: 'eq', values: ['models'] },
  { field: 'kind', operator: 'eq', values: ['Versioned'] },
  { field: 'properties/isAnonymous', operator: 'ne', values: ['true'] },
  { field: 'annotations/archived', operator: 'ne', values: ['true'] },
  { field: 'properties/userProperties/is-promptflow', operator: 'notexists' },
  { field: 'labels', operator: 'eq', values: ['latest'] },
];

const HUGGING_FACE_EXCLUSION = {
  field: 'annotations/systemCatalogData/publisher',
  operator: 'ne',
  values: ['Hugging Face'],
};

function buildBody(filters, continuationToken) {
  const body = {
    filters,
    searchParameters: {
      freeTextSearch: '',
      freeTextSearchColumns: [
        { name: 'annotations/systemCatalogData/publisher' },
        { name: 'properties/name' },
        { name: 'annotations/systemCatalogData/inferenceTasks' },
      ],
    },
    order: [{ field: 'usage/popularity', direction: 'Desc' }],
    pageSize: 100,
    facets: [],
    includeTotalResultCount: true,
    searchBuilder: 'AppendPrefix',
  };
  if (continuationToken) body.continuationToken = continuationToken;
  return body;
}

function extractItems(json) {
  if (!json || typeof json !== 'object') return [];
  return (
    json.modelResults ||
    json.value ||
    json.models ||
    json.results ||
    json.assets ||
    []
  );
}

async function fetchFoundryCatalog(options) {
  const includeHuggingFace = !!(options && options.includeHuggingFace);
  const region = config.resolveCatalogRegion();
  const url = RESOURCE + '/api/' + region + '/asset-gallery/v1.0/models';
  const status = {
    ok: false,
    source: url,
    includeHuggingFace,
    pages: 0,
    loaded: 0,
  };

  const tokenResult = await getAccessToken(RESOURCE);
  if (!tokenResult.ok) {
    status.message = 'Failed to acquire ai.azure.com token: ' + tokenResult.error;
    return { entries: [], status };
  }
  const token = tokenResult.data.accessToken;

  const filters = BASE_FILTERS.slice();
  if (!includeHuggingFace) filters.push(HUGGING_FACE_EXCLUSION);

  const entries = [];
  let continuationToken = null;
  let totalCount;

  try {
    do {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'x-ms-use-full-service-contracts': 'true',
        },
        body: JSON.stringify(buildBody(filters, continuationToken)),
      });

      if (!response.ok) {
        const text = await response.text();
        status.message =
          'HTTP ' + response.status + ': ' + text.slice(0, 400);
        break;
      }

      const json = await response.json();
      const items = extractItems(json);
      for (const item of items) entries.push(item);
      status.pages += 1;

      if (typeof json.totalResultCount === 'number') {
        totalCount = json.totalResultCount;
      } else if (typeof json.totalCount === 'number') {
        totalCount = json.totalCount;
      }

      continuationToken = json.continuationToken || json.nextSkipToken || null;
    } while (continuationToken && status.pages < 2000);

    status.ok = true;
    status.loaded = entries.length;
    if (typeof totalCount === 'number') status.totalCount = totalCount;
  } catch (err) {
    status.message = 'Catalog fetch error: ' + err.message;
  }

  return { entries, status };
}

module.exports = { fetchFoundryCatalog };

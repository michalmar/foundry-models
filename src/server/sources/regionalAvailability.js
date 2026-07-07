'use strict';

// Regional availability source (PRD §6.3). Uses the ARM CognitiveServices
// locations/{region}/models endpoint to learn which models + deployment SKUs are
// available per region. Scans AZURE_LOCATIONS, or a curated list flagged as
// "sampled". Records per-region status so partial coverage is visible (PRD §12).

const config = require('../config');
const { getAccessToken, getSubscription } = require('../azureCli');

const RESOURCE = 'https://management.azure.com';
const API_VERSION = '2024-10-01';

async function fetchRegionalAvailability() {
  const { locations, sampled } = config.resolveLocations();
  const statuses = [];
  const result = { byRegion: {}, locations, sampled, statuses };

  const sub = await getSubscription();
  if (!sub.ok) {
    statuses.push({
      ok: false,
      command: 'az account show',
      message: 'Cannot resolve subscription: ' + sub.error,
    });
    return result;
  }
  const subscriptionId = sub.data && sub.data.id;
  if (!subscriptionId) {
    statuses.push({
      ok: false,
      command: 'az account show',
      message: 'No subscription id returned.',
    });
    return result;
  }

  const tokenResult = await getAccessToken(RESOURCE);
  if (!tokenResult.ok) {
    statuses.push({
      ok: false,
      source: 'management.azure.com',
      message: 'Failed to acquire ARM token: ' + tokenResult.error,
    });
    return result;
  }
  const token = tokenResult.data.accessToken;

  for (const region of locations) {
    const url =
      RESOURCE +
      '/subscriptions/' +
      subscriptionId +
      '/providers/Microsoft.CognitiveServices/locations/' +
      region +
      '/models?api-version=' +
      API_VERSION;
    try {
      const response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!response.ok) {
        const text = await response.text();
        statuses.push({
          ok: false,
          source: 'models@' + region,
          message: 'HTTP ' + response.status + ': ' + text.slice(0, 200),
        });
        continue;
      }
      const json = await response.json();
      const items = (json && json.value) || [];
      result.byRegion[region] = items;
      statuses.push({
        ok: true,
        source: 'models@' + region,
        loaded: items.length,
      });
    } catch (err) {
      statuses.push({
        ok: false,
        source: 'models@' + region,
        message: err.message,
      });
    }
  }

  return result;
}

module.exports = { fetchRegionalAvailability };

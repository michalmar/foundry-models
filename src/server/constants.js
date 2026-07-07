'use strict';

// Shared maps and classifiers used by normalization. Isolated here so that
// Foundry/ARM/Retail quirks can be tuned in one place (PRD §4, §14).

// Default catalog region when no env override is provided (PRD §6.1).
const DEFAULT_CATALOG_REGION = 'eastus';

// Curated common-AI regions scanned when AZURE_LOCATIONS is not set (PRD §6.3).
// Results derived from this list are flagged as "sampled".
const CURATED_LOCATIONS = [
  'eastus',
  'eastus2',
  'westus',
  'westus3',
  'northcentralus',
  'southcentralus',
  'swedencentral',
  'westeurope',
  'northeurope',
  'francecentral',
  'uksouth',
  'switzerlandnorth',
  'germanywestcentral',
  'japaneast',
  'australiaeast',
  'canadaeast',
  'southindia',
];

// Azure region -> coarse geography, used for "Data Zone EU" semantics (PRD §10.3).
const REGION_GEO = {
  // Europe (EU data zone)
  swedencentral: 'eu',
  westeurope: 'eu',
  northeurope: 'eu',
  francecentral: 'eu',
  francesouth: 'eu',
  germanywestcentral: 'eu',
  germanynorth: 'eu',
  switzerlandnorth: 'eu',
  switzerlandwest: 'eu',
  norwayeast: 'eu',
  norwaywest: 'eu',
  uksouth: 'eu',
  ukwest: 'eu',
  polandcentral: 'eu',
  italynorth: 'eu',
  spaincentral: 'eu',
  // United States (US data zone)
  eastus: 'us',
  eastus2: 'us',
  westus: 'us',
  westus2: 'us',
  westus3: 'us',
  centralus: 'us',
  northcentralus: 'us',
  southcentralus: 'us',
  westcentralus: 'us',
};

// ARM / CLI deployment SKU name (lowercased) -> normalized deployment type + scope.
const SKU_MAP = {
  standard: { deploymentType: 'pay-as-you-go', scope: 'regional' },
  globalstandard: { deploymentType: 'pay-as-you-go', scope: 'global' },
  datazonestandard: { deploymentType: 'pay-as-you-go', scope: 'data-zone' },
  globalbatch: { deploymentType: 'pay-as-you-go', scope: 'global' },
  datazonebatch: { deploymentType: 'pay-as-you-go', scope: 'data-zone' },
  provisionedmanaged: { deploymentType: 'provisioned-throughput', scope: 'regional' },
  globalprovisionedmanaged: { deploymentType: 'provisioned-throughput', scope: 'global' },
  datazoneprovisionedmanaged: { deploymentType: 'provisioned-throughput', scope: 'data-zone' },
};

// Publishers treated as first-party / serverless "direct" when no other signal exists.
const DIRECT_PUBLISHERS = new Set([
  'openai',
  'azure openai',
  'microsoft',
  'mistral ai',
  'mistral',
  'cohere',
  'meta',
  'ai21 labs',
  'ai21',
  'deepseek',
  'core42',
  'nixtla',
  'nvidia',
  'xai',
  'gretel',
  'stability ai',
  'black forest labs',
]);

// Abbreviation normalization applied to both model aliases and Retail meter text
// so they meet in the middle (PRD §6.4 pricing matching rules).
const ABBREVIATIONS = [
  [/\binputs?\b/g, 'inp'],
  [/\boutputs?\b/g, 'outp'],
  [/\bglobal\b/g, 'glbl'],
  [/\bregional\b/g, 'regnl'],
  [/\bdata ?zone\b/g, 'dzone'],
];

// Model-name suffixes stripped to build looser aliases (PRD §6.4).
const STRIP_SUFFIXES = ['instruct', 'preview', 'chat', 'base', 'vision', 'completions'];

function regionGeo(region) {
  if (!region) return 'unknown';
  return REGION_GEO[String(region).toLowerCase()] || 'unknown';
}

function mapSku(skuName) {
  const key = String(skuName || '').toLowerCase().replace(/[^a-z]/g, '');
  return SKU_MAP[key] || { deploymentType: 'pay-as-you-go', scope: 'regional' };
}

module.exports = {
  DEFAULT_CATALOG_REGION,
  CURATED_LOCATIONS,
  REGION_GEO,
  SKU_MAP,
  DIRECT_PUBLISHERS,
  ABBREVIATIONS,
  STRIP_SUFFIXES,
  regionGeo,
  mapSku,
};

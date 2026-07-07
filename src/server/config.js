'use strict';

// Configuration loader. Reads optional local .env.local / .env (git-ignored) and
// resolver helpers. No user project/resource/subscription values are hard-coded
// in source (PRD §13).

const fs = require('fs');
const path = require('path');
const { DEFAULT_CATALOG_REGION, CURATED_LOCATIONS } = require('./constants');

function loadEnvFile(fileName) {
  const envPath = path.join(process.cwd(), fileName);
  if (!fs.existsSync(envPath)) return;
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

// Load local env files. Precedence: real process env > .env.local > .env
// (first assignment wins, so .env.local is read before .env).
function loadDotEnv() {
  loadEnvFile('.env.local');
  loadEnvFile('.env');
}

loadDotEnv();

function str(name) {
  const value = process.env[name];
  return value == null ? '' : String(value).trim();
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function num(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveCatalogRegion() {
  return (
    str('AZURE_FOUNDRY_REGION') ||
    str('AZURE_REGION') ||
    str('AZURE_LOCATION') ||
    DEFAULT_CATALOG_REGION
  );
}

function resolveLocations() {
  const configured = splitList(str('AZURE_LOCATIONS'));
  if (configured.length) {
    return { locations: configured, sampled: false };
  }
  return { locations: CURATED_LOCATIONS.slice(), sampled: true };
}

function resolveAccountName() {
  return (
    str('AZURE_AI_SERVICES_ACCOUNT_NAME') ||
    str('AZURE_OPENAI_ACCOUNT_NAME') ||
    str('AZURE_FOUNDRY_PROJECT_NAME')
  );
}

function resolveMlRegistries() {
  const configured = splitList(str('AZURE_ML_REGISTRIES'));
  return configured.length ? configured : ['azureml'];
}

module.exports = {
  loadDotEnv,
  get PORT() {
    return num(str('PORT'), 3000);
  },
  get resourceGroup() {
    return str('AZURE_RESOURCE_GROUP');
  },
  get foundryProject() {
    return str('AZURE_FOUNDRY_PROJECT_NAME');
  },
  get aiServicesAccount() {
    return str('AZURE_AI_SERVICES_ACCOUNT_NAME');
  },
  get openAiAccount() {
    return str('AZURE_OPENAI_ACCOUNT_NAME');
  },
  resolveCatalogRegion,
  resolveLocations,
  resolveAccountName,
  resolveMlRegistries,
};

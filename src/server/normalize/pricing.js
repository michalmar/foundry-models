'use strict';

// Pricing normalization + matching (PRD §6.4, §7.4). Retail meters are not
// model-name normalized: they usually drop the publisher/family prefix (which
// lives in productName, e.g. "Azure Mistral Models" / "Large 3 Outp glbl Tokens")
// and often the version. We therefore match model-name aliases as token
// SUBSEQUENCES of the meter name, after dropping leading alias tokens that are
// already carried by the product name. A publisher/family guardrail keeps prices
// from bleeding across vendors, and generic family prices are never attached
// broadly (PRD §6.4, §18) — a model-specific alias must appear in the meter.

const { STRIP_SUFFIXES } = require('../constants');
const {
  normalizeText,
  applyAbbreviations,
  tokens,
  lower,
} = require('./text');

// Words too generic to be a family token or a standalone distinctive alias.
const GENERIC = new Set([
  'ai', 'labs', 'lab', 'inc', 'llc', 'ltd', 'co', 'corp', 'technologies',
  'technology', 'team', 'research', 'the', 'and', 'models', 'model', 'azure',
  'foundry', 'tokens', 'token', 'inp', 'outp', 'glbl', 'regnl', 'dzone',
  'global', 'regional', 'data', 'zone', 'standard', 'provisioned', 'managed',
  'hosting', 'service', 'services', 'units', 'unit', 'meter', 'machine',
  'learning', 'open', 'source', 'company', 'systems', 'group', 'studio',
  'batch', 'cached', 'tuning', 'pages', 'page', 'search', 'image', 'images',
  'audio', 'video', 'char', 'chars', 'characters', 'million', 'deployment',
  'fine', 'ft', 'in', 'out', 'enterprise', 'commitment', 'fw',
]);

function tokenList(value) {
  return applyAbbreviations(normalizeText(value)).split(' ').filter(Boolean);
}

function derivePrice(item) {
  const serviceName = lower(item.serviceName);
  const productName = String(item.productName || '');
  const meterName = String(item.meterName || '');
  const skuName = String(item.skuName || '');
  const text = applyAbbreviations(normalizeText(meterName + ' ' + skuName));

  let deploymentType = 'pay-as-you-go';
  if (serviceName === 'azure machine learning' && /managed model hosting/.test(lower(productName))) {
    deploymentType = 'managed-vm';
  } else if (/\bprovisioned\b|\bptu\b/.test(text)) {
    deploymentType = 'provisioned-throughput';
  }

  let scope;
  if (/\bdzone\b|\bdz\b/.test(text)) scope = 'data-zone';
  else if (/\bglbl\b|\bgl\b/.test(text)) scope = 'global';
  else if (/\bregnl\b/.test(text)) scope = 'regional';
  else scope = serviceName === 'foundry models' ? 'global' : 'regional';

  return {
    region: item.armRegionName || 'global',
    deploymentType,
    scope,
    productName,
    meterName,
    skuName,
    unit: item.unitOfMeasure || '',
    currency: item.currencyCode || '',
    retailPrice: typeof item.retailPrice === 'number' ? item.retailPrice : Number(item.retailPrice) || 0,
    _meterTokens: tokenList(meterName),
    _productTokens: new Set(tokens(productName, 2)),
    _familyTokens: new Set([].concat(tokenList(productName), tokenList(meterName))),
  };
}

function firstFamilyToken(value) {
  for (const part of normalizeText(value).split(' ')) {
    if (!part || /^\d/.test(part) || part.length < 3 || GENERIC.has(part)) continue;
    return part;
  }
  return null;
}

// Build name variants: abbreviation-normalized, text-suffix-stripped, and
// trailing-version-number-stripped (e.g. "Codestral-2501" -> "codestral").
// Each variant is tagged `reduced` when it was produced by stripping a trailing
// version number. Reduced variants are powerful (they let a meter that omits the
// version still match) but dangerous for families shared by many catalog models:
// "gpt-5.5" reduces to bare "gpt", which would match every OpenAI meter. The
// caller drops reduced variants for such "broad" families (see buildModelPricing).
// Structural-suffix stripping (instruct/preview/chat...) is always safe because
// meters routinely omit those words, so those variants stay reduced:false.
function nameVariants(raw) {
  const norm = normalizeText(raw);
  if (!norm) return [];
  const out = [];
  const seen = new Set();
  function add(str, reduced) {
    const arr = str.split(' ').filter(Boolean);
    if (!arr.length) return;
    const key = arr.join(' ');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ tokens: arr, reduced: reduced });
  }
  add(norm, false);
  add(applyAbbreviations(norm), false);
  const noSuffix = norm.split(' ');
  while (noSuffix.length > 1 && STRIP_SUFFIXES.includes(noSuffix[noSuffix.length - 1])) {
    noSuffix.pop();
    add(noSuffix.join(' '), false);
  }
  const noVersion = noSuffix.slice();
  while (noVersion.length > 1 && /^\d+$/.test(noVersion[noVersion.length - 1])) {
    noVersion.pop();
    add(noVersion.join(' '), true);
  }
  return out;
}

// Roots shared by more than this many catalog models are "broad" (e.g. "gpt",
// "llama", "deepseek"). Distinctive roots ("codestral", "codex") fall below it.
const BROAD_ROOT_THRESHOLD = 3;

// Count distinct models per name-root so we can tell broad families from
// distinctive ones. Only the model NAME/modelName roots count (not the
// publisher) — otherwise "Codestral" would inherit its publisher root "mistral"
// (broad) and lose the reduced alias it needs.
function computeBroadRoots(models) {
  const freq = new Map();
  for (const model of models) {
    const roots = new Set();
    [model.name, model.modelName].forEach(function (n) {
      const r = firstFamilyToken(n);
      if (r) roots.add(r);
    });
    roots.forEach(function (r) { freq.set(r, (freq.get(r) || 0) + 1); });
  }
  const broad = new Set();
  freq.forEach(function (count, root) { if (count > BROAD_ROOT_THRESHOLD) broad.add(root); });
  return broad;
}

function buildModelPricing(model, broadRoots) {
  const names = [model.name, model.modelName].filter(Boolean);

  const family = new Set();
  const pubRoot = firstFamilyToken(model.publisher);
  if (pubRoot) family.add(pubRoot);
  for (const raw of names) {
    const root = firstFamilyToken(raw);
    if (root) family.add(root);
  }

  const aliases = [];
  const seen = new Set();
  for (const raw of names) {
    for (const variant of nameVariants(raw)) {
      // Drop a version-stripped alias only when it carries no distinctive token,
      // i.e. it collapsed to just a broad family root + numbers/structural words
      // ("gpt-5.5" -> "gpt 5" -> "gpt"). Such an alias would attach every meter in
      // the family. A reduced alias that still holds a distinctive word
      // ("Mistral-large-2407" -> "mistral large", "DeepSeek-R1-0528" -> "deepseek
      // r1") is kept, since the meter often omits the exact version.
      if (variant.reduced && !hasDistinctiveToken(variant.tokens, broadRoots)) continue;
      const key = variant.tokens.join(' ');
      if (!seen.has(key)) { seen.add(key); aliases.push(variant.tokens); }
    }
  }

  return { aliases: aliases, family: family, allowed: new Set([].concat(Array.from(GENERIC), Array.from(family))) };
}

// A token is "distinctive" when it is not a bare number, not a structural/generic
// word, and not a broad family root shared across many catalog models.
function hasDistinctiveToken(tokenArr, broadRoots) {
  return tokenArr.some(function (t) {
    if (/^\d+$/.test(t)) return false;
    if (GENERIC.has(t)) return false;
    if (broadRoots && broadRoots.has(t)) return false;
    return true;
  });
}

// Anchored subsequence: the needle must occur in hay preceded only by tokens
// the model considers "allowed" (generic structural words or its own family).
// This rejects sibling meters like "MAI-DS-R1" for R1 or "5.1 codex mini" for
// codex-mini, where a distinctive foreign token precedes the alias.
//
// Version boundary: when the alias ends in a number, it must not be immediately
// followed by another number in the meter — that signals a longer version. So
// base "gpt 5" will not grab "GPT 5.1" (-> [gpt,5,1]), but "large" still matches
// "Large 3" (the trailing token is a word, so the rule does not apply).
function seqInAnchored(hay, needle, allowed) {
  if (!needle.length || needle.length > hay.length) return false;
  const lastNumeric = /^\d+$/.test(needle[needle.length - 1]);
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (!ok) continue;
    let anchored = true;
    for (let k = 0; k < i; k++) {
      if (!allowed.has(hay[k])) { anchored = false; break; }
    }
    if (!anchored) continue;
    const next = hay[i + needle.length];
    if (lastNumeric && next !== undefined && /^\d+$/.test(next)) continue;
    return true;
  }
  return false;
}

function aliasCompactLen(arr) {
  return arr.join('').length;
}

// Is this trimmed alias specific enough to attach? Reject empty / single bare
// digit / single ultra-generic qualifier tokens.
function acceptable(arr) {
  if (!arr.length) return false;
  if (aliasCompactLen(arr) < 2) return false;
  if (arr.length === 1) {
    const t = arr[0];
    if (/^\d+$/.test(t)) return false;
    if (GENERIC.has(t)) return false;
  }
  return true;
}

function matchesMeter(price, info) {
  for (const alias of info.aliases) {
    // Full alias (meters that repeat the family, e.g. "Llama-4-Scout-...").
    if (acceptable(alias) && seqInAnchored(price._meterTokens, alias, info.allowed)) return true;
    // Drop leading alias tokens already present in the product name
    // (e.g. "Azure Llama Models" / "3.3 70b ..." -> alias "3 3 70b").
    let start = 0;
    while (start < alias.length && price._productTokens.has(alias[start])) start++;
    if (start > 0 && start < alias.length) {
      const trimmed = alias.slice(start);
      if (acceptable(trimmed) && seqInAnchored(price._meterTokens, trimmed, info.allowed)) return true;
    }
  }
  return false;
}

function priceKey(price) {
  return [
    price.region,
    price.deploymentType,
    price.scope,
    price.meterName,
    price.skuName,
    price.unit,
    price.retailPrice,
  ].join('|');
}

function attachPricing(models, rawRows) {
  const rows = (rawRows || []).map(derivePrice);
  const broadRoots = computeBroadRoots(models);

  // Inverted index: family token -> row indices, for fast candidate lookup.
  const index = new Map();
  rows.forEach(function (row, i) {
    row._familyTokens.forEach(function (token) {
      if (GENERIC.has(token)) return;
      let bucket = index.get(token);
      if (!bucket) { bucket = new Set(); index.set(token, bucket); }
      bucket.add(i);
    });
  });

  for (const model of models) {
    const info = buildModelPricing(model, broadRoots);
    if (!info.family.size || !info.aliases.length) continue;

    const candidates = new Set();
    info.family.forEach(function (token) {
      const bucket = index.get(token);
      if (bucket) bucket.forEach(function (i) { candidates.add(i); });
    });
    if (!candidates.size) continue;

    const attached = new Set(model.prices.map(priceKey));

    candidates.forEach(function (i) {
      const row = rows[i];
      // Family guardrail: the row must share a family token with the model.
      let familyOk = false;
      info.family.forEach(function (token) { if (row._familyTokens.has(token)) familyOk = true; });
      if (!familyOk) return;
      if (!matchesMeter(row, info)) return;

      const price = {
        region: row.region,
        deploymentType: row.deploymentType,
        scope: row.scope,
        productName: row.productName,
        meterName: row.meterName,
        skuName: row.skuName,
        unit: row.unit,
        currency: row.currency,
        retailPrice: row.retailPrice,
      };
      const key = priceKey(price);
      if (attached.has(key)) return;
      attached.add(key);
      model.prices.push(price);
    });
  }
}

module.exports = { attachPricing, derivePrice, buildModelPricing, nameVariants };

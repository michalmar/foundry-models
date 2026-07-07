'use strict';

// Shared text helpers for normalization and pricing alias matching (PRD §6.4).

const { ABBREVIATIONS } = require('../constants');

function lower(value) {
  return value == null ? '' : String(value).toLowerCase();
}

// Lowercase, collapse non-alphanumerics to single spaces, trim.
function normalizeText(value) {
  return lower(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Apply abbreviation normalization (input -> inp, global -> glbl, ...).
function applyAbbreviations(value) {
  let out = ' ' + lower(value) + ' ';
  for (const [pattern, replacement] of ABBREVIATIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Remove all separators/punctuation -> compact identifier.
function compact(value) {
  return lower(value).replace(/[^a-z0-9]+/g, '');
}

// Distinct word tokens of length >= minLen.
function tokens(value, minLen) {
  const min = minLen || 3;
  const set = new Set();
  for (const part of normalizeText(value).split(' ')) {
    if (part.length >= min) set.add(part);
  }
  return set;
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, '-');
}

module.exports = {
  lower,
  normalizeText,
  applyAbbreviations,
  compact,
  tokens,
  slugify,
};

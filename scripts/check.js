#!/usr/bin/env node
'use strict';

// Syntax-checks every project .js file via `node --check`.
// Used by `npm run check`.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}

walk(path.join(root, 'src'));
files.push(path.join(root, 'server.js'));
files.push(path.join(root, 'scripts', 'check.js'));
files.push(path.join(root, 'public', 'app.js'));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    const detail = err.stderr ? err.stderr.toString() : err.message;
    console.error('Syntax error in ' + path.relative(root, file) + '\n' + detail);
  }
}

if (failed) {
  console.error('\n' + failed + ' file(s) failed syntax check.');
  process.exit(1);
}
console.log('Checked ' + files.length + ' file(s). All OK.');

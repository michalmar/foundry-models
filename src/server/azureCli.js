'use strict';

// Thin wrapper around the Azure CLI. Uses execFile with an argument array (no
// shell) so values from config/env cannot be interpreted as shell. Never logs
// or stores tokens (PRD §13, §18).

const { execFile } = require('child_process');

function runAz(args, options) {
  const opts = options || {};
  const timeout = opts.timeout || 120000;
  return new Promise((resolve) => {
    execFile(
      'az',
      args,
      { timeout, maxBuffer: 96 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const command = 'az ' + args.join(' ');
        if (err) {
          const message = (stderr && stderr.trim()) || err.message || 'az command failed';
          resolve({ ok: false, error: message.trim(), command });
        } else {
          resolve({ ok: true, stdout, command });
        }
      }
    );
  });
}

async function runAzJson(args, options) {
  const res = await runAz(args, options);
  if (!res.ok) return res;
  try {
    return { ok: true, data: JSON.parse(res.stdout), command: res.command };
  } catch (err) {
    return {
      ok: false,
      error: 'Failed to parse az JSON output: ' + err.message,
      command: res.command,
    };
  }
}

function getAccessToken(resource) {
  return runAzJson([
    'account',
    'get-access-token',
    '--resource',
    resource,
    '-o',
    'json',
  ]);
}

function getSubscription() {
  return runAzJson(['account', 'show', '-o', 'json']);
}

function accountShow(name, group) {
  return runAzJson([
    'cognitiveservices',
    'account',
    'show',
    '--name',
    name,
    '--resource-group',
    group,
    '-o',
    'json',
  ]);
}

function listModels(name, group) {
  return runAzJson([
    'cognitiveservices',
    'account',
    'list-models',
    '--name',
    name,
    '--resource-group',
    group,
    '-o',
    'json',
  ]);
}

module.exports = {
  runAz,
  runAzJson,
  getAccessToken,
  getSubscription,
  accountShow,
  listModels,
};

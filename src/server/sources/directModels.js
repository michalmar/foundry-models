'use strict';

// Direct deployment availability source (PRD §6.2). Uses Azure CLI against the
// configured Foundry AI Services / OpenAI account. Degrades gracefully and
// records status when configuration is missing or commands fail (PRD §12).

const config = require('../config');
const { accountShow, listModels } = require('../azureCli');

async function fetchDirectModels() {
  const statuses = [];
  const account = config.resolveAccountName();
  const group = config.resourceGroup;
  const result = { models: [], account, group, region: null, statuses };

  if (!account || !group) {
    statuses.push({
      ok: false,
      command: 'az cognitiveservices account show',
      message:
        'Missing AZURE_FOUNDRY_PROJECT_NAME / AZURE_AI_SERVICES_ACCOUNT_NAME or AZURE_RESOURCE_GROUP; skipping direct deployment lookup.',
    });
    return result;
  }

  const show = await accountShow(account, group);
  if (show.ok) {
    result.region =
      (show.data && (show.data.location || show.data.Location)) || null;
    statuses.push({ ok: true, command: show.command });
  } else {
    statuses.push({ ok: false, command: show.command, message: show.error });
  }

  const list = await listModels(account, group);
  if (list.ok) {
    const data = list.data;
    result.models = Array.isArray(data) ? data : (data && data.value) || [];
    statuses.push({
      ok: true,
      command: list.command,
      loaded: result.models.length,
    });
  } else {
    statuses.push({ ok: false, command: list.command, message: list.error });
  }

  return result;
}

module.exports = { fetchDirectModels };

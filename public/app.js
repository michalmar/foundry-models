'use strict';

/*
 * Azure AI Foundry Model Browser — client SPA (PRD §10, §11).
 * - Builds a precomputed search index (excludes long descriptions/pricing text).
 * - Debounced filtering, pagination (100/page), grid + list views.
 * - Three decision helpers: model availability, region inventory, best region.
 * - All model-derived text is rendered via textContent (no innerHTML) (PRD §18).
 */

(function () {
  var PAGE_SIZE = 100;
  var DETAIL_ROW_CAP = 250;

  // Coarse EU/US region geography for "Data Zone EU/US" semantics (PRD §10.3).
  var REGION_GEO = {
    swedencentral: 'eu', westeurope: 'eu', northeurope: 'eu', francecentral: 'eu',
    francesouth: 'eu', germanywestcentral: 'eu', germanynorth: 'eu',
    switzerlandnorth: 'eu', switzerlandwest: 'eu', norwayeast: 'eu', norwaywest: 'eu',
    uksouth: 'eu', ukwest: 'eu', polandcentral: 'eu', italynorth: 'eu', spaincentral: 'eu',
    eastus: 'us', eastus2: 'us', westus: 'us', westus2: 'us', westus3: 'us',
    centralus: 'us', northcentralus: 'us', southcentralus: 'us', westcentralus: 'us'
  };

  function geo(region) {
    return REGION_GEO[String(region || '').toLowerCase()] || 'unknown';
  }

  var state = {
    payload: null,
    index: [],
    filtered: [],
    page: 1,
    viewMode: 'grid',
    filters: { search: '', category: '', vendor: '', deployment: '', scope: '', region: '' }
  };

  // ---- DOM helpers (safe construction) ---------------------------------------

  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value == null) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.keys(value).forEach(function (d) { node.dataset[d] = value[d]; });
        else if (key.indexOf('on') === 0 && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value);
      });
    }
    for (var i = 2; i < arguments.length; i++) appendChild(node, arguments[i]);
    return node;
  }

  function appendChild(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { appendChild(node, c); }); return; }
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function byId(id) { return document.getElementById(id); }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  // ---- Data loading ----------------------------------------------------------

  function fetchJson(url, options) {
    return fetch(url, options).then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function loadModels() {
    return fetchJson('/api/models').then(function (res) {
      applyPayload(res.data);
    }).catch(function (err) {
      showNotice('Failed to load models: ' + err.message);
    });
  }

  function applyPayload(payload) {
    state.payload = payload;
    state.index = (payload.models || []).map(buildIndexEntry);
    populateFilters(payload.meta || {});
    populateDatalists(payload);
    renderStatus();
    state.page = 1;
    applyFilters();
  }

  function buildIndexEntry(model) {
    var parts = [model.name, model.modelName, model.publisher];
    if (model.catalog) { parts.push(model.catalog.registry, model.catalog.task); }
    if (model.versions && model.versions.length) parts.push(model.versions.join(' '));
    var regions = {}, deployments = {}, scopes = {};
    (model.availability || []).forEach(function (a) {
      parts.push(a.region, a.route, a.deploymentType, a.scope, a.sku);
      if (a.region) regions[a.region] = true;
      if (a.deploymentType) deployments[a.deploymentType] = true;
      if (a.scope) scopes[a.scope] = true;
    });
    // Availability is the source of truth for where/how a model is deployable
    // (see facetValues). Pricing is published for far more regions than a model
    // can be deployed in, so region is NEVER derived from pricing. Deployment /
    // scope fall back to pricing only for models that have no availability rows,
    // so those models stay filterable.
    if (!(model.availability && model.availability.length)) {
      (model.prices || []).forEach(function (p) {
        if (p.deploymentType) deployments[p.deploymentType] = true;
        if (p.scope) scopes[p.scope] = true;
      });
    }
    return {
      ref: model,
      search: parts.filter(Boolean).join(' ').toLowerCase(),
      category: model.category || 'unknown',
      vendorLower: (model.publisher || '').toLowerCase(),
      regions: regions,
      deployments: deployments,
      scopes: scopes
    };
  }

  // ---- Filters ---------------------------------------------------------------

  function fillSelect(select, values, keepFirst) {
    var current = select.value;
    if (keepFirst && select.firstChild) {
      while (select.childNodes.length > 1) select.removeChild(select.lastChild);
    } else clear(select);
    (values || []).forEach(function (v) {
      select.appendChild(h('option', { value: v, text: v }));
    });
    if (current) select.value = current;
  }

  function populateFilters(meta) {
    var categories = Object.keys(meta.categories || {}).sort();
    fillSelect(byId('filterCategory'), categories, true);
    fillSelect(byId('filterVendor'), meta.vendors || [], true);
    fillSelect(byId('filterDeployment'), meta.deploymentTypes || [], true);
    fillSelect(byId('filterScope'), meta.scopes || [], true);
    fillSelect(byId('filterRegion'), meta.regions || [], true);
    // Decision-helper selects reuse the same option lists.
    fillSelect(byId('daDeployment'), meta.deploymentTypes || [], true);
    fillSelect(byId('riVendor'), meta.vendors || [], true);
    fillSelect(byId('riCategory'), categories, true);
    fillSelect(byId('riDeployment'), meta.deploymentTypes || [], true);
    fillSelect(byId('riScope'), meta.scopes || [], true);
    fillSelect(byId('brDeployment'), meta.deploymentTypes || [], true);
  }

  function populateDatalists(payload) {
    var modelList = byId('modelNameList');
    var regionList = byId('regionList');
    clear(modelList);
    clear(regionList);
    var names = (payload.models || []).map(function (m) { return m.name; }).sort();
    names.slice(0, 4000).forEach(function (n) { modelList.appendChild(h('option', { value: n })); });
    ((payload.meta && payload.meta.regions) || []).forEach(function (r) {
      regionList.appendChild(h('option', { value: r }));
    });
  }

  function readFilters() {
    state.filters = {
      search: byId('filterSearch').value.trim().toLowerCase(),
      category: byId('filterCategory').value,
      vendor: byId('filterVendor').value,
      deployment: byId('filterDeployment').value,
      scope: byId('filterScope').value,
      region: byId('filterRegion').value
    };
  }

  function passesFilters(entry) {
    var f = state.filters;
    if (f.category && entry.category !== f.category) return false;
    if (f.vendor && entry.vendorLower !== f.vendor.toLowerCase()) return false;
    if (f.deployment && !entry.deployments[f.deployment]) return false;
    if (f.scope && !entry.scopes[f.scope]) return false;
    if (f.region && !entry.regions[f.region]) return false;
    if (f.search) {
      var tokens = f.search.split(/\s+/);
      for (var i = 0; i < tokens.length; i++) {
        if (entry.search.indexOf(tokens[i]) === -1) return false;
      }
    }
    return true;
  }

  function applyFilters() {
    readFilters();
    state.filtered = state.index.filter(passesFilters);
    var maxPage = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    if (state.page > maxPage) state.page = maxPage;
    render();
  }

  // ---- Rendering: summary + results -----------------------------------------

  function render() {
    renderSummary();
    renderResults();
    renderPagination();
  }

  function sumOver(entries, field) {
    return entries.reduce(function (acc, e) {
      return acc + ((e.ref[field] || []).length);
    }, 0);
  }

  function renderSummary() {
    var box = byId('summary');
    clear(box);
    if (!state.payload || !state.payload.models || !state.payload.models.length) return;

    var total = state.filtered.length;
    var start = (state.page - 1) * PAGE_SIZE;
    var pageEntries = state.filtered.slice(start, start + PAGE_SIZE);
    var maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

    var categoryCounts = {};
    state.filtered.forEach(function (e) {
      categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
    });

    function metric(value, label) {
      return h('div', { class: 'metric' }, h('strong', { text: String(value) }), h('span', { text: label }));
    }

    box.appendChild(metric(total, 'matches'));
    box.appendChild(metric('Page ' + state.page + ' / ' + maxPage, 'current page'));
    box.appendChild(metric(pageEntries.length, state.viewMode === 'list' ? 'rows rendered' : 'cards rendered'));
    box.appendChild(metric(sumOver(state.filtered, 'availability'), 'availability rows'));
    box.appendChild(metric(sumOver(state.filtered, 'prices'), 'pricing rows'));

    var cats = h('div', { class: 'category-counts' });
    cats.appendChild(h('span', { class: 'field' }, h('span', { text: 'Categories' })));
    Object.keys(categoryCounts).sort().forEach(function (cat) {
      cats.appendChild(h('span', { class: 'badge ' + cat, text: cat + ': ' + categoryCounts[cat] }));
    });
    box.appendChild(cats);
  }

  function renderResults() {
    var container = byId('results');
    clear(container);
    container.className = 'results ' + state.viewMode;

    if (!state.payload || !state.payload.models || !state.payload.models.length) {
      container.className = 'results';
      var msg = (state.payload && state.payload.message) ||
        'No models loaded yet. Click "Refresh data" to fetch the catalog.';
      container.appendChild(h('div', { class: 'notice', text: msg }));
      return;
    }
    if (!state.filtered.length) {
      container.className = 'results';
      container.appendChild(h('div', { class: 'notice', text: 'No models match the current filters.' }));
      return;
    }

    var start = (state.page - 1) * PAGE_SIZE;
    var pageEntries = state.filtered.slice(start, start + PAGE_SIZE);

    if (state.viewMode === 'grid') {
      pageEntries.forEach(function (e) { container.appendChild(renderCard(e.ref)); });
    } else {
      container.appendChild(renderListHeader());
      pageEntries.forEach(function (e) { container.appendChild(renderListRow(e.ref)); });
    }
  }

  function summarizeSet(arr, key) {
    var seen = {};
    (arr || []).forEach(function (item) { if (item[key]) seen[item[key]] = true; });
    return Object.keys(seen);
  }

  // Multi-select badge group used as the in-card filter: clicking a badge toggles
  // it on/off; the selected values (a Set the caller reads in rowPasses) narrow the
  // availability + pricing tables. These badges replace the old filter dropdowns.
  function selectableChipGroup(label, values, selected, onChange) {
    if (!values.length) return null;
    var chips = h('div', { class: 'chips' });
    values.forEach(function (v) {
      var chip = h('button', { type: 'button', class: 'chip chip-toggle',
        'aria-pressed': 'false', text: v });
      chip.addEventListener('click', function () {
        if (selected.has(v)) {
          selected.delete(v);
          chip.classList.remove('is-selected');
          chip.setAttribute('aria-pressed', 'false');
        } else {
          selected.add(v);
          chip.classList.add('is-selected');
          chip.setAttribute('aria-pressed', 'true');
        }
        onChange();
      });
      chips.appendChild(chip);
    });
    return h('div', { class: 'chip-group' },
      h('span', { class: 'chip-group-label', text: label }), chips);
  }

  // Badge values for the in-card filters come from the model's AVAILABILITY rows
  // (the source of truth for where/how a model can actually be deployed), sorted.
  // Pricing rows are published for far more regions than a model is deployable in,
  // so unioning them would surface regions the model isn't available in. For the
  // few models that have pricing but no availability, fall back to pricing values
  // so those models remain filterable.
  function facetValues(model, key) {
    var vals = summarizeSet(model.availability, key);
    if (!vals.length) vals = summarizeSet(model.prices, key);
    return vals.sort();
  }

  // A row passes when, for each facet, no badge is selected (Set empty) or the
  // row's value is among the selected badges (multi-select OR within a facet,
  // AND across facets).
  function setPass(selected, value) {
    return selected.size === 0 || selected.has(value);
  }

  function rowPasses(row, f) {
    return setPass(f.region, row.region) &&
      setPass(f.deploymentType, row.deploymentType) &&
      setPass(f.scope, row.scope);
  }

  // Shared detail block used by both grid cards and list rows: multi-select badge
  // filters (Region / Deployment / Scope) and collapsible availability + pricing
  // tables that re-render as badges are toggled. The badges are the filter — they
  // replace the previous dropdown controls.
  function buildDetailBlock(model, openSections) {
    var frag = document.createDocumentFragment();
    var f = { region: new Set(), deploymentType: new Set(), scope: new Set() };

    var availSummary = h('summary');
    var priceSummary = h('summary');
    var availBody = h('div', { class: 'table-scroll' });
    var priceBody = h('div', { class: 'table-scroll' });

    function fill(body, all, render) {
      clear(body);
      body.appendChild(render(all.slice(0, DETAIL_ROW_CAP)));
      if (all.length > DETAIL_ROW_CAP) {
        body.appendChild(h('div', { class: 'detail-more',
          text: 'Showing ' + DETAIL_ROW_CAP + ' of ' + all.length + ' rows — narrow with the badges above.' }));
      }
    }

    function refresh() {
      var availTotal = (model.availability || []).length;
      var priceTotal = (model.prices || []).length;
      var fa = (model.availability || []).filter(function (r) { return rowPasses(r, f); });
      var fp = (model.prices || []).filter(function (r) { return rowPasses(r, f); });
      availSummary.textContent = 'Availability (' + fa.length + (fa.length !== availTotal ? ' of ' + availTotal : '') + ')';
      priceSummary.textContent = 'Pricing (' + fp.length + (fp.length !== priceTotal ? ' of ' + priceTotal : '') + ')';
      fill(availBody, fa, availabilityTable);
      fill(priceBody, fp, priceTable);
    }

    var groups = [
      selectableChipGroup('Region', facetValues(model, 'region'), f.region, refresh),
      selectableChipGroup('Deployment', facetValues(model, 'deploymentType'), f.deploymentType, refresh),
      selectableChipGroup('Scope', facetValues(model, 'scope'), f.scope, refresh)
    ].filter(Boolean);
    if (groups.length) {
      var filterWrap = h('div', { class: 'card-filters' },
        h('span', { class: 'card-filters-label', text: 'Filter details — select badges:' }));
      groups.forEach(function (g) { filterWrap.appendChild(g); });
      frag.appendChild(filterWrap);
    }

    var availDetails = h('details', { class: 'section' }, availSummary, availBody);
    var priceDetails = h('details', { class: 'section' }, priceSummary, priceBody);
    if (openSections) { availDetails.open = true; priceDetails.open = true; }
    frag.appendChild(availDetails);
    frag.appendChild(priceDetails);

    refresh();
    return { frag: frag, sections: [availDetails, priceDetails] };
  }

  function availabilityTable(rows) {
    if (!rows || !rows.length) return h('div', { class: 'empty-detail', text: 'No matching availability rows.' });
    var table = h('table', { class: 'detail-table' });
    table.appendChild(h('tr', null,
      h('th', { text: 'Region' }), h('th', { text: 'Route' }),
      h('th', { text: 'Deployment' }), h('th', { text: 'Scope' }), h('th', { text: 'SKU' })));
    rows.forEach(function (r) {
      table.appendChild(h('tr', null,
        h('td', { text: r.region }), h('td', { text: r.route }),
        h('td', { text: r.deploymentType }), h('td', { text: r.scope }), h('td', { text: r.sku })));
    });
    return table;
  }

  function priceTable(prices) {
    if (!prices || !prices.length) {
      return h('div', { class: 'price-none', text: 'No pricing found in cache for this selection.' });
    }
    var table = h('table', { class: 'detail-table' });
    table.appendChild(h('tr', null,
      h('th', { text: 'Region' }), h('th', { text: 'Deployment' }), h('th', { text: 'Scope' }),
      h('th', { text: 'Meter' }), h('th', { text: 'SKU' }), h('th', { text: 'Unit' }), h('th', { text: 'Price' })));
    prices.forEach(function (p) {
      table.appendChild(h('tr', null,
        h('td', { text: p.region }), h('td', { text: p.deploymentType }), h('td', { text: p.scope }),
        h('td', { text: p.meterName }), h('td', { text: p.skuName }), h('td', { text: p.unit }),
        h('td', { text: formatPrice(p) })));
    });
    return table;
  }

  function formatPrice(p) {
    if (typeof p.retailPrice !== 'number') return String(p.retailPrice);
    return (p.currency ? p.currency + ' ' : '') + p.retailPrice;
  }

  function renderCard(model) {
    var card = h('div', { class: 'card' });
    var versions = (model.versions && model.versions.length) ? ' · v' + model.versions.join(', v') : '';
    card.appendChild(h('div', { class: 'card-head' },
      h('div', null,
        h('div', { class: 'card-title', text: model.name }),
        h('div', { class: 'card-vendor', text: model.publisher + versions })),
      h('span', { class: 'badge ' + (model.category || 'unknown'), text: model.category || 'unknown' })));

    if (model.summary) card.appendChild(h('p', { class: 'description', text: model.summary }));

    var block = buildDetailBlock(model, false);
    card.appendChild(block.frag);

    // Grow the card to span a full grid row when a detail section opens, so the
    // wide availability/pricing tables have room to render (card redesign req §2).
    function syncExpanded() {
      card.classList.toggle('is-expanded', block.sections.some(function (d) { return d.open; }));
    }
    block.sections.forEach(function (d) { d.addEventListener('toggle', syncExpanded); });

    return card;
  }

  function renderListHeader() {
    return h('div', { class: 'list-header' },
      h('span', { text: '' }), h('span', { text: 'Model' }), h('span', { text: 'Vendor / version' }),
      h('span', { text: 'Category' }), h('span', { text: 'Regions' }),
      h('span', { text: 'Deployment' }), h('span', { text: 'Scope' }));
  }

  function renderListRow(model) {
    var row = h('div', { class: 'list-row' });
    var regions = summarizeSet(model.availability, 'region');
    var deployments = summarizeSet(model.availability, 'deploymentType');
    var scopes = summarizeSet(model.availability, 'scope');
    var version = (model.versions && model.versions.length) ? model.versions[0] : '';

    var detail = h('div', { class: 'list-row-detail is-hidden' });
    if (model.summary) detail.appendChild(h('p', { class: 'description', text: model.summary }));
    detail.appendChild(buildDetailBlock(model, true).frag);

    var main = h('button', { class: 'list-row-main', type: 'button', 'aria-expanded': 'false' },
      h('span', { class: 'expand-indicator', text: '▶' }),
      h('span', { class: 'list-cell-name', text: model.name }),
      h('span', { text: model.publisher + (version ? ' · v' + version : '') }),
      h('span', null, h('span', { class: 'badge ' + (model.category || 'unknown'), text: model.category || 'unknown' })),
      h('span', { text: String(regions.length) }),
      h('span', { text: deployments.join(', ') || '—' }),
      h('span', { text: scopes.join(', ') || '—' }));

    main.addEventListener('click', function () {
      var open = row.classList.toggle('open');
      detail.classList.toggle('is-hidden', !open);
      main.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    row.appendChild(main);
    row.appendChild(detail);
    return row;
  }

  function renderPagination() {
    var nav = byId('pagination');
    clear(nav);
    if (!state.filtered.length) return;
    var maxPage = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    var prev = h('button', { type: 'button', text: 'Previous' });
    prev.disabled = state.page <= 1;
    prev.addEventListener('click', function () { if (state.page > 1) { state.page--; render(); scrollTopResults(); } });
    var next = h('button', { type: 'button', text: 'Next' });
    next.disabled = state.page >= maxPage;
    next.addEventListener('click', function () { if (state.page < maxPage) { state.page++; render(); scrollTopResults(); } });
    nav.appendChild(prev);
    nav.appendChild(h('span', { class: 'page-label', text: 'Page ' + state.page + ' of ' + maxPage }));
    nav.appendChild(next);
  }

  function scrollTopResults() {
    var el = byId('results');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function showNotice(message) {
    var container = byId('results');
    container.className = 'results';
    clear(container);
    container.appendChild(h('div', { class: 'notice', text: message }));
  }

  // ---- Status panel ----------------------------------------------------------

  function statusPill(label, ok, extra) {
    var cls = ok === true ? 'ok' : ok === false ? 'err' : 'warn';
    var text = label + (extra ? ' · ' + extra : '');
    return h('span', { class: 'status-pill' }, h('span', { class: 'status-dot ' + cls }), h('span', { text: text }));
  }

  function countOk(list) {
    var ok = 0, fail = 0;
    (list || []).forEach(function (s) { if (s.ok) ok++; else fail++; });
    return { ok: ok, fail: fail };
  }

  function renderStatus() {
    var panel = byId('statusPanel');
    clear(panel);
    var payload = state.payload || {};
    var status = payload.status || { catalog: [], commands: [], pricing: [] };

    var line = h('div', { class: 'status-line' });
    if (payload.generatedAt) {
      line.appendChild(h('span', { class: 'status-pill' },
        h('span', { text: 'Cache: ' + new Date(payload.generatedAt).toLocaleString() })));
    } else {
      line.appendChild(h('span', { class: 'status-pill' }, h('span', { class: 'status-dot warn' }), h('span', { text: 'No cache yet' })));
    }

    var cat = countOk(status.catalog);
    var catPages = (status.catalog[0] && status.catalog[0].pages) || 0;
    var catLoaded = (status.catalog[0] && status.catalog[0].loaded);
    var catTotal = (status.catalog[0] && status.catalog[0].totalCount);
    var catExtra = (catLoaded != null ? catLoaded : 0) + (catTotal != null ? ' / ' + catTotal : '') + ' models, ' + catPages + 'p';
    line.appendChild(statusPill('Catalog', cat.fail === 0 && (status.catalog.length > 0), status.catalog.length ? catExtra : 'none'));

    var cmd = countOk(status.commands);
    line.appendChild(statusPill('CLI/Regional', cmd.fail === 0 && status.commands.length > 0, cmd.ok + ' ok / ' + cmd.fail + ' fail'));

    var price = countOk(status.pricing);
    var pricePages = (status.pricing || []).reduce(function (a, s) { return a + (s.pages || 0); }, 0);
    var priceLoaded = (status.pricing || []).reduce(function (a, s) { return a + (s.loaded || 0); }, 0);
    line.appendChild(statusPill('Pricing', price.fail === 0 && status.pricing.length > 0, priceLoaded + ' rows, ' + pricePages + 'p'));

    var meta = payload.meta || {};
    line.appendChild(h('span', { class: 'status-pill' }, h('span', {
      text: (meta.vendorCount || 0) + ' vendors · ' + (meta.modelsWithPricing || 0) + ' priced · HF ' + (payload.options && payload.options.includeHuggingFace ? 'on' : 'off')
    })));

    panel.appendChild(line);

    if (payload.sampledLocations && payload.locations && payload.locations.length) {
      panel.appendChild(h('div', { class: 'status-note',
        text: 'Regional availability is a sampled view (AZURE_LOCATIONS not set). Scanned: ' + payload.locations.join(', ') + '.' }));
    }
    if (payload.message) {
      panel.appendChild(h('div', { class: 'status-note', text: payload.message }));
    }

    var allStatuses = [].concat(status.catalog, status.commands, status.pricing);
    var failures = allStatuses.filter(function (s) { return s && s.ok === false; });
    if (failures.length) {
      var details = h('details', { class: 'status-details' }, h('summary', { text: failures.length + ' source warning(s) — details' }));
      var ul = h('ul');
      failures.forEach(function (s) {
        var label = s.command || s.source || s.filter || 'source';
        ul.appendChild(h('li', { text: label + ': ' + (s.message || 'failed') }));
      });
      details.appendChild(ul);
      panel.appendChild(details);
    }
  }

  // ---- Refresh ---------------------------------------------------------------

  function doRefresh() {
    var button = byId('refreshButton');
    var statusText = byId('refreshStatus');
    var includeHF = byId('includeHuggingFace').checked;
    button.disabled = true;
    statusText.textContent = includeHF
      ? 'Refreshing (incl. Hugging Face)… catalog, availability, pricing'
      : 'Refreshing… catalog, availability, pricing';

    fetchJson('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeHuggingFace: includeHF })
    }).then(function (res) {
      if (!res.ok) {
        statusText.textContent = 'Refresh failed: ' + ((res.data && res.data.error) || res.status);
        return;
      }
      applyPayload(res.data);
      statusText.textContent = 'Refreshed ' + new Date().toLocaleTimeString();
    }).catch(function (err) {
      statusText.textContent = 'Refresh error: ' + err.message;
    }).then(function () {
      button.disabled = false;
    });
  }

  // ---- Decision helpers ------------------------------------------------------

  function allModels() {
    return (state.payload && state.payload.models) || [];
  }

  function resolveModel(query) {
    if (!query) return null;
    var q = query.trim().toLowerCase();
    var models = allModels();
    var i;
    for (i = 0; i < models.length; i++) {
      if (models[i].name.toLowerCase() === q || (models[i].modelName && models[i].modelName.toLowerCase() === q)) return models[i];
    }
    for (i = 0; i < models.length; i++) {
      if (models[i].name.toLowerCase().indexOf(q) === 0) return models[i];
    }
    for (i = 0; i < models.length; i++) {
      if (models[i].name.toLowerCase().indexOf(q) !== -1 || (models[i].modelName && models[i].modelName.toLowerCase().indexOf(q) !== -1)) return models[i];
    }
    return null;
  }

  function scopeMatches(row, wanted) {
    if (!wanted) return true;
    if (wanted === 'eu' || wanted === 'us') {
      if (row.scope === wanted) return true;
      if (row.scope === 'data-zone' && geo(row.region) === wanted) return true;
      return false;
    }
    return row.scope === wanted;
  }

  function rowMatches(row, scope, deployment, route) {
    if (deployment && row.deploymentType !== deployment) return false;
    if (route && row.route !== route) return false;
    return scopeMatches(row, scope);
  }

  function pricesForRegion(model, region, scope, deployment) {
    return (model.prices || []).filter(function (p) {
      if (p.region !== region && p.region !== 'global') return false;
      if (deployment && p.deploymentType !== deployment) return false;
      if (scope && !scopeMatches(p, scope)) return false;
      return true;
    });
  }

  function runAvailabilityMode() {
    var out = byId('daOutput');
    clear(out);
    var model = resolveModel(byId('daModel').value);
    if (!model) {
      out.appendChild(h('div', { class: 'notice', text: 'No model matches that name in the current cache.' }));
      return;
    }
    var scope = byId('daScope').value;
    var deployment = byId('daDeployment').value;
    var route = byId('daRoute').value;

    var rows = (model.availability || []).filter(function (r) { return rowMatches(r, scope, deployment, route); });

    out.appendChild(h('h4', { text: model.name + ' — ' + model.publisher }));
    if (!rows.length) {
      out.appendChild(h('div', { class: 'notice',
        text: 'No cached availability matches ' + model.name + ' for the selected scope/deployment/route.' }));
      return;
    }

    var byRegion = {};
    rows.forEach(function (r) { (byRegion[r.region] = byRegion[r.region] || []).push(r); });
    Object.keys(byRegion).sort().forEach(function (region) {
      var card = h('div', { class: 'region-card' });
      card.appendChild(h('h4', { text: region + (geo(region) !== 'unknown' ? ' (' + geo(region).toUpperCase() + ')' : '') }));
      card.appendChild(availabilityTable(byRegion[region]));
      var prices = pricesForRegion(model, region, scope, deployment);
      card.appendChild(h('div', null, h('strong', { text: 'Pricing' }), priceTable(prices)));
      out.appendChild(card);
    });
  }

  function runRegionMode() {
    var out = byId('riOutput');
    clear(out);
    var region = byId('riRegion').value.trim().toLowerCase();
    if (!region) {
      out.appendChild(h('div', { class: 'notice', text: 'Enter a region to see its inventory.' }));
      return;
    }
    var vendor = byId('riVendor').value.toLowerCase();
    var category = byId('riCategory').value;
    var deployment = byId('riDeployment').value;
    var scope = byId('riScope').value;

    var matches = [];
    allModels().forEach(function (model) {
      if (vendor && (model.publisher || '').toLowerCase() !== vendor) return;
      if (category && (model.category || 'unknown') !== category) return;
      var rows = (model.availability || []).filter(function (r) {
        return r.region.toLowerCase() === region && rowMatches(r, scope, deployment, '');
      });
      if (rows.length) matches.push({ model: model, rows: rows });
    });

    if (!matches.length) {
      out.appendChild(h('div', { class: 'notice', text: 'No cached models available in "' + region + '" for the selected filters. Coverage may be sampled — try Refresh with AZURE_LOCATIONS set.' }));
      return;
    }

    var vendors = {}, cats = {}, deployments = {}, scopes = {};
    matches.forEach(function (m) {
      vendors[m.model.publisher] = (vendors[m.model.publisher] || 0) + 1;
      cats[m.model.category || 'unknown'] = (cats[m.model.category || 'unknown'] || 0) + 1;
      m.rows.forEach(function (r) {
        deployments[r.deploymentType] = (deployments[r.deploymentType] || 0) + 1;
        scopes[r.scope] = (scopes[r.scope] || 0) + 1;
      });
    });

    out.appendChild(h('h4', { text: matches.length + ' models available in ' + region + (geo(region) !== 'unknown' ? ' (' + geo(region).toUpperCase() + ')' : '') }));
    out.appendChild(summaryLine('By vendor', vendors));
    out.appendChild(summaryLine('By category', cats));
    out.appendChild(summaryLine('By deployment', deployments));
    out.appendChild(summaryLine('By scope', scopes));

    var list = h('div', { class: 'results list' });
    list.appendChild(renderListHeader());
    matches.sort(function (a, b) { return a.model.name.localeCompare(b.model.name); });
    matches.slice(0, 500).forEach(function (m) {
      // Constrain the rendered availability to the selected region first (PRD §10.4).
      var constrained = Object.assign({}, m.model, { availability: m.rows });
      list.appendChild(renderListRow(constrained));
    });
    out.appendChild(list);
    if (matches.length > 500) out.appendChild(h('div', { class: 'status-note', text: 'Showing first 500 of ' + matches.length + ' models.' }));
  }

  function summaryLine(label, counts) {
    var row = h('div', { class: 'summary-grid' });
    row.appendChild(h('span', null, h('strong', { text: label + ': ' })));
    Object.keys(counts).sort().forEach(function (key) {
      row.appendChild(h('span', { text: key + ' (' + counts[key] + ')' }));
    });
    return row;
  }

  function parseList(value) {
    return (value || '').split(/[,\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function runBestRegionMode() {
    var out = byId('brOutput');
    clear(out);
    var names = parseList(byId('brModels').value);
    if (!names.length) {
      out.appendChild(h('div', { class: 'notice', text: 'Enter one or more required model names.' }));
      return;
    }
    var scope = byId('brScope').value;
    var deployment = byId('brDeployment').value;
    var allowed = parseList(byId('brAllowed').value).map(function (s) { return s.toLowerCase(); });
    var preferred = parseList(byId('brPreferred').value).map(function (s) { return s.toLowerCase(); });

    var resolved = [], unresolved = [];
    names.forEach(function (name) {
      var model = resolveModel(name);
      if (model) resolved.push({ query: name, model: model });
      else unresolved.push(name);
    });

    if (!resolved.length) {
      out.appendChild(h('div', { class: 'notice', text: 'None of the requested models were found in the cache: ' + names.join(', ') }));
      return;
    }

    // Candidate regions = union of regions (matching scope/deployment) across resolved models.
    var regionSet = {};
    resolved.forEach(function (item) {
      (item.model.availability || []).forEach(function (r) {
        if (rowMatches(r, scope, deployment, '')) regionSet[r.region] = true;
      });
    });
    var regions = Object.keys(regionSet).filter(function (r) {
      return !allowed.length || allowed.indexOf(r.toLowerCase()) !== -1;
    });

    if (!regions.length) {
      out.appendChild(h('div', { class: 'notice', text: 'No cached region offers any of the selected models under the chosen constraints.' }));
      return;
    }

    var candidates = regions.map(function (region) {
      var available = [], missing = [], deployments = {}, scopes = {}, vendors = {}, pricedCount = 0, optionCount = 0;
      resolved.forEach(function (item) {
        var rows = (item.model.availability || []).filter(function (r) {
          return r.region === region && rowMatches(r, scope, deployment, '');
        });
        if (rows.length) {
          available.push(item.model.name);
          vendors[item.model.publisher] = true;
          optionCount += rows.length;
          rows.forEach(function (r) { deployments[r.deploymentType] = true; scopes[r.scope] = true; });
          if (pricesForRegion(item.model, region, scope, deployment).length) pricedCount++;
        } else {
          missing.push(item.model.name);
        }
      });

      var allAvailable = missing.length === 0;
      var score = 0;
      var reasons = [];
      if (allAvailable) { score += 1000; reasons.push('All ' + resolved.length + ' required models available'); }
      else reasons.push(available.length + '/' + resolved.length + ' required models available');
      score += Math.round((available.length / resolved.length) * 500);
      if (scope && allAvailable) { score += 100; reasons.push('Scope "' + scope + '" satisfied for all models'); }
      if (deployment && allAvailable) { score += 100; reasons.push('Deployment "' + deployment + '" satisfied for all models'); }
      if (pricedCount) { score += pricedCount * 10; reasons.push(pricedCount + ' models with pricing coverage'); }
      score += Object.keys(deployments).length;
      var prefIndex = preferred.indexOf(region.toLowerCase());
      if (prefIndex !== -1) { score += (preferred.length - prefIndex) * 5; reasons.push('Preferred region (#' + (prefIndex + 1) + ')'); }

      return {
        region: region, available: available, missing: missing, allAvailable: allAvailable,
        deployments: Object.keys(deployments), scopes: Object.keys(scopes), vendors: Object.keys(vendors),
        pricedCount: pricedCount, optionCount: optionCount, score: score, reasons: reasons
      };
    });

    candidates.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.region.localeCompare(b.region);
    });

    var full = candidates.filter(function (c) { return c.allAvailable; });
    var header = full.length
      ? full.length + ' region(s) cover all ' + resolved.length + ' selected models'
      : 'No single region covers all models — showing closest partial matches';
    out.appendChild(h('h4', { text: header }));

    if (unresolved.length) {
      out.appendChild(h('div', { class: 'status-note', text: 'Not found in cache (ignored): ' + unresolved.join(', ') }));
    }
    if (state.payload && state.payload.sampledLocations) {
      out.appendChild(h('div', { class: 'status-note', text: 'Regional coverage is sampled; a region missing here may still support a model if not scanned.' }));
    }

    candidates.slice(0, 25).forEach(function (c) {
      var card = h('div', { class: 'region-card' });
      card.appendChild(h('h4', null,
        h('span', { text: c.region + (geo(c.region) !== 'unknown' ? ' (' + geo(c.region).toUpperCase() + ')' : '') }),
        h('span', { class: 'score-badge', text: 'score ' + c.score })));
      var grid = h('div', { class: 'summary-grid' });
      grid.appendChild(h('span', null, h('strong', { text: 'Covered: ' }), document.createTextNode(c.available.join(', ') || '—')));
      grid.appendChild(h('span', null, h('strong', { text: 'Missing: ' }), document.createTextNode(c.missing.join(', ') || 'none')));
      card.appendChild(grid);
      var grid2 = h('div', { class: 'summary-grid' });
      grid2.appendChild(h('span', { text: 'Deployments: ' + (c.deployments.join(', ') || '—') }));
      grid2.appendChild(h('span', { text: 'Scopes: ' + (c.scopes.join(', ') || '—') }));
      grid2.appendChild(h('span', { text: 'Priced models: ' + c.pricedCount }));
      card.appendChild(grid2);
      var reasons = h('ul', { class: 'reasons' });
      c.reasons.forEach(function (r) { reasons.appendChild(h('li', { text: r })); });
      card.appendChild(reasons);
      out.appendChild(card);
    });
  }

  // ---- Wiring ----------------------------------------------------------------

  function switchDecisionMode(mode) {
    var tabs = document.querySelectorAll('.mode-tab');
    tabs.forEach(function (t) { t.classList.toggle('is-active', t.dataset.mode === mode); });
    document.querySelectorAll('.decision-panel').forEach(function (p) {
      p.classList.toggle('is-hidden', p.dataset.panel !== mode);
    });
  }

  function wire() {
    byId('refreshButton').addEventListener('click', doRefresh);

    var debounced = debounce(function () { state.page = 1; applyFilters(); }, 200);
    byId('filterSearch').addEventListener('input', debounced);
    ['filterCategory', 'filterVendor', 'filterDeployment', 'filterScope', 'filterRegion'].forEach(function (id) {
      byId(id).addEventListener('change', function () { state.page = 1; applyFilters(); });
    });
    byId('clearFilters').addEventListener('click', function () {
      ['filterSearch', 'filterCategory', 'filterVendor', 'filterDeployment', 'filterScope', 'filterRegion'].forEach(function (id) {
        byId(id).value = '';
      });
      state.page = 1;
      applyFilters();
    });

    document.querySelectorAll('input[name="viewMode"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) { state.viewMode = radio.value; render(); }
      });
    });

    document.querySelectorAll('.mode-tab').forEach(function (tab) {
      tab.addEventListener('click', function () { switchDecisionMode(tab.dataset.mode); });
    });
    byId('daRun').addEventListener('click', runAvailabilityMode);
    byId('riRun').addEventListener('click', runRegionMode);
    byId('brRun').addEventListener('click', runBestRegionMode);
  }

  document.addEventListener('DOMContentLoaded', function () {
    wire();
    loadModels();
  });
})();

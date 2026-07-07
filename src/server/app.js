'use strict';

// HTTP layer (PRD §9). Plain Node http server: serves the static SPA from
// public/ and exposes /api/models, /api/cache, /api/refresh. Azure auth and
// refresh logic stay server-side (PRD §3 non-functional goals).

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const cache = require('./cache');
const { runRefresh, isRefreshing } = require('./refresh');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes) {
  const limit = limitBytes || 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getModelsPayload() {
  const payload = cache.load();
  if (payload) return payload;
  return cache.emptyPayload();
}

function cacheSummary() {
  const payload = cache.getMemory() || cache.readDisk();
  if (!payload) {
    return {
      cached: false,
      generatedAt: null,
      message: 'No cache present. Use Refresh data to build it.',
      status: { catalog: [], commands: [], pricing: [] },
      meta: cache.computeMeta([]),
    };
  }
  return {
    cached: true,
    generatedAt: payload.generatedAt,
    startedAt: payload.startedAt,
    options: payload.options,
    locations: payload.locations,
    sampledLocations: payload.sampledLocations,
    status: payload.status,
    meta: payload.meta || cache.computeMeta(payload.models),
    refreshing: isRefreshing(),
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/models') {
    sendJson(res, 200, getModelsPayload());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cache') {
    sendJson(res, 200, cacheSummary());
    return true;
  }

  if (url.pathname === '/api/refresh') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
      return true;
    }
    if (isRefreshing()) {
      sendJson(res, 409, { error: 'A refresh is already in progress.' });
      return true;
    }
    let options = {};
    try {
      const raw = await readBody(req);
      if (raw && raw.trim()) options = JSON.parse(raw);
    } catch (err) {
      sendJson(res, 400, { error: 'Invalid JSON body: ' + err.message });
      return true;
    }
    try {
      const payload = await runRefresh({ includeHuggingFace: !!options.includeHuggingFace });
      sendJson(res, 200, payload);
    } catch (err) {
      if (err && err.code === 'REFRESH_IN_PROGRESS') {
        sendJson(res, 409, { error: err.message });
      } else {
        sendJson(res, 500, { error: 'Refresh failed: ' + (err && err.message) });
      }
    }
    return true;
  }

  return false;
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const resolved = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    });
    res.end(data);
  });
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (err) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { error: 'Unknown API route' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error: ' + (err && err.message) });
    else res.end();
  }
}

function startServer() {
  const port = config.PORT;
  const server = http.createServer(handleRequest);
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log('Foundry Models browser running at http://localhost:' + port);
    const cached = cache.readDisk();
    if (cached && Array.isArray(cached.models)) {
      console.log('Loaded disk cache: ' + cached.models.length + ' models (generated ' + cached.generatedAt + ').');
    } else {
      console.log('No disk cache found. Open the app and click "Refresh data".');
    }
  });
  return server;
}

module.exports = { startServer, handleRequest };

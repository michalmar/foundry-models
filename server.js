'use strict';

// Server entry point. Honors PORT (via env or .env).
// Usage: node server.js   |   PORT=3024 node server.js

const { startServer } = require('./src/server/app');

startServer();

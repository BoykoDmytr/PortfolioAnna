'use strict';

/**
 * Спільні помічники для тестів (node:test).
 * Кожен сервер працює з власною тимчасовою копією data/ — дані в репозиторії не змінюються.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const ROOT_DIR = path.resolve(__dirname, '..');
const SEED_DATA_DIR = path.join(ROOT_DIR, 'data');
const TEST_PASSWORD = 'test-password-123';
const HAS_INDEX_VIEW = fs.existsSync(path.join(ROOT_DIR, 'views', 'index.ejs'));
const HAS_404_VIEW = fs.existsSync(path.join(ROOT_DIR, 'views', '404.ejs'));
const HAS_SEED_CONTENT = fs.existsSync(path.join(SEED_DATA_DIR, 'content.json'));

/** Тимчасова папка з копією content.json і uploads/ (якщо вони є). */
function makeTempDataDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-test-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (HAS_SEED_CONTENT) fs.copyFileSync(path.join(SEED_DATA_DIR, 'content.json'), path.join(dataDir, 'content.json'));
  const seedUploads = path.join(SEED_DATA_DIR, 'uploads');
  if (fs.existsSync(seedUploads)) fs.cpSync(seedUploads, path.join(dataDir, 'uploads'), { recursive: true });
  return { root, dataDir };
}

function createLogger() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`[${level}] ${args.join(' ')}`);
  return { lines, log: push('log'), info: push('info'), warn: push('warn'), error: push('error') };
}

/**
 * Запускає застосунок на випадковому порту.
 * → { app, server, base, dataDir, root, logger, close() }
 */
async function startServer(options = {}) {
  const { root, dataDir } = makeTempDataDir();
  const logger = createLogger();
  const app = createApp({ dataDir, adminPassword: TEST_PASSWORD, logger, ...options });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { app, server, base, dataDir, root, logger, close };
}

/** HTTP-клієнт з «банкою» для cookie af_admin і заголовком X-Admin-Request. */
function createClient(base) {
  let cookie = '';

  async function request(method, url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie && opts.cookie !== false) headers.cookie = cookie;
    if (opts.csrf !== false && !['GET', 'HEAD'].includes(method)) headers['x-admin-request'] = '1';
    let { body } = opts;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (pair.slice(0, eq).trim() === 'af_admin') {
        const value = pair.slice(eq + 1).trim();
        cookie = value ? `af_admin=${value}` : '';
      }
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { status: res.status, headers: res.headers, text, buffer, data, setCookies };
  }

  return {
    request,
    get: (url, opts) => request('GET', url, opts),
    post: (url, opts) => request('POST', url, opts),
    put: (url, opts) => request('PUT', url, opts),
    patch: (url, opts) => request('PATCH', url, opts),
    del: (url, opts) => request('DELETE', url, opts),
    async login(password = TEST_PASSWORD) {
      const res = await request('POST', '/admin/api/login', { json: { password } });
      if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
      return res;
    },
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  ROOT_DIR,
  SEED_DATA_DIR,
  TEST_PASSWORD,
  HAS_INDEX_VIEW,
  HAS_404_VIEW,
  HAS_SEED_CONTENT,
  makeTempDataDir,
  startServer,
  createClient,
  readJson,
};

'use strict';

/**
 * Безпека адмінки: паралельні спроби входу, стандартний пароль з інструкції, DNS rebinding (Host),
 * Origin, робота за реверс-проксі (TRUST_PROXY), відкликання сесій, перехешування старих паролів.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startServer, createClient, readJson, TEST_PASSWORD } = require('./helpers');
const { Auth, LEGACY_SCRYPT_PARAMS, SCRYPT_PARAMS } = require('../src/auth');
const { createSemaphore, BusyError } = require('../src/limits');
const { createHostGuard, hostnameOf, isLocalRequest, parseTrustProxy } = require('../src/net');

const PUBLIC_DEFAULT = 'anna2026';
const REMOTE = { 'x-forwarded-for': '192.168.1.50' }; // так виглядає запит через проксі / не з цього комп'ютера

/** Запит із довільним заголовком Host (fetch його не дозволяє змінювати). */
function rawRequest(base, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const loginBody = (password) => JSON.stringify({ password });
const jsonHeaders = (extra = {}) => ({ 'content-type': 'application/json', 'x-admin-request': '1', ...extra });

async function withServer(options, fn) {
  const ctx = await startServer(options);
  try {
    await fn(ctx);
  } finally {
    await ctx.close();
  }
}

/* ---------------- ліміт спроб: паралельні запити ---------------- */

test('паралельні неправильні входи: не більше 5 перевірок пароля, решта — 429', () => withServer({}, async (ctx) => {
  const client = createClient(ctx.base);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => client.post('/admin/api/login', { json: { password: `wrong-${i}` } })));
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  assert.deepEqual(counts, { 401: 5, 429: 15 });
  // навіть правильний пароль тепер чекає кінця блокування
  assert.equal((await client.post('/admin/api/login', { json: { password: TEST_PASSWORD } })).status, 429);
}));

test('паралельні спроби вгадати поточний пароль у «Безпеці» теж обмежені', () => withServer({}, async (ctx) => {
  const client = createClient(ctx.base);
  await client.login();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => client.post('/admin/api/password', { json: { current: `wrong-${i}`, next: 'new-password-1' } })));
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  assert.deepEqual(counts, { 400: 5, 429: 7 });
}));

test('сервер зайнятий перевірками пароля → 503, спроба не зараховується', () => withServer({}, async (ctx) => {
  const { auth } = ctx.app.services;
  const original = auth.verifyPassword;
  auth.verifyPassword = async () => {
    throw new BusyError();
  };
  try {
    const client = createClient(ctx.base);
    const busy = await client.post('/admin/api/login', { json: { password: 'whatever-1' } });
    assert.equal(busy.status, 503);
    assert.match(busy.data.error, /зайнятий/);
    assert.ok(Number(busy.headers.get('retry-after')) > 0);
  } finally {
    auth.verifyPassword = original;
  }
  const wrong = await createClient(ctx.base).post('/admin/api/login', { json: { password: 'nope-nope' } });
  assert.equal(wrong.data.attemptsLeft, 4, 'відхилена через зайнятість спроба не врахована');
}));

test('createSemaphore: не більше max одночасно, переповнена черга → BusyError', async () => {
  const sem = createSemaphore({ max: 2, maxQueue: 1 });
  let running = 0;
  let peak = 0;
  const releases = [];
  const job = () => sem.run(() => new Promise((resolve) => {
    running += 1;
    peak = Math.max(peak, running);
    releases.push(() => {
      running -= 1;
      resolve();
    });
  }));
  const jobs = [job(), job(), job()];
  await assert.rejects(job(), (err) => err.code === 'BUSY' && err.status === 503);
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.active, 2);
  assert.equal(sem.pending, 1);
  releases.shift()();
  await new Promise((r) => setImmediate(r));
  releases.shift()();
  releases.shift()();
  await Promise.all(jobs);
  assert.equal(peak, 2);
  assert.equal(sem.active, 0);
});

/* ---------------- стандартний пароль з інструкції ---------------- */

test('стандартний пароль: вхід лише з цього комп’ютера, з іншого пристрою — 403 з поясненням', () => withServer({ adminPassword: PUBLIC_DEFAULT }, async (ctx) => {
  assert.equal(ctx.app.services.auth.usingPublicDefault, true);
  assert.equal(readJson(path.join(ctx.dataDir, 'private', 'auth.json')).publicDefault, true);

  const phone = createClient(ctx.base);
  const remote = await phone.post('/admin/api/login', { json: { password: PUBLIC_DEFAULT }, headers: REMOTE });
  assert.equal(remote.status, 403);
  assert.equal(remote.data.reason, 'default-password');
  assert.match(remote.data.error, /Безпека/);
  assert.match(remote.data.error, new RegExp(`localhost:${new URL(ctx.base).port}/admin/`));
  assert.equal(remote.setCookies.length, 0);

  // Неправильний пароль з іншого пристрою — звичайне 401
  assert.equal((await phone.post('/admin/api/login', { json: { password: 'other-pass' }, headers: REMOTE })).status, 401);

  // На цьому ж комп'ютері — можна (щоб змінити пароль)
  const laptop = createClient(ctx.base);
  const local = await laptop.post('/admin/api/login', { json: { password: PUBLIC_DEFAULT } });
  assert.equal(local.status, 200);
  assert.equal(local.data.mustChangePassword, true);

  // Та сама cookie, але запит «з мережі» (наприклад, видана до оновлення) — не діє
  const stolen = createClient(ctx.base);
  stolen.cookie = laptop.cookie;
  assert.deepEqual((await stolen.get('/admin/api/session', { headers: REMOTE })).data, { authenticated: false, mustChangePassword: false });
  assert.equal((await stolen.get('/admin/api/leads', { headers: REMOTE })).status, 401);
  assert.equal((await laptop.get('/admin/api/leads')).status, 200);

  // Новим паролем не може бути стандартний
  const backToDefault = await laptop.post('/admin/api/password', { json: { current: PUBLIC_DEFAULT, next: PUBLIC_DEFAULT } });
  assert.equal(backToDefault.status, 400);

  const changed = await laptop.post('/admin/api/password', { json: { current: PUBLIC_DEFAULT, next: 'my-own-pass-1' } });
  assert.equal(changed.status, 200);
  assert.equal(ctx.app.services.auth.usingPublicDefault, false);
  assert.equal(readJson(path.join(ctx.dataDir, 'private', 'auth.json')).publicDefault, false);

  const toDefault = await laptop.post('/admin/api/password', { json: { current: 'my-own-pass-1', next: PUBLIC_DEFAULT } });
  assert.equal(toDefault.status, 400, 'стандартний пароль з інструкції не можна поставити знову');
  assert.equal(toDefault.data.details[0].field, 'next');
  assert.match(toDefault.data.error, /стандартний/);

  const fromPhone = await phone.post('/admin/api/login', { json: { password: 'my-own-pass-1' }, headers: REMOTE });
  assert.equal(fromPhone.status, 200, 'після зміни пароля можна входити з телефона');
  assert.equal((await phone.post('/admin/api/login', { json: { password: PUBLIC_DEFAULT }, headers: REMOTE })).status, 401);
}));

test('isLocalRequest: лише loopback без заголовків проксі вважається «цим комп’ютером»', () => {
  const fakeReq = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(isLocalRequest(fakeReq('127.0.0.1')), true);
  assert.equal(isLocalRequest(fakeReq('::1')), true);
  assert.equal(isLocalRequest(fakeReq('::ffff:127.0.0.1')), true);
  assert.equal(isLocalRequest(fakeReq('192.168.1.23')), false, 'телефон у Wi-Fi');
  assert.equal(isLocalRequest(fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false, 'через проксі на тому ж сервері');
  assert.equal(isLocalRequest(fakeReq('127.0.0.1', { forwarded: 'for=1.2.3.4' })), false);
});

test('робочий режим (production): стандартний пароль не діє навіть локально', () => withServer({ adminPassword: PUBLIC_DEFAULT, production: true }, async (ctx) => {
  const res = await createClient(ctx.base).post('/admin/api/login', { json: { password: PUBLIC_DEFAULT } });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /ADMIN_PASSWORD/);
}));

test('auth.json зі старої версії: стандартний пароль розпізнається, старий хеш перехешовується після входу', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-legacy-'));
  const authFile = path.join(dir, 'auth.json');
  const legacyRecord = (password) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64, { ...LEGACY_SCRYPT_PARAMS, maxmem: 64 * 1024 * 1024 }).toString('hex');
    return { hash, salt, secret: crypto.randomBytes(32).toString('hex'), sessionVersion: 3, mustChangePassword: true };
  };
  const quiet = { warn() {}, error() {}, log() {} };
  try {
    fs.writeFileSync(authFile, JSON.stringify(legacyRecord(PUBLIC_DEFAULT)));
    const old = new Auth({ authFile, defaultPassword: 'unused-pass', logger: quiet }).init();
    assert.equal(old.usingPublicDefault, true, 'старий запис зі стандартним паролем');
    assert.deepEqual(old.record.scrypt, { ...LEGACY_SCRYPT_PARAMS });

    fs.writeFileSync(authFile, JSON.stringify(legacyRecord('legacy-pass-1')));
    const auth = new Auth({ authFile, defaultPassword: 'unused-pass', logger: quiet }).init();
    assert.equal(auth.usingPublicDefault, false);
    const token = auth.issueToken();
    assert.equal(await auth.verifyPassword('wrong-pass'), false);
    assert.equal(readJson(authFile).scrypt, undefined, 'після невдалої спроби нічого не змінено');
    assert.equal(await auth.verifyPassword('legacy-pass-1'), true);
    const saved = readJson(authFile);
    assert.deepEqual(saved.scrypt, { ...SCRYPT_PARAMS }, 'хеш оновлено до поточних параметрів');
    assert.equal(saved.sessionVersion, 3, 'входи при цьому не завершуються');
    assert.equal(auth.verifyToken(token), true);
    const reloaded = new Auth({ authFile, defaultPassword: 'unused-pass', logger: quiet }).init();
    assert.equal(await reloaded.verifyPassword('legacy-pass-1'), true);
    assert.equal(await reloaded.verifyPassword('wrong-pass'), false);

    // Недопустимі параметри scrypt → запис вважається пошкодженим
    fs.writeFileSync(authFile, JSON.stringify({ ...saved, scrypt: { N: 3, r: 8, p: 1 } }));
    const reset = new Auth({ authFile, defaultPassword: 'reset-pass-1', logger: quiet }).init();
    assert.equal(reset.verifyPasswordSync('reset-pass-1'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- вихід ---------------- */

test('«Вийти» відкликає саме цей вхід: збережена копія cookie більше не діє', () => withServer({}, async (ctx) => {
  const client = createClient(ctx.base);
  await client.login();
  const other = createClient(ctx.base);
  await other.login();
  const copy = client.cookie;

  assert.equal((await client.post('/admin/api/logout')).status, 200);
  const replay = createClient(ctx.base);
  replay.cookie = copy;
  assert.deepEqual((await replay.get('/admin/api/session')).data, { authenticated: false, mustChangePassword: false });
  assert.equal((await replay.get('/admin/api/content')).status, 401);
  assert.equal((await other.get('/admin/api/content')).status, 200, 'інші входи працюють');
  assert.ok(Object.keys(readJson(path.join(ctx.dataDir, 'private', 'auth.json')).revoked).length >= 1, 'відкликання переживає перезапуск');
}));

test('«Вийти на всіх пристроях» завершує всі входи; без входу — 401', () => withServer({}, async (ctx) => {
  const laptop = createClient(ctx.base);
  const phone = createClient(ctx.base);
  await laptop.login();
  await phone.login();
  assert.equal((await createClient(ctx.base).post('/admin/api/logout', { json: { everywhere: true } })).status, 401);
  assert.equal((await phone.get('/admin/api/content')).status, 200);

  const res = await laptop.post('/admin/api/logout', { json: { everywhere: true } });
  assert.equal(res.status, 200);
  assert.equal(laptop.cookie, '');
  assert.equal((await phone.get('/admin/api/content')).status, 401);
  await laptop.login();
  assert.equal((await laptop.get('/admin/api/content')).status, 200);
}));

test('токени без ідентифікатора сесії (зі старої версії) не приймаються', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-sid-'));
  try {
    const auth = new Auth({ authFile: path.join(dir, 'auth.json'), defaultPassword: 'x-password', logger: { warn() {} } }).init();
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 1e6, v: 1 })).toString('base64url');
    assert.equal(auth.verifyToken(`${payload}.${auth.sign(payload)}`), false);
    assert.equal(auth.verifyToken(auth.issueToken()), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- Host / Origin (DNS rebinding) ---------------- */

test('адмінка не відповідає на чужий домен у Host (DNS rebinding), сайт — відповідає', () => withServer({ adminPassword: PUBLIC_DEFAULT }, async (ctx) => {
  const evil = 'evil-rebind.test:3917';
  const login = await rawRequest(ctx.base, { method: 'POST', path: '/admin/api/login', headers: jsonHeaders({ host: evil }), body: loginBody(PUBLIC_DEFAULT) });
  assert.equal(login.status, 421);
  assert.match(login.data.error, /evil-rebind\.test/);
  assert.equal(login.headers['set-cookie'], undefined);
  assert.equal((await rawRequest(ctx.base, { path: '/admin/api/leads', headers: { host: evil } })).status, 421);
  const ui = await rawRequest(ctx.base, { path: '/admin/', headers: { host: evil } });
  assert.equal(ui.status, 421);
  assert.match(ui.headers['content-type'], /text\/plain/);
  assert.equal((await rawRequest(ctx.base, { path: '/admin', headers: { host: evil } })).status, 421);

  // Публічні сторінки — як і раніше
  assert.equal((await rawRequest(ctx.base, { path: '/healthz', headers: { host: evil } })).status, 200);

  // Звичні адреси працюють
  const port = new URL(ctx.base).port;
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `192.168.1.23:${port}`, `anna.localhost:${port}`, `${os.hostname()}:${port}`]) {
    const res = await rawRequest(ctx.base, { method: 'POST', path: '/admin/api/login', headers: jsonHeaders({ host }), body: loginBody(PUBLIC_DEFAULT) });
    assert.equal(res.status, 200, host);
  }
}));

test('домен з «Адреси сайту» (SEO) і ALLOWED_HOSTS дозволені для адмінки', () => withServer({ allowedHosts: ['.anna-travel.example'] }, async (ctx) => {
  const ok = (host) => rawRequest(ctx.base, { path: '/admin/api/session', headers: { host } }).then((r) => r.status);
  assert.equal(await ok('annafrolova.travel'), 421);
  assert.equal(await ok('admin.anna-travel.example'), 200);
  assert.equal(await ok('anna-travel.example'), 200);

  const client = createClient(ctx.base);
  await client.login();
  const content = (await client.get('/admin/api/content')).data;
  content.seo.siteUrl = 'https://annafrolova.travel';
  assert.equal((await client.put('/admin/api/content', { json: content })).status, 200);
  assert.equal(await ok('annafrolova.travel'), 200);
  assert.equal(await ok('www.annafrolova.travel'), 200);
  assert.equal(await ok('annafrolova.travel.evil.test'), 421);
}));

test('Origin чужого сайту в запиті, що змінює дані → 403', () => withServer({}, async (ctx) => {
  const client = createClient(ctx.base);
  const foreign = await client.post('/admin/api/login', { json: { password: TEST_PASSWORD }, headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.equal((await client.post('/admin/api/login', { json: { password: TEST_PASSWORD }, headers: { origin: 'null' } })).status, 403);
  const same = await client.post('/admin/api/login', { json: { password: TEST_PASSWORD }, headers: { origin: ctx.base } });
  assert.equal(same.status, 200);
}));

test('net: розбір Host, TRUST_PROXY', () => {
  assert.equal(hostnameOf('Example.COM:3000'), 'example.com');
  assert.equal(hostnameOf('[::1]:3000'), '::1');
  assert.equal(hostnameOf('localhost.'), 'localhost');
  assert.equal(hostnameOf('a b'), '');
  assert.equal(hostnameOf(''), '');
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  const guard = createHostGuard({ allowedHosts: ['example.org'], siteUrl: () => 'https://Anna.Travel/sub' });
  assert.equal(guard.isAllowedHostname('anna.travel'), true);
  assert.equal(guard.isAllowedHostname('example.org'), true);
  assert.equal(guard.isAllowedHostname('sub.example.org'), false);
  assert.equal(guard.isAllowedHostname('10.0.0.5'), true);
  assert.equal(guard.isAllowedHostname('rebind.attacker.example'), false);
});

/* ---------------- за реверс-проксі (TRUST_PROXY) ---------------- */

test('за проксі з TRUST_PROXY: cookie Secure, HSTS, ліміт спроб — за справжнім IP', () => withServer({ trustProxy: 'loopback' }, async (ctx) => {
  const https = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7' };
  const client = createClient(ctx.base);
  const res = await client.post('/admin/api/login', { json: { password: TEST_PASSWORD }, headers: https });
  assert.equal(res.status, 200);
  assert.match(res.setCookies.find((c) => c.startsWith('af_admin=')), /;\s*Secure/i);
  assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
  const page = await client.get('/', { headers: https });
  assert.match(page.headers.get('strict-transport-security') || '', /max-age/);

  // Чужі невдалі спроби (інший IP) не блокують власницю
  const attacker = createClient(ctx.base);
  for (let i = 0; i < 6; i += 1) await attacker.post('/admin/api/login', { json: { password: `x-${i}` }, headers: { 'x-forwarded-for': '198.51.100.9' } });
  assert.equal((await attacker.post('/admin/api/login', { json: { password: 'x' }, headers: { 'x-forwarded-for': '198.51.100.9' } })).status, 429);
  assert.equal((await createClient(ctx.base).post('/admin/api/login', { json: { password: TEST_PASSWORD }, headers: https })).status, 200);

  // Адмінка за проксі відкривається за доменом, який обрав проксі
  assert.equal((await rawRequest(ctx.base, { path: '/admin/api/session', headers: { host: 'annafrolova.travel', 'x-forwarded-proto': 'https' } })).status, 200);
}));

test('без TRUST_PROXY заголовкам X-Forwarded-* не віримо: ні Secure, ні HSTS, ліміт — спільний', () => withServer({}, async (ctx) => {
  const client = createClient(ctx.base);
  const res = await client.post('/admin/api/login', { json: { password: TEST_PASSWORD }, headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.setCookies.find((c) => c.startsWith('af_admin=')), /Secure/i);
  assert.equal(res.headers.get('strict-transport-security'), null);
  for (let i = 0; i < 5; i += 1) await client.post('/admin/api/login', { json: { password: `x-${i}` }, headers: { 'x-forwarded-for': `10.0.0.${i}` } });
  assert.equal((await client.post('/admin/api/login', { json: { password: 'x' }, headers: { 'x-forwarded-for': '10.0.0.99' } })).status, 429, 'X-Forwarded-For не обходить ліміт');
}));

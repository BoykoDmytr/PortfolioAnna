'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createClient } = require('./helpers');
const { CONTENT_SECURITY_POLICY } = require('../src/app');

let ctx;
let client;

before(async () => {
  ctx = await startServer();
  client = createClient(ctx.base);
});

after(() => ctx.close());

test('GET /healthz → ok', async () => {
  const res = await client.get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.text, 'ok');
});

test('заголовки безпеки є на всіх відповідях', async () => {
  for (const url of ['/healthz', '/nope', '/admin/api/session']) {
    const res = await client.get(url);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', url);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', url);
    assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, url);
    assert.equal(res.headers.get('x-powered-by'), null, url);
  }
  assert.equal(
    CONTENT_SECURITY_POLICY,
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  );
});

test('/en → 301 на /en/ (зі збереженням query)', async () => {
  let res = await client.get('/en');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/en/');
  res = await client.get('/en?lead=ok');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/en/?lead=ok');
});

test('/admin → 302 на /admin/', async () => {
  const res = await client.get('/admin');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/');
});

test('/admin/ віддає оболонку адмінки без входу', async () => {
  const res = await client.get('/admin/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('невідома сторінка → 404', async () => {
  const res = await client.get('/no-such-page');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const api = await client.get('/api/nope');
  assert.equal(api.status, 404);
  assert.ok(api.data && typeof api.data.error === 'string');
  const post = await client.post('/no-such-page', { csrf: false });
  assert.equal(post.status, 404);
});

test('/uploads/* — файли з DATA_DIR/uploads, без виходу за межі папки', async () => {
  const uploadsDir = path.join(ctx.dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, 'test-pixel.webp'), Buffer.from('RIFF0000WEBP'));
  const res = await client.get('/uploads/test-pixel.webp');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.match(res.headers.get('cache-control'), /max-age=3600/);

  for (const url of ['/uploads/..%2fcontent.json', '/uploads/%2e%2e/content.json', '/uploads/..%5ccontent.json']) {
    const bad = await client.get(url);
    assert.notEqual(bad.status, 200, url);
    assert.ok(!bad.text.includes('"sections"'), url);
  }
  const missing = await client.get('/uploads/missing.webp');
  assert.equal(missing.status, 404);
});

test('/assets/* — статика з public/', async () => {
  const res = await client.get('/assets/css/fonts.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/css/);
  assert.match(res.headers.get('cache-control'), /max-age=3600/);
});

test('robots.txt забороняє індексувати адмінку', async () => {
  const res = await client.get('/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.text, /Disallow: \/admin\//);
});

test('GET / — українська сторінка', async () => {
  const res = await client.get('/');
  assert.equal(res.status, 200, res.text.slice(0, 500));
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.text, /<html[^>]*\slang="uk"/);
  assert.match(res.text, /ANNA FROLOVA/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.doesNotMatch(res.text, /<script(?![^>]*\bsrc=)[^>]*>/i, 'інлайн-скрипти заборонені CSP');
  assert.doesNotMatch(res.text, /\son(click|load|error|submit)=/i, 'інлайн-обробники заборонені CSP');
});

test('GET /en/ — англійська сторінка', async () => {
  const res = await client.get('/en/');
  assert.equal(res.status, 200, res.text.slice(0, 500));
  assert.match(res.text, /<html[^>]*\slang="en"/);
  assert.match(res.text, /ANNA FROLOVA/);
});

test('GET /?lead=ok і /?lead=garbage рендеряться', async () => {
  assert.equal((await client.get('/?lead=ok')).status, 200);
  assert.equal((await client.get('/en/?lead=error')).status, 200);
  assert.equal((await client.get('/?lead=<script>')).status, 200);
});

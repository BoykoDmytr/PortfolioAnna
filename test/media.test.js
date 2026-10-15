'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { startServer, createClient } = require('./helpers');

let ctx;
let client;
let uploadsDir;

function upload(file, { name = 'photo.png', type = 'image/png', purpose, field = 'file', csrf } = {}) {
  const form = new FormData();
  if (file) form.append(field, new Blob([file], { type }), name);
  const qs = purpose ? `?purpose=${encodeURIComponent(purpose)}` : '';
  return client.post(`/admin/api/upload${qs}`, { body: form, csrf });
}

function makeImage({ width, height, format = 'png', alpha = false }) {
  const img = sharp({
    create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 180, g: 140, b: 100, alpha: 0.4 } : { r: 201, g: 184, b: 166 } },
  });
  return img.toFormat(format).toBuffer();
}

before(async () => {
  ctx = await startServer();
  client = createClient(ctx.base);
  await client.login();
  uploadsDir = path.join(ctx.dataDir, 'uploads');
});

after(() => ctx.close());

test('завантаження PNG → WebP ≤ 2400 px, доступний за /uploads/', async () => {
  const png = await makeImage({ width: 3000, height: 2000 });
  const res = await upload(png, { name: 'Мальдіви 2025.png' });
  assert.equal(res.status, 201, res.text);
  assert.match(res.data.name, /^maldivy-2025-[0-9a-f]{6}\.webp$/);
  assert.equal(res.data.url, `/uploads/${res.data.name}`);
  assert.equal(res.data.width, 2400);
  assert.equal(res.data.height, 1600);
  assert.ok(res.data.size > 0);

  const file = await client.get(res.data.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/webp');
  assert.equal(file.buffer.subarray(0, 4).toString(), 'RIFF');
  assert.equal(file.buffer.subarray(8, 12).toString(), 'WEBP');
  const meta = await sharp(file.buffer).metadata();
  assert.equal(meta.width, 2400);
});

test('маленьке фото не збільшується; назва без латиниці → image-xxxxxx', async () => {
  const jpg = await makeImage({ width: 300, height: 200, format: 'jpeg' });
  const res = await upload(jpg, { name: '😀.jpg', type: 'image/jpeg' });
  assert.equal(res.status, 201, res.text);
  assert.match(res.data.name, /^image-[0-9a-f]{6}\.webp$/);
  assert.equal(res.data.width, 300);
});

test('EXIF/GPS-метадані не зберігаються, орієнтація застосовується', async () => {
  const jpg = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#c9b8a6' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret-author', ImageDescription: 'home address' } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const srcMeta = await sharp(jpg).metadata();
  assert.ok(srcMeta.exif, 'у вихідному файлі є EXIF');
  const res = await upload(jpg, { name: 'rotated.jpg', type: 'image/jpeg' });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.data.width, 200, 'повернуто за EXIF orientation');
  assert.equal(res.data.height, 400);
  const out = fs.readFileSync(path.join(uploadsDir, res.data.name));
  const meta = await sharp(out).metadata();
  assert.equal(meta.exif, undefined);
  assert.ok(!out.includes(Buffer.from('secret-author')));
});

test('логотип: ≤ 800 px, прозорість зберігається', async () => {
  const png = await makeImage({ width: 1600, height: 1000, alpha: true });
  const res = await upload(png, { name: 'logo.png', purpose: 'logo' });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.data.width, 800);
  assert.equal(res.data.height, 500);
  const meta = await sharp(fs.readFileSync(path.join(uploadsDir, res.data.name))).metadata();
  assert.equal(meta.hasAlpha, true);
});

test('не-зображення з «правильним» MIME-типом → 415', async () => {
  const res = await upload(Buffer.from('<?php echo "hi"; ?>'), { name: 'evil.png', type: 'image/png' });
  assert.equal(res.status, 415);
  assert.equal(typeof res.data.error, 'string');
});

test('SVG відхиляється (415), навіть з іменем .png', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
  for (const [name, type] of [['icon.svg', 'image/svg+xml'], ['icon.png', 'image/png']]) {
    const res = await upload(svg, { name, type });
    assert.equal(res.status, 415, name);
    assert.match(res.data.error, /SVG/);
  }
});

test('«бомба»: крихітний файл із величезною роздільністю → 413 ще до розпакування', async () => {
  const bomb = await sharp({ create: { width: 10000, height: 8100, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(bomb.length < 2 * 1024 * 1024, `файл маленький (${bomb.length} Б)`);
  const before = fs.readdirSync(uploadsDir).length;
  const res = await upload(bomb, { name: 'bomb.png' });
  assert.equal(res.status, 413);
  assert.match(res.data.error, /мегапікселів/);
  assert.equal(fs.readdirSync(uploadsDir).length, before, 'нічого не збережено');

  // 48 Мп (як у сучасних телефонах) — приймається
  const big = await sharp({ create: { width: 8064, height: 6048, channels: 3, background: { r: 200, g: 180, b: 160 } } }).jpeg({ quality: 50 }).toBuffer();
  const ok = await upload(big, { name: 'iphone.jpg', type: 'image/jpeg' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.data.width, 2400);
});

test('інші формати (TIFF) → 415; AVIF і GIF приймаються', async () => {
  const tiff = await makeImage({ width: 20, height: 20, format: 'tiff' });
  assert.equal((await upload(tiff, { name: 'scan.tiff', type: 'image/tiff' })).status, 415);
  const avif = await makeImage({ width: 40, height: 30, format: 'avif' });
  assert.equal((await upload(avif, { name: 'a.avif', type: 'image/avif' })).status, 201);
  const gif = await makeImage({ width: 40, height: 30, format: 'gif' });
  assert.equal((await upload(gif, { name: 'a.gif', type: 'image/gif' })).status, 201);
});

test('помилки запиту: без файлу, невідоме призначення, завеликий файл, без CSRF, без входу', async () => {
  const none = await upload(null);
  assert.equal(none.status, 400);

  const png = await makeImage({ width: 10, height: 10 });
  assert.equal((await upload(png, { purpose: 'banner' })).status, 400);
  assert.equal((await upload(png, { field: 'photo' })).status, 400);

  const huge = Buffer.alloc(15 * 1024 * 1024 + 10, 0);
  const tooBig = await upload(huge, { name: 'big.png' });
  assert.equal(tooBig.status, 413);
  assert.match(tooBig.data.error, /15 МБ/);

  assert.equal((await upload(png, { csrf: false })).status, 403);

  const anon = createClient(ctx.base);
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
  assert.equal((await anon.post('/admin/api/upload', { body: form })).status, 401);
});

test('медіатека: список, позначка used, видалення 409 / force', async () => {
  const png = await makeImage({ width: 120, height: 80 });
  const used = (await upload(png, { name: 'hero.png' })).data;
  const unused = (await upload(png, { name: 'spare.png' })).data;

  const content = (await client.get('/admin/api/content')).data;
  content.sections.hero.image = used.url;
  assert.equal((await client.put('/admin/api/content', { json: content })).status, 200);

  const list = (await client.get('/admin/api/media')).data;
  assert.ok(Array.isArray(list));
  const byName = Object.fromEntries(list.map((m) => [m.name, m]));
  assert.equal(byName[used.name].used, true);
  assert.equal(byName[unused.name].used, false);
  assert.equal(byName[used.name].url, used.url);
  assert.equal(byName[used.name].width, 120);
  assert.equal(byName[used.name].height, 80);
  assert.ok(byName[used.name].size > 0);
  assert.ok(!Number.isNaN(Date.parse(byName[used.name].mtime)));
  const mtimes = list.map((m) => m.mtime);
  assert.deepEqual(mtimes, [...mtimes].sort().reverse(), 'найновіші першими');

  const conflict = await client.del(`/admin/api/media/${used.name}`);
  assert.equal(conflict.status, 409);
  assert.equal(typeof conflict.data.error, 'string');
  assert.ok(fs.existsSync(path.join(uploadsDir, used.name)));

  assert.deepEqual((await client.del(`/admin/api/media/${unused.name}`)).data, { ok: true });
  assert.ok(!fs.existsSync(path.join(uploadsDir, unused.name)));

  const forced = await client.del(`/admin/api/media/${used.name}?force=1`);
  assert.equal(forced.status, 200);
  assert.ok(!fs.existsSync(path.join(uploadsDir, used.name)));
  assert.equal((await client.get(used.url)).status, 404);

  assert.equal((await client.del(`/admin/api/media/${used.name}`)).status, 404, 'вже видалено');
});

test('медіатека: спроби вийти за межі папки відхиляються', async () => {
  const contentFile = path.join(ctx.dataDir, 'content.json');
  for (const name of ['..%2Fcontent.json', '..%2F..%2Fetc%2Fpasswd', '.hidden', '%2E%2E', 'a%5C..%5Cb', '-x.webp']) {
    const res = await client.del(`/admin/api/media/${name}?force=1`);
    assert.ok([400, 404].includes(res.status), `${name} → ${res.status}`);
  }
  assert.ok(fs.existsSync(contentFile));
  assert.ok(fs.existsSync(path.join(ctx.dataDir, 'private', 'auth.json')));
});

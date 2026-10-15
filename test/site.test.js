'use strict';

/**
 * Регресійні перевірки сайту й адмінки після фінального рев’ю:
 * контраст власних кольорів, орієнтири (landmarks), 404, повтори контактів,
 * чесні обіцянки в seed-контенті, безпечні DOM-виклики в адмінці.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createClient, ROOT_DIR, SEED_DATA_DIR } = require('./helpers');
const { sanitizeContent, collectImageRefs } = require('../src/validate');

let ctx;
let client;

before(async () => {
  ctx = await startServer();
  client = createClient(ctx.base);
});

after(() => ctx.close());

async function putContent(mutate) {
  const current = await client.get('/admin/api/content');
  assert.equal(current.status, 200);
  const next = structuredClone(current.data);
  mutate(next);
  const res = await client.put('/admin/api/content', { json: next });
  assert.equal(res.status, 200, res.text);
  return current.data;
}

test('сторінка UA має рівно один <nav> перемикача мови', async () => {
  const res = await client.get('/');
  assert.equal(res.status, 200);
  const navs = res.text.match(/<nav[^>]*aria-label="Мова сайту"/g) || [];
  assert.equal(navs.length, 1);
});

test('з seed-контентом телефон не повторюється в контактних даних', async () => {
  const res = await client.get('/');
  assert.ok(!res.text.includes('contact-details__value" href="tel:'));
  assert.match(res.text, /href="tel:\+380/, 'телефон лишається у картці «Зателефонувати»');
});

test('404: заголовок h1 «Сторінку не знайдено», велике «404» — декоративне', async () => {
  const res = await client.get('/no-such-page');
  assert.equal(res.status, 404);
  assert.match(res.text, /<h1 class="notfound__title">Сторінку не знайдено<\/h1>/);
  assert.equal((res.text.match(/<h1\b/g) || []).length, 1);
});

test('SEO: англійська сторінка має og:locale en_GB, українська — en_GB як альтернативу', async () => {
  const en = await client.get('/en/');
  assert.match(en.text, /<meta property="og:locale" content="en_GB">/);
  const uk = await client.get('/');
  assert.match(uk.text, /<meta property="og:locale" content="uk_UA">/);
  assert.match(uk.text, /<meta property="og:locale:alternate" content="en_GB">/);
});

test('фото «Про мене» має опис (photoAlt) обома мовами', async () => {
  const uk = await client.get('/');
  assert.match(uk.text, /class="arch__img"[^>]*alt="Анна Фролова, тревел-експертка"/);
  const en = await client.get('/en/');
  assert.match(en.text, /class="arch__img"[^>]*alt="Anna Frolova, travel advisor"/);
});

test('власні кольори: світлий акцент отримує темний текст на кнопках і контрастний акцентний текст', async () => {
  await client.login();
  const before = await putContent((c) => {
    c.theme = { preset: 'custom', accent: '#e9d8b4', background: '#f8f4ef' };
  });
  try {
    const res = await client.get('/');
    const html = res.text.match(/<html[^>]*>/)[0];
    assert.match(html, /data-theme="custom"/);
    assert.match(html, /--accent:#e9d8b4;/);
    assert.match(html, /--on-accent:#3a3029/);
    const strong = html.match(/--accent-strong:(#[0-9a-f]{6})/)[1];
    assert.notEqual(strong, '#e9d8b4', 'акцентний текст затемнено');

    // Темний фон → світлий основний текст
    await putContent((c) => {
      c.theme = { preset: 'custom', accent: '#c9a227', background: '#1e2a2e' };
    });
    const dark = (await client.get('/')).text.match(/<html[^>]*>/)[0];
    assert.match(dark, /--ink:#f6f1ea/);

    // Та сама логіка на сторінці 404
    const nf = await client.get('/no-such-page');
    assert.match(nf.text.match(/<html[^>]*>/)[0], /--ink:#f6f1ea/);
  } finally {
    await putContent((c) => {
      c.theme = before.theme;
    });
  }
});

test('seed-контент: без обіцянок «24/7», 0 помилок валідації, усі фото на місці, uploads ≤ 10 МБ', () => {
  const raw = fs.readFileSync(path.join(SEED_DATA_DIR, 'content.json'), 'utf8');
  assert.ok(!raw.includes('24/7'), 'content.json не обіцяє 24/7');
  const { content, errors } = sanitizeContent(JSON.parse(raw));
  assert.deepEqual(errors, []);
  for (const ref of collectImageRefs(content)) {
    if (!ref.startsWith('/uploads/')) continue;
    assert.ok(fs.existsSync(path.join(SEED_DATA_DIR, 'uploads', ref.slice('/uploads/'.length))), ref);
  }
  const dir = path.join(SEED_DATA_DIR, 'uploads');
  const total = fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  assert.ok(total <= 10 * 1024 * 1024, `uploads: ${total} байт`);
});

test('адмінка: пароль на телефоні без автозаміни; жодного нативного append із «порожніми» дітьми', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'admin', 'index.html'), 'utf8');
  const input = html.match(/<input[^>]*id="login-password"[^>]*>/)[0];
  assert.match(input, /autocapitalize="none"/);
  assert.match(input, /autocorrect="off"/);
  assert.match(input, /spellcheck="false"/);

  // Нативні el.append()/replaceChildren() виводять null/false як текст («null» під полем фото).
  // Для дітей, що можуть бути порожніми, адмінка використовує append()/replace() з dom.js.
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(ROOT_DIR, 'admin', 'js'));
  const risky = /\.(append|prepend|replaceChildren|before|after)\([^;]*(&&|\?[^:;]*:\s*(null|false|undefined)\b)/;
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      assert.ok(!risky.test(line), `${path.relative(ROOT_DIR, file)}:${i + 1}: ${line.trim()}`);
    });
  }
});

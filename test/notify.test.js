'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startServer, createClient, readJson } = require('./helpers');
const { maskToken } = require('../src/notify');

const TOKEN = '123456789:AAHfakeTokenForTests_abcdefghijklmnop';
const OTHER_TOKEN = '987654321:BBHanotherFakeToken_zyxwvutsrqponmlk';

/** Імітація Telegram Bot API: запам'ятовує запити, відповідає за сценарієм. */
let telegram;
let telegramRequests = [];
let telegramReply = () => ({ status: 200, body: { ok: true, result: {} } });

let ctx;
let admin;

before(async () => {
  telegram = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      telegramRequests.push({ url: req.url, body });
      const reply = telegramReply(req);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => telegram.listen(0, '127.0.0.1', resolve));
  ctx = await startServer({ telegramApiBase: `http://127.0.0.1:${telegram.address().port}` });
  admin = createClient(ctx.base);
  await admin.login();
});

after(async () => {
  await ctx.close();
  telegram.closeAllConnections();
  await new Promise((resolve) => telegram.close(resolve));
});

const settingsFile = () => path.join(ctx.dataDir, 'private', 'settings.json');

async function waitFor(predicate, ms = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('типові налаштування', async () => {
  const res = await admin.get('/admin/api/notifications');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { telegramEnabled: false, telegramChatId: '', telegramTokenSet: false, telegramTokenMasked: '' });
  assert.equal((await createClient(ctx.base).get('/admin/api/notifications')).status, 401);
});

test('тест без налаштувань → 400', async () => {
  const res = await admin.post('/admin/api/notifications/test', { json: {} });
  assert.equal(res.status, 400);
  assert.equal(typeof res.data.error, 'string');
});

test('збереження: токен ніколи не повертається, лише маска', async () => {
  const res = await admin.put('/admin/api/notifications', { json: { telegramEnabled: true, telegramChatId: '123456789', telegramToken: TOKEN } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.data, {
    telegramEnabled: true,
    telegramChatId: '123456789',
    telegramTokenSet: true,
    telegramTokenMasked: maskToken(TOKEN),
  });
  assert.ok(!res.text.includes(TOKEN));
  assert.ok(!res.data.telegramTokenMasked.includes(TOKEN.slice(10, 30)));

  const got = await admin.get('/admin/api/notifications');
  assert.ok(!got.text.includes(TOKEN));
  assert.equal(got.data.telegramTokenSet, true);

  // зберігається лише в private/settings.json, не в публічному content.json
  assert.equal(readJson(settingsFile()).telegramToken, TOKEN);
  assert.ok(!fs.readFileSync(path.join(ctx.dataDir, 'content.json'), 'utf8').includes(TOKEN));
  const content = await admin.get('/admin/api/content');
  assert.ok(!content.text.includes(TOKEN));
});

test("telegramToken: '' або відсутній — лишається, null — видаляється", async () => {
  let res = await admin.put('/admin/api/notifications', { json: { telegramEnabled: true, telegramChatId: '-1001234567890', telegramToken: '' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.telegramChatId, '-1001234567890');
  assert.equal(readJson(settingsFile()).telegramToken, TOKEN);

  res = await admin.put('/admin/api/notifications', { json: { telegramEnabled: false, telegramChatId: '123456789' } });
  assert.equal(res.status, 200);
  assert.equal(readJson(settingsFile()).telegramToken, TOKEN);

  res = await admin.put('/admin/api/notifications', { json: { telegramEnabled: false, telegramToken: null } });
  assert.equal(res.status, 200);
  assert.equal(res.data.telegramTokenSet, false);
  assert.equal(readJson(settingsFile()).telegramToken, '');
});

test('некоректні налаштування → 400 з details', async () => {
  let res = await admin.put('/admin/api/notifications', { json: { telegramEnabled: true, telegramChatId: '123', telegramToken: 'not-a-token' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.details[0].field, 'telegramToken');

  res = await admin.put('/admin/api/notifications', { json: { telegramEnabled: true, telegramChatId: 'abc', telegramToken: TOKEN } });
  assert.equal(res.status, 400);
  assert.equal(res.data.details[0].field, 'telegramChatId');

  res = await admin.put('/admin/api/notifications', { json: { telegramEnabled: true, telegramChatId: '' } });
  assert.equal(res.status, 400, 'увімкнути без токена не можна');
});

test('тестове повідомлення: успіх і помилка Telegram (502)', async () => {
  await admin.put('/admin/api/notifications', { json: { telegramEnabled: true, telegramChatId: '555', telegramToken: TOKEN } });
  telegramRequests = [];
  let res = await admin.post('/admin/api/notifications/test', { json: {} });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.data, { ok: true });
  assert.equal(telegramRequests.length, 1);
  assert.equal(telegramRequests[0].url, `/bot${TOKEN}/sendMessage`);
  assert.equal(telegramRequests[0].body.chat_id, '555');

  // ще не збережені значення з форми
  res = await admin.post('/admin/api/notifications/test', { json: { telegramToken: OTHER_TOKEN, telegramChatId: '777' } });
  assert.equal(res.status, 200);
  assert.equal(telegramRequests[1].url, `/bot${OTHER_TOKEN}/sendMessage`);
  assert.equal(telegramRequests[1].body.chat_id, '777');

  telegramReply = () => ({ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } });
  try {
    res = await admin.post('/admin/api/notifications/test', { json: {} });
    assert.equal(res.status, 502);
    assert.match(res.data.error, /chat not found/);
    assert.ok(!res.text.includes(TOKEN));
  } finally {
    telegramReply = () => ({ status: 200, body: { ok: true, result: {} } });
  }
});

test('нова заявка надсилається в Telegram; збій Telegram не ламає заявку', async () => {
  await admin.put('/admin/api/notifications', { json: { telegramEnabled: true, telegramChatId: '555', telegramToken: TOKEN } });
  telegramRequests = [];
  const visitor = createClient(ctx.base);
  const res = await visitor.post('/api/lead', { json: { name: 'Ірина', contact: '@irina', destination: 'Греція', lang: 'en' }, csrf: false });
  assert.equal(res.status, 201);
  await waitFor(() => telegramRequests.length === 1);
  const { text } = telegramRequests[0].body;
  assert.match(text, /Ірина/);
  assert.match(text, /@irina/);
  assert.match(text, /Греція/);
  assert.match(text, /English/);

  telegramReply = () => ({ status: 500, body: { ok: false, description: 'Internal' } });
  try {
    const again = await visitor.post('/api/lead', { json: { name: 'Петро', contact: '+380670000000' }, csrf: false });
    assert.equal(again.status, 201);
    await waitFor(() => telegramRequests.length === 2);
    await waitFor(() => ctx.logger.lines.some((l) => l.includes('Telegram')));
  } finally {
    telegramReply = () => ({ status: 200, body: { ok: true, result: {} } });
  }
});

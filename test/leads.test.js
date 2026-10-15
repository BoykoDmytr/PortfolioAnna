'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createClient, readJson } = require('./helpers');
const { validateLead } = require('../src/leads');

const VALID = {
  name: 'Олена',
  contact: '+380 67 000 00 00',
  destination: 'Мальдіви',
  dates: 'травень',
  travelers: '2 дорослих',
  message: 'Хочемо спокійний відпочинок\n\nбез пересадок',
  lang: 'uk',
  website: '',
};

/** Кожен тест — на власному сервері: ліміт заявок рахується за IP (тут усі з 127.0.0.1). */
async function withServer(fn) {
  const ctx = await startServer();
  try {
    await fn(ctx, createClient(ctx.base));
  } finally {
    await ctx.close();
  }
}

const leadsFile = (ctx) => path.join(ctx.dataDir, 'private', 'leads.json');
const form = (obj) => new URLSearchParams(obj).toString();
const postForm = (client, obj) => client.post('/api/lead', {
  body: form(obj),
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml' },
  csrf: false,
});

test('JSON: валідна заявка → 201 і зберігається', () => withServer(async (ctx, client) => {
  const res = await client.post('/api/lead', { json: VALID, csrf: false });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.data, { ok: true });

  const leads = readJson(leadsFile(ctx));
  assert.equal(leads.length, 1);
  const [lead] = leads;
  assert.match(lead.id, /^[A-Za-z0-9_-]+$/);
  assert.ok(!Number.isNaN(Date.parse(lead.createdAt)));
  assert.equal(lead.status, 'new');
  assert.equal(lead.lang, 'uk');
  assert.equal(lead.name, 'Олена');
  assert.equal(lead.message, 'Хочемо спокійний відпочинок\n\nбез пересадок');
  assert.equal(lead.website, undefined, 'honeypot не зберігається');
  assert.deepEqual(Object.keys(lead).sort(), ['contact', 'createdAt', 'dates', 'destination', 'id', 'lang', 'message', 'name', 'status', 'travelers']);
}));

test('urlencoded (без JS): 303 на сторінку з ?lead=ok|error#contact', () => withServer(async (ctx, client) => {
  let res = await postForm(client, VALID);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/?lead=ok#contact');

  res = await postForm(client, { ...VALID, lang: 'en' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/en/?lead=ok#contact');

  res = await postForm(client, { ...VALID, name: '', lang: 'en' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/en/?lead=error#contact');

  assert.equal(readJson(leadsFile(ctx)).length, 2);
  assert.equal(readJson(leadsFile(ctx))[0].lang, 'en', 'найновіші першими');
}));

test('multipart (FormData з fetch) теж приймається', () => withServer(async (ctx, client) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(VALID)) fd.append(k, v);
  const res = await client.post('/api/lead', { body: fd, headers: { accept: 'application/json' }, csrf: false });
  assert.equal(res.status, 201, res.text);
  assert.equal(readJson(leadsFile(ctx)).length, 1);
}));

test('honeypot: бот отримує «успіх», але нічого не зберігається', () => withServer(async (ctx, client) => {
  const res = await client.post('/api/lead', { json: { ...VALID, website: 'http://spam.example' }, csrf: false });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data, { ok: true });
  const viaForm = await postForm(client, { ...VALID, website: 'spam' });
  assert.equal(viaForm.headers.get('location'), '/?lead=ok#contact');
  assert.ok(!fs.existsSync(leadsFile(ctx)) || readJson(leadsFile(ctx)).length === 0);
}));

test('валідація → 400 з details (мова повідомлень — за lang)', () => withServer(async (ctx, client) => {
  const res = await client.post('/api/lead', { json: { name: 'A', contact: '', message: 'x'.repeat(1001) }, csrf: false });
  assert.equal(res.status, 400);
  assert.equal(typeof res.data.error, 'string');
  const fields = res.data.details.map((d) => d.field).sort();
  assert.deepEqual(fields, ['contact', 'message', 'name']);
  assert.match(res.data.details.find((d) => d.field === 'name').message, /символ/);

  const en = await client.post('/api/lead', { json: { lang: 'en' }, csrf: false });
  assert.equal(en.status, 400);
  assert.match(en.data.error, /Please/);

  const wrongType = await client.post('/api/lead', { json: { ...VALID, name: { $gt: '' } }, csrf: false });
  assert.equal(wrongType.status, 400);

  const tooLong = await client.post('/api/lead', { json: { ...VALID, destination: 'x'.repeat(121) }, csrf: false });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.data.details[0].field, 'destination');

  const broken = await client.post('/api/lead', { body: '{"name":', headers: { 'content-type': 'application/json' }, csrf: false });
  assert.equal(broken.status, 400);

  assert.ok(!fs.existsSync(leadsFile(ctx)));
}));

test('rate limit: не більше 5 заявок за 10 хв з одного IP → 429', () => withServer(async (ctx, client) => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await client.post('/api/lead', { json: { ...VALID, name: `Клієнт ${i}` }, csrf: false })).status, 201);
  }
  const blocked = await client.post('/api/lead', { json: VALID, csrf: false });
  assert.equal(blocked.status, 429);
  assert.equal(typeof blocked.data.error, 'string');
  const viaForm = await postForm(client, VALID);
  assert.equal(viaForm.status, 303);
  assert.equal(viaForm.headers.get('location'), '/?lead=error#contact');
  assert.equal(readJson(leadsFile(ctx)).length, 5);
}));

test('адмінка: список, зміна статусу, видалення', () => withServer(async (ctx, client) => {
  const admin = createClient(ctx.base);
  assert.equal((await admin.get('/admin/api/leads')).status, 401);
  await admin.login();
  assert.deepEqual((await admin.get('/admin/api/leads')).data, []);

  await client.post('/api/lead', { json: { ...VALID, name: 'Перша' }, csrf: false });
  await client.post('/api/lead', { json: { ...VALID, name: 'Друга' }, csrf: false });
  const list = (await admin.get('/admin/api/leads')).data;
  assert.deepEqual(list.map((l) => l.name), ['Друга', 'Перша']);

  const id = list[1].id;
  const patched = await admin.patch(`/admin/api/leads/${id}`, { json: { status: 'in_progress' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.id, id);
  assert.equal(patched.data.status, 'in_progress');
  assert.equal(readJson(leadsFile(ctx)).find((l) => l.id === id).status, 'in_progress');

  assert.equal((await admin.patch(`/admin/api/leads/${id}`, { json: { status: 'archived' } })).status, 400);
  assert.equal((await admin.patch('/admin/api/leads/unknown-id', { json: { status: 'done' } })).status, 404);
  assert.equal((await admin.patch(`/admin/api/leads/${id}`, { json: { status: 'done' }, csrf: false })).status, 403);

  assert.deepEqual((await admin.del(`/admin/api/leads/${id}`)).data, { ok: true });
  assert.equal((await admin.del(`/admin/api/leads/${id}`)).status, 404);
  assert.deepEqual((await admin.get('/admin/api/leads')).data.map((l) => l.name), ['Друга']);
}));

test('validateLead: обрізає пробіли й керівні символи', () => {
  const { lead, errors } = validateLead({ name: '  Анна\u0000  ', contact: ' @anna ', travelers: 2 });
  assert.deepEqual(errors, []);
  assert.equal(lead.name, 'Анна');
  assert.equal(lead.contact, '@anna');
  assert.equal(lead.travelers, '2');
  assert.equal(lead.lang, 'uk');
  assert.deepEqual(validateLead({ website: 'x' }), { spam: true, lang: 'uk' });
});

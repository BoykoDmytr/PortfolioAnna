'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { startServer, createClient, readJson, SEED_DATA_DIR } = require('./helpers');
const { sanitizeContent, pluralUk, charsAtMost, charsAtLeast } = require('../src/validate');
const { changedUnits } = require('../src/content-store');
const { ICON_NAMES, SECTION_TYPES } = require('../src/schema');

let ctx;
let client;
let backupsDir;
let contentFile;

const clone = (v) => JSON.parse(JSON.stringify(v));
const listBackupFiles = () => (fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((n) => n.endsWith('.json')).sort() : []);

before(async () => {
  ctx = await startServer();
  client = createClient(ctx.base);
  await client.login();
  backupsDir = path.join(ctx.dataDir, 'private', 'backups');
  contentFile = path.join(ctx.dataDir, 'content.json');
});

after(() => ctx.close());

test('seed content.json проходить sanitizeContent без помилок', () => {
  const { errors } = sanitizeContent(readJson(path.join(SEED_DATA_DIR, 'content.json')));
  assert.deepEqual(errors, []);
});

test('GET /admin/api/schema', async () => {
  const res = await client.get('/admin/api/schema');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.sections.map((s) => s.type), SECTION_TYPES);
  assert.ok(Array.isArray(res.data.groups));
  assert.equal(res.data.languages.length, 2);
});

test('GET /admin/api/icons → { назва: <svg> } для всіх іконок схеми', async () => {
  const res = await client.get('/admin/api/icons');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.data).sort(), [...ICON_NAMES].sort());
  for (const name of ICON_NAMES) assert.match(res.data[name], /^<svg[\s>]/, name);
});

test('GET /admin/api/content повертає очищений контент', async () => {
  const res = await client.get('/admin/api/content');
  assert.equal(res.status, 200);
  assert.equal(res.data.version, 1);
  assert.equal(res.data.order[0], 'hero');
  assert.deepEqual(res.data, sanitizeContent(res.data).content);
  assert.deepEqual(res.data, sanitizeContent(readJson(path.join(SEED_DATA_DIR, 'content.json'))).content);
});

test('PUT /admin/api/content: збереження, резервна копія попередньої версії', async () => {
  const before = (await client.get('/admin/api/content')).data;
  const backupsBefore = listBackupFiles();

  const next = clone(before);
  next.sections.hero.title.uk = 'Новий заголовок для тесту';
  next.sections.hero.title.en = 'New test title';
  next.contacts.telegram = '@anna_frolova_travel';
  const res = await client.put('/admin/api/content', { json: next });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.content.sections.hero.title.uk, 'Новий заголовок для тесту');
  assert.equal(res.data.content.contacts.telegram, 'anna_frolova_travel', 'handle нормалізовано');

  assert.equal((await client.get('/admin/api/content')).data.sections.hero.title.en, 'New test title');
  assert.equal(readJson(contentFile).sections.hero.title.uk, 'Новий заголовок для тесту');
  assert.ok(!fs.readdirSync(ctx.dataDir).some((n) => n.endsWith('.tmp')), 'тимчасових файлів не лишилося');

  const backupsAfter = listBackupFiles();
  assert.equal(backupsAfter.length, backupsBefore.length + 1);
  const newest = backupsAfter.find((n) => !backupsBefore.includes(n));
  assert.match(newest, /^content-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?\.json$/);
  assert.deepEqual(readJson(path.join(backupsDir, newest)), before, 'у копії — попередня версія');
});

test('PUT без змін не створює зайвої резервної копії', async () => {
  const current = (await client.get('/admin/api/content')).data;
  const count = listBackupFiles().length;
  assert.equal((await client.put('/admin/api/content', { json: current })).status, 200);
  assert.equal(listBackupFiles().length, count);
});

test('PUT з неправильним телефоном → 422 з details, нічого не збережено', async () => {
  const current = (await client.get('/admin/api/content')).data;
  const onDisk = fs.readFileSync(contentFile, 'utf8');
  const bad = clone(current);
  bad.contacts.phone = 'дзвоніть мені';
  bad.sections.reviews.items = [{ name: 'A', rating: 5, text: { uk: 'x'.repeat(1300), en: '' } }];
  const res = await client.put('/admin/api/content', { json: bad });
  assert.equal(res.status, 422);
  assert.equal(res.data.error, 'Перевірте виділені поля');
  const paths = res.data.details.map((d) => d.path);
  assert.ok(paths.includes('contacts.phone'), JSON.stringify(res.data.details));
  assert.ok(paths.includes('sections.reviews.items.0.text.uk'), JSON.stringify(res.data.details));
  for (const d of res.data.details) assert.equal(typeof d.message, 'string');
  assert.equal(fs.readFileSync(contentFile, 'utf8'), onDisk);
});

test('повідомлення про довжину — з правильною формою множини («4 символи», не «4 символів»)', async () => {
  const current = (await client.get('/admin/api/content')).data;
  const bad = clone(current);
  bad.sections.certificates.items[0].year = '2024р';
  bad.contacts.phone = '12';
  const res = await client.put('/admin/api/content', { json: bad });
  assert.equal(res.status, 422);
  const year = res.data.details.find((d) => d.path === 'sections.certificates.items.0.year');
  assert.equal(year.message, 'Задовгий текст: не більше 4 символів');
  assert.ok(res.data.details.every((d) => !/Невірн/.test(d.message)), 'без «невірний»');
  const phone = res.data.details.find((d) => d.path === 'contacts.phone');
  assert.equal(phone.message, 'Неправильний формат');

  assert.equal(pluralUk(1, ['символ', 'символи', 'символів']), 'символ');
  assert.equal(pluralUk(4, ['символ', 'символи', 'символів']), 'символи');
  assert.equal(pluralUk(12, ['символ', 'символи', 'символів']), 'символів');
  assert.equal(pluralUk(22, ['символ', 'символи', 'символів']), 'символи');
  assert.equal(pluralUk(300, ['символ', 'символи', 'символів']), 'символів');
  assert.equal(charsAtMost(1), 'не більше 1 символу');
  assert.equal(charsAtMost(21), 'не більше 21 символу');
  assert.equal(charsAtMost(11), 'не більше 11 символів');
  assert.equal(charsAtMost(4), 'не більше 4 символів');
  assert.equal(charsAtLeast(2), 'щонайменше 2 символи');
  assert.equal(charsAtLeast(8), 'щонайменше 8 символів');
});

test('X-Content-Revision / If-Match: збереження з іншого пристрою не затирається мовчки', async () => {
  const first = await client.get('/admin/api/content');
  const rev = first.headers.get('x-content-revision');
  assert.match(rev, /^[0-9a-f]{20}$/);
  assert.equal((await client.get('/admin/api/content')).headers.get('x-content-revision'), rev, 'стабільний, поки вміст не змінився');

  // «Ноутбук» зберігає з If-Match → успіх і новий відбиток
  const laptop = clone(first.data);
  laptop.settings.footerText = { uk: 'Ноутбук', en: 'Laptop' };
  const saved = await client.put('/admin/api/content', { json: laptop, headers: { 'if-match': rev } });
  assert.equal(saved.status, 200);
  const rev2 = saved.headers.get('x-content-revision');
  assert.ok(rev2 && rev2 !== rev);

  // «Телефон» відкрив адмінку раніше (старий відбиток) → 412, нічого не збережено
  const onDisk = fs.readFileSync(contentFile, 'utf8');
  const phone = clone(first.data);
  phone.contacts.city = { uk: 'Львів', en: 'Lviv' };
  const stale = await client.put('/admin/api/content', { json: phone, headers: { 'if-match': `"${rev}"` } });
  assert.equal(stale.status, 412);
  assert.match(stale.data.error, /іншому пристрої/);
  assert.equal(stale.headers.get('x-content-revision'), rev2);
  assert.equal(fs.readFileSync(contentFile, 'utf8'), onDisk);

  // Без If-Match (старі клієнти, імпорт) — як раніше
  const plain = await client.put('/admin/api/content', { json: (await client.get('/admin/api/content')).data });
  assert.equal(plain.status, 200);
  assert.equal((await client.put('/admin/api/content', { json: plain.data.content, headers: { 'if-match': '*' } })).status, 200);
});

test('PUT з тілом, що не є контентом → 400; зіпсований JSON → 400', async () => {
  for (const json of [[], { foo: 1 }, 'text', null]) {
    const res = await client.put('/admin/api/content', { json });
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.equal(typeof res.data.error, 'string');
  }
  const broken = await client.put('/admin/api/content', { body: '{"sections":', headers: { 'content-type': 'application/json' } });
  assert.equal(broken.status, 400);
  assert.equal(typeof broken.data.error, 'string');
});

test('GET /admin/api/export → файл для завантаження', async () => {
  const res = await client.get('/admin/api/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="anna-frolova-content-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.deepEqual(res.data, (await client.get('/admin/api/content')).data);
});

test('POST /admin/api/import працює як PUT', async () => {
  const current = (await client.get('/admin/api/content')).data;
  const imported = clone(current);
  imported.settings.footerText = { uk: 'Імпортовано', en: 'Imported' };
  const res = await client.post('/admin/api/import', { json: imported });
  assert.equal(res.status, 200);
  assert.equal(res.data.content.settings.footerText.uk, 'Імпортовано');

  const bad = await client.post('/admin/api/import', { json: { hello: 'world' } });
  assert.equal(bad.status, 400);
  const invalid = clone(current);
  invalid.theme.accent = 'red';
  const res422 = await client.post('/admin/api/import', { json: invalid });
  assert.equal(res422.status, 422);
  assert.equal(res422.data.details[0].path, 'theme.accent');
});

test('резервні копії: список і відновлення', async () => {
  const list = (await client.get('/admin/api/backups')).data;
  assert.ok(list.length >= 2);
  for (const b of list) {
    assert.match(b.name, /^content-.+\.json$/);
    assert.ok(!Number.isNaN(Date.parse(b.createdAt)));
    assert.ok(b.size > 0);
  }
  const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  assert.deepEqual(list.map((b) => b.createdAt), sorted.map((b) => b.createdAt), 'найновіші першими');

  const oldest = list[list.length - 1];
  const expected = sanitizeContent(readJson(path.join(backupsDir, oldest.name))).content;
  const countBefore = listBackupFiles().length;
  const res = await client.post(`/admin/api/backups/${oldest.name}/restore`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.ok, true);
  assert.deepEqual(res.data.content, expected);
  assert.deepEqual((await client.get('/admin/api/content')).data, expected);
  assert.equal(listBackupFiles().length, countBefore + 1, 'поточну версію збережено перед відновленням');

  const download = await client.get(`/admin/api/backups/${oldest.name}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
});

test('резервні копії: підпис «що змінилося після неї»', async () => {
  const current = (await client.get('/admin/api/content')).data;
  const next = clone(current);
  next.contacts.hours = { uk: 'Пн–Пт 10:00–18:00', en: 'Mon–Fri 10:00–18:00' };
  next.sections.faq.title = { uk: 'Питання', en: 'FAQ' };
  assert.equal((await client.put('/admin/api/content', { json: next })).status, 200);
  const [newest] = (await client.get('/admin/api/backups')).data;
  assert.deepEqual(newest.changes, ['contacts', 'sections.faq']);

  assert.deepEqual(changedUnits(current, current), []);
  const reordered = clone(current);
  reordered.order = [...current.order].reverse();
  assert.deepEqual(changedUnits(current, reordered), ['order']);
});

test('резервні копії: недопустимі назви', async () => {
  for (const name of ['..%2Fauth.json', 'auth.json', 'content-2020-01-01.json', '..%2F..%2Fcontent.json']) {
    const res = await client.post(`/admin/api/backups/${name}/restore`);
    assert.equal(res.status, 400, name);
  }
  const missing = await client.post('/admin/api/backups/content-2001-01-01_00-00-00.json/restore');
  assert.equal(missing.status, 404);
  assert.equal((await client.get('/admin/api/backups/..%2Fauth.json')).status, 404);
});

test('зберігається не більше 30 резервних копій', async () => {
  let content = (await client.get('/admin/api/content')).data;
  for (let i = 0; i < 33; i += 1) {
    content = clone(content);
    content.settings.footerText.uk = `Версія ${i}`;
    const res = await client.put('/admin/api/content', { json: content });
    assert.equal(res.status, 200);
  }
  assert.equal(listBackupFiles().length, 30);
  const list = (await client.get('/admin/api/backups')).data;
  assert.equal(list.length, 30);
  const newest = readJson(path.join(backupsDir, list[0].name));
  assert.equal(newest.settings.footerText.uk, 'Версія 31', 'найновіша копія — передостання версія');
});

test('ContentStore: кілька копій за одну секунду мають зростаючі номери навіть після прибирання', async () => {
  const { ContentStore } = require('../src/content-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-backups-'));
  try {
    const store = new ContentStore({ contentFile: path.join(dir, 'content.json'), backupsDir: path.join(dir, 'b'), logger: { warn() {}, error() {} } });
    const at = new Date(2026, 4, 1, 10, 0, 0);
    const names = [];
    for (let i = 0; i < 3; i += 1) names.push(await store.createBackup({ i }, at));
    assert.deepEqual(names, ['content-2026-05-01_10-00-00.json', 'content-2026-05-01_10-00-00-2.json', 'content-2026-05-01_10-00-00-3.json']);
    await store.pruneBackups(2);
    assert.equal(fs.existsSync(path.join(dir, 'b', names[0])), false, 'прибрано найстарішу');
    assert.equal(await store.createBackup({ i: 3 }, at), 'content-2026-05-01_10-00-00-4.json');
    const list = await store.listBackups();
    assert.deepEqual(list.map((b) => b.name), ['content-2026-05-01_10-00-00-4.json', 'content-2026-05-01_10-00-00-3.json', 'content-2026-05-01_10-00-00-2.json']);
    assert.equal(list[0].createdAt, at.toISOString());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('зламаний content.json на старті не валить сервер і не перезаписується', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-broken-'));
  try {
    fs.writeFileSync(path.join(dir, 'content.json'), '{ not json');
    const logs = [];
    const logger = { log() {}, info() {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) };
    const app = createApp({ dataDir: dir, adminPassword: 'whatever-123', logger });
    assert.equal(app.services.store.get().order[0], 'hero');
    assert.equal(fs.readFileSync(path.join(dir, 'content.json'), 'utf8'), '{ not json');
    assert.ok(logs.length > 0);
    const copy = fs.readdirSync(dir).find((n) => /^content\.broken-\d+\.json$/.test(n));
    assert.ok(copy, 'копію пошкодженого файлу збережено');
    assert.equal(fs.readFileSync(path.join(dir, copy), 'utf8'), '{ not json');

    // невідомі/погані поля — попередження, але не падіння
    fs.writeFileSync(path.join(dir, 'content.json'), JSON.stringify({ contacts: { phone: 'abc' }, junk: 1, sections: { hero: { overlay: 'x' } } }));
    const app2 = createApp({ dataDir: dir, adminPassword: 'whatever-123', logger });
    assert.equal(app2.services.store.get().contacts.phone, 'abc');
    assert.equal(app2.services.store.get().junk, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('відсутній content.json створюється з типовими значеннями', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aft-empty-'));
  try {
    const logger = { log() {}, info() {}, warn() {}, error() {} };
    createApp({ dataDir: dir, adminPassword: 'whatever-123', logger });
    const created = readJson(path.join(dir, 'content.json'));
    assert.deepEqual(created, sanitizeContent({}).content);
    assert.ok(fs.existsSync(path.join(dir, 'private', 'auth.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

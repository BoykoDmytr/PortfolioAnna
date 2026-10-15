'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, createClient, readJson, TEST_PASSWORD, FAST_SCRYPT } = require('./helpers');
const { Auth, parseCookies, createRateLimiter, SCRYPT_PARAMS } = require('../src/auth');

let ctx;

before(async () => {
  ctx = await startServer();
});

after(() => ctx.close());

test('auth.json створюється під час першого запуску (scrypt, без пароля у відкритому вигляді)', () => {
  const file = path.join(ctx.dataDir, 'private', 'auth.json');
  const rec = readJson(file);
  assert.deepEqual(Object.keys(rec).sort(), ['hash', 'mustChangePassword', 'publicDefault', 'revoked', 'salt', 'scrypt', 'secret', 'sessionVersion']);
  assert.equal(rec.mustChangePassword, true);
  assert.equal(rec.sessionVersion, 1);
  assert.deepEqual(rec.scrypt, { ...FAST_SCRYPT }, 'параметри scrypt записано поруч із хешем');
  assert.equal(rec.publicDefault, false, 'пароль з ADMIN_PASSWORD — не стандартний з інструкції');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(TEST_PASSWORD));
});

test('GET /admin/api/session без cookie', async () => {
  const res = await createClient(ctx.base).get('/admin/api/session');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { authenticated: false, mustChangePassword: false });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('захищені маршрути без cookie → 401 «Потрібно увійти»', async () => {
  const client = createClient(ctx.base);
  for (const [method, url] of [['GET', '/admin/api/content'], ['GET', '/admin/api/schema'], ['GET', '/admin/api/leads'], ['PUT', '/admin/api/content'], ['GET', '/admin/api/media']]) {
    const res = await client.request(method, url, method === 'PUT' ? { json: {} } : {});
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.deepEqual(res.data, { error: 'Потрібно увійти' });
  }
});

test('CSRF: POST без X-Admin-Request → 403', async () => {
  const client = createClient(ctx.base);
  const res = await client.post('/admin/api/login', { json: { password: TEST_PASSWORD }, csrf: false });
  assert.equal(res.status, 403);
  assert.equal(typeof res.data.error, 'string');
  assert.equal(res.setCookies.length, 0);
});

test('вхід: неправильний пароль → 401 (і скільки спроб лишилось), правильний → cookie', async () => {
  const client = createClient(ctx.base);
  const wrong = await client.post('/admin/api/login', { json: { password: 'nope-nope' } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.data, { error: 'Неправильний пароль', attemptsLeft: 4 });

  const empty = await client.post('/admin/api/login', { json: {} });
  assert.equal(empty.status, 400);

  const ok = await client.post('/admin/api/login', { json: { password: TEST_PASSWORD } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { ok: true, mustChangePassword: true });
  const cookieLine = ok.setCookies.find((c) => c.startsWith('af_admin='));
  assert.ok(cookieLine, 'cookie af_admin встановлено');
  assert.match(cookieLine, /HttpOnly/i);
  assert.match(cookieLine, /SameSite=Strict/i);
  assert.match(cookieLine, /Path=\//);
  assert.match(cookieLine, /Max-Age=604800/);
  assert.doesNotMatch(cookieLine, /Secure/i, 'Secure лише для HTTPS');

  const session = await client.get('/admin/api/session');
  assert.deepEqual(session.data, { authenticated: true, mustChangePassword: true });
  assert.equal((await client.get('/admin/api/content')).status, 200);
});

test('підроблена або зіпсована cookie не приймається', async () => {
  const client = createClient(ctx.base);
  await client.login();
  const [payload, sig] = client.cookie.replace('af_admin=', '').split('.');
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e9, v: 1 })).toString('base64url');
  for (const value of [`${forged}.${sig}`, `${payload}.${sig.slice(0, -2)}xx`, payload, 'garbage', '']) {
    const other = createClient(ctx.base);
    other.cookie = `af_admin=${value}`;
    assert.equal((await other.get('/admin/api/content')).status, 401, value);
  }
});

test('CSRF: авторизований PUT без заголовка → 403', async () => {
  const client = createClient(ctx.base);
  await client.login();
  const content = (await client.get('/admin/api/content')).data;
  const res = await client.put('/admin/api/content', { json: content, csrf: false });
  assert.equal(res.status, 403);
});

test('вихід очищає cookie', async () => {
  const client = createClient(ctx.base);
  await client.login();
  const res = await client.post('/admin/api/logout');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true });
  assert.ok(res.setCookies.some((c) => /^af_admin=;/.test(c)));
  assert.equal(client.cookie, '');
  assert.equal((await client.get('/admin/api/content')).status, 401);
});

test('rate limit: після 5 невдалих спроб → 429 (навіть із правильним паролем)', async () => {
  const local = await startServer();
  try {
    const client = createClient(local.base);
    for (let i = 0; i < 5; i += 1) {
      const res = await client.post('/admin/api/login', { json: { password: `wrong-${i}` } });
      assert.equal(res.status, 401);
      assert.equal(res.data.attemptsLeft, 4 - i, 'адмінка попереджає до блокування');
    }
    const blocked = await client.post('/admin/api/login', { json: { password: TEST_PASSWORD } });
    assert.equal(blocked.status, 429);
    assert.equal(typeof blocked.data.error, 'string');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally {
    await local.close();
  }
});

test('успішний вхід скидає лічильник невдалих спроб', async () => {
  const local = await startServer();
  try {
    const client = createClient(local.base);
    for (let i = 0; i < 4; i += 1) await client.post('/admin/api/login', { json: { password: 'wrong' } });
    await client.login();
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await client.post('/admin/api/login', { json: { password: 'wrong' } })).status, 401);
    }
  } finally {
    await local.close();
  }
});

test('зміна пароля: перевірки, нова cookie, інші сесії завершуються', async () => {
  const local = await startServer();
  try {
    const phone = createClient(local.base);
    const laptop = createClient(local.base);
    await phone.login();
    await laptop.login();

    const wrongCurrent = await laptop.post('/admin/api/password', { json: { current: 'wrong', next: 'new-password-1' } });
    assert.equal(wrongCurrent.status, 400, 'неправильний поточний пароль — не 401, щоб адмінка не «вилогінювала»');
    assert.equal(wrongCurrent.data.details[0].field, 'current');
    assert.equal(wrongCurrent.data.error, 'Поточний пароль неправильний');
    assert.equal(wrongCurrent.data.attemptsLeft, 4);

    const short = await laptop.post('/admin/api/password', { json: { current: TEST_PASSWORD, next: 'short' } });
    assert.equal(short.status, 400);
    assert.equal(short.data.details[0].field, 'next');

    const same = await laptop.post('/admin/api/password', { json: { current: TEST_PASSWORD, next: TEST_PASSWORD } });
    assert.equal(same.status, 400);

    const oldCookie = laptop.cookie;
    const ok = await laptop.post('/admin/api/password', { json: { current: TEST_PASSWORD, next: 'new-password-1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ok, true);
    assert.notEqual(laptop.cookie, oldCookie, 'поточній сесії видано нову cookie');

    assert.deepEqual((await laptop.get('/admin/api/session')).data, { authenticated: true, mustChangePassword: false });
    assert.equal((await phone.get('/admin/api/content')).status, 401, 'інша сесія завершилась');

    const relogin = createClient(local.base);
    assert.equal((await relogin.post('/admin/api/login', { json: { password: TEST_PASSWORD } })).status, 401);
    const fresh = await relogin.post('/admin/api/login', { json: { password: 'new-password-1' } });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.data.mustChangePassword, false);

    const rec = readJson(path.join(local.dataDir, 'private', 'auth.json'));
    assert.equal(rec.sessionVersion, 2);
    assert.equal(rec.mustChangePassword, false);
  } finally {
    await local.close();
  }
});

test('справжні параметри scrypt — за OWASP (N=2^14, r=8, p=5)', async () => {
  assert.deepEqual({ ...SCRYPT_PARAMS }, { N: 16384, r: 8, p: 5 });
  const local = await startServer({ scryptParams: null });
  try {
    assert.deepEqual(readJson(path.join(local.dataDir, 'private', 'auth.json')).scrypt, { N: 16384, r: 8, p: 5 });
    await createClient(local.base).login();
  } finally {
    await local.close();
  }
});

test('Auth: токен з минулим терміном дії не приймається', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aft-auth-'));
  try {
    const auth = new Auth({ authFile: path.join(dir, 'auth.json'), defaultPassword: 'x-password', logger: { warn() {} } }).init();
    const token = auth.issueToken(Date.now() - 8 * 24 * 3600 * 1000);
    assert.equal(auth.verifyToken(token), false);
    assert.equal(auth.verifyToken(auth.issueToken()), true);
    assert.equal(auth.verifyPasswordSync('x-password'), true);
    // пошкоджений auth.json → створюється заново, старий відкладається
    fs.writeFileSync(path.join(dir, 'auth.json'), '{broken');
    const again = new Auth({ authFile: path.join(dir, 'auth.json'), defaultPassword: 'y-password', logger: { warn() {} } }).init();
    assert.equal(again.verifyPasswordSync('y-password'), true);
    assert.ok(fs.readdirSync(dir).some((n) => n.includes('.broken-')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCookies і rate limiter', () => {
  assert.deepEqual(parseCookies('a=1; af_admin=x.y; b="q%20w"'), { a: '1', af_admin: 'x.y', b: 'q w' });
  assert.deepEqual(parseCookies(undefined), {});
  const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
  limiter.hit('ip', 0);
  limiter.hit('ip', 100);
  assert.equal(limiter.check('ip', 200).limited, true);
  assert.equal(limiter.check('ip', 1001).limited, false, 'старі події виходять з вікна');
  assert.equal(limiter.check('other', 200).limited, false);

  // consume: перевірка й облік одним кроком; undo повертає спробу
  const l2 = createRateLimiter({ windowMs: 1000, max: 2 });
  const a = l2.consume('ip', 0);
  assert.deepEqual([a.limited, a.remaining], [false, 1]);
  const b = l2.consume('ip', 1);
  assert.deepEqual([b.limited, b.remaining], [false, 0]);
  assert.equal(l2.consume('ip', 2).limited, true);
  b.undo();
  b.undo(); // повторний undo нічого не ламає
  assert.equal(l2.consume('ip', 3).limited, false);
  assert.equal(l2.consume('ip', 4).limited, true);
});

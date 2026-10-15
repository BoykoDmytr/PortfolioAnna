'use strict';

/**
 * Вхід до адмін-панелі.
 *
 * - Пароль зберігається як scrypt-хеш з випадковою сіллю в data/private/auth.json
 *   ({ hash, salt, scrypt: {N, r, p}, secret, sessionVersion, mustChangePassword, publicDefault, revoked }).
 *   Параметри scrypt записано поруч із хешем: старі записи (без них) після наступного входу
 *   автоматично перехешовуються з поточними параметрами.
 * - Сесія — підписаний токен у cookie `af_admin`: base64url(JSON {exp, v, sid}) + '.' + HMAC-SHA256.
 *   `v` — sessionVersion: після зміни пароля (або «вийти на всіх пристроях») інші сесії стають недійсними;
 *   `sid` — ідентифікатор сесії: після «Вийти» саме цей токен потрапляє до списку відкликаних (`revoked`).
 * - publicDefault: пароль досі стандартний «anna2026» з інструкції — app.js дозволяє вхід з ним
 *   лише з цього ж комп'ютера.
 * - Одночасно обчислюється не більше 2 хешів (решта чекає в черзі), щоб потік запитів на вхід
 *   не зайняв увесь пул потоків Node, з якого читаються й файли сайту.
 */

const crypto = require('crypto');
const { promisify } = require('util');
const { readJsonFile, writeJsonAtomic, writeJsonAtomicSync, moveAside, isPlainObject } = require('./content-store');
const { createRateLimiter, createSemaphore } = require('./limits');
const { DEFAULT_ADMIN_PASSWORD } = require('./config');

const scryptAsync = promisify(crypto.scrypt);

const COOKIE_NAME = 'af_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;
// OWASP Password Storage Cheat Sheet: N=2^17,r=8,p=1 або рівноцінні N=2^14,r=8,p=5 (лише 16 МБ пам'яті
// на хеш замість 128 МБ — важливо для невеликого VPS). Близько 0,3 с на сучасному процесорі.
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 5 });
// Записи, створені до появи поля `scrypt`
const LEGACY_SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
const MAX_PASSWORD_LENGTH = 200;
const MAX_CONCURRENT_HASHES = 2;
const MAX_QUEUED_HASHES = 16;
const MAX_REVOKED = 500;

const HEX_RE = /^[0-9a-f]+$/i;
const SID_RE = /^[A-Za-z0-9_-]{12,64}$/;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function safeEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function scryptOptions({ N, r, p }) {
  return { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) };
}

/** {N, r, p} з auth.json або null, якщо значення недопустимі. */
function parseParams(value) {
  if (value === undefined) return { ...LEGACY_SCRYPT_PARAMS };
  if (!isPlainObject(value)) return null;
  const { N, r, p } = value;
  const ok = Number.isInteger(N) && N >= 1024 && N <= 2 ** 20 && (N & (N - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= 32
    && Number.isInteger(p) && p >= 1 && p <= 16;
  return ok ? { N, r, p } : null;
}

const sameParams = (a, b) => a.N === b.N && a.r === b.r && a.p === b.p;

function hashPasswordSync(password, saltHex, params = SCRYPT_PARAMS) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, scryptOptions(params));
}

async function hashPassword(password, saltHex, params = SCRYPT_PARAMS) {
  return scryptAsync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, scryptOptions(params));
}

function cleanRevoked(value, now = Date.now()) {
  const out = {};
  if (!isPlainObject(value)) return out;
  const entries = Object.entries(value)
    .filter(([sid, exp]) => SID_RE.test(sid) && typeof exp === 'number' && exp > now)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_REVOKED);
  for (const [sid, exp] of entries) out[sid] = exp;
  return out;
}

function isValidAuthRecord(rec) {
  return isPlainObject(rec)
    && typeof rec.hash === 'string' && HEX_RE.test(rec.hash) && rec.hash.length === SCRYPT_KEYLEN * 2
    && typeof rec.salt === 'string' && HEX_RE.test(rec.salt) && rec.salt.length >= 16
    && typeof rec.secret === 'string' && rec.secret.length >= 32
    && parseParams(rec.scrypt) !== null;
}

class Auth {
  /**
   * @param {object} opts
   * @param {string} opts.authFile         data/private/auth.json
   * @param {string} opts.defaultPassword  початковий пароль (ADMIN_PASSWORD або 'anna2026')
   * @param {object} [opts.scryptParams]   {N, r, p} для нових хешів (лише для тестів; за замовчуванням SCRYPT_PARAMS)
   * @param {object} [opts.logger]
   */
  constructor({ authFile, defaultPassword, scryptParams, logger = console }) {
    this.authFile = authFile;
    this.defaultPassword = defaultPassword;
    this.params = (scryptParams && parseParams(scryptParams)) || { ...SCRYPT_PARAMS };
    this.logger = logger;
    this.record = null;
    this.hashing = createSemaphore({ max: MAX_CONCURRENT_HASHES, maxQueue: MAX_QUEUED_HASHES });
    this.mutations = Promise.resolve();
  }

  /** Читає auth.json або створює його під час першого запуску. */
  init() {
    const result = readJsonFile(this.authFile);
    if (result.exists && !result.error && isValidAuthRecord(result.value)) {
      const rec = result.value;
      const mustChangePassword = rec.mustChangePassword === true;
      this.record = {
        hash: rec.hash,
        salt: rec.salt,
        scrypt: parseParams(rec.scrypt),
        secret: rec.secret,
        sessionVersion: Number.isInteger(rec.sessionVersion) ? rec.sessionVersion : 1,
        mustChangePassword,
        publicDefault: false,
        revoked: cleanRevoked(rec.revoked),
      };
      if (typeof rec.publicDefault === 'boolean') {
        this.record.publicDefault = rec.publicDefault;
      } else if (mustChangePassword) {
        // Запис зі старої версії: перевіряємо один раз, чи це досі пароль з інструкції
        this.record.publicDefault = this.verifyPasswordSync(DEFAULT_ADMIN_PASSWORD);
      }
      return this;
    }
    if (result.exists) {
      this.logger.warn(`Файл ${this.authFile} пошкоджений — пароль адмінки скинуто до початкового.`);
      moveAside(this.authFile, this.logger);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    this.record = {
      hash: hashPasswordSync(this.defaultPassword, salt, this.params).toString('hex'),
      salt,
      scrypt: { ...this.params },
      secret: crypto.randomBytes(32).toString('hex'),
      sessionVersion: 1,
      mustChangePassword: true,
      publicDefault: this.defaultPassword === DEFAULT_ADMIN_PASSWORD,
      revoked: {},
    };
    writeJsonAtomicSync(this.authFile, this.record, { mode: 0o600 });
    return this;
  }

  get mustChangePassword() {
    return this.record.mustChangePassword;
  }

  /** true — діє стандартний пароль з інструкції (anna2026), який знають усі. */
  get usingPublicDefault() {
    return this.record.publicDefault === true;
  }

  /**
   * Послідовні зміни запису: fn(record) → новий запис (або null — нічого не міняти).
   * Запис спершу потрапляє на диск, і лише потім — у пам'ять.
   */
  mutate(fn) {
    const run = this.mutations.catch(() => {}).then(async () => {
      const next = fn(this.record);
      if (!next) return this.record;
      await writeJsonAtomic(this.authFile, next, { mode: 0o600 });
      this.record = next;
      return next;
    });
    this.mutations = run;
    return run;
  }

  /**
   * Перевіряє пароль. Може кинути BusyError (503), якщо в черзі на перевірку забагато запитів.
   * Після успішної перевірки старий хеш (зі слабшими параметрами) тихо замінюється новим.
   */
  async verifyPassword(password) {
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) return false;
    const { salt, hash, scrypt } = this.record;
    const computed = await this.hashing.run(() => hashPassword(password, salt, scrypt));
    const ok = safeEqual(computed, Buffer.from(hash, 'hex'));
    if (ok && !sameParams(scrypt, this.params)) {
      await this.rehash(password, salt).catch((err) => {
        this.logger.warn(`Не вдалося оновити хеш пароля: ${err.message}`);
      });
    }
    return ok;
  }

  async rehash(password, oldSalt) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await this.hashing.run(() => hashPassword(password, salt, this.params))).toString('hex');
    await this.mutate((rec) => (rec.salt === oldSalt ? { ...rec, hash, salt, scrypt: { ...this.params } } : null));
  }

  /** Синхронна перевірка — лише під час запуску. */
  verifyPasswordSync(password) {
    if (typeof password !== 'string' || !password) return false;
    const { salt, hash, scrypt } = this.record;
    return safeEqual(hashPasswordSync(password, salt, scrypt), Buffer.from(hash, 'hex'));
  }

  /** Змінює пароль: нова сіль, sessionVersion + 1 (інші сесії стають недійсними). */
  async changePassword(nextPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await this.hashing.run(() => hashPassword(nextPassword, salt, this.params))).toString('hex');
    await this.mutate((rec) => ({
      ...rec,
      hash,
      salt,
      scrypt: { ...this.params },
      sessionVersion: rec.sessionVersion + 1,
      mustChangePassword: false,
      publicDefault: nextPassword === DEFAULT_ADMIN_PASSWORD,
      revoked: {},
    }));
  }

  /** «Вийти на всіх пристроях»: усі видані токени стають недійсними. */
  async revokeAllSessions() {
    await this.mutate((rec) => ({ ...rec, sessionVersion: rec.sessionVersion + 1, revoked: {} }));
  }

  /** «Вийти»: саме цей токен більше не приймається (навіть якщо його скопіювали до виходу). */
  async revokeToken(token) {
    const data = this.readToken(token);
    if (!data) return false;
    await this.mutate((rec) => {
      if (rec.revoked[data.sid]) return null;
      return { ...rec, revoked: cleanRevoked({ ...rec.revoked, [data.sid]: data.exp }) };
    });
    return true;
  }

  sign(payloadB64) {
    return b64url(crypto.createHmac('sha256', this.record.secret).update(payloadB64).digest());
  }

  issueToken(now = Date.now()) {
    const sid = b64url(crypto.randomBytes(12));
    const payload = b64url(JSON.stringify({ exp: now + SESSION_TTL_MS, v: this.record.sessionVersion, sid }));
    return `${payload}.${this.sign(payload)}`;
  }

  /** Розшифровує дійсний токен → { exp, v, sid } або null. */
  readToken(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 512) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!safeEqual(signature, this.sign(payload))) return null;
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const valid = isPlainObject(data)
      && typeof data.exp === 'number' && data.exp > now
      && data.v === this.record.sessionVersion
      && typeof data.sid === 'string' && SID_RE.test(data.sid)
      && !Object.prototype.hasOwnProperty.call(this.record.revoked, data.sid);
    return valid ? data : null;
  }

  verifyToken(token, now = Date.now()) {
    return this.readToken(token, now) !== null;
  }

  tokenFrom(req) {
    return parseCookies(req.headers.cookie)[COOKIE_NAME];
  }

  /** true, якщо запит містить дійсну сесійну cookie. */
  isAuthenticated(req) {
    return this.verifyToken(this.tokenFrom(req));
  }
}

/* ------------------------------------------------------------------ */
/* Cookie                                                             */
/* ------------------------------------------------------------------ */

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    // За реверс-проксі з HTTPS req.secure стає true лише з TRUST_PROXY (див. README, варіант Б)
    secure: Boolean(req.secure),
  };
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(req), maxAge: SESSION_TTL_MS });
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

module.exports = {
  Auth,
  COOKIE_NAME,
  SESSION_TTL_MS,
  MAX_PASSWORD_LENGTH,
  SCRYPT_PARAMS,
  LEGACY_SCRYPT_PARAMS,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createRateLimiter,
};

'use strict';

/**
 * Вхід до адмін-панелі.
 *
 * - Пароль зберігається як scrypt-хеш з випадковою сіллю в data/private/auth.json
 *   ({ hash, salt, secret, sessionVersion, mustChangePassword }).
 * - Сесія — підписаний токен у cookie `af_admin`: base64url(JSON {exp, v}) + '.' + HMAC-SHA256.
 *   `v` — sessionVersion: після зміни пароля всі інші сесії стають недійсними.
 * - Обмеження спроб (rate limit) — у пам'яті, за IP.
 */

const crypto = require('crypto');
const { promisify } = require('util');
const { readJsonFile, writeJsonAtomic, writeJsonAtomicSync, moveAside, isPlainObject } = require('./content-store');

const scryptAsync = promisify(crypto.scrypt);

const COOKIE_NAME = 'af_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_PASSWORD_LENGTH = 200;

const HEX_RE = /^[0-9a-f]+$/i;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function safeEqual(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPasswordSync(password, saltHex) {
  return crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, SCRYPT_OPTIONS);
}

async function hashPassword(password, saltHex) {
  return scryptAsync(String(password), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, SCRYPT_OPTIONS);
}

function isValidAuthRecord(rec) {
  return isPlainObject(rec)
    && typeof rec.hash === 'string' && HEX_RE.test(rec.hash) && rec.hash.length === SCRYPT_KEYLEN * 2
    && typeof rec.salt === 'string' && HEX_RE.test(rec.salt) && rec.salt.length >= 16
    && typeof rec.secret === 'string' && rec.secret.length >= 32;
}

class Auth {
  /**
   * @param {object} opts
   * @param {string} opts.authFile         data/private/auth.json
   * @param {string} opts.defaultPassword  початковий пароль (ADMIN_PASSWORD або 'anna2026')
   * @param {object} [opts.logger]
   */
  constructor({ authFile, defaultPassword, logger = console }) {
    this.authFile = authFile;
    this.defaultPassword = defaultPassword;
    this.logger = logger;
    this.record = null;
  }

  /** Читає auth.json або створює його під час першого запуску. */
  init() {
    const result = readJsonFile(this.authFile);
    if (result.exists && !result.error && isValidAuthRecord(result.value)) {
      const rec = result.value;
      this.record = {
        hash: rec.hash,
        salt: rec.salt,
        secret: rec.secret,
        sessionVersion: Number.isInteger(rec.sessionVersion) ? rec.sessionVersion : 1,
        mustChangePassword: rec.mustChangePassword === true,
      };
      return this;
    }
    if (result.exists) {
      this.logger.warn(`Файл ${this.authFile} пошкоджений — пароль адмінки скинуто до початкового.`);
      moveAside(this.authFile, this.logger);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    this.record = {
      hash: hashPasswordSync(this.defaultPassword, salt).toString('hex'),
      salt,
      secret: crypto.randomBytes(32).toString('hex'),
      sessionVersion: 1,
      mustChangePassword: true,
    };
    writeJsonAtomicSync(this.authFile, this.record, { mode: 0o600 });
    return this;
  }

  get mustChangePassword() {
    return this.record.mustChangePassword;
  }

  async verifyPassword(password) {
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) return false;
    const hash = await hashPassword(password, this.record.salt);
    return safeEqual(hash, Buffer.from(this.record.hash, 'hex'));
  }

  /** Синхронна перевірка — лише для підказки в консолі під час запуску. */
  verifyPasswordSync(password) {
    if (typeof password !== 'string' || !password) return false;
    return safeEqual(hashPasswordSync(password, this.record.salt), Buffer.from(this.record.hash, 'hex'));
  }

  /** Змінює пароль: нова сіль, sessionVersion + 1 (інші сесії стають недійсними). */
  async changePassword(nextPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await hashPassword(nextPassword, salt)).toString('hex');
    const record = {
      ...this.record,
      hash,
      salt,
      sessionVersion: this.record.sessionVersion + 1,
      mustChangePassword: false,
    };
    await writeJsonAtomic(this.authFile, record, { mode: 0o600 });
    this.record = record;
  }

  sign(payloadB64) {
    return b64url(crypto.createHmac('sha256', this.record.secret).update(payloadB64).digest());
  }

  issueToken(now = Date.now()) {
    const payload = b64url(JSON.stringify({ exp: now + SESSION_TTL_MS, v: this.record.sessionVersion }));
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 512) return false;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return false;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (!safeEqual(signature, this.sign(payload))) return false;
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    return isPlainObject(data)
      && typeof data.exp === 'number' && data.exp > now
      && data.v === this.record.sessionVersion;
  }

  /** true, якщо запит містить дійсну сесійну cookie. */
  isAuthenticated(req) {
    return this.verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
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
    secure: Boolean(req.secure),
  };
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(req), maxAge: SESSION_TTL_MS });
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

/* ------------------------------------------------------------------ */
/* Rate limit (у пам'яті)                                             */
/* ------------------------------------------------------------------ */

/**
 * Ковзне вікно: не більше `max` подій за `windowMs` на ключ (IP).
 *   check(key) → { limited, retryAfterMs }   hit(key)   reset(key)
 */
function createRateLimiter({ windowMs, max }) {
  const events = new Map();

  function recent(key, now) {
    const list = events.get(key);
    if (!list) return [];
    const fresh = list.filter((ts) => now - ts < windowMs);
    if (fresh.length) events.set(key, fresh);
    else events.delete(key);
    return fresh;
  }

  function sweep(now) {
    if (events.size < 1000) return;
    for (const key of [...events.keys()]) recent(key, now);
  }

  return {
    check(key, now = Date.now()) {
      const list = recent(String(key), now);
      if (list.length < max) return { limited: false, retryAfterMs: 0 };
      return { limited: true, retryAfterMs: Math.max(1000, windowMs - (now - list[0])) };
    },
    hit(key, now = Date.now()) {
      sweep(now);
      const k = String(key);
      const list = recent(k, now);
      list.push(now);
      events.set(k, list);
    },
    reset(key) {
      events.delete(String(key));
    },
  };
}

module.exports = {
  Auth,
  COOKIE_NAME,
  SESSION_TTL_MS,
  MAX_PASSWORD_LENGTH,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  createRateLimiter,
};

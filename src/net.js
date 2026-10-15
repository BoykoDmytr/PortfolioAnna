'use strict';

/**
 * Звідки прийшов запит і на яку адресу він адресований.
 *
 * - isLocalRequest(req)  — браузер на цьому ж комп'ютері (loopback), напряму, не через проксі;
 * - createHostGuard(...) — захист адмінки від DNS rebinding: чужий сайт не може «прикинутися»
 *   localhost, бо браузер надсилає в заголовку Host його доменне ім'я, якого немає в списку дозволених;
 * - requestOrigin(req)   — 'http://localhost:3000' для абсолютних посилань (SEO), якщо адресу сайту не вказано.
 */

const net = require('net');
const os = require('os');

// Заголовки, які додають реверс-проксі (Caddy, Nginx, Cloudflare…). Якщо є хоч один — запит
// прийшов не напряму з браузера на цьому комп'ютері (навіть якщо TCP-з'єднання з 127.0.0.1).
const PROXY_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via',
  'cf-connecting-ip', 'true-client-ip', 'fastly-client-ip', 'x-client-ip',
];

const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/i;

function isLoopbackAddress(addr) {
  const a = String(addr || '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function isProxied(req) {
  return PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
}

/** true — браузер на цьому ж комп'ютері, з'єднання напряму (не через реверс-проксі). */
function isLocalRequest(req) {
  return isLoopbackAddress(req.socket && req.socket.remoteAddress) && !isProxied(req);
}

/** 'Example.com:3000' → 'example.com'; '[::1]:3000' → '::1'; некоректне значення → '' */
function hostnameOf(hostHeader) {
  const m = HOST_RE.exec(String(hostHeader || '').trim());
  if (!m) return '';
  return m[1].toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** Перше значення заголовка, якому довіряємо лише за TRUST_PROXY (X-Forwarded-Host). */
function firstValue(header) {
  return String(header || '').split(',')[0].trim();
}

/** true — з'єднання від проксі, якому довіряємо за TRUST_PROXY (express 'trust proxy fn'). */
function fromTrustedProxy(req) {
  const trust = req.app && req.app.get('trust proxy') ? req.app.get('trust proxy fn') : null;
  return Boolean(trust && req.socket && trust(req.socket.remoteAddress, 0));
}

/** Адреса, на яку звернувся браузер: X-Forwarded-Host (лише від довіреного проксі) або Host. */
function requestHost(req) {
  const forwarded = fromTrustedProxy(req) ? firstValue(req.headers['x-forwarded-host']) : '';
  const host = forwarded || String(req.headers.host || '').trim();
  return HOST_RE.test(host) ? host.toLowerCase() : '';
}

/** 'https://annafrolova.travel' — для абсолютних посилань, коли «Адресу сайту» не вказано. */
function requestOrigin(req) {
  const host = requestHost(req);
  if (!host) return '';
  return `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
}

function machineNames() {
  const names = new Set();
  try {
    const host = os.hostname().toLowerCase().replace(/\.$/, '');
    if (host) {
      names.add(host);
      const short = host.split('.')[0];
      names.add(short);
      names.add(`${short}.local`); // mDNS: «Annas-MacBook.local»
    }
  } catch {
    // без назви комп'ютера — лише IP та localhost
  }
  return names;
}

/** 'https://annafrolova.travel/' → 'annafrolova.travel' */
function hostOfUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return '';
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/**
 * @param {object} opts
 * @param {string[]} [opts.allowedHosts]  ALLOWED_HOSTS: 'example.com', '.example.com' (з піддоменами)
 * @param {boolean}  [opts.trustProxy]    сервер за реверс-проксі (TRUST_PROXY): віртуальні хости обирає проксі
 * @param {function} [opts.siteUrl]       () → seo.siteUrl з контенту (читається щоразу, тож зміни діють одразу)
 */
function createHostGuard({ allowedHosts = [], trustProxy = false, siteUrl = () => '' } = {}) {
  const extra = allowedHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  const names = machineNames();

  function isAllowedHostname(hostname) {
    if (!hostname) return false;
    if (net.isIP(hostname)) return true; // DNS rebinding можливий лише через доменне ім'я
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
    if (names.has(hostname)) return true;
    const site = hostOfUrl(siteUrl());
    if (site && (hostname === site || hostname === `www.${site}` || `www.${hostname}` === site)) return true;
    return extra.some((e) => (e.startsWith('.') ? hostname.endsWith(e) || hostname === e.slice(1) : hostname === e));
  }

  return {
    isAllowedHostname,
    /** true — запит можна обслужити (адреса відома або сервер за проксі, який сам обирає домени). */
    allows(req) {
      if (trustProxy && !extra.length) return true;
      return isAllowedHostname(hostnameOf(requestHost(req)));
    },
    /** Для запитів, що змінюють дані: Origin (якщо є) має збігатися з адресою запиту. */
    originMatches(req) {
      const origin = req.headers.origin;
      if (origin === undefined) return true;
      if (trustProxy) return true; // за проксі Host може бути переписано; CSRF закриває X-Admin-Request
      try {
        return new URL(origin).host.toLowerCase() === requestHost(req);
      } catch {
        return false; // 'null' та інше сміття
      }
    },
  };
}

/**
 * TRUST_PROXY → значення для app.set('trust proxy', …):
 *   '' | 'false' | '0'  → false (за замовчуванням)
 *   '1', '2'            → кількість проксі перед сервером
 *   'true'              → довіряти всім (лише якщо сервер недоступний напряму!)
 *   'loopback', '10.0.0.1, 10.0.0.2' → адреси/підмережі проксі
 */
function parseTrustProxy(value) {
  const v = String(value || '').trim();
  if (!v || /^(false|0|no|off)$/i.test(v)) return false;
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

function parseHostList(value) {
  return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

module.exports = {
  isLoopbackAddress,
  isProxied,
  isLocalRequest,
  hostnameOf,
  requestHost,
  requestOrigin,
  createHostGuard,
  parseTrustProxy,
  parseHostList,
};

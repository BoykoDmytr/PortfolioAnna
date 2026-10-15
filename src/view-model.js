'use strict';

/**
 * buildViewModel(content, lang, { basePath, isStatic, leadStatus, origin }) → локальні змінні для views/index.ejs.
 * origin — адреса, з якої відкрито сторінку ('https://example.com'); потрібна для абсолютних
 * посилань (og:image, hreflang, canonical), коли в SEO не вказано «Адресу сайту».
 * Контракт описано в SPEC.md («View-model contract»). Шаблони не мають знати про структуру
 * content.json більше, ніж потрібно: тексти через t()/u(), шляхи через asset()/img(), іконки через icon().
 */

const { LANGUAGES, LANG_CODES } = require('./schema');
const { normalizeBasePath } = require('./config');

const PRIMARY_LANG = LANG_CODES[0];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const OG_LOCALES = { uk: 'uk_UA', en: 'en_GB' };
const ORIGIN_RE = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d{1,5})?$/i;
const MESSENGERS = [
  ['telegram', 'writeTelegram'],
  ['viber', 'writeViber'],
  ['instagram', 'writeInstagram'],
  ['phone', 'call'],
];

/* ------------------------------------------------------------------ */
/* Іконки: src/icons.js завантажується ліниво, щоб сервер працював     */
/* навіть без нього (тоді замість іконки — порожній <svg>).            */
/* ------------------------------------------------------------------ */

let iconsModule = null;
let iconsWarned = false;

function loadIcons() {
  if (iconsModule) return iconsModule;
  try {
    // eslint-disable-next-line global-require
    const mod = require('./icons');
    if (mod && typeof mod.iconSvg === 'function') iconsModule = mod;
  } catch (err) {
    if (!iconsWarned && !(err.code === 'MODULE_NOT_FOUND' && /icons/.test(err.message))) {
      console.warn(`Не вдалося завантажити src/icons.js: ${err.message}`);
    }
    iconsWarned = true;
  }
  return iconsModule;
}

const escapeAttr = (v) => String(v).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function emptySvg(cls) {
  return `<svg class="${escapeAttr(cls)}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"></svg>`;
}

/* ------------------------------------------------------------------ */
/* Допоміжні                                                          */
/* ------------------------------------------------------------------ */

const langPath = (code) => (code === PRIMARY_LANG ? '/' : `/${code}/`);

/**
 * '+380 67 123-45-67' → '+380671234567' (лише цифри і початковий +).
 * Український номер без коду країни ('067 123 45 67', '380 67 …') → '+380…',
 * щоб посилання tel: працювало і з іноземної SIM-картки.
 */
function dialable(value) {
  const s = String(value || '').trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (s.startsWith('+')) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+38${digits}`;
  if (/^380\d{9}$/.test(digits)) return `+${digits}`;
  return digits;
}

/** Номер для Viber у міжнародному форматі без '+': '067 123 45 67' → '380671234567' */
function viberNumber(value) {
  return dialable(value).replace(/^\+/, '');
}

function buildLinks(contacts) {
  const c = contacts || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const phone = str(c.phone);
  const telegram = str(c.telegram).replace(/^@/, '');
  const viber = str(c.viber);
  const instagram = str(c.instagram).replace(/^@/, '');
  const email = str(c.email);

  return {
    phone: phone && dialable(phone) ? { display: phone, href: `tel:${dialable(phone)}` } : null,
    telegram: telegram ? { display: `@${telegram}`, href: `https://t.me/${encodeURIComponent(telegram)}` } : null,
    viber: viber && viberNumber(viber) ? { display: viber, href: `viber://chat?number=%2B${viberNumber(viber)}` } : null,
    instagram: instagram ? { display: `@${instagram}`, href: `https://instagram.com/${encodeURIComponent(instagram)}` } : null,
    email: email && email.includes('@') ? { display: email, href: `mailto:${email}` } : null,
  };
}

/* ------------------------------------------------------------------ */
/* View-model                                                         */
/* ------------------------------------------------------------------ */

function buildViewModel(content, lang, options = {}) {
  const basePath = normalizeBasePath(options.basePath);
  const isStatic = Boolean(options.isStatic);
  const leadStatus = options.leadStatus === 'ok' || options.leadStatus === 'error' ? options.leadStatus : null;

  const c = content && typeof content === 'object' ? content : {};
  const L = LANG_CODES.includes(lang) ? lang : PRIMARY_LANG;
  const otherLangs = LANG_CODES.filter((code) => code !== L);

  const settings = c.settings || {};
  const contacts = c.contacts || {};
  const theme = c.theme || {};
  const seo = c.seo || {};
  const ui = c.ui || {};
  const allSections = c.sections || {};
  const order = Array.isArray(c.order) ? c.order : [];

  /** Локалізований текст: поточна мова → інша мова → ''. */
  const t = (v) => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v !== 'object') return '';
    if (typeof v[L] === 'string' && v[L]) return v[L];
    for (const code of otherLangs) if (typeof v[code] === 'string' && v[code]) return v[code];
    return '';
  };

  /** Абзаци (розділені порожнім рядком). */
  const paras = (v) => t(v).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const u = (key) => t(ui[key]);

  const asset = (p) => `${basePath}${p}`;

  const img = (p) => {
    if (typeof p !== 'string' || !p) return '';
    if (/^https:\/\//i.test(p)) return p;
    if (p.startsWith('/uploads/') || p.startsWith('/assets/')) return `${basePath}${p}`;
    return '';
  };

  const icons = loadIcons();
  const icon = (name, cls = 'icon') => {
    if (!icons) return emptySvg(cls);
    try {
      return icons.iconSvg(name, cls);
    } catch {
      return emptySvg(cls);
    }
  };

  const isEnabled = (type) => Boolean(allSections[type] && allSections[type].enabled);
  const sections = order.filter(isEnabled).map((type) => ({ type, data: allSections[type] }));
  const section = (type) => (isEnabled(type) ? allSections[type] : null);

  const nav = sections
    .filter((s) => s.type !== 'hero' && s.data.showInNav && t(s.data.navLabel))
    .map((s) => ({ id: s.type, label: t(s.data.navLabel) }));

  const links = buildLinks(contacts);
  const messengers = MESSENGERS
    .filter(([key]) => links[key])
    .map(([key, uiKey]) => ({ key, label: u(uiKey), href: links[key].href, display: links[key].display }));

  const brand = {
    name: settings.brandName || '',
    tagline: settings.brandTagline || '',
    logo: img(settings.logo),
  };

  const themePreset = theme.preset || 'sand';
  const themeStyle = themePreset === 'custom' && COLOR_RE.test(theme.accent || '') && COLOR_RE.test(theme.background || '')
    ? `--accent:${theme.accent.toLowerCase()};--bg:${theme.background.toLowerCase()};`
    : '';

  // SEO: абсолютні адреси (Google вимагає їх для hreflang, а Telegram/Viber/Facebook — для og:image).
  // «Адреса сайту» з SEO (вона вже містить можливу підпапку); якщо її не вказано — адреса, з якої
  // відкрито сторінку (сервер), і лише в статичному експорті без адреси — відносні шляхи.
  const siteUrl = typeof seo.siteUrl === 'string' && /^https?:\/\/[^\s]+$/i.test(seo.siteUrl) ? seo.siteUrl.replace(/\/+$/, '') : '';
  const origin = typeof options.origin === 'string' && ORIGIN_RE.test(options.origin) ? options.origin.toLowerCase() : '';
  const absoluteBase = siteUrl || (origin ? `${origin}${basePath}` : '');
  const pageHref = (code) => `${basePath}${langPath(code)}`;
  const absolute = (p) => (absoluteBase ? `${absoluteBase}${p}` : `${basePath}${p}`);
  const hero = allSections.hero || {};
  const ogSource = seo.ogImage || hero.image || '';
  let ogImage = '';
  if (/^https:\/\//i.test(ogSource)) ogImage = ogSource;
  else if (img(ogSource)) ogImage = absoluteBase ? `${absoluteBase}${ogSource}` : img(ogSource);

  const fullBrand = [brand.name, brand.tagline].filter(Boolean).join(' ');
  const meta = {
    title: t(seo.title) || fullBrand,
    description: t(seo.description),
    ogImage,
    canonical: absoluteBase ? `${absoluteBase}${langPath(L)}` : '',
    alternates: [
      ...LANG_CODES.map((code) => ({ hreflang: code, href: absolute(langPath(code)) })),
      { hreflang: 'x-default', href: absolute(langPath(PRIMARY_LANG)) },
    ],
    siteName: fullBrand,
    locale: OG_LOCALES[L] || L,
    localeAlternates: otherLangs.map((code) => OG_LOCALES[code] || code),
  };

  const contact = section('contact');

  return {
    lang: L,
    htmlLang: L,
    langs: LANGUAGES.map((l) => ({ code: l.code, short: l.short, label: l.label, href: pageHref(l.code), active: l.code === L })),
    t,
    paras,
    u,
    asset,
    img,
    icon,
    settings,
    contacts,
    theme,
    seo,
    ui,
    brand,
    agency: settings.showAgency ? t(settings.agencyName) : '',
    sections,
    section,
    nav,
    links,
    messengers,
    themePreset,
    themeStyle,
    meta,
    isStatic,
    formEnabled: Boolean(contact && contact.formEnabled && !isStatic),
    leadStatus,
    year: new Date().getFullYear(),
    leadAction: `${basePath}/api/lead`,
    basePath,
    homeHref: pageHref(L),
    content: c,
  };
}

module.exports = { buildViewModel, buildLinks, dialable, viberNumber };

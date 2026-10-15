'use strict';

/**
 * Налаштування сервера: шляхи до папок і змінні середовища.
 *
 *   PORT            — порт (за замовчуванням 3000)
 *   HOST            — адреса (127.0.0.1; 0.0.0.0 — щоб відкрити сайт з телефона в тій самій Wi-Fi)
 *   DATA_DIR        — папка з даними (./data): content.json, uploads/, private/
 *   ADMIN_PASSWORD  — початковий пароль адмінки (лише під час першого запуску; інакше 'anna2026')
 *   BASE_PATH       — префікс шляхів для статичного експорту (наприклад /PortfolioAnna для GitHub Pages)
 */

const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ADMIN_PASSWORD = 'anna2026';

/** '/foo/' → '/foo', '' | '/' → '' */
function normalizeBasePath(value) {
  if (!value) return '';
  let v = String(value).trim().replace(/\\/g, '/');
  if (!v || v === '/') return '';
  if (!v.startsWith('/')) v = `/${v}`;
  return v.replace(/\/+$/, '');
}

function resolveDataDir(value, rootDir = ROOT_DIR) {
  // Явно задану папку рахуємо від поточної директорії (як звично для змінних середовища),
  // папку за замовчуванням — від кореня проєкту, щоб сервер можна було запускати звідусіль.
  return value ? path.resolve(process.cwd(), value) : path.join(rootDir, 'data');
}

/** Усі шляхи всередині папки даних. */
function dataPaths(dataDir) {
  const privateDir = path.join(dataDir, 'private');
  return {
    dataDir,
    contentFile: path.join(dataDir, 'content.json'),
    uploadsDir: path.join(dataDir, 'uploads'),
    privateDir,
    authFile: path.join(privateDir, 'auth.json'),
    settingsFile: path.join(privateDir, 'settings.json'),
    leadsFile: path.join(privateDir, 'leads.json'),
    backupsDir: path.join(privateDir, 'backups'),
  };
}

/** Шляхи до коду / шаблонів / статики проєкту. */
function projectPaths(rootDir = ROOT_DIR) {
  return {
    rootDir,
    viewsDir: path.join(rootDir, 'views'),
    publicDir: path.join(rootDir, 'public'),
    adminDir: path.join(rootDir, 'admin'),
  };
}

function parsePort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback;
}

function loadConfig(env = process.env) {
  return {
    rootDir: ROOT_DIR,
    port: parsePort(env.PORT, DEFAULT_PORT),
    host: env.HOST || DEFAULT_HOST,
    dataDir: resolveDataDir(env.DATA_DIR),
    adminPassword: env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
    adminPasswordFromEnv: Boolean(env.ADMIN_PASSWORD),
    basePath: normalizeBasePath(env.BASE_PATH),
    telegramApiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',
    production: env.NODE_ENV === 'production',
  };
}

module.exports = {
  ROOT_DIR,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_ADMIN_PASSWORD,
  loadConfig,
  dataPaths,
  projectPaths,
  normalizeBasePath,
  resolveDataDir,
};

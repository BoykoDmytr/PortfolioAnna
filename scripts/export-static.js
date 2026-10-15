#!/usr/bin/env node
'use strict';

/**
 * Статична копія сайту для безкоштовного хостингу (GitHub Pages, Netlify, Cloudflare Pages).
 *
 *   npm run export
 *       → dist/index.html, dist/en/index.html, dist/assets/…, dist/uploads/…, dist/404.html, dist/.nojekyll
 *
 *   BASE_PATH=/PortfolioAnna npm run export
 *       — якщо сайт відкриватиметься з підпапки, напр. https://<ім'я>.github.io/PortfolioAnna/
 *
 *   OUT_DIR=…  — інша папка для результату;  DATA_DIR=…  — інша папка з даними.
 *
 * У статичній версії немає сервера, тому форма заявки вимкнена (formEnabled = false),
 * а відвідувачі зв'язуються через месенджери й телефон. Адмін-панель не експортується.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ejs = require('ejs');

const { ROOT_DIR, resolveDataDir, dataPaths, projectPaths, normalizeBasePath } = require('../src/config');
const { readJsonFile } = require('../src/content-store');
const { sanitizeContent } = require('../src/validate');
const { buildViewModel } = require('../src/view-model');
const { LANG_CODES } = require('../src/schema');

const MEDIA_EXT_RE = /\.(webp|png|jpe?g|gif|avif|svg)$/i;
const MARKER = '.nojekyll';

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Захист від випадкового видалення важливих папок через OUT_DIR. */
function prepareOutDir(outDir, { rootDir, dataDir, publicDir }) {
  const forbidden = [path.parse(outDir).root, os.homedir(), rootDir, dataDir];
  if (forbidden.includes(outDir) || isInside(rootDir, outDir) || isInside(dataDir, outDir)) {
    throw new Error(`Не можна експортувати в ${outDir}: оберіть окрему папку, наприклад dist.`);
  }
  for (const dir of [dataDir, publicDir, path.join(rootDir, 'admin'), path.join(rootDir, 'views'), path.join(rootDir, 'src')]) {
    if (isInside(outDir, dir)) throw new Error(`Не можна експортувати всередину ${dir}. Оберіть окрему папку, наприклад dist.`);
  }
  if (fs.existsSync(outDir)) {
    const entries = fs.readdirSync(outDir);
    if (entries.length && !entries.includes(MARKER)) {
      throw new Error(`Папка ${outDir} не порожня і не схожа на попередній експорт. Оберіть порожню папку або видаліть її вміст.`);
    }
    // Прибираємо лише те, що створює експорт; інше (CNAME, .git тощо) лишається.
    for (const name of generatedEntries()) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
}

function generatedEntries() {
  return ['index.html', '404.html', MARKER, 'assets', 'uploads', ...LANG_CODES.map(langDir).filter(Boolean)];
}

function renderFile(file, locals) {
  return new Promise((resolve, reject) => {
    ejs.renderFile(file, locals, { cache: false }, (err, html) => (err ? reject(err) : resolve(html)));
  });
}

function langDir(code) {
  return code === LANG_CODES[0] ? '' : code;
}

function copyDir(from, to, filter) {
  if (!fs.existsSync(from)) return 0;
  let count = 0;
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) return true;
      if (path.basename(src).startsWith('.')) return false;
      if (filter && !filter(src)) return false;
      count += 1;
      return true;
    },
  });
  return count;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {string} [opts.outDir]
 * @param {string} [opts.basePath]
 * @param {string} [opts.rootDir]
 * @returns {Promise<{ outDir, pages: string[], assets: number, uploads: number, warnings: number }>}
 */
async function exportStatic(opts = {}) {
  const logger = opts.logger || console;
  const rootDir = path.resolve(opts.rootDir || ROOT_DIR);
  const dataDir = path.resolve(opts.dataDir || resolveDataDir(process.env.DATA_DIR, rootDir));
  const outDir = path.resolve(opts.outDir || process.env.OUT_DIR || path.join(rootDir, 'dist'));
  const basePath = normalizeBasePath(opts.basePath !== undefined ? opts.basePath : process.env.BASE_PATH);
  const { viewsDir, publicDir } = projectPaths(rootDir);
  const { contentFile, uploadsDir } = dataPaths(dataDir);

  const indexTemplate = path.join(viewsDir, 'index.ejs');
  if (!fs.existsSync(indexTemplate)) throw new Error(`Не знайдено шаблон сторінки: ${indexTemplate}`);

  const loaded = readJsonFile(contentFile);
  if (!loaded.exists) throw new Error(`Не знайдено файл контенту: ${contentFile}`);
  if (loaded.error) throw new Error(`Не вдалося прочитати ${contentFile}: ${loaded.error.message}`);
  const { content, errors } = sanitizeContent(loaded.value);
  if (errors.length) {
    logger.warn(`Увага: у content.json є помилки (${errors.length}), їх виправлено автоматично:`);
    for (const e of errors.slice(0, 10)) logger.warn(`  • ${e.path || '(корінь)'}: ${e.message}`);
  }

  prepareOutDir(outDir, { rootDir, dataDir, publicDir });

  const pages = [];
  for (const code of LANG_CODES) {
    const vm = buildViewModel(content, code, { basePath, isStatic: true });
    const html = await renderFile(indexTemplate, vm);
    const rel = path.join(langDir(code), 'index.html');
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), html);
    pages.push(rel);
  }

  const notFoundTemplate = path.join(viewsDir, '404.ejs');
  if (fs.existsSync(notFoundTemplate)) {
    const vm = { ...buildViewModel(content, LANG_CODES[0], { basePath, isStatic: true }), status: 404 };
    fs.writeFileSync(path.join(outDir, '404.html'), await renderFile(notFoundTemplate, vm));
    pages.push('404.html');
  }

  const assets = copyDir(publicDir, path.join(outDir, 'assets'));
  const uploads = copyDir(uploadsDir, path.join(outDir, 'uploads'), (src) => MEDIA_EXT_RE.test(src));
  fs.writeFileSync(path.join(outDir, MARKER), '');

  const siteUrl = content.seo && typeof content.seo.siteUrl === 'string' ? content.seo.siteUrl.trim() : '';
  return { outDir, pages, assets, uploads, warnings: errors.length, basePath, siteUrl };
}

async function main() {
  try {
    const result = await exportStatic();
    const lines = [
      '',
      '  Готово! Статичну копію сайту збережено в папці:',
      `    ${result.outDir}`,
      '',
      `  Сторінки: ${result.pages.join(', ')}`,
      `  Файлів дизайну: ${result.assets}, фото: ${result.uploads}`,
      '',
      '  У статичній версії форма заявки вимкнена — відвідувачі пишуть у месенджери або телефонують.',
      '  Цю папку можна безкоштовно опублікувати на GitHub Pages, Netlify або Cloudflare Pages.',
    ];
    if (!result.siteUrl) {
      lines.push(
        '',
        '  !!! УВАГА: не вказано «Адресу сайту» (адмінка → Налаштування → SEO та соцмережі).',
        '  !!! Без неї посилання на сайт у Telegram, Viber і Facebook показуються без картинки,',
        '  !!! а Google не бачить зв’язку між українською та англійською версіями.',
        '  !!! Після публікації впишіть адресу (наприклад https://annafrolova.travel) і зробіть експорт ще раз.',
      );
    }
    if (!result.basePath) {
      lines.push(
        '',
        '  Якщо сайт відкриватиметься з підпапки (наприклад https://<ім’я>.github.io/PortfolioAnna/),',
        '  запустіть експорт так:  BASE_PATH=/PortfolioAnna npm run export',
      );
    } else {
      lines.push('', `  Префікс шляхів (BASE_PATH): ${result.basePath}`);
    }
    console.log(`${lines.join('\n')}\n`);
  } catch (err) {
    console.error(`\nЕкспорт не вдався: ${err.message}\n`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { exportStatic };

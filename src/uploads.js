'use strict';

/**
 * Завантаження зображень і медіатека (data/uploads).
 *
 * - multer (у пам'яті, ≤ 15 МБ) приймає файл у полі `file`;
 * - справжній формат визначається за вмістом файлу (sharp metadata), а не за MIME-типом від браузера;
 *   SVG та інші формати відхиляються (415);
 * - sharp: поворот за EXIF, зменшення, конвертація у WebP; метадані (EXIF, GPS) не зберігаються;
 * - назва: <ascii-slug-оригіналу>-<6 hex>.webp.
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { writeFileAtomic } = require('./content-store');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif']);
const MEDIA_EXT_RE = /\.(webp|png|jpe?g|gif|avif|svg)$/i;
const MEDIA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PURPOSES = {
  photo: { maxSize: 2400, webp: { quality: 80 } },
  logo: { maxSize: 800, webp: { quality: 90, alphaQuality: 100 } },
};

function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (details) err.details = details;
  return err;
}

/* ------------------------------------------------------------------ */
/* Назви файлів                                                       */
/* ------------------------------------------------------------------ */

// Транслітерація за офіційною українською системою (спрощено) + російські літери
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i',
  ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', '’': '', "'": '', 'ʼ': '',
  ё: 'e', ы: 'y', э: 'e', ъ: '',
};

function slugify(originalName) {
  const base = path.basename(String(originalName || '')).replace(/\.[^.]*$/, '');
  const ascii = base
    .toLowerCase()
    .split('')
    .map((ch) => (Object.prototype.hasOwnProperty.call(TRANSLIT, ch) ? TRANSLIT[ch] : ch))
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return ascii || 'image';
}

function isMediaName(name) {
  return typeof name === 'string' && name.length <= 200 && MEDIA_NAME_RE.test(name);
}

/* ------------------------------------------------------------------ */
/* multer                                                             */
/* ------------------------------------------------------------------ */

const multerSingle = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8', // браузери надсилають назви файлів (зокрема кирилицю) в UTF-8
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 1024 },
}).single('file');

/** Middleware: розбирає multipart і перетворює помилки multer на зрозумілі повідомлення. */
function uploadMiddleware(req, res, next) {
  multerSingle(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(httpError(413, 'Файл завеликий: максимум 15 МБ.'));
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        return next(httpError(400, 'Надсилайте один файл у полі «file».'));
      }
      return next(httpError(400, 'Не вдалося прочитати файл. Спробуйте ще раз.'));
    }
    return next(httpError(400, 'Не вдалося прочитати файл. Спробуйте ще раз.'));
  });
}

/* ------------------------------------------------------------------ */
/* MediaStore                                                         */
/* ------------------------------------------------------------------ */

class MediaStore {
  constructor({ uploadsDir, logger = console }) {
    this.uploadsDir = path.resolve(uploadsDir);
    this.logger = logger;
    this.dimensionCache = new Map();
  }

  /** Визначає справжній формат файлу. Кидає 415 для всього, що не є дозволеним растровим зображенням. */
  async detectFormat(buffer) {
    let meta;
    try {
      meta = await sharp(buffer).metadata();
    } catch {
      throw httpError(415, 'Це не схоже на зображення. Завантажте фото у форматі JPG, PNG, WebP, AVIF або GIF.');
    }
    let format = meta.format;
    if (format === 'heif') {
      if (meta.compression === 'av1') format = 'avif';
      else throw httpError(415, 'Формат HEIC (фото з iPhone) не підтримується. Збережіть фото як JPG і завантажте ще раз.');
    }
    if (format === 'svg') {
      throw httpError(415, 'SVG-файли не підтримуються з міркувань безпеки. Завантажте PNG або WebP.');
    }
    if (!ALLOWED_FORMATS.has(format)) {
      throw httpError(415, 'Непідтримуваний формат. Завантажте фото у форматі JPG, PNG, WebP, AVIF або GIF.');
    }
    return { format, meta };
  }

  async uniqueName(slug) {
    for (let i = 0; i < 20; i += 1) {
      const name = `${slug}-${crypto.randomBytes(3).toString('hex')}.webp`;
      try {
        await fsp.access(path.join(this.uploadsDir, name));
      } catch {
        return name;
      }
    }
    throw new Error('Не вдалося підібрати унікальну назву файлу');
  }

  /**
   * Обробляє і зберігає завантажений файл.
   * → { url, name, width, height, size }
   */
  async saveUpload({ buffer, originalName, purpose = 'photo' }) {
    const preset = PURPOSES[purpose];
    if (!preset) throw httpError(400, 'Невідоме призначення файлу.');
    if (!buffer || !buffer.length) throw httpError(400, 'Файл порожній.');

    await this.detectFormat(buffer);

    let output;
    try {
      output = await sharp(buffer, { failOn: 'error' })
        .rotate()
        .resize({ width: preset.maxSize, height: preset.maxSize, fit: 'inside', withoutEnlargement: true })
        .webp(preset.webp)
        .toBuffer({ resolveWithObject: true });
    } catch (err) {
      this.logger.warn(`Не вдалося обробити зображення: ${err.message}`);
      throw httpError(415, 'Не вдалося обробити зображення — можливо, файл пошкоджений. Спробуйте інше фото.');
    }

    await fsp.mkdir(this.uploadsDir, { recursive: true });
    const name = await this.uniqueName(slugify(originalName));
    await writeFileAtomic(path.join(this.uploadsDir, name), output.data);

    return {
      url: `/uploads/${name}`,
      name,
      width: output.info.width,
      height: output.info.height,
      size: output.data.length,
    };
  }

  async dimensions(file, stat) {
    const key = `${file}|${stat.size}|${stat.mtimeMs}`;
    if (this.dimensionCache.has(key)) return this.dimensionCache.get(key);
    let dims = { width: null, height: null };
    try {
      const meta = await sharp(file).metadata();
      dims = { width: meta.width || null, height: meta.height || null };
    } catch {
      // не зображення або пошкоджений файл — розміри невідомі
    }
    if (this.dimensionCache.size > 2000) this.dimensionCache.clear();
    this.dimensionCache.set(key, dims);
    return dims;
  }

  /**
   * Усі зображення з папки uploads, найновіші першими.
   * @param {Set<string>} usedRefs шляхи, які використовуються в контенті ('/uploads/x.webp')
   */
  async list(usedRefs = new Set()) {
    let names;
    try {
      names = await fsp.readdir(this.uploadsDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const items = [];
    for (const name of names) {
      if (!isMediaName(name) || !MEDIA_EXT_RE.test(name)) continue;
      const file = path.join(this.uploadsDir, name);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const { width, height } = await this.dimensions(file, stat);
      const url = `/uploads/${name}`;
      items.push({
        name,
        url,
        size: stat.size,
        width,
        height,
        mtime: stat.mtime.toISOString(),
        used: usedRefs.has(url),
      });
    }
    items.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.name.localeCompare(b.name)));
    return items;
  }

  /**
   * Видаляє файл з медіатеки.
   * Кидає 400 (недопустима назва), 404 (немає файлу), 409 (використовується і не force).
   */
  async remove(name, { force = false, usedRefs = new Set() } = {}) {
    if (!isMediaName(name)) throw httpError(400, 'Недопустима назва файлу.');
    const file = path.resolve(this.uploadsDir, name);
    if (path.dirname(file) !== this.uploadsDir) throw httpError(400, 'Недопустима назва файлу.');
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw httpError(404, 'Файл не знайдено — можливо, його вже видалили.');
    }
    if (!stat.isFile()) throw httpError(404, 'Файл не знайдено — можливо, його вже видалили.');
    if (!force && usedRefs.has(`/uploads/${name}`)) {
      throw httpError(409, 'Це фото використовується на сайті. Спершу приберіть його зі сторінки або підтвердьте видалення.');
    }
    await fsp.unlink(file);
  }
}

module.exports = {
  MediaStore,
  uploadMiddleware,
  slugify,
  isMediaName,
  MAX_UPLOAD_BYTES,
  PURPOSES,
};

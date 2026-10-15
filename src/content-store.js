'use strict';

/**
 * Сховище контенту сайту (data/content.json) + резервні копії.
 *
 * - Контент тримається в пам'яті (кеш) і віддається сторінкам без читання з диска.
 * - Збереження: sanitizeContent → резервна копія попередньої версії → атомарний запис (tmp + rename).
 * - Резервні копії: data/private/backups/content-YYYY-MM-DD_HH-MM-SS.json (зберігаються 30 найновіших).
 *
 * Тут же — спільні помічники для JSON-файлів (readJsonFile, writeJsonAtomic), якими користуються
 * й інші модулі сервера (auth, leads, notify).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { sanitizeContent } = require('./validate');
const { schema } = require('./schema');

const MAX_BACKUPS = 30;
const BACKUP_RE = /^content-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d{1,3}))?\.json$/;
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']); // Windows: файл тимчасово зайнятий антивірусом тощо

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* ------------------------------------------------------------------ */
/* Атомарний запис файлів                                             */
/* ------------------------------------------------------------------ */

const writeQueues = new Map();

function tmpNameFor(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (attempt >= 4 || !RETRYABLE_RENAME.has(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

async function writeFileNow(file, data, mode) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpNameFor(file);
  try {
    const handle = await fsp.open(tmp, 'w', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Атомарно записує файл: спершу в тимчасовий файл поруч, потім rename.
 * Записи в один і той самий файл виконуються строго по черзі.
 */
function writeFileAtomic(file, data, { mode = 0o644 } = {}) {
  const key = path.resolve(file);
  const previous = writeQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => writeFileNow(key, data, mode));
  writeQueues.set(key, run);
  const cleanup = () => {
    if (writeQueues.get(key) === run) writeQueues.delete(key);
  };
  run.then(cleanup, cleanup);
  return run;
}

function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonAtomic(file, value, options) {
  return writeFileAtomic(file, toJson(value), options);
}

/** Синхронний варіант — лише для старту сервера (до того, як почали приходити запити). */
function writeJsonAtomicSync(file, value, { mode = 0o644 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpNameFor(file);
  try {
    fs.writeFileSync(tmp, toJson(value), { mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Читає JSON-файл синхронно.
 * → { exists: false } | { exists: true, value } | { exists: true, error }
 */
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false };
    return { exists: true, error: err };
  }
  try {
    return { exists: true, value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (err) {
    return { exists: true, error: err };
  }
}

/** Відкладає зіпсований файл убік (name.broken-<час>.json), щоб не втратити його вміст. */
function moveAside(file, logger) {
  const target = `${file.replace(/\.json$/, '')}.broken-${Date.now()}.json`;
  try {
    fs.renameSync(file, target);
    logger.warn(`  Пошкоджений файл збережено як ${target}`);
  } catch (err) {
    logger.warn(`  Не вдалося перейменувати пошкоджений файл ${file}: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Резервні копії                                                     */
/* ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

function backupStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function parseBackupName(name) {
  const m = typeof name === 'string' ? BACKUP_RE.exec(name) : null;
  if (!m) return null;
  const [, y, mo, d, h, mi, s, seq] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (Number.isNaN(date.getTime())) return null;
  return { stamp: `${y}${mo}${d}${h}${mi}${s}`, seq: seq ? Number(seq) : 1, date };
}

function isBackupName(name) {
  return parseBackupName(name) !== null;
}

/** Найновіші першими. */
function compareBackupsDesc(a, b) {
  if (a.parsed.stamp !== b.parsed.stamp) return a.parsed.stamp < b.parsed.stamp ? 1 : -1;
  return b.parsed.seq - a.parsed.seq;
}

/* ------------------------------------------------------------------ */
/* Частини контенту (для підпису «що змінилося» біля резервних копій)   */
/* ------------------------------------------------------------------ */

/** 'settings', 'contacts', …, 'order', 'sections.hero', … — ті самі ключі, що й у адмінці (unitLabel). */
function contentUnits() {
  return [
    ...schema.groups.map((g) => g.key),
    'order',
    ...schema.sections.map((def) => `sections.${def.type}`),
  ];
}

function unitValue(content, key) {
  if (!isPlainObject(content)) return undefined;
  if (key.startsWith('sections.')) return isPlainObject(content.sections) ? content.sections[key.slice(9)] : undefined;
  return content[key];
}

/** Частини, що відрізняються між двома версіями контенту. */
function changedUnits(before, after) {
  return contentUnits().filter((key) => JSON.stringify(unitValue(before, key)) !== JSON.stringify(unitValue(after, key)));
}

async function readJsonAsync(file) {
  try {
    const value = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* ContentStore                                                       */
/* ------------------------------------------------------------------ */

class ContentStore {
  /**
   * @param {object} opts
   * @param {string} opts.contentFile  шлях до content.json
   * @param {string} opts.backupsDir   папка резервних копій
   * @param {object} [opts.logger]
   */
  constructor({ contentFile, backupsDir, logger = console }) {
    this.contentFile = contentFile;
    this.backupsDir = backupsDir;
    this.logger = logger;
    this.content = null;
    this.saving = Promise.resolve();
    this.revisionCache = { content: null, value: '' };
  }

  /** Короткий відбиток поточного вмісту (змінюється з кожним збереженням, що щось змінило). */
  get revision() {
    const content = this.get();
    if (this.revisionCache.content !== content) {
      const value = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 20);
      this.revisionCache = { content, value };
    }
    return this.revisionCache.value;
  }

  /** Завантажує content.json під час старту. Ніколи не падає через погані поля. */
  load() {
    const { logger } = this;
    const result = readJsonFile(this.contentFile);

    if (!result.exists) {
      this.content = sanitizeContent({}).content;
      writeJsonAtomicSync(this.contentFile, this.content);
      logger.warn(`Файл контенту не знайдено — створено новий із порожнім контентом: ${this.contentFile}`);
      return this.content;
    }

    if (result.error) {
      // Файл не перезаписуємо, а ще й зберігаємо його копію: наступне збереження в адмінці
      // замінить content.json, але пошкоджений оригінал лишиться поруч для ручного відновлення.
      this.content = sanitizeContent({}).content;
      logger.error(`Не вдалося прочитати ${this.contentFile}: ${result.error.message}`);
      const copy = `${this.contentFile.replace(/\.json$/, '')}.broken-${Date.now()}.json`;
      try {
        fs.copyFileSync(this.contentFile, copy);
        logger.error(`Копію пошкодженого файлу збережено: ${copy}`);
      } catch (err) {
        logger.warn(`Не вдалося зберегти копію пошкодженого файлу: ${err.message}`);
      }
      logger.error('Сайт тимчасово показує порожній контент. Відновіть файл з резервної копії в адмінці (розділ «Резервні копії»).');
      return this.content;
    }

    const { content, errors } = sanitizeContent(result.value);
    if (errors.length) {
      logger.warn(`У content.json знайдено помилок: ${errors.length}. Їх виправлено автоматично (лише в пам'яті, файл не змінено):`);
      for (const e of errors.slice(0, 20)) logger.warn(`  • ${e.path || '(корінь)'}: ${e.message}`);
      if (errors.length > 20) logger.warn(`  … та ще ${errors.length - 20}`);
    }
    this.content = content;
    return content;
  }

  get() {
    if (!this.content) this.load();
    return this.content;
  }

  /**
   * Перевіряє і зберігає новий контент.
   * expectedRevision — якщо задано і вміст тим часом змінився (інший пристрій), нічого не зберігається.
   * → { content } | { errors: [{ path, message }] } | { conflict: true }
   */
  save(input, { expectedRevision = '' } = {}) {
    const run = this.saving.catch(() => {}).then(() => this.saveNow(input, expectedRevision));
    this.saving = run;
    return run;
  }

  async saveNow(input, expectedRevision = '') {
    if (expectedRevision && expectedRevision !== this.revision) return { conflict: true };
    const { content, errors } = sanitizeContent(input);
    if (errors.length) return { errors };

    const current = this.get();
    const unchanged = JSON.stringify(current) === JSON.stringify(content);
    if (!unchanged) {
      // Якщо копію зробити не вдалося — не зберігаємо, щоб не втратити попередню версію.
      await this.createBackup(current);
    }
    await writeJsonAtomic(this.contentFile, content);
    this.content = content;
    if (!unchanged) {
      await this.pruneBackups().catch((err) => this.logger.warn(`Не вдалося прибрати старі резервні копії: ${err.message}`));
    }
    return { content };
  }

  async createBackup(content, now = new Date()) {
    await fsp.mkdir(this.backupsDir, { recursive: true });
    const stamp = backupStamp(now);
    // Кілька збережень за одну секунду: content-<час>.json, content-<час>-2.json, …
    // Номер завжди більший за наявні — навіть якщо старіші копії цієї секунди вже прибрано.
    const sameSecond = (await this.readBackupEntries()).filter((e) => e.name.startsWith(`content-${stamp}`));
    const seq = sameSecond.length ? Math.max(...sameSecond.map((e) => e.parsed.seq)) + 1 : 1;
    const name = seq === 1 ? `content-${stamp}.json` : `content-${stamp}-${seq}.json`;
    await writeJsonAtomic(path.join(this.backupsDir, name), content, { mode: 0o600 });
    return name;
  }

  async readBackupEntries() {
    let names;
    try {
      names = await fsp.readdir(this.backupsDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return names
      .map((name) => ({ name, parsed: parseBackupName(name) }))
      .filter((e) => e.parsed)
      .sort(compareBackupsDesc);
  }

  async pruneBackups(keep = MAX_BACKUPS) {
    const entries = await this.readBackupEntries();
    for (const entry of entries.slice(keep)) {
      await fsp.rm(path.join(this.backupsDir, entry.name), { force: true });
    }
  }

  /**
   * → [{ name, createdAt, size, changes }] найновіші першими.
   * changes — частини сайту, які змінило збереження ПІСЛЯ цієї копії (порівняння з наступною
   * новішою версією, для найновішої — з поточним сайтом), щоб було видно, яку копію відновлювати.
   */
  async listBackups() {
    const entries = await this.readBackupEntries();
    const out = [];
    let newer = this.get();
    for (const entry of entries) {
      const file = path.join(this.backupsDir, entry.name);
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue; // файл щойно видалили — пропускаємо
      }
      if (!stat.isFile()) continue;
      const raw = await readJsonAsync(file);
      const data = raw ? sanitizeContent(raw).content : null;
      const item = { name: entry.name, createdAt: entry.parsed.date.toISOString(), size: stat.size };
      if (data && newer) item.changes = changedUnits(data, newer);
      out.push(item);
      newer = data;
    }
    return out;
  }

  /** Повертає шлях до резервної копії або null, якщо назва недопустима чи файлу немає. */
  backupPath(name) {
    if (!isBackupName(name)) return null;
    const dir = path.resolve(this.backupsDir);
    const file = path.resolve(dir, name);
    if (path.dirname(file) !== dir) return null;
    return fs.existsSync(file) ? file : null;
  }

  /**
   * Відновлює контент з резервної копії (поточна версія спершу теж потрапляє в копії).
   * → { content } | { errors } | { notFound: true } | { invalid: true }
   */
  async restoreBackup(name) {
    const file = this.backupPath(name);
    if (!file) return { notFound: true };
    const result = readJsonFile(file);
    if (!result.exists) return { notFound: true };
    if (result.error || !isPlainObject(result.value)) return { invalid: true };
    return this.save(result.value);
  }
}

module.exports = {
  ContentStore,
  changedUnits,
  MAX_BACKUPS,
  isBackupName,
  readJsonFile,
  writeFileAtomic,
  writeJsonAtomic,
  writeJsonAtomicSync,
  moveAside,
  isPlainObject,
};

'use strict';

/**
 * Сповіщення про нові заявки в Telegram (необов'язково, безкоштовно).
 *
 * Налаштування зберігаються в data/private/settings.json (НЕ в content.json — той файл публічний):
 *   { telegramEnabled, telegramChatId, telegramToken }
 * Токен бота ніколи не віддається назовні — лише ознака telegramTokenSet і маска.
 */

const { readJsonFile, writeJsonAtomic, isPlainObject } = require('./content-store');

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const REQUEST_TIMEOUT_MS = 10000;

const DEFAULTS = { telegramEnabled: false, telegramChatId: '', telegramToken: '' };

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 12) return '••••••';
  return `${token.slice(0, 4)}••••••${token.slice(-4)}`;
}

function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (details) err.details = details;
  return err;
}

function formatLead(lead) {
  const lines = [
    'Нова заявка з сайту ANNA FROLOVA TRAVEL',
    '',
    `Ім’я: ${lead.name}`,
    `Контакт: ${lead.contact}`,
  ];
  if (lead.destination) lines.push(`Куди: ${lead.destination}`);
  if (lead.dates) lines.push(`Дати: ${lead.dates}`);
  if (lead.travelers) lines.push(`Кількість людей: ${lead.travelers}`);
  if (lead.message) lines.push('', `Побажання: ${lead.message}`);
  lines.push('', `Мова сайту: ${lead.lang === 'en' ? 'English' : 'українська'}`);
  return lines.join('\n').slice(0, 4000);
}

class Notifier {
  /**
   * @param {object} opts
   * @param {string} opts.settingsFile  data/private/settings.json
   * @param {string} [opts.apiBase]     https://api.telegram.org (для тестів — локальний сервер)
   * @param {Function} [opts.fetch]
   */
  constructor({ settingsFile, apiBase = 'https://api.telegram.org', logger = console, fetch: fetchImpl }) {
    this.settingsFile = settingsFile;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.logger = logger;
    this.fetch = fetchImpl || globalThis.fetch;
    this.settings = null;
  }

  load() {
    if (this.settings) return this.settings;
    const result = readJsonFile(this.settingsFile);
    const raw = result.exists && !result.error && isPlainObject(result.value) ? result.value : {};
    if (result.error) this.logger.warn(`Не вдалося прочитати ${this.settingsFile}: ${result.error.message}`);
    this.settings = {
      ...raw,
      telegramEnabled: raw.telegramEnabled === true,
      telegramChatId: typeof raw.telegramChatId === 'string' ? raw.telegramChatId : DEFAULTS.telegramChatId,
      telegramToken: typeof raw.telegramToken === 'string' ? raw.telegramToken : DEFAULTS.telegramToken,
    };
    return this.settings;
  }

  /** Те, що бачить адмінка (без токена). */
  publicSettings() {
    const s = this.load();
    return {
      telegramEnabled: s.telegramEnabled,
      telegramChatId: s.telegramChatId,
      telegramTokenSet: Boolean(s.telegramToken),
      telegramTokenMasked: maskToken(s.telegramToken),
    };
  }

  /**
   * Оновлює налаштування. telegramToken: відсутній або '' — залишити як є, null — видалити.
   * Кидає 400 з details, якщо дані некоректні.
   */
  async update(body) {
    const src = isPlainObject(body) ? body : {};
    const current = this.load();
    const errors = [];
    const next = { ...current };

    if (src.telegramEnabled !== undefined) {
      if (typeof src.telegramEnabled !== 'boolean') errors.push({ field: 'telegramEnabled', message: 'Очікувалося так / ні' });
      else next.telegramEnabled = src.telegramEnabled;
    }

    if (src.telegramChatId !== undefined && src.telegramChatId !== null) {
      const chatId = String(src.telegramChatId).trim();
      if (chatId && !CHAT_ID_RE.test(chatId)) {
        errors.push({ field: 'telegramChatId', message: 'Chat ID — це число (наприклад 123456789 або -1001234567890)' });
      } else {
        next.telegramChatId = chatId;
      }
    } else if (src.telegramChatId === null) {
      next.telegramChatId = '';
    }

    if (src.telegramToken === null) {
      next.telegramToken = '';
    } else if (typeof src.telegramToken === 'string' && src.telegramToken.trim()) {
      const token = src.telegramToken.trim();
      if (!TOKEN_RE.test(token)) {
        errors.push({ field: 'telegramToken', message: 'Токен має вигляд 123456789:AA… — скопіюйте його повністю з повідомлення @BotFather' });
      } else {
        next.telegramToken = token;
      }
    } else if (src.telegramToken !== undefined && typeof src.telegramToken !== 'string') {
      errors.push({ field: 'telegramToken', message: 'Невірний токен' });
    }

    if (!errors.length && next.telegramEnabled) {
      if (!next.telegramToken) errors.push({ field: 'telegramToken', message: 'Щоб увімкнути сповіщення, вкажіть токен бота' });
      if (!next.telegramChatId) errors.push({ field: 'telegramChatId', message: 'Щоб увімкнути сповіщення, вкажіть Chat ID' });
    }

    if (errors.length) throw httpError(400, 'Перевірте налаштування сповіщень', errors);

    await writeJsonAtomic(this.settingsFile, next, { mode: 0o600 });
    this.settings = next;
    return this.publicSettings();
  }

  async sendMessage(token, chatId, text) {
    if (typeof this.fetch !== 'function') throw httpError(502, 'Ця версія Node.js не вміє надсилати запити. Оновіть Node.js до 20+.');
    let res;
    try {
      res = await this.fetch(`${this.apiBase}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw httpError(502, 'Не вдалося з’єднатися з Telegram. Перевірте інтернет і спробуйте ще раз.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // відповідь не JSON
    }
    if (!res.ok || !data || data.ok !== true) {
      const description = data && typeof data.description === 'string' ? data.description : `HTTP ${res.status}`;
      let hint = '';
      if (res.status === 401 || res.status === 404) hint = ' Перевірте токен бота.';
      else if (/chat not found/i.test(description)) hint = ' Перевірте Chat ID і чи написали ви боту /start.';
      else if (/blocked/i.test(description)) hint = ' Розблокуйте бота в Telegram.';
      throw httpError(502, `Telegram відповів помилкою: ${description}.${hint}`);
    }
    return true;
  }

  /** Тестове повідомлення. Можна передати ще не збережені telegramToken / telegramChatId. */
  async sendTest(overrides = {}) {
    const s = this.load();
    const src = isPlainObject(overrides) ? overrides : {};
    const token = typeof src.telegramToken === 'string' && src.telegramToken.trim() ? src.telegramToken.trim() : s.telegramToken;
    const chatId = typeof src.telegramChatId === 'string' && src.telegramChatId.trim() ? src.telegramChatId.trim() : s.telegramChatId;
    if (!token || !chatId) throw httpError(400, 'Спершу вкажіть токен бота і Chat ID.');
    if (!TOKEN_RE.test(token)) throw httpError(400, 'Токен бота має невірний формат.');
    if (!CHAT_ID_RE.test(chatId)) throw httpError(400, 'Chat ID має невірний формат.');
    await this.sendMessage(token, chatId, 'Тестове повідомлення з сайту ANNA FROLOVA TRAVEL. Сповіщення про нові заявки працюють!');
    return true;
  }

  /** Сповіщення про нову заявку. Ніколи не кидає помилок — лише записує їх у лог. */
  async notifyLead(lead) {
    try {
      const s = this.load();
      if (!s.telegramEnabled || !s.telegramToken || !s.telegramChatId) return false;
      await this.sendMessage(s.telegramToken, s.telegramChatId, formatLead(lead));
      return true;
    } catch (err) {
      this.logger.warn(`Не вдалося надіслати сповіщення в Telegram: ${err.message}`);
      return false;
    }
  }
}

module.exports = { Notifier, maskToken, formatLead };

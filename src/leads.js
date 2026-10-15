'use strict';

/**
 * Заявки з форми на сайті: перевірка полів і зберігання в data/private/leads.json
 * (найновіші першими, не більше 5000).
 */

const crypto = require('crypto');
const { normalizeText, charsAtLeast, charsAtMost } = require('./validate');
const { readJsonFile, writeJsonAtomic, moveAside, isPlainObject } = require('./content-store');

const MAX_LEADS = 5000;
const LEAD_STATUSES = ['new', 'in_progress', 'done'];
const LEAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NOTE = 1000;

const FIELDS = [
  { key: 'name', min: 2, max: 80, required: true },
  { key: 'contact', min: 3, max: 100, required: true },
  { key: 'destination', max: 120 },
  { key: 'dates', max: 80 },
  { key: 'travelers', max: 40 },
  { key: 'message', max: 1000, multiline: true },
];

const MESSAGES = {
  uk: {
    invalid: 'Перевірте, будь ласка, поля форми.',
    required: { name: 'Вкажіть, як до вас звертатися.', contact: 'Залиште телефон або Telegram, щоб я могла з вами зв’язатися.' },
    tooShort: {
      name: (min) => `Ім’я закоротке — ${charsAtLeast(min)}.`,
      contact: (min) => `Вкажіть повний номер телефону або нік у Telegram (${charsAtLeast(min)}).`,
      other: (min) => `Занадто коротко: ${charsAtLeast(min)}.`,
    },
    tooLong: (max) => `Задовгий текст — ${charsAtMost(max)}.`,
    type: 'Неправильне значення.',
  },
  en: {
    invalid: 'Please check the form fields.',
    required: { name: 'Please tell me your name.', contact: 'Please leave a phone number or Telegram so I can reach you.' },
    tooShort: {
      name: (min) => `Name is too short — at least ${min} characters.`,
      contact: () => 'Please enter a full phone number or Telegram username.',
      other: (min) => `Too short — at least ${min} characters.`,
    },
    tooLong: (max) => `Too long — ${max} characters at most.`,
    type: 'Invalid value.',
  },
};

function leadLang(body) {
  return isPlainObject(body) && body.lang === 'en' ? 'en' : 'uk';
}

/**
 * Перевіряє дані форми.
 * → { spam: true } якщо заповнене приховане поле `website` (бот);
 *   інакше { lead, errors: [{ field, message }] }
 */
function validateLead(body) {
  const src = isPlainObject(body) ? body : {};
  const lang = leadLang(src);
  const msg = MESSAGES[lang];

  const honeypot = src.website;
  if (honeypot !== undefined && honeypot !== null && String(honeypot).trim() !== '') return { spam: true, lang };

  const errors = [];
  const lead = {};
  for (const field of FIELDS) {
    const raw = src[field.key];
    let value = '';
    if (typeof raw === 'string' || typeof raw === 'number') {
      value = normalizeText(String(raw), Boolean(field.multiline));
    } else if (raw !== undefined && raw !== null) {
      errors.push({ field: field.key, message: msg.type });
      continue;
    }
    if (!value) {
      if (field.required) errors.push({ field: field.key, message: msg.required[field.key] });
    } else if (field.min && value.length < field.min) {
      errors.push({ field: field.key, message: (msg.tooShort[field.key] || msg.tooShort.other)(field.min) });
    } else if (value.length > field.max) {
      errors.push({ field: field.key, message: msg.tooLong(field.max) });
    }
    lead[field.key] = value;
  }
  lead.lang = lang;
  return { lead, errors, lang, message: msg.invalid };
}

/** Нотатка власниці до заявки → { value } | { error } */
function validateLeadNote(raw) {
  if (raw === null) return { value: '' };
  if (typeof raw !== 'string') return { error: 'Нотатка має бути текстом.' };
  const value = normalizeText(raw, true);
  if (value.length > MAX_NOTE) return { error: `Задовга нотатка: ${charsAtMost(MAX_NOTE)}.` };
  return { value };
}

/** Заявки, збережені до появи нотаток, отримують порожню нотатку. */
const withNote = (lead) => (typeof lead.note === 'string' ? lead : { ...lead, note: '' });

class LeadStore {
  constructor({ leadsFile, logger = console }) {
    this.leadsFile = leadsFile;
    this.logger = logger;
    this.leads = null;
  }

  load() {
    if (this.leads) return this.leads;
    const result = readJsonFile(this.leadsFile);
    if (!result.exists) {
      this.leads = [];
    } else if (result.error || !Array.isArray(result.value)) {
      this.logger.error(`Не вдалося прочитати ${this.leadsFile} — список заявок почнеться заново.`);
      moveAside(this.leadsFile, this.logger);
      this.leads = [];
    } else {
      this.leads = result.value.filter((l) => isPlainObject(l) && typeof l.id === 'string').map(withNote);
    }
    return this.leads;
  }

  persist() {
    return writeJsonAtomic(this.leadsFile, this.leads, { mode: 0o600 });
  }

  list() {
    return this.load();
  }

  async add(data) {
    const leads = this.load();
    const lead = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      name: data.name,
      contact: data.contact,
      destination: data.destination || '',
      dates: data.dates || '',
      travelers: data.travelers || '',
      message: data.message || '',
      lang: data.lang === 'en' ? 'en' : 'uk',
      status: 'new',
      note: '',
    };
    leads.unshift(lead);
    if (leads.length > MAX_LEADS) leads.length = MAX_LEADS;
    await this.persist();
    return lead;
  }

  find(id) {
    if (typeof id !== 'string' || !LEAD_ID_RE.test(id)) return null;
    return this.load().find((l) => l.id === id) || null;
  }

  /**
   * Змінює статус і/або нотатку: update(id, { status, note }).
   * → оновлена заявка або null, якщо не знайдено
   */
  async update(id, { status, note } = {}) {
    const lead = this.find(id);
    if (!lead) return null;
    if (status !== undefined) lead.status = status;
    if (note !== undefined) lead.note = note;
    lead.updatedAt = new Date().toISOString();
    await this.persist();
    return lead;
  }

  /** → оновлена заявка або null, якщо не знайдено */
  setStatus(id, status) {
    return this.update(id, { status });
  }

  /** → true, якщо видалено */
  async remove(id) {
    const lead = this.find(id);
    if (!lead) return false;
    const leads = this.load();
    leads.splice(leads.indexOf(lead), 1);
    await this.persist();
    return true;
  }
}

module.exports = { LeadStore, validateLead, validateLeadNote, leadLang, LEAD_STATUSES, MAX_LEADS, MAX_NOTE };

'use strict';

/**
 * Валідація та очищення контенту за схемою (src/schema.js).
 *
 * sanitizeContent(input) повертає { content, errors }:
 *   - content — повністю нормалізований об'єкт: невідомі ключі відкинуто, відсутні заповнено
 *     значеннями за замовчуванням, порядок ключів відповідає схемі;
 *   - errors  — [{ path, message }] для значень, які не пройшли перевірку
 *     (адмінка підсвічує поля за path, наприклад "contacts.phone" або "sections.reviews.items.2.text.en").
 */

const crypto = require('crypto');
const { schema, LANG_CODES, ICON_NAMES, SECTION_TYPES } = require('./schema');

const DEFAULT_MAX = { text: 300, textarea: 3000, string: 300 };
const IMAGE_RE = /^(\/(uploads|assets)\/[A-Za-z0-9][A-Za-z0-9._/-]*\.(webp|png|jpe?g|gif|avif|svg)|https:\/\/[^\s"'<>()]+)$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
// Керівні символи, крім табуляції та переносу рядка
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function normalizeText(value, multiline) {
  let v = String(value).replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
  if (multiline) {
    v = v.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  } else {
    v = v.replace(/\s*\n\s*/g, ' ').trim();
  }
  return v;
}

function normalizeHandle(value) {
  return value
    .replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me|instagram\.com)\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '')
    .trim();
}

function defaultFor(field) {
  switch (field.type) {
    case 'text':
    case 'textarea': {
      const out = {};
      for (const code of LANG_CODES) {
        out[code] = isPlainObject(field.default) && typeof field.default[code] === 'string' ? field.default[code] : '';
      }
      return out;
    }
    case 'string':
    case 'image':
      return typeof field.default === 'string' ? field.default : '';
    case 'number':
      return typeof field.default === 'number' ? field.default : (typeof field.min === 'number' ? field.min : 0);
    case 'boolean':
      return typeof field.default === 'boolean' ? field.default : false;
    case 'color':
      return field.default || '#000000';
    case 'select':
      return field.default !== undefined ? field.default : (field.options[0] && field.options[0].value);
    case 'icon':
      return field.default || 'star';
    case 'list':
      return [];
    default:
      return null;
  }
}

function sanitizeField(field, value, path, errors) {
  const max = field.max || DEFAULT_MAX[field.type];

  switch (field.type) {
    case 'text':
    case 'textarea': {
      const multiline = field.type === 'textarea';
      let src = {};
      if (isPlainObject(value)) src = value;
      else if (typeof value === 'string') src = { [LANG_CODES[0]]: value };
      else if (value !== undefined && value !== null) errors.push({ path, message: 'Очікувався текст' });
      const out = {};
      for (const code of LANG_CODES) {
        let v = typeof src[code] === 'string' ? normalizeText(src[code], multiline) : '';
        if (v.length > max) {
          errors.push({ path: `${path}.${code}`, message: `Задовгий текст: максимум ${max} символів` });
          v = v.slice(0, max);
        }
        out[code] = v;
      }
      return out;
    }

    case 'string': {
      if (value === undefined || value === null) return defaultFor(field);
      if (typeof value !== 'string' && typeof value !== 'number') {
        errors.push({ path, message: 'Очікувався текст' });
        return defaultFor(field);
      }
      let v = normalizeText(value, false);
      if (field.normalize === 'handle') v = normalizeHandle(v);
      if (v.length > max) {
        errors.push({ path, message: `Задовгий текст: максимум ${max} символів` });
        v = v.slice(0, max);
      }
      if (v && field.pattern && !new RegExp(field.pattern).test(v)) {
        errors.push({ path, message: 'Невірний формат' });
      }
      return v;
    }

    case 'number': {
      if (value === undefined || value === null || value === '') return defaultFor(field);
      let n = Number(value);
      if (!Number.isFinite(n)) {
        errors.push({ path, message: 'Очікувалося число' });
        return defaultFor(field);
      }
      n = Math.round(n);
      if (typeof field.min === 'number' && n < field.min) n = field.min;
      if (typeof field.max === 'number' && n > field.max) n = field.max;
      return n;
    }

    case 'boolean':
      return typeof value === 'boolean' ? value : defaultFor(field);

    case 'image': {
      if (value === undefined || value === null || value === '') return '';
      const v = typeof value === 'string' ? value.trim() : '';
      if (!v || !IMAGE_RE.test(v) || v.includes('..') || v.includes('//', v.startsWith('https://') ? 8 : 0)) {
        errors.push({ path, message: 'Невірний шлях до зображення' });
        return '';
      }
      return v;
    }

    case 'color': {
      if (typeof value === 'string' && COLOR_RE.test(value.trim())) return value.trim().toLowerCase();
      if (value !== undefined && value !== null && value !== '') errors.push({ path, message: 'Невірний колір' });
      return defaultFor(field);
    }

    case 'select': {
      if (field.options.some((o) => o.value === value)) return value;
      if (value !== undefined && value !== null && value !== '') errors.push({ path, message: 'Невідоме значення' });
      return defaultFor(field);
    }

    case 'icon': {
      if (ICON_NAMES.includes(value)) return value;
      if (value !== undefined && value !== null && value !== '') errors.push({ path, message: 'Невідома іконка' });
      return defaultFor(field);
    }

    case 'list': {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value)) {
        errors.push({ path, message: 'Очікувався список' });
        return [];
      }
      let items = value;
      if (field.max && items.length > field.max) {
        errors.push({ path, message: `Забагато елементів: максимум ${field.max}` });
        items = items.slice(0, field.max);
      }
      const seen = new Set();
      return items.map((raw, i) => {
        const src = isPlainObject(raw) ? raw : {};
        let id = typeof src.id === 'string' && ID_RE.test(src.id) && !seen.has(src.id) ? src.id : newId();
        while (seen.has(id)) id = newId();
        seen.add(id);
        return { id, ...sanitizeFields(field.item, src, `${path}.${i}`, errors) };
      });
    }

    default:
      return null;
  }
}

function sanitizeFields(fields, input, path, errors) {
  const src = isPlainObject(input) ? input : {};
  const out = {};
  for (const field of fields) {
    out[field.key] = sanitizeField(field, src[field.key], path ? `${path}.${field.key}` : field.key, errors);
  }
  return out;
}

function sanitizeOrder(input) {
  const order = [];
  if (Array.isArray(input)) {
    for (const t of input) {
      if (SECTION_TYPES.includes(t) && !order.includes(t)) order.push(t);
    }
  }
  for (const t of SECTION_TYPES) if (!order.includes(t)) order.push(t);
  // Закріплені секції (hero) завжди на початку
  const pinned = schema.sections.filter((s) => s.pinned).map((s) => s.type);
  return [...pinned, ...order.filter((t) => !pinned.includes(t))];
}

function sanitizeContent(input) {
  const errors = [];
  const src = isPlainObject(input) ? input : {};
  if (!isPlainObject(input)) errors.push({ path: '', message: 'Очікувався об’єкт контенту' });

  const content = { version: schema.version };
  for (const group of schema.groups) {
    content[group.key] = sanitizeFields(group.fields, src[group.key], group.key, errors);
  }
  content.order = sanitizeOrder(src.order);
  content.sections = {};
  const srcSections = isPlainObject(src.sections) ? src.sections : {};
  for (const def of schema.sections) {
    content.sections[def.type] = sanitizeFields(
      [...schema.sectionCommon, ...def.fields],
      srcSections[def.type],
      `sections.${def.type}`,
      errors,
    );
  }
  return { content, errors };
}

/** Усі шляхи зображень, які використовуються в контенті (для медіатеки). */
function collectImageRefs(content) {
  const refs = new Set();
  const walk = (fields, obj) => {
    if (!isPlainObject(obj)) return;
    for (const field of fields) {
      const v = obj[field.key];
      if (field.type === 'image' && typeof v === 'string' && v) refs.add(v);
      if (field.type === 'list' && Array.isArray(v)) v.forEach((item) => walk(field.item, item));
    }
  };
  for (const group of schema.groups) walk(group.fields, content[group.key]);
  for (const def of schema.sections) {
    walk([...schema.sectionCommon, ...def.fields], content.sections && content.sections[def.type]);
  }
  return refs;
}

module.exports = { sanitizeContent, collectImageRefs, normalizeText };

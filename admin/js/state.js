/**
 * Стан адмінки: схема, збережений контент, чернетка (те, що редагується), помилки, заявки.
 *
 * Чернетка — одна на весь сайт: Анна може змінити кілька розділів і зберегти все однією кнопкою.
 * Поля форм пишуть просто в об'єкти state.draft і викликають changed(path).
 */

import { clone, isObject, uid } from './dom.js';

export const state = {
  schema: null,
  icons: {},
  saved: null, // останній збережений контент (як на сервері)
  draft: null, // те, що редагується
  savedJson: '',
  dirty: false,
  saving: false,
  session: { mustChangePassword: false },
  leads: [],
  leadsLoaded: false,
  media: null, // кеш медіатеки (список з /media) — null, поки не завантажено
  errors: new Map(), // path → повідомлення сервера
  expanded: new Set(), // id розгорнутих елементів списків
};

/* ---------------- події ---------------- */

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (set) for (const fn of [...set]) fn(payload);
}

/* ---------------- чернетка ---------------- */

const DRAFT_KEY = 'af-admin-draft-v1';

export function setContent(content, { keepDraft = false } = {}) {
  state.saved = content;
  state.savedJson = JSON.stringify(content);
  if (!keepDraft) state.draft = clone(content);
  computeDirty();
}

let dirtyTimer = 0;

/** Викликається полями після кожної зміни. path — щоб прибрати підсвічену помилку цього поля. */
export function changed(path) {
  if (path) clearErrors(path);
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(computeDirty, 120);
  emit('change', path);
}

export function computeDirty() {
  clearTimeout(dirtyTimer);
  if (!state.draft) return false;
  const json = JSON.stringify(state.draft);
  const dirty = json !== state.savedJson;
  state.dirty = dirty;
  persistDraft(dirty ? json : null);
  emit('dirty', dirty);
  return dirty;
}

function persistDraft(json) {
  try {
    if (json) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ base: state.savedJson, draft: json }));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // сховище недоступне — не страшно, чернетка лишається в пам'яті
  }
}

/**
 * Незбережена чернетка з попереднього завантаження сторінки (sessionStorage).
 * Читати треба ДО setContent(): той одразу перезаписує сховище.
 * → { base, draft } або null
 */
export function readStoredDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    if (!stored || typeof stored.base !== 'string' || typeof stored.draft !== 'string') return null;
    const draft = JSON.parse(stored.draft);
    return isObject(draft) && isObject(draft.sections) ? { base: stored.base, draft } : null;
  } catch {
    return null;
  }
}

export function forgetStoredDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

/* ---------------- маршрути та «брудні» сторінки ---------------- */

/** Частина контенту, за яку відповідає сторінка адмінки (для позначок «є зміни» в меню). */
function pageSlice(content, route) {
  if (!content) return null;
  if (route.name === 'section') return content.sections && content.sections[route.param];
  if (route.name === 'group') return content[route.param];
  if (route.name === 'structure') {
    return { order: content.order, enabled: (content.order || []).map((t) => content.sections[t] && content.sections[t].enabled) };
  }
  return null;
}

export function isPageDirty(route) {
  if (!state.dirty) return false;
  return JSON.stringify(pageSlice(state.draft, route)) !== JSON.stringify(pageSlice(state.saved, route));
}

/** Шлях помилки (наприклад "sections.reviews.items.2.text.en") → сторінка, де це поле. */
export function routeForPath(path) {
  const parts = String(path || '').split('.');
  if (parts[0] === 'sections' && parts[1]) return { name: 'section', param: parts[1] };
  if (parts[0] === 'order') return { name: 'structure' };
  if (state.schema && state.schema.groups.some((g) => g.key === parts[0])) return { name: 'group', param: parts[0] };
  return null;
}

export function pageHasErrors(route) {
  for (const path of state.errors.keys()) {
    const r = routeForPath(path);
    if (r && r.name === route.name && r.param === route.param) return true;
  }
  return false;
}

/* ---------------- помилки валідації ---------------- */

export function setErrors(details) {
  state.errors = new Map();
  for (const d of details || []) {
    if (d && typeof d.path === 'string') state.errors.set(d.path, d.message || 'Перевірте це поле');
  }
  emit('errors');
}

/** Прибирає помилки поля та всіх вкладених полів. */
export function clearErrors(path) {
  let removed = false;
  for (const key of [...state.errors.keys()]) {
    if (key === path || key.startsWith(`${path}.`)) {
      state.errors.delete(key);
      removed = true;
    }
  }
  if (removed) emit('errors');
}

/** Розгортає елементи списків, у яких є помилки (щоб поле з помилкою було видно). */
export function expandForPath(path) {
  const parts = String(path).split('.');
  let node = state.draft;
  for (const part of parts) {
    if (node === undefined || node === null) break;
    node = Array.isArray(node) ? node[Number(part)] : node[part];
    if (isObject(node) && typeof node.id === 'string') state.expanded.add(node.id);
  }
}

/* ---------------- схема ---------------- */

export function sectionDef(type) {
  return state.schema.sections.find((s) => s.type === type) || null;
}

export function groupDef(key) {
  return state.schema.groups.find((g) => g.key === key) || null;
}

export const languages = () => (state.schema && state.schema.languages) || [
  { code: 'uk', label: 'Українська', short: 'UA' },
  { code: 'en', label: 'English', short: 'EN' },
];

/** Значення за замовчуванням — так само, як у src/validate.js. */
export function defaultValue(field) {
  switch (field.type) {
    case 'text':
    case 'textarea': {
      const out = {};
      for (const { code } of languages()) {
        out[code] = isObject(field.default) && typeof field.default[code] === 'string' ? field.default[code] : '';
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

export function newListItem(listField) {
  const item = { id: uid() };
  for (const f of listField.item) item[f.key] = defaultValue(f);
  return item;
}

/** Текст для заголовка картки елемента списку. */
export function textOf(value) {
  if (typeof value === 'string') return value;
  if (isObject(value)) {
    for (const { code } of languages()) if (value[code]) return value[code];
  }
  return '';
}

/* ---------------- зображення в контенті ---------------- */

function walkImages(fields, obj, fn) {
  if (!isObject(obj)) return;
  for (const field of fields) {
    if (field.type === 'image') fn(obj, field.key);
    if (field.type === 'list' && Array.isArray(obj[field.key])) obj[field.key].forEach((item) => walkImages(field.item, item, fn));
  }
}

function forEachImage(content, fn) {
  if (!content || !state.schema) return;
  for (const group of state.schema.groups) walkImages(group.fields, content[group.key], fn);
  for (const def of state.schema.sections) {
    walkImages([...state.schema.sectionCommon, ...def.fields], content.sections && content.sections[def.type], fn);
  }
}

export function imageRefs(content) {
  const refs = new Set();
  forEachImage(content, (obj, key) => {
    if (obj[key]) refs.add(obj[key]);
  });
  return refs;
}

/** Прибирає зображення з усіх полів чернетки → кількість змінених полів. */
export function removeImageFromDraft(url) {
  let count = 0;
  forEachImage(state.draft, (obj, key) => {
    if (obj[key] === url) {
      obj[key] = '';
      count += 1;
    }
  });
  return count;
}

export const newLeadsCount = () => state.leads.filter((l) => l.status === 'new').length;

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
  revision: '', // X-Content-Revision з сервера (якщо він його надсилає) — для захисту від затирання чужих змін
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

/**
 * Чернетка зберігається в localStorage (а не sessionStorage): так вона переживе закриття вкладки
 * чи вивантаження сторінки телефоном (iOS не показує попередження beforeunload).
 * Перевірка base при відновленні не дає затерти новіші зміни, збережені з іншого пристрою.
 */
const DRAFT_KEY = 'af-admin-draft-v2';
const LEGACY_DRAFT_KEY = 'af-admin-draft-v1'; // старі версії адмінки тримали чернетку в sessionStorage
const TAB_ID = uid();

/* --- оновлення чернетки «на місці» --- */

function syncValue(old, value) {
  if (isObject(old) && isObject(value)) return syncObject(old, value);
  if (Array.isArray(old) && Array.isArray(value)) return syncArray(old, value);
  return value;
}

function syncObject(target, source) {
  const entries = Object.keys(source).map((key) => [key, syncValue(target[key], source[key])]);
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of entries) target[key] = value; // порядок ключів — як у source
  return target;
}

function syncArray(target, source) {
  const byId = new Map();
  for (const item of target) if (isObject(item) && typeof item.id === 'string') byId.set(item.id, item);
  const next = source.map((value, i) => {
    if (isObject(value) && typeof value.id === 'string') {
      const old = byId.get(value.id);
      byId.delete(value.id);
      return old ? syncObject(old, value) : value;
    }
    return syncValue(target[i], value);
  });
  target.length = 0;
  target.push(...next);
  return target;
}

/**
 * Робить target глибоко рівним source, але зберігає ті самі об'єкти й масиви (елементи списків — за id).
 * Поля форм і незавершені дії (завантаження фото, «Повернути» після видалення) тримають посилання
 * на об'єкти чернетки — після збереження чи скасування вони мають і далі писати в справжню чернетку.
 */
export function syncInto(target, source) {
  return syncObject(target, source);
}

export function setContent(content, { keepDraft = false } = {}) {
  state.saved = content;
  state.savedJson = JSON.stringify(content);
  if (!keepDraft) state.draft = state.draft ? syncInto(state.draft, clone(content)) : clone(content);
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
  dirtyTimer = 0;
  if (!state.draft) return false;
  const json = JSON.stringify(state.draft);
  const dirty = json !== state.savedJson;
  state.dirty = dirty;
  persistDraft(dirty ? json : null);
  emit('dirty', dirty);
  return dirty;
}

/** Негайно записує чернетку в сховище (коли сторінку ховають або закривають). */
export function flushDraft() {
  if (dirtyTimer) computeDirty();
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function persistDraft(json) {
  const store = storage();
  if (!store) return;
  try {
    if (json) {
      store.setItem(DRAFT_KEY, JSON.stringify({ base: state.savedJson, draft: json, savedAt: new Date().toISOString(), tab: TAB_ID }));
    } else {
      // Чисту чернетку прибираємо лише свою: в іншій вкладці можуть бути незбережені зміни
      const raw = store.getItem(DRAFT_KEY);
      const stored = raw ? JSON.parse(raw) : null;
      if (!stored || stored.tab === TAB_ID || (stored.base === state.savedJson && stored.draft === state.savedJson)) store.removeItem(DRAFT_KEY);
    }
  } catch {
    // сховище недоступне або переповнене — не страшно, чернетка лишається в пам'яті
  }
}

function parseStored(raw) {
  if (!raw) return null;
  const stored = JSON.parse(raw);
  if (!stored || typeof stored.base !== 'string' || typeof stored.draft !== 'string') return null;
  const draft = JSON.parse(stored.draft);
  if (!isObject(draft) || !isObject(draft.sections)) return null;
  return { base: stored.base, draft, savedAt: typeof stored.savedAt === 'string' ? stored.savedAt : '' };
}

/**
 * Незбережена чернетка з попереднього разу (ця або інша вкладка, до перезавантаження чи закриття).
 * Читати треба ДО setContent(): той одразу перезаписує сховище.
 * → { base, draft, savedAt } або null
 */
export function readStoredDraft() {
  try {
    const store = storage();
    const found = parseStored(store && store.getItem(DRAFT_KEY));
    if (found) return found;
    return parseStored(window.sessionStorage.getItem(LEGACY_DRAFT_KEY));
  } catch {
    return null;
  }
}

export function forgetStoredDraft() {
  try {
    const store = storage();
    if (store) store.removeItem(DRAFT_KEY);
    window.sessionStorage.removeItem(LEGACY_DRAFT_KEY);
  } catch {
    // ignore
  }
}

/* ---------------- злиття змін (інший пристрій / вкладка) ---------------- */

/** Незалежні частини контенту: кожна група налаштувань, кожна секція і порядок секцій. */
function contentUnits(...contents) {
  const keys = new Set();
  for (const c of contents) {
    if (!isObject(c)) continue;
    for (const key of Object.keys(c)) if (key !== 'sections') keys.add(key);
    if (isObject(c.sections)) for (const type of Object.keys(c.sections)) keys.add(`sections.${type}`);
  }
  return [...keys];
}

const unitGet = (content, key) => {
  if (!isObject(content)) return undefined;
  if (key.startsWith('sections.')) return isObject(content.sections) ? content.sections[key.slice(9)] : undefined;
  return content[key];
};

function unitSet(content, key, value) {
  if (key.startsWith('sections.')) {
    if (!isObject(content.sections)) content.sections = {};
    if (value === undefined) delete content.sections[key.slice(9)];
    else content.sections[key.slice(9)] = clone(value);
  } else if (value === undefined) {
    delete content[key];
  } else {
    content[key] = clone(value);
  }
}

/**
 * Тристороннє злиття: base — версія, з якої почали редагувати; mine — чернетка; theirs — те, що зараз на сервері.
 * Частини, змінені лише в одному місці, беруться звідти; змінені і там, і тут (по-різному) — це конфлікти.
 * → { merged, conflicts: [unitKey] }  (у merged для конфліктів — версія theirs)
 */
export function mergeContent(base, mine, theirs) {
  const merged = clone(theirs);
  const conflicts = [];
  for (const key of contentUnits(base, mine, theirs)) {
    const b = JSON.stringify(unitGet(base, key));
    const m = JSON.stringify(unitGet(mine, key));
    const t = JSON.stringify(unitGet(theirs, key));
    if (m === b || m === t) continue;
    if (t === b) unitSet(merged, key, unitGet(mine, key));
    else conflicts.push(key);
  }
  // Порядок секцій має відповідати наявним секціям
  if (Array.isArray(merged.order) && isObject(merged.sections)) {
    merged.order = merged.order.filter((t) => merged.sections[t]);
    for (const t of Object.keys(merged.sections)) if (!merged.order.includes(t)) merged.order.push(t);
  }
  return { merged, conflicts };
}

/**
 * Приймає нову збережену версію з сервера (змінену деінде) і переносить на неї незбережені правки:
 * частини, які Анна не чіпала, беруться з сервера; змінені нею — лишаються її.
 * → ключі частин, змінених і тут, і на сервері (у чернетці лишилася її версія)
 */
export function rebaseDraft(newSaved, { keepMine = true } = {}) {
  const { merged, conflicts } = mergeContent(state.saved, state.draft, newSaved);
  if (keepMine) takeUnits(merged, state.draft, conflicts);
  state.saved = newSaved;
  state.savedJson = JSON.stringify(newSaved);
  if (state.draft) syncInto(state.draft, merged);
  else state.draft = merged;
  computeDirty();
  return conflicts;
}

/** Переносить частини keys з source у target (наприклад, «залишити мої версії» для конфліктів). */
export function takeUnits(target, source, keys) {
  for (const key of keys) unitSet(target, key, unitGet(source, key));
  return target;
}

/** Назва частини контенту для людини: «Контакти», «Головний екран», «Структура сторінки». */
export function unitLabel(key) {
  if (key === 'order') return 'Структура сторінки';
  if (key.startsWith('sections.')) {
    const def = state.schema && sectionDef(key.slice(9));
    return def ? def.title : key.slice(9);
  }
  const group = state.schema && groupDef(key);
  return group ? group.title : key;
}

/* ---------------- завантаження фото, що тривають ---------------- */

let uploadsPending = 0;
let uploadWaiters = [];

/** Реєструє завантаження фото: «Зберегти» дочекається його, щоб нове фото не загубилося. */
export function trackUpload(promise) {
  uploadsPending += 1;
  emit('uploads', uploadsPending);
  const done = () => {
    uploadsPending = Math.max(0, uploadsPending - 1);
    emit('uploads', uploadsPending);
    if (!uploadsPending) {
      const waiters = uploadWaiters;
      uploadWaiters = [];
      for (const fn of waiters) fn();
    }
  };
  promise.then(done, done);
  return promise;
}

export const uploadsInFlight = () => uploadsPending;

export function uploadsSettled() {
  return uploadsPending ? new Promise((resolve) => uploadWaiters.push(resolve)) : Promise.resolve();
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

/** Прибирає зображення з усіх полів контенту (за замовчуванням — чернетки) → кількість змінених полів. */
export function removeImageFromDraft(url, content = state.draft) {
  let count = 0;
  forEachImage(content, (obj, key) => {
    if (obj[key] === url) {
      obj[key] = '';
      count += 1;
    }
  });
  return count;
}

export const newLeadsCount = () => state.leads.filter((l) => l.status === 'new').length;

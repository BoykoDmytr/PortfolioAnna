/**
 * Поля форм, що будуються зі схеми (src/schema.js → GET /admin/api/schema).
 *
 * Кожне поле пише значення прямо в об'єкт чернетки (obj[field.key]) і викликає changed(path).
 * Обгортка поля має data-path — за ним підсвічуються помилки сервера (422 → details[].path).
 */

import { h, append, nextId, parseSvg, clone, describedBy, getByPath, isTouch } from './dom.js';
import { icon } from './icons.js';
import { assetUrl } from './api.js';
import { state, changed, emit, on, languages, newListItem, textOf, defaultValue } from './state.js';
import { toast, confirmDialog, openModal, switchControl, button, iconButton, actionSheet } from './ui.js';
import { pickImage, chooseFiles, uploadOne, bindDrop } from './media.js';

/* ---------------- довідники ---------------- */

const PATTERN_HINTS = {
  phone: 'Лише цифри, пробіли, дужки й дефіси, наприклад: +380 67 123 45 67',
  telegram: 'Лише латинські літери, цифри та «_», від 4 до 32 символів — без @ і без посилання',
  instagram: 'Лише латинські літери, цифри, крапка та «_» — без @',
  email: 'Схоже, в адресі помилка. Приклад: anna@example.com',
  url: 'Адреса має починатися з https://, наприклад https://annafrolova.travel',
  year: 'Рік — чотири цифри, наприклад 2024',
};

function patternKind(field) {
  if (!field.pattern) return '';
  const p = field.pattern;
  if (p.includes('@')) return 'email';
  if (p.startsWith('^https?')) return 'url';
  if (p.includes('[0-9]{4}')) return 'year';
  if (p.includes('()')) return 'phone';
  if (p.includes('{4,32}')) return 'telegram';
  if (p.includes('._')) return 'instagram';
  return 'other';
}

const ADD_LABELS = {
  'about.stats': 'Додати цифру',
  'services.items': 'Додати послугу',
  'destinations.items': 'Додати напрямок',
  'process.items': 'Додати крок',
  'gallery.items': 'Додати фото',
  'reviews.items': 'Додати відгук',
  'certificates.items': 'Додати сертифікат',
  'faq.items': 'Додати питання',
};

const COLOR_PRESETS = {
  accent: ['#8a6a4a', '#6e5139', '#a65e43', '#6b7250', '#3f6e7a', '#5c6788', '#8c5a6b', '#3a3029'],
  background: ['#f8f4ef', '#fffdfb', '#efe7dd', '#faf4ef', '#f6f5ee', '#f4f7f7', '#f5f3f7', '#ffffff'],
};

export const THEME_PRESETS = {
  sand: { accent: '#8a6a4a', bg: '#f8f4ef', sand: '#c9b8a6' },
  sea: { accent: '#3f6e7a', bg: '#f4f7f7', sand: '#a9c2c4' },
  olive: { accent: '#6b7250', bg: '#f6f5ee', sand: '#c3c4a8' },
  terracotta: { accent: '#a65e43', bg: '#faf4ef', sand: '#d9b8a5' },
};

/** Рекомендована довжина (Google обрізає довші заголовок і опис), якщо схема не задає field.recommended. */
const RECOMMENDED = {
  'seo.title': 60,
  'seo.description': 160,
};

/** Як читати мітки мов UA / EN для екранних читачів. */
const LANG_SPOKEN = { uk: 'українською', en: 'англійською' };

const IMAGE_SIZE_HINTS = {
  'settings.logo': 'logo',
  'seo.ogImage': 'wide',
  'sections.hero.image': 'wide',
};

/* ---------------- спільне ---------------- */

/** Повідомляє про зміну поля: чернетка «брудна», підсвітка помилки знімається. */
function notify(el, path) {
  changed(path);
  el.dispatchEvent(new CustomEvent('fieldchange', { bubbles: true, detail: { path } }));
}

function counterText(el, length, max, recommended) {
  if (!max) return;
  if (recommended) {
    // Лічильник видно завжди: так одразу зрозуміло, скільки ще можна написати
    el.textContent = `${length} / ${recommended}`;
    el.classList.toggle('is-near', length > recommended);
    el.classList.toggle('is-full', length >= max);
    return;
  }
  const near = length >= Math.floor(max * 0.7);
  el.textContent = near ? `${length} / ${max}` : '';
  el.classList.toggle('is-near', length >= Math.floor(max * 0.9));
  el.classList.toggle('is-full', length >= max);
}

export function autosize(textarea) {
  if (!textarea.isConnected) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

export function autosizeAll(root) {
  for (const ta of root.querySelectorAll('textarea.input')) autosize(ta);
}

function shell(field, path, { labelFor, extraClass, counter = false } = {}) {
  const labelId = nextId('lbl');
  const helpId = field.help ? nextId('help') : undefined;
  const errorId = nextId('err');
  const counterEl = counter ? h('span', { class: 'counter' }) : null;
  const labelChildren = [field.label, field.required && h('span', { class: 'field__req', title: 'Обов’язкове поле', text: ' *' })];
  const label = labelFor
    ? h('label', { class: 'field__label', id: labelId, for: labelFor }, labelChildren)
    : h('span', { class: 'field__label', id: labelId }, labelChildren);
  const root = h('div', { class: ['field', `field--${field.type}`, extraClass], dataset: { path } },
    h('div', { class: 'field__head' }, label, counterEl),
    field.help && h('p', { class: 'field__help', id: helpId, text: field.help }),
  );
  const error = h('p', { class: 'field__error', id: errorId, hidden: true });
  return { root, labelId, helpId, counterEl, error, errorId };
}

/* ---------------- текст UA / EN ---------------- */

function localizedField(field, obj, path) {
  const multiline = field.type === 'textarea';
  if (!obj[field.key] || typeof obj[field.key] !== 'object') obj[field.key] = defaultValue(field);
  const value = obj[field.key];
  const { root, labelId, helpId, error } = shell(field, path, { extraClass: 'field--i18n' });
  const langs = languages();
  const cols = [];
  const recommended = field.recommended || RECOMMENDED[path];

  for (const lang of langs) {
    const id = nextId();
    const tagId = nextId('tag');
    const spokenId = nextId('lang');
    const colPath = `${path}.${lang.code}`;
    const input = multiline
      ? h('textarea', { id, class: 'input', rows: 3, lang: lang.code, spellcheck: true })
      : h('input', { id, type: 'text', class: 'input', lang: lang.code, autocomplete: 'off' });
    input.value = typeof value[lang.code] === 'string' ? value[lang.code] : '';
    if (field.max) input.maxLength = field.max;
    // «Надзаголовок українською», а не «Надзаголовок U A»
    input.setAttribute('aria-labelledby', `${labelId} ${spokenId}`);
    if (helpId) input.setAttribute('aria-describedby', helpId);
    const counter = h('span', { class: 'counter' });
    const hint = h('p', { class: 'i18n__hint', hidden: true });
    const over = recommended ? h('p', { class: 'field__warn i18n__over', id: nextId('warn'), hidden: true, 'aria-live': 'polite' }) : null;
    const col = h('div', { class: 'i18n__col', dataset: { path: colPath, lang: lang.code } },
      h('div', { class: 'i18n__bar' },
        h('label', { class: 'lang-tag', id: tagId, for: id, title: lang.label, text: lang.short }),
        h('span', { class: 'sr-only', id: spokenId, text: LANG_SPOKEN[lang.code] || lang.label }),
        counter),
      input,
      h('p', { class: 'field__error', id: nextId('err'), hidden: true }),
      over,
      hint);
    input.addEventListener('input', () => {
      value[lang.code] = input.value;
      if (multiline) autosize(input);
      refresh();
      notify(input, colPath);
    });
    cols.push({ lang, input, counter, hint, over });
  }

  function refresh() {
    for (const c of cols) {
      counterText(c.counter, c.input.value.length, field.max, recommended);
      if (c.over) {
        const tooLong = c.input.value.length > recommended;
        c.over.hidden = !tooLong;
        c.over.textContent = tooLong ? `Довше за ${recommended} символів — Google, найімовірніше, обріже кінець.` : '';
        describedBy(c.input, c.over.id, tooLong);
      }
      const others = cols.filter((o) => o !== c && o.input.value.trim());
      const empty = !c.input.value.trim();
      c.hint.hidden = !(empty && others.length);
      if (!c.hint.hidden) {
        c.hint.textContent = c.lang.code === 'en'
          ? 'Порожньо — на англійській версії сайту буде показано український текст.'
          : 'Порожньо — на українській версії сайту буде показано англійський текст.';
      }
    }
  }
  refresh();

  append(root, h('div', { class: 'i18n' }, cols.map((c) => c.input.parentElement)), error);
  return root;
}

/* ---------------- рядок ---------------- */

function normalizeHandle(value) {
  return value
    .trim()
    .replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me|instagram\.com)\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '')
    .trim();
}

function stringField(field, obj, path) {
  const id = nextId();
  const kind = patternKind(field);
  // Для полів з форматом (телефон, нікнейм, рік) лічильник зайвий — довжину обмежує maxlength
  const { root, helpId, counterEl, error } = shell(field, path, { labelFor: id, counter: Boolean(field.max && !field.pattern) });
  const types = { phone: 'tel', email: 'email', url: 'url' };
  const input = h('input', {
    id,
    type: types[kind] || 'text',
    class: 'input',
    autocomplete: 'off',
    inputMode: kind === 'year' ? 'numeric' : undefined,
  });
  if (kind) input.spellcheck = false;
  input.value = obj[field.key] === undefined || obj[field.key] === null ? '' : String(obj[field.key]);
  if (field.max) input.maxLength = field.max;
  if (helpId) input.setAttribute('aria-describedby', helpId);
  const warn = h('p', { class: 'field__warn', id: nextId('warn'), hidden: true, 'aria-live': 'polite' });
  if (PATTERN_HINTS[kind]) root.dataset.hint = PATTERN_HINTS[kind];

  const check = () => {
    const v = input.value.trim();
    const bad = Boolean(v && field.pattern && !new RegExp(field.pattern).test(v));
    warn.hidden = !bad;
    warn.textContent = bad ? (PATTERN_HINTS[kind] || 'Перевірте формат') : '';
    root.classList.toggle('has-warning', bad);
    describedBy(input, warn.id, bad);
  };

  input.addEventListener('input', () => {
    obj[field.key] = input.value;
    if (counterEl) counterText(counterEl, input.value.length, field.max);
    if (!warn.hidden) check();
    notify(input, path);
  });
  input.addEventListener('change', () => {
    if (field.normalize === 'handle') {
      const normalized = normalizeHandle(input.value);
      if (normalized !== input.value) {
        input.value = normalized;
        obj[field.key] = normalized;
        notify(input, path);
      }
    }
    check();
  });
  if (counterEl) counterText(counterEl, input.value.length, field.max);
  if (input.value) check();

  const control = field.normalize === 'handle'
    ? h('div', { class: 'input-group' }, h('span', { class: 'input-group__prefix', 'aria-hidden': 'true', text: '@' }), input)
    : input;
  append(root, control, warn, error);
  return root;
}

/* ---------------- число ---------------- */

function clampNumber(field, raw) {
  let n = Math.round(Number(raw));
  if (!Number.isFinite(n)) n = defaultValue(field);
  if (typeof field.min === 'number' && n < field.min) n = field.min;
  if (typeof field.max === 'number' && n > field.max) n = field.max;
  return n;
}

function ratingField(field, obj, path) {
  const { root, labelId, error } = shell(field, path);
  const group = h('div', { class: 'stars', role: 'radiogroup', 'aria-labelledby': labelId });
  const buttons = [];
  const render = () => {
    const v = clampNumber(field, obj[field.key]);
    buttons.forEach((b, i) => {
      const on = i + 1 <= v;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(i + 1 === v));
      b.tabIndex = i + 1 === v ? 0 : -1;
    });
  };
  for (let n = field.min; n <= field.max; n += 1) {
    const b = h('button', {
      type: 'button',
      class: 'star',
      role: 'radio',
      'aria-label': `${n} з ${field.max}`,
      onClick: () => {
        obj[field.key] = n;
        render();
        notify(b, path);
      },
    }, icon('star'));
    b.addEventListener('keydown', (e) => {
      const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!delta) return;
      e.preventDefault();
      const next = clampNumber(field, Number(obj[field.key]) + delta);
      obj[field.key] = next;
      render();
      buttons[next - field.min].focus();
      notify(b, path);
    });
    buttons.push(b);
    group.append(b);
  }
  render();
  append(root, group, error);
  return root;
}

function numberField(field, obj, path) {
  const min = typeof field.min === 'number' ? field.min : 0;
  const max = typeof field.max === 'number' ? field.max : 100;
  if (field.key === 'rating' && min === 1 && max === 5) return ratingField(field, obj, path);

  const id = nextId();
  const { root, helpId, error } = shell(field, path, { labelFor: id });
  const input = h('input', { id, type: 'number', class: 'input input--number', min, max, step: 1, inputMode: 'numeric' });
  input.value = String(obj[field.key] ?? defaultValue(field));
  if (helpId) input.setAttribute('aria-describedby', helpId);

  const set = (raw, from) => {
    const n = clampNumber(field, raw);
    obj[field.key] = n;
    if (from !== 'input') input.value = String(n);
    if (range && from !== 'range') range.value = String(n);
    notify(input, path);
  };

  let range = null;
  let control;
  if (max - min > 10) {
    range = h('input', { type: 'range', class: 'range', min, max, step: 1, 'aria-label': field.label });
    range.value = String(obj[field.key] ?? defaultValue(field));
    range.addEventListener('input', () => set(range.value, 'range'));
    control = h('div', { class: 'range-row' }, range, input);
  } else {
    const step = (delta, label, sign) => h('button', {
      type: 'button',
      class: 'icon-btn stepper__btn',
      'aria-label': label,
      title: label,
      onClick: () => set(Number(obj[field.key]) + delta),
    }, h('span', { 'aria-hidden': 'true', text: sign }));
    const minus = step(-1, 'Менше', '−');
    const plus = step(1, 'Більше', '+');
    control = h('div', { class: 'stepper' }, minus, input, plus);
  }
  input.addEventListener('input', () => {
    if (input.value !== '' && Number.isFinite(Number(input.value))) set(input.value, 'input');
  });
  input.addEventListener('change', () => set(input.value));
  append(root, control, error);
  return root;
}

/* ---------------- так / ні ---------------- */

function booleanField(field, obj, path) {
  const root = h('div', { class: 'field field--boolean', dataset: { path } });
  const sw = switchControl({
    checked: obj[field.key] === true,
    label: field.label,
    help: field.help,
    onChange: (checked) => {
      obj[field.key] = checked;
      notify(sw.input, path);
    },
  });
  append(root, sw.root, h('p', { class: 'field__error', id: nextId('err'), hidden: true }));
  return root;
}

/* ---------------- зображення ---------------- */

function imageField(field, obj, path) {
  const purpose = path === 'settings.logo' ? 'logo' : 'photo';
  const variant = IMAGE_SIZE_HINTS[path] || (path.endsWith('.photo') && path.startsWith('sections.about') ? 'portrait' : 'photo');
  const { root, labelId, helpId, error } = shell(field, path, { extraClass: `imgf imgf--${variant}` });

  const img = h('img', { class: 'imgf__img', alt: '', decoding: 'async' });
  // На телефоні перетягнути файл неможливо — пропонуємо натиснути
  const emptyText = isTouch() ? 'Натисніть, щоб додати фото' : 'Перетягніть фото сюди або натисніть';
  const empty = h('span', { class: 'imgf__empty' }, icon('image'), h('span', { text: emptyText }));
  // Головний екран: попередній перегляд затемнення, як на сайті
  const shade = path === 'sections.hero.image' ? h('span', { class: 'imgf__shade', 'aria-hidden': 'true' }) : null;
  const bar = h('span', { class: 'progress__bar' });
  const progress = h('div', { class: 'progress imgf__progress', hidden: true }, bar);
  const preview = h('div', { class: 'imgf__preview' }, img, shade, empty, progress);
  const name = h('p', { class: 'imgf__name' });

  const uploadBtn = button({ label: 'Завантажити фото', iconName: 'upload', variant: 'secondary', size: 'sm' });
  const pickBtn = button({ label: 'Обрати з медіатеки', iconName: 'images', variant: 'secondary', size: 'sm' });
  const clearBtn = button({ label: 'Прибрати', iconName: 'close', variant: 'ghost', size: 'sm' });

  // Підказки під полем: обов'язкове фото, вертикальне фото у «широкому» полі, помилка завантаження
  const need = field.required ? h('p', { class: 'field__warn', id: nextId('warn'), hidden: true, text: 'Додайте фото — без нього цей блок на сайті виглядатиме порожнім.' }) : null;
  const shape = variant === 'wide' ? h('p', { class: 'field__warn', id: nextId('warn'), hidden: true, text: 'Це вертикальне фото: на комп’ютері його буде сильно обрізано згори й знизу. Краще обрати горизонтальне.' }) : null;
  const problem = h('p', { class: 'field__warn imgf__problem', id: nextId('warn'), hidden: true });
  const notes = h('div', { class: 'imgf__notes', 'aria-live': 'polite' }, need, shape, problem);
  const box = h('div', { class: 'imgf__box', role: 'group', 'aria-labelledby': labelId });
  if (helpId) describedBy(box, helpId, true);

  const showNote = (el, on, text) => {
    if (!el) return;
    if (text !== undefined) el.textContent = text;
    el.hidden = !on;
    describedBy(box, el.id, on);
  };

  const update = () => {
    const v = obj[field.key] || '';
    showNote(need, !v);
    showNote(shape, false);
    root.classList.toggle('is-empty', !v);
    root.classList.remove('is-broken');
    if (v) img.src = assetUrl(v);
    else img.removeAttribute('src');
    name.textContent = v ? decodeURIComponent(v.split('/').pop()) : 'Фото не обрано';
    clearBtn.hidden = !v;
  };
  img.addEventListener('error', () => {
    if (img.getAttribute('src')) {
      root.classList.add('is-broken');
      name.textContent = 'Не вдалося показати фото — оберіть інше';
    }
  });
  img.addEventListener('load', () => {
    showNote(shape, img.naturalHeight > img.naturalWidth * 1.05);
  });

  const set = (url) => {
    obj[field.key] = url;
    showNote(problem, false);
    if (root.isConnected) {
      update();
      notify(root, path);
    } else {
      // Поки фото завантажувалося, сторінку перемалювали (наприклад, після збереження) — оновлюємо її знову
      changed(path);
      emit('draft-replaced');
    }
  };

  const upload = async (file) => {
    if (!file || root.classList.contains('is-uploading')) return;
    showNote(problem, false);
    root.classList.add('is-uploading');
    progress.hidden = false;
    bar.style.width = '0';
    uploadBtn.disabled = true;
    const result = await uploadOne(file, {
      purpose,
      onProgress: (p) => { bar.style.width = `${Math.round(p * 100)}%`; },
      onError: (message) => showNote(problem, true, message),
    });
    root.classList.remove('is-uploading');
    progress.hidden = true;
    uploadBtn.disabled = false;
    if (result) {
      set(result.url);
      toast('Фото завантажено. Не забудьте зберегти зміни.', { key: 'upload' });
    }
  };
  const chooseAndUpload = async () => {
    const [file] = await chooseFiles();
    upload(file);
  };

  uploadBtn.addEventListener('click', chooseAndUpload);
  // Порожнє поле — велика зрозуміла ціль: натиснули → вибір фото (клавіатурою — кнопка «Завантажити фото»)
  preview.addEventListener('click', () => {
    if (root.classList.contains('is-empty') || root.classList.contains('is-broken')) chooseAndUpload();
  });
  pickBtn.addEventListener('click', async () => {
    const url = await pickImage({ current: obj[field.key], purpose, title: field.label });
    if (url) set(url);
  });
  clearBtn.addEventListener('click', () => set(''));
  bindDrop(preview, (files) => upload(files[0]));

  if (shade) {
    const paintShade = () => {
      const pct = Math.max(0, Math.min(80, Number(obj.overlay) || 0));
      root.style.setProperty('--ov', String(pct / 100));
    };
    paintShade();
    const off = on('change', (changedPath) => {
      if (!root.isConnected) {
        off();
        return;
      }
      if (changedPath === path.replace(/image$/, 'overlay')) paintShade();
    });
  }

  update();
  append(box,
    preview,
    h('div', { class: 'imgf__side' },
      name,
      h('div', { class: 'imgf__actions' }, uploadBtn, pickBtn, clearBtn)));
  append(root, box, notes, error);
  return root;
}

/* ---------------- колір ---------------- */

function colorField(field, obj, path) {
  const id = nextId();
  const { root, helpId, error } = shell(field, path, { labelFor: id });
  const current = () => (/^#[0-9a-f]{6}$/i.test(obj[field.key] || '') ? obj[field.key].toLowerCase() : defaultValue(field));
  const picker = h('input', { type: 'color', class: 'color__picker', 'aria-label': `${field.label} — палітра` });
  const hex = h('input', { id, type: 'text', class: 'input color__hex', maxLength: 7, autocomplete: 'off' });
  hex.spellcheck = false;
  if (helpId) hex.setAttribute('aria-describedby', helpId);
  const presets = COLOR_PRESETS[field.key] || COLOR_PRESETS.accent;
  const swatches = presets.map((c) => h('button', {
    type: 'button',
    class: 'swatch',
    style: { '--c': c },
    title: c,
    'aria-label': `Колір ${c}`,
    onClick: () => set(c),
  }));

  function paint() {
    const v = current();
    picker.value = v;
    if (document.activeElement !== hex) hex.value = v;
    for (const sw of swatches) {
      const on = sw.title === v;
      sw.classList.toggle('is-active', on);
      sw.setAttribute('aria-pressed', String(on));
    }
  }
  function set(v) {
    obj[field.key] = v.toLowerCase();
    paint();
    notify(root, path);
  }

  picker.addEventListener('input', () => set(picker.value));
  hex.addEventListener('input', () => {
    let v = hex.value.trim();
    if (v && !v.startsWith('#')) v = `#${v}`;
    if (/^#[0-9a-f]{6}$/i.test(v)) set(v);
  });
  hex.addEventListener('blur', () => {
    hex.value = current();
  });
  paint();
  append(root, h('div', { class: 'color' }, h('span', { class: 'color__well' }, picker), hex, h('div', { class: 'swatches', role: 'group', 'aria-label': `${field.label}: готові кольори` }, swatches)), error);
  return root;
}

/* ---------------- вибір зі списку ---------------- */

function presetCards(field, obj, path) {
  const { root, labelId, error } = shell(field, path, { extraClass: 'field--presets' });
  const name = nextId('preset');
  const group = h('div', { class: 'presets', role: 'radiogroup', 'aria-labelledby': labelId });
  for (const opt of field.options) {
    const colors = THEME_PRESETS[opt.value];
    const input = h('input', { type: 'radio', class: 'preset__input', name, value: opt.value, checked: obj[field.key] === opt.value });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      obj[field.key] = opt.value;
      notify(root, path);
    });
    const chips = colors
      ? [colors.bg, colors.sand, colors.accent].map((c) => h('span', { class: 'preset__chip', style: { '--c': c } }))
      : [h('span', { class: 'preset__chip preset__chip--custom' })];
    group.append(h('label', { class: 'preset' }, input, h('span', { class: 'preset__chips', 'aria-hidden': 'true' }, chips), h('span', { class: 'preset__label', text: opt.label })));
  }
  append(root, group, error);
  return root;
}

function selectField(field, obj, path) {
  if (path === 'theme.preset') return presetCards(field, obj, path);
  const id = nextId();
  const { root, helpId, error } = shell(field, path, { labelFor: id });
  const select = h('select', { id, class: 'input select' }, field.options.map((o) => h('option', { value: o.value, text: o.label })));
  select.value = obj[field.key];
  if (helpId) select.setAttribute('aria-describedby', helpId);
  select.addEventListener('change', () => {
    obj[field.key] = select.value;
    notify(select, path);
  });
  append(root, h('div', { class: 'select-wrap' }, select, icon('chevron', 'i select-wrap__chev')), error);
  return root;
}

/* ---------------- іконка ---------------- */

const svgCache = new Map();
export function contentIcon(name) {
  if (!svgCache.has(name)) svgCache.set(name, parseSvg(state.icons[name]) || icon('star'));
  const node = svgCache.get(name).cloneNode(true);
  node.setAttribute('class', 'cicon');
  return node;
}

const iconLabel = (name) => {
  const found = (state.schema.icons || []).find((i) => i.value === name);
  return found ? found.label : name;
};

function pickIcon(current) {
  const modal = openModal({ title: 'Оберіть іконку', size: 'md' });
  const grid = h('div', { class: 'icon-grid', role: 'group', 'aria-label': 'Іконки' });
  for (const { value, label } of state.schema.icons || []) {
    const selected = value === current;
    grid.append(h('button', {
      type: 'button',
      class: ['icon-tile', selected && 'is-selected'],
      'aria-pressed': String(selected),
      onClick: () => modal.close(value),
    }, contentIcon(value), h('span', { class: 'icon-tile__label', text: label })));
  }
  modal.body.append(grid);
  modal.footer.append(h('button', { type: 'button', class: 'btn btn--ghost', text: 'Скасувати', onClick: () => modal.close(null) }));
  return modal.closed.then((v) => v || null);
}

function iconField(field, obj, path) {
  const { root, labelId, error } = shell(field, path);
  const preview = h('span', { class: 'iconf__preview' });
  const label = h('span', { class: 'iconf__label' });
  const btn = h('button', { type: 'button', class: 'iconf', 'aria-haspopup': 'dialog', 'aria-describedby': labelId },
    preview,
    h('span', { class: 'iconf__text' }, label, h('span', { class: 'iconf__change', text: 'Змінити' })));
  const update = () => {
    preview.replaceChildren(contentIcon(obj[field.key]));
    label.textContent = iconLabel(obj[field.key]);
  };
  btn.addEventListener('click', async () => {
    const choice = await pickIcon(obj[field.key]);
    if (choice && choice !== obj[field.key]) {
      obj[field.key] = choice;
      update();
      notify(root, path);
    }
  });
  update();
  append(root, btn, error);
  return root;
}

/* ---------------- список ---------------- */

let drag = null; // { list, id }

function listField(field, obj, path) {
  if (!Array.isArray(obj[field.key])) obj[field.key] = [];
  const items = obj[field.key];
  const max = field.max || Infinity;
  const listKey = path.replace(/^sections\./, '');
  const count = h('span', { class: 'list__count' });
  const ol = h('ol', { class: 'list__items' });
  const addBtn = button({ label: ADD_LABELS[listKey] || 'Додати', iconName: 'plus', variant: 'secondary', className: 'list__add' });
  const maxNote = h('p', { class: 'list__max', hidden: true });
  const root = h('section', { class: 'field field--list', dataset: { path } },
    h('header', { class: 'list__head' },
      h('h3', { class: 'list__title', text: field.label }),
      count),
    field.help && h('p', { class: 'field__help', text: field.help }),
    h('p', { class: 'field__error', id: nextId('err'), hidden: true }),
    ol,
    h('div', { class: 'list__foot' }, addBtn, maxNote));

  const imageSub = field.item.find((f) => f.type === 'image');
  const iconSub = field.item.find((f) => f.type === 'icon');
  const labelSub = field.item.find((f) => f.key === field.itemLabel);

  function structural() {
    notify(root, path);
  }

  const itemEl = (id) => ol.querySelector(`[data-id="${CSS.escape(id)}"]`);

  /**
   * focus: { id, selector, fallback, scroll, anchor, flash }
   * anchor — позиція елемента на екрані до зміни: після перемальовування сторінку зсуваємо так,
   * щоб елемент (і кнопка ↑ / ↓ під пальцем) лишився на тому самому місці.
   */
  function rerender(focus) {
    ol.replaceChildren(...items.map((item, i) => renderItem(item, i)));
    count.textContent = Number.isFinite(max) ? `${items.length} з ${max}` : String(items.length);
    const full = items.length >= max;
    addBtn.disabled = full;
    maxNote.hidden = !full;
    maxNote.textContent = full ? `Це максимум для цього блоку (${max}). Щоб додати новий елемент, видаліть один з наявних.` : '';
    paintErrors(root);
    if (!focus) return;
    const li = itemEl(focus.id);
    if (!li) return;
    if (typeof focus.anchor === 'number') window.scrollBy(0, li.getBoundingClientRect().top - focus.anchor);
    if (focus.flash) flashMoved(li);
    requestAnimationFrame(() => {
      autosizeAll(li);
      const target = focus.selector ? li.querySelector(focus.selector) : null;
      const el = target && !target.disabled ? target : (focus.fallback ? li.querySelector(focus.fallback) : null);
      if (focus.scroll) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (el) el.focus({ preventScroll: true });
    });
  }

  function renderItem(item, index) {
    const itemPath = `${path}.${index}`;
    const open = state.expanded.has(item.id);
    const bodyId = nextId('item');
    const thumb = imageSub || iconSub ? h('span', { class: ['item__thumb', iconSub && !imageSub && 'item__thumb--icon'] }) : null;
    const title = h('span', { class: 'item__title' });
    const toggle = h('button', { type: 'button', class: 'item__toggle', 'aria-expanded': String(open), 'aria-controls': bodyId },
      h('span', { class: 'item__num', text: String(index + 1) }),
      thumb,
      title,
      icon('chevron', 'i item__chev'));
    const body = h('div', { class: 'item__body', id: bodyId, hidden: !open });
    const grip = h('span', { class: 'item__grip', title: 'Перетягніть, щоб змінити порядок', 'aria-hidden': 'true' }, icon('grip'));
    const li = h('li', { class: ['item', open && 'is-open'], dataset: { id: item.id, path: itemPath } },
      h('div', { class: 'item__head' },
        grip,
        toggle,
        h('div', { class: 'item__actions' },
          iconButton({ iconName: 'up', label: 'Перемістити вище', className: 'js-up', disabled: index === 0, onClick: () => move(index, -1, '.js-up') }),
          iconButton({ iconName: 'down', label: 'Перемістити нижче', className: 'js-down', disabled: index === items.length - 1, onClick: () => move(index, 1, '.js-down') }),
          // На широкому екрані — одразу під рукою; на телефоні ховаються в меню «⋯», щоб «Видалити» не стояло впритул до інших кнопок
          iconButton({ iconName: 'copy', label: 'Дублювати', className: 'item__wide js-dup', disabled: items.length >= max, onClick: () => duplicate(index) }),
          iconButton({ iconName: 'trash', label: 'Видалити', className: 'icon-btn--danger item__wide js-del', onClick: () => remove(index) }),
          h('button', {
            type: 'button',
            class: 'icon-btn js-more',
            'aria-label': 'Інші дії',
            title: 'Інші дії: на початок, в кінець, дублювати, видалити',
            'aria-haspopup': 'dialog',
            onClick: () => moreActions(item),
          }, icon('more')))),
      body);

    const updateHead = () => {
      const text = labelSub ? textOf(item[labelSub.key]).trim() : '';
      title.textContent = text || 'Без назви';
      title.classList.toggle('is-untitled', !text);
      if (thumb) {
        if (imageSub && item[imageSub.key]) {
          thumb.replaceChildren(h('img', { src: assetUrl(item[imageSub.key]), alt: '', loading: 'lazy', decoding: 'async' }));
          thumb.classList.remove('is-empty');
        } else if (iconSub) {
          thumb.replaceChildren(contentIcon(item[iconSub.key]));
          thumb.classList.remove('is-empty');
        } else {
          thumb.replaceChildren(icon('image'));
          thumb.classList.add('is-empty');
        }
      }
    };
    updateHead();

    const fill = () => {
      if (body.childElementCount) return;
      body.append(...renderFields(field.item, item, itemPath));
      paintErrors(body);
    };
    if (open) fill();

    toggle.addEventListener('click', () => {
      const nowOpen = !state.expanded.has(item.id);
      if (nowOpen) state.expanded.add(item.id);
      else state.expanded.delete(item.id);
      li.classList.toggle('is-open', nowOpen);
      toggle.setAttribute('aria-expanded', String(nowOpen));
      if (nowOpen) fill();
      body.hidden = !nowOpen;
      if (nowOpen) requestAnimationFrame(() => autosizeAll(body));
    });
    body.addEventListener('input', updateHead);
    body.addEventListener('fieldchange', updateHead);

    // Перетягування мишею (на телефоні — кнопки ↑ ↓ та «⋯»)
    const undrag = () => {
      li.draggable = false;
    };
    grip.addEventListener('pointerdown', () => {
      li.draggable = true;
      // Простий клік без перетягування не має лишати елемент «перетягуваним» —
      // інакше мишею вже не виділити текст у його полях
      document.addEventListener('pointerup', undrag, { once: true });
    });
    li.addEventListener('dragstart', (e) => {
      if (!li.draggable) return;
      drag = { list: ol, id: item.id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
      requestAnimationFrame(() => li.classList.add('is-dragging'));
    });
    li.addEventListener('dragend', () => {
      document.removeEventListener('pointerup', undrag);
      li.draggable = false;
      li.classList.remove('is-dragging');
      for (const el of ol.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
      drag = null;
    });
    return li;
  }

  ol.addEventListener('dragover', (e) => {
    if (!drag || drag.list !== ol) return;
    const li = e.target.closest('.item');
    if (!li || li.parentElement !== ol) return;
    e.preventDefault();
    const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2;
    for (const el of ol.querySelectorAll('.drop-before, .drop-after')) if (el !== li) el.classList.remove('drop-before', 'drop-after');
    li.classList.toggle('drop-after', after);
    li.classList.toggle('drop-before', !after);
  });
  ol.addEventListener('drop', (e) => {
    if (!drag || drag.list !== ol) return;
    e.preventDefault();
    const li = e.target.closest('.item');
    const from = items.findIndex((it) => it.id === drag.id);
    if (!li || from < 0) return;
    let to = items.findIndex((it) => it.id === li.dataset.id);
    if (li.classList.contains('drop-after')) to += 1;
    if (from < to) to -= 1;
    if (to === from) return;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    structural();
    rerender({ id: moved.id, flash: true });
  });

  function move(index, dir, selector) {
    const to = index + dir;
    if (to < 0 || to >= items.length) return;
    const before = itemEl(items[index].id);
    const anchor = before ? before.getBoundingClientRect().top : undefined;
    const [moved] = items.splice(index, 1);
    items.splice(to, 0, moved);
    structural();
    rerender({ id: moved.id, selector, fallback: dir < 0 ? '.js-down' : '.js-up', anchor, flash: true });
  }

  /** На початок / в кінець списку — замість десятка натискань ↑. */
  function moveTo(item, edge) {
    const from = items.indexOf(item);
    const to = edge === 'start' ? 0 : items.length - 1;
    if (from < 0 || from === to) return;
    items.splice(from, 1);
    if (edge === 'start') items.unshift(item);
    else items.push(item);
    structural();
    rerender({ id: item.id, selector: '.js-more', scroll: true, flash: true });
    toast(edge === 'start' ? 'Переміщено на початок' : 'Переміщено в кінець', { type: 'info', key: 'list-move' });
  }

  async function moreActions(item) {
    const index = items.indexOf(item);
    if (index < 0) return;
    const name = labelSub ? textOf(item[labelSub.key]).trim() : '';
    const choice = await actionSheet({
      title: name ? `«${name.length > 50 ? `${name.slice(0, 47)}…` : name}»` : `Елемент ${index + 1}`,
      actions: [
        { label: 'На початок', iconName: 'toTop', disabled: index === 0 },
        { label: 'В кінець', iconName: 'toBottom', disabled: index === items.length - 1 },
        { label: 'Дублювати', iconName: 'copy', disabled: items.length >= max, hint: items.length >= max ? `максимум ${max}` : '' },
        { label: 'Видалити', iconName: 'trash', danger: true },
      ],
    });
    const at = items.indexOf(item);
    if (choice === null || at < 0) return;
    if (choice === 0) moveTo(item, 'start');
    else if (choice === 1) moveTo(item, 'end');
    else if (choice === 2) duplicate(at);
    else if (choice === 3) remove(at);
  }

  function duplicate(index) {
    if (items.length >= max) return;
    const copy = clone(items[index]);
    copy.id = newListItem(field).id;
    items.splice(index + 1, 0, copy);
    state.expanded.add(copy.id);
    structural();
    rerender({ id: copy.id, selector: '.item__toggle', scroll: true });
    toast('Створено копію — вона нижче оригіналу', { key: 'list-dup' });
  }

  async function remove(index) {
    const item = items[index];
    const name = labelSub ? textOf(item[labelSub.key]).trim() : '';
    const ok = await confirmDialog({
      title: name ? `Видалити «${name.length > 60 ? `${name.slice(0, 57)}…` : name}»?` : 'Видалити цей елемент?',
      message: 'Елемент зникне з сайту після збереження змін.',
      confirmLabel: 'Видалити',
      danger: true,
    });
    if (!ok) return;
    const at = items.indexOf(item);
    if (at < 0) return;
    items.splice(at, 1);
    structural();
    const neighbour = items[Math.min(at, items.length - 1)];
    rerender(neighbour ? { id: neighbour.id, selector: '.item__toggle' } : null);
    if (!neighbour) addBtn.focus();
    toast('Видалено', {
      type: 'info',
      key: 'list-remove',
      action: {
        label: 'Повернути',
        onClick: () => {
          // Список міг змінитися повністю (вихід, відновлення копії) — тоді повертати нікуди
          if (getByPath(state.draft, path) !== items || items.includes(item)) return;
          if (items.length >= max) {
            toast(`Не вдалося повернути: у блоці вже максимум елементів (${max}).`, { type: 'error' });
            return;
          }
          items.splice(Math.min(at, items.length), 0, item);
          if (root.isConnected) {
            structural();
            rerender({ id: item.id, selector: '.item__toggle', scroll: true, flash: true });
          } else {
            // Сторінку тим часом перемалювали (збереження, перехід) — оновлюємо її
            changed(path);
            emit('draft-replaced');
          }
        },
      },
    });
  }

  addBtn.addEventListener('click', () => {
    if (items.length >= max) return;
    const item = newListItem(field);
    items.push(item);
    state.expanded.add(item.id);
    structural();
    rerender({ id: item.id, selector: '.item__body input, .item__body textarea, .item__body button', scroll: true });
  });

  rerender();
  return root;
}

/** Коротка підсвітка переміщеного елемента, щоб було видно, куди він став. */
export function flashMoved(el) {
  el.classList.remove('is-moved');
  void el.offsetWidth; // перезапуск анімації
  el.classList.add('is-moved');
  el.addEventListener('animationend', () => el.classList.remove('is-moved'), { once: true });
}

/* ---------------- збірка ---------------- */

const RENDERERS = {
  text: localizedField,
  textarea: localizedField,
  string: stringField,
  number: numberField,
  boolean: booleanField,
  image: imageField,
  color: colorField,
  select: selectField,
  icon: iconField,
  list: listField,
};

export function renderField(field, obj, path) {
  const render = RENDERERS[field.type];
  if (!render) return h('p', { class: 'muted', text: `Невідомий тип поля: ${field.type}` });
  return render(field, obj, path);
}

/** Рендерить набір полів. basePath — шлях об'єкта (наприклад "sections.hero"). */
export function renderFields(fields, obj, basePath, { skip = [] } = {}) {
  return fields
    .filter((f) => !skip.includes(f.key))
    .map((f) => renderField(f, obj, basePath ? `${basePath}.${f.key}` : f.key));
}

/* ---------------- помилки ---------------- */

/** Показує / ховає помилки сервера на всіх полях усередині root. */
export function paintErrors(root) {
  if (!root) return;
  const nodes = root.matches && root.matches('[data-path]') ? [root, ...root.querySelectorAll('[data-path]')] : [...root.querySelectorAll('[data-path]')];
  for (const el of nodes) {
    const path = el.dataset.path;
    const own = state.errors.get(path);
    if (el.classList.contains('item')) {
      let nested = Boolean(own);
      if (!nested) {
        for (const key of state.errors.keys()) {
          if (key.startsWith(`${path}.`)) {
            nested = true;
            break;
          }
        }
      }
      el.classList.toggle('has-error', nested);
      continue;
    }
    el.classList.toggle('has-error', Boolean(own));
    const errEl = el.querySelector(':scope > .field__error');
    if (errEl) {
      errEl.hidden = !own;
      if (!errEl.id) errEl.id = nextId('err');
      // «Невірний формат» з сервера доповнюємо зрозумілою підказкою
      errEl.textContent = own && /^(Невірний|Неправильний) формат\.?$/.test(own) && el.dataset.hint ? `${own.replace(/\.$/, '')}. ${el.dataset.hint}` : (own || '');
    }
    for (const input of el.querySelectorAll('input, textarea, select')) {
      if (input.closest('[data-path]') !== el) continue;
      if (own) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      // Текст помилки читається разом з полем (а підказку про формат, сховану на час помилки, — ні)
      if (errEl) describedBy(input, errEl.id, Boolean(own));
      for (const warnEl of el.querySelectorAll(':scope > .field__warn')) describedBy(input, warnEl.id, !own && !warnEl.hidden);
    }
    const group = el.querySelector(':scope > .imgf__box');
    if (group && errEl) describedBy(group, errEl.id, Boolean(own));
  }
}

/** Знаходить поле за шляхом помилки (або найближче батьківське) і переводить на нього фокус. */
export function focusPath(root, path) {
  let parts = String(path).split('.');
  let el = null;
  while (parts.length && !el) {
    el = root.querySelector(`[data-path="${CSS.escape(parts.join('.'))}"]`);
    parts = parts.slice(0, -1);
  }
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const input = el.querySelector('input:not([type="hidden"]):not([type="color"]), textarea, select, button');
  if (input) input.focus({ preventScroll: true });
  el.classList.remove('flash');
  void el.offsetWidth; // перезапуск анімації
  el.classList.add('flash');
  return true;
}

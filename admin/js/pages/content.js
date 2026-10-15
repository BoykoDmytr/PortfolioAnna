/**
 * Сторінки редагування контенту: «Структура сторінки», секції сайту та групи налаштувань.
 */

import { h, append, replace, describedBy, nextId } from '../dom.js';
import { icon } from '../icons.js';
import { urls } from '../api.js';
import { state, changed, sectionDef, groupDef, textOf } from '../state.js';
import { pageHeader, card, switchControl, iconButton } from '../ui.js';
import { renderFields, renderField, flashMoved } from '../fields.js';

const SITE_LINK_LABEL = 'Подивитися на сайті';

function siteLink(hash) {
  // data-site: якщо є незбережені зміни, адмінка спершу пояснить, що на сайті ще попередня версія
  return h('a', { class: 'btn btn--ghost btn--sm', href: `${urls.site}${hash ? `#${hash}` : ''}`, target: '_blank', rel: 'noopener', dataset: { site: 'uk' } },
    h('span', { class: 'btn__label', text: SITE_LINK_LABEL }), icon('external'));
}

/* ---------------- Структура сторінки ---------------- */

export function renderStructure(view) {
  const list = h('ol', { class: 'structure' });

  const render = (focus) => {
    const order = state.draft.order;
    const movable = order.filter((t) => !(sectionDef(t) || {}).pinned);
    replace(list, ...order.map((type, index) => {
      const def = sectionDef(type);
      const data = state.draft.sections[type];
      if (!def || !data) return null;
      const pinned = Boolean(def.pinned);
      const pos = movable.indexOf(type);
      const nav = data.showInNav && textOf(data.navLabel) ? textOf(data.navLabel) : '';
      const sw = switchControl({
        checked: data.enabled,
        label: data.enabled ? 'На сайті' : 'Приховано',
        onChange: (checked) => {
          data.enabled = checked;
          changed(`sections.${type}.enabled`);
          render({ type, selector: '.switch__input' });
        },
      });
      sw.input.setAttribute('aria-label', `${def.title}: показувати на сайті`);
      const move = (dir, selector) => {
        const from = order.indexOf(type);
        const to = from + dir;
        if (to < 0 || to >= order.length || (sectionDef(order[to]) || {}).pinned) return;
        // Запам'ятовуємо, де рядок був на екрані: після перестановки він лишиться під пальцем
        const row = list.querySelector(`[data-type="${type}"]`);
        const anchor = row ? row.getBoundingClientRect().top : undefined;
        order.splice(from, 1);
        order.splice(to, 0, type);
        changed('order');
        render({ type, selector, fallback: selector === '.js-up' ? '.js-down' : '.js-up', anchor });
      };
      return h('li', { class: ['structure__row', !data.enabled && 'is-hidden', pinned && 'is-pinned'], dataset: { type } },
        h('span', { class: 'structure__num', text: String(index + 1) }),
        h('div', { class: 'structure__info' },
          h('a', { class: 'structure__title', href: `#/section/${type}`, text: def.title }),
          h('p', { class: 'structure__desc', text: def.description || '' }),
          h('p', { class: 'structure__meta' },
            pinned
              ? h('span', { class: 'structure__pin' }, icon('lock'), 'Завжди перша на сторінці')
              : h('span', { text: nav ? `У меню: «${nav}»` : 'Немає в меню' })),
        ),
        h('div', { class: 'structure__controls' },
          sw.root,
          h('div', { class: 'structure__move' },
            pinned
              ? null
              : [
                iconButton({ iconName: 'up', label: `Перемістити «${def.title}» вище`, className: 'js-up', disabled: pos <= 0, onClick: () => move(-1, '.js-up') }),
                iconButton({ iconName: 'down', label: `Перемістити «${def.title}» нижче`, className: 'js-down', disabled: pos === movable.length - 1, onClick: () => move(1, '.js-down') }),
              ]),
          h('a', { class: 'btn btn--secondary btn--sm structure__edit', href: `#/section/${type}` },
            icon('edit'), h('span', { class: 'btn__label', text: 'Редагувати' })),
        ));
    }));
    if (focus) {
      const row = list.querySelector(`[data-type="${focus.type}"]`);
      const anchored = Boolean(row) && typeof focus.anchor === 'number';
      if (anchored) {
        window.scrollBy(0, row.getBoundingClientRect().top - focus.anchor);
        flashMoved(row);
      }
      let el = row && row.querySelector(focus.selector);
      if (el && el.disabled && focus.fallback) el = row.querySelector(focus.fallback);
      if (el) el.focus({ preventScroll: anchored });
    }
  };

  view.append(
    pageHeader({
      eyebrow: 'Сторінка',
      title: 'Структура сторінки',
      description: 'Які секції показувати на сайті та в якому порядку. Порядок тут — це порядок блоків на сторінці згори донизу. Не забудьте зберегти зміни.',
      actions: siteLink(''),
    }),
    h('section', { class: 'card card--flush' }, list),
    h('p', { class: 'page-note' }, icon('info'), 'Прихована секція не видаляється: її вміст збережено, і її можна показати знову будь-коли.'),
  );
  render();
}

/* ---------------- Секція ---------------- */

/*
 * Демонстраційний вміст із першого запуску: вигадані відгуки, зразки сертифікатів, фото з фотостоку.
 * Підказка показується, доки в секції лишається хоч щось демонстраційне (впізнаємо за id / файлами
 * з початкового content.json), і її можна сховати для цієї секції.
 */
const DEMO_KEY = 'af-admin-demo-hidden';
const DEMO = {
  about: {
    has: (d) => d.photo === '/uploads/about-sun-hat-cove.webp',
    text: 'Фото тут — демонстраційне, з фотостоку. Замініть його своїм фото, а текст і цифри — своїми.',
  },
  reviews: {
    has: (d) => (d.items || []).some((i) => /^rev-/.test(i.id || '')),
    text: 'Ці відгуки — демонстраційні, вигадані. Замініть їх справжніми відгуками клієнтів або приховайте секцію.',
  },
  certificates: {
    has: (d) => (d.items || []).some((i) => /^cert-/.test(i.id || '') || /\/uploads\/certificate-/.test(i.image || '')),
    text: 'Це зразки сертифікатів (з написом «ЗРАЗОК»). Додайте скани своїх сертифікатів або приховайте секцію.',
  },
  gallery: {
    has: (d) => (d.items || []).some((i) => /^gal-/.test(i.id || '')),
    text: 'Фото в галереї — з фотостоку. Найкраще замінити їх знімками з ваших подорожей.',
  },
};

function demoHidden() {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function demoNotice(type, data) {
  const demo = DEMO[type];
  if (!demo || !demo.has(data) || demoHidden()[type]) return null;
  const note = h('div', { class: 'notice notice--demo', role: 'note' },
    icon('info'),
    h('p', { class: 'notice__text' }, h('strong', { text: 'Демонстраційний вміст. ' }), demo.text),
    iconButton({
      iconName: 'close',
      label: 'Сховати цю підказку',
      className: 'notice__close',
      onClick: () => {
        try {
          localStorage.setItem(DEMO_KEY, JSON.stringify({ ...demoHidden(), [type]: true }));
        } catch { /* приватний режим — сховаємо лише до наступного відкриття */ }
        const view = note.closest('.view');
        note.remove();
        if (view) view.focus({ preventScroll: true });
      },
    }));
  return note;
}


export function renderSection(view, type) {
  const def = sectionDef(type);
  const data = state.draft.sections[type];
  if (!def || !data) {
    view.append(pageHeader({ title: 'Секцію не знайдено', description: 'Оберіть секцію в меню ліворуч.' }));
    return;
  }
  const index = state.draft.order.indexOf(type);
  const base = `sections.${type}`;
  const common = state.schema.sectionCommon;
  const enabledField = common.find((f) => f.key === 'enabled');
  const navFields = common.filter((f) => f.key !== 'enabled');

  const statusText = () => (data.enabled ? 'Секція показується на сайті' : 'Секція прихована — відвідувачі її не бачать');
  const visibility = card({
    title: 'Показ на сайті',
    className: ['card--visibility', !data.enabled && 'is-off'].filter(Boolean).join(' '),
    children: [
      renderField({ ...enabledField, help: statusText() }, data, `${base}.enabled`),
      def.pinned ? null : h('div', { class: 'grid-2 nav-fields' }, renderFields(navFields, data, base)),
    ],
  });
  visibility.addEventListener('fieldchange', (e) => {
    if (e.detail.path === `${base}.enabled`) {
      visibility.classList.toggle('is-off', !data.enabled);
      const help = visibility.querySelector('.switch__help');
      if (help) help.textContent = statusText();
    }
  });

  const plain = def.fields.filter((f) => f.type !== 'list');
  const lists = def.fields.filter((f) => f.type === 'list');

  append(view,
    pageHeader({
      eyebrow: `Сторінка · секція ${index + 1} з ${state.draft.order.length}`,
      title: def.title,
      description: def.description,
      actions: siteLink(type),
    }),
    demoNotice(type, data),
    visibility,
    card({ title: 'Тексти та фото', children: renderFields(plain, data, base) }),
    ...lists.map((f) => card({ className: 'card--list', children: [renderField(f, data, `${base}.${f.key}`)] })),
  );
}

/* ---------------- Група налаштувань ---------------- */

const GROUP_EYEBROW = 'Налаштування';

export function renderGroup(view, key) {
  const def = groupDef(key);
  const data = state.draft[key];
  if (!def || !data) {
    view.append(pageHeader({ title: 'Розділ не знайдено' }));
    return;
  }

  const header = pageHeader({ eyebrow: GROUP_EYEBROW, title: def.title, description: def.description, actions: key === 'theme' ? siteLink('') : null });

  if (key === 'theme') {
    renderTheme(view, header, def, data);
    return;
  }

  if (key === 'ui') {
    // Тексти інтерфейсу: розбиваємо довгий перелік на зрозумілі блоки
    const pick = (keys) => def.fields.filter((f) => keys.includes(f.key));
    const formKeys = ['formName', 'formContact', 'formDestination', 'formDates', 'formTravelers', 'formMessage', 'formSubmit', 'formSending', 'formSuccess', 'formError', 'formConsent'];
    const contactKeys = ['navCta', 'writeTelegram', 'writeViber', 'writeInstagram', 'call', 'contactMe'];
    const used = new Set([...formKeys, ...contactKeys]);
    view.append(
      header,
      card({ title: 'Кнопки зв’язку', description: 'Написи на кнопках у шапці, блоці контактів і плаваючій кнопці.', children: renderFields(pick(contactKeys), data, key) }),
      card({ title: 'Форма заявки', description: 'Підписи полів і повідомлення, які бачить відвідувач.', children: renderFields(pick(formKeys), data, key) }),
      card({ title: 'Службові написи', description: 'Підказки для програм екранного доступу й мобільного меню.', children: renderFields(def.fields.filter((f) => !used.has(f.key)), data, key) }),
    );
    return;
  }

  if (key === 'contacts') {
    const messengers = ['phone', 'telegram', 'viber', 'instagram', 'email'];
    const contactsCard = card({ title: 'Як з вами зв’язатися', description: 'Заповнені контакти автоматично з’являються на сайті як кнопки. Порожні — не показуються.', children: h('div', { class: 'grid-2' }, renderFields(def.fields.filter((f) => messengers.includes(f.key)), data, key)) });
    linkViberToPhone(contactsCard, data);
    view.append(
      header,
      contactsCard,
      card({ title: 'Місто та графік', children: renderFields(def.fields.filter((f) => !messengers.includes(f.key)), data, key) }),
    );
    return;
  }

  if (key === 'seo') {
    // Без адреси сайту статична копія (публікація, варіант А) не матиме картинки для поширення
    // та посилань на мовні версії; живий сервер підставляє адресу сам.
    const warn = h('div', { class: 'notice', role: 'note' }, icon('info'),
      h('p', { class: 'notice__text' },
        h('strong', { text: 'Адресу сайту ще не вказано. ' }),
        'Поки сайт працює з цього комп’ютера, це нормально. Щойно опублікуєте сайт, впишіть його адресу — інакше в месенджерах не з’явиться картинка-прев’ю, а Google може не пов’язати українську й англійську версії.'));
    const fieldsCard = card({ children: renderFields(def.fields, data, key) });
    const paint = () => {
      warn.hidden = Boolean(String(data.siteUrl || '').trim());
    };
    fieldsCard.addEventListener('fieldchange', (e) => {
      if (e.detail.path === 'seo.siteUrl') paint();
    });
    paint();
    view.append(header, warn, fieldsCard);
    return;
  }

  view.append(header, card({ children: renderFields(def.fields, data, key) }));
}

/* ---------------- Контакти: Viber на тому ж номері ---------------- */

/** +380 67 123 45 67, 067 123 45 67 і +380671234567 — це один номер. */
function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return `38${digits}`;
  return digits;
}

/**
 * Перемикач «Viber на цьому ж номері»: увімкнений (коли номери вже збігаються), він переносить
 * кожну зміну телефону у Viber — інакше клієнти писали б у Viber на старий номер.
 */
function linkViberToPhone(cardEl, data) {
  const viberField = cardEl.querySelector('[data-path="contacts.viber"]');
  const viberInput = viberField && viberField.querySelector('input');
  if (!viberInput || !('phone' in data)) return;
  let linked = Boolean(data.viber) && phoneKey(data.viber) === phoneKey(data.phone);

  const copy = () => {
    if (data.viber === data.phone) return;
    data.viber = data.phone;
    viberInput.value = data.phone || '';
    changed('contacts.viber');
    viberInput.dispatchEvent(new Event('change')); // перевірка формату поля Viber
  };
  let helpId = '';
  const paint = () => {
    viberInput.readOnly = linked;
    viberField.classList.toggle('is-linked', linked);
    describedBy(viberInput, helpId, linked);
  };
  const sw = switchControl({
    checked: linked,
    label: 'Той самий номер, що й телефон',
    help: 'Змінюєте телефон — Viber оновлюється разом із ним',
    onChange: (checked) => {
      linked = checked;
      if (linked) copy();
      paint();
      if (!linked) viberInput.focus();
    },
  });
  const helpEl = sw.root.querySelector('.switch__help');
  if (helpEl) {
    helpEl.id = nextId('help');
    helpId = helpEl.id;
  }
  const errorEl = viberField.querySelector(':scope > .field__error');
  viberField.insertBefore(h('div', { class: 'field__link' }, sw.root), errorEl);
  cardEl.addEventListener('fieldchange', (e) => {
    if (linked && e.detail.path === 'contacts.phone') copy();
  });
  paint();
}

/* ---------------- Дизайн: перевірка контрасту власних кольорів ---------------- */

/*
 * Сайт сам підбирає кольори тексту для власної теми (views/partials/theme-vars.ejs):
 * текст на кнопках — кремовий або темний, дрібні акцентні написи — темніший (світліший) відтінок акценту,
 * на темному фоні — світлий основний текст. Тут та сама формула: перевірка показує те, що буде на сайті,
 * а попереджає лише про випадки, які формула врятувати не може (кольори «середньої» яскравості).
 */
const CREAM = [255, 253, 251];
const INK = [58, 48, 41];
const LIGHT_TEXT = [246, 241, 234];
const MUTED = [116, 103, 92];
const AA = 4.5;

function rgbOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** p — частка кольору a (як у theme-vars.ejs) */
const mixRgb = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));

/** Кольори, які сайт виведе для пари «акцент + фон» (копія формули з views/partials/theme-vars.ejs). */
function siteColors(accent, bg) {
  const darkBg = ratio(INK, bg) < AA && ratio(CREAM, bg) > ratio(INK, bg);
  const onAccent = ratio(CREAM, accent) >= AA || ratio(CREAM, accent) >= ratio(INK, accent) ? CREAM : INK;
  const toward = darkBg ? [255, 255, 255] : [0, 0, 0];
  let strong = mixRgb(accent, toward, 0.78);
  for (let p = 0.78; p >= 0 && ratio(strong, bg) < 4.6; p -= 0.04) strong = mixRgb(accent, toward, Math.max(0, p));
  let text = INK;
  let muted = MUTED;
  if (darkBg) {
    text = LIGHT_TEXT;
    muted = mixRgb(text, bg, 0.72);
    for (let p = 0.72; p <= 1 && ratio(muted, bg) < 4.8; p += 0.04) muted = mixRgb(text, bg, Math.min(1, p));
  } else {
    const bgAlt = mixRgb(bg, accent, 0.9);
    const mutedOk = (m) => ratio(m, bg) >= 4.6 && ratio(mixRgb(m, INK, 0.82), bgAlt) >= AA;
    for (let p = 0.96; p >= 0 && !mutedOk(muted); p -= 0.04) muted = mixRgb(MUTED, INK, Math.max(0, p));
  }
  return { darkBg, onAccent, strong, text, muted };
}

/** Найближчий темніший і світліший відтінки, з якими умова виконується; → '#rrggbb' | null */
function nearest(rgb, ok) {
  for (let t = 0.04; t <= 1.0001; t += 0.04) {
    for (const target of [[0, 0, 0], [255, 255, 255]]) {
      const candidate = mixRgb(target, rgb, t); // t — частка цілі
      if (ok(candidate)) return toHex(candidate);
    }
  }
  return null;
}

function themeContrast(data) {
  const accentHex = rgbOf(data.accent) ? data.accent.toLowerCase() : '#8a6a4a';
  const bgHex = rgbOf(data.background) ? data.background.toLowerCase() : '#f8f4ef';
  const accent = rgbOf(accentHex);
  const bg = rgbOf(bgHex);
  const site = siteColors(accent, bg);
  const buttonsOk = (a) => ratio(siteColors(a, bg).onAccent, a) >= AA;
  const textOk = (b) => ratio(siteColors(accent, b).text, b) >= AA;
  const visibleOk = (a) => ratio(a, bg) >= 1.25; // майже той самий колір, що й фон
  return {
    accentHex,
    bgHex,
    site,
    buttonRatio: ratio(site.onAccent, accent),
    textRatio: ratio(site.text, bg),
    buttonsFine: buttonsOk(accent),
    textFine: textOk(bg),
    visible: visibleOk(accent),
    strongAdjusted: ratio(accent, bg) < 4.6,
    betterAccent: () => nearest(accent, (a) => buttonsOk(a) && visibleOk(a)),
    betterBg: () => nearest(bg, (b) => textOk(b) && ratio(accent, b) >= 1.25),
  };
}

/** Невеликий «шматочок сайту» з цими кольорами — щоб бачити результат до збереження. */
function themePreview() {
  const eyebrow = h('span', { class: 'theme-preview__eyebrow', text: 'Подорожі під ключ' });
  const title = h('span', { class: 'theme-preview__title', text: 'Відпочинок, який запам’ятовується' });
  const text = h('span', { class: 'theme-preview__text', text: 'Так виглядатимуть написи, кнопки й фон на сайті.' });
  const button = h('span', { class: 'theme-preview__btn', text: 'Залишити заявку' });
  const link = h('span', { class: 'theme-preview__link', text: 'Напрямки →' });
  const root = h('div', { class: 'theme-preview', 'aria-hidden': 'true' },
    eyebrow, title, text, h('span', { class: 'theme-preview__row' }, button, link));
  const paint = (c) => {
    const vars = {
      '--p-bg': c.bgHex,
      '--p-accent': c.accentHex,
      '--p-on-accent': toHex(c.site.onAccent),
      '--p-strong': toHex(c.site.strong),
      '--p-ink': toHex(c.site.text),
      '--p-muted': toHex(c.site.muted),
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  };
  return { root, paint };
}

function renderTheme(view, header, def, data) {
  const presetField = def.fields.find((f) => f.key === 'preset');
  const colorFields = def.fields.filter((f) => f.key !== 'preset');
  const colors = h('div', { class: 'grid-2 theme-colors' }, renderFields(colorFields, data, 'theme'));
  const report = h('div', { class: 'contrast', 'aria-live': 'polite' });
  const preview = themePreview();
  const colorsCard = card({
    title: 'Власні кольори',
    description: 'Працюють, коли обрано тему «Власні кольори». Щойно ви зміните колір, тема перемкнеться на неї автоматично.',
    className: 'card--colors',
    headerExtra: h('span', { class: 'badge badge--muted card__state', text: 'Зараз не діють' }),
    children: [colors, preview.root, report],
  });
  const presetCard = card({ title: 'Кольорова тема', children: [renderField(presetField, data, 'theme.preset')] });

  const useColor = (key, value) => {
    data[key] = value;
    changed(`theme.${key}`);
    // Перемальовуємо поля кольорів, щоб вони показали новий відтінок
    replace(colors, ...renderFields(colorFields, data, 'theme'));
    check();
    const field = colors.querySelector(`[data-path="theme.${key}"] .color__hex`);
    if (field) field.focus({ preventScroll: true });
  };

  function check() {
    const custom = data.preset === 'custom';
    report.hidden = !custom;
    preview.root.hidden = !custom;
    if (!custom) {
      report.replaceChildren();
      return;
    }
    const c = themeContrast(data);
    preview.paint(c);
    const suggest = (key, better) => better && h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onClick: () => useColor(key, better) },
      h('span', { class: 'contrast__chip', style: { '--c': better }, 'aria-hidden': 'true' }), h('span', { class: 'btn__label', text: `Використати ${better}` }));
    const rows = [];
    if (!c.textFine) {
      rows.push(h('div', { class: 'contrast__row is-bad' }, icon('alert'),
        h('p', { text: 'Фон середньої яскравості: на ньому погано читається і темний, і світлий текст. Оберіть світліший або темніший фон.' }),
        suggest('background', c.betterBg())));
    }
    if (!c.buttonsFine) {
      rows.push(h('div', { class: 'contrast__row is-bad' }, icon('alert'),
        h('p', { text: 'Напис на кнопках цього кольору читатиметься погано. Оберіть темніший або світліший відтінок акценту.' }),
        suggest('accent', c.betterAccent())));
    } else if (!c.visible) {
      rows.push(h('div', { class: 'contrast__row is-bad' }, icon('alert'),
        h('p', { text: 'Акцент майже зливається з фоном — кнопки й лінії буде погано видно.' }),
        suggest('accent', c.betterAccent())));
    }
    if (!rows.length) {
      rows.push(h('div', { class: 'contrast__row is-ok' }, icon('check'), h('p', { text: 'Текст і кнопки з цими кольорами добре читаються.' })));
      const notes = [];
      if (c.site.onAccent === INK) notes.push('на кнопках буде темний текст');
      if (c.site.darkBg) notes.push('текст на темному фоні стане світлим');
      if (c.strongAdjusted) notes.push(`дрібні акцентні написи стануть трохи ${c.site.darkBg ? 'світлішими' : 'темнішими'} (${toHex(c.site.strong)})`);
      if (notes.length) rows.push(h('p', { class: 'contrast__note', text: `Сайт підлаштується сам: ${notes.join('; ')}.` }));
    }
    replace(report, ...rows);
  }

  const sync = () => {
    colorsCard.classList.toggle('is-inactive', data.preset !== 'custom');
    check();
  };
  presetCard.addEventListener('fieldchange', sync);
  colorsCard.addEventListener('fieldchange', () => {
    if (data.preset !== 'custom') {
      data.preset = 'custom';
      const radio = presetCard.querySelector('input[value="custom"]');
      if (radio) radio.checked = true;
      changed('theme.preset');
    }
    sync();
  });
  sync();

  view.append(header, presetCard, colorsCard,
    h('p', { class: 'page-note' }, icon('info'), 'Фірмова тема «Пісок» підібрана під ваш логотип. Інші теми — спокійні альтернативи; повернутися до фірмової можна будь-коли.'));
}

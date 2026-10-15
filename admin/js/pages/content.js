/**
 * Сторінки редагування контенту: «Структура сторінки», секції сайту та групи налаштувань.
 */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { urls } from '../api.js';
import { state, changed, sectionDef, groupDef, textOf } from '../state.js';
import { pageHeader, card, switchControl, iconButton } from '../ui.js';
import { renderFields, renderField } from '../fields.js';

const SITE_LINK_LABEL = 'Подивитися на сайті';

function siteLink(hash) {
  return h('a', { class: 'btn btn--ghost btn--sm', href: `${urls.site}${hash ? `#${hash}` : ''}`, target: '_blank', rel: 'noopener' },
    h('span', { class: 'btn__label', text: SITE_LINK_LABEL }), icon('external'));
}

/* ---------------- Структура сторінки ---------------- */

export function renderStructure(view) {
  const list = h('ol', { class: 'structure' });

  const render = (focus) => {
    const order = state.draft.order;
    const movable = order.filter((t) => !(sectionDef(t) || {}).pinned);
    list.replaceChildren(...order.map((type, index) => {
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
        order.splice(from, 1);
        order.splice(to, 0, type);
        changed('order');
        render({ type, selector, fallback: selector === '.js-up' ? '.js-down' : '.js-up' });
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
      let el = row && row.querySelector(focus.selector);
      if (el && el.disabled && focus.fallback) el = row.querySelector(focus.fallback);
      if (el) el.focus();
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

  view.append(
    pageHeader({
      eyebrow: `Сторінка · секція ${index + 1} з ${state.draft.order.length}`,
      title: def.title,
      description: def.description,
      actions: siteLink(type),
    }),
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
      card({ title: 'Службові написи', description: 'Переважно для екранних читачів і мобільного меню.', children: renderFields(def.fields.filter((f) => !used.has(f.key)), data, key) }),
    );
    return;
  }

  if (key === 'contacts') {
    const messengers = ['phone', 'telegram', 'viber', 'instagram', 'email'];
    view.append(
      header,
      card({ title: 'Як з вами зв’язатися', description: 'Заповнені контакти автоматично з’являються на сайті як кнопки. Порожні — не показуються.', children: h('div', { class: 'grid-2' }, renderFields(def.fields.filter((f) => messengers.includes(f.key)), data, key)) }),
      card({ title: 'Місто та графік', children: renderFields(def.fields.filter((f) => !messengers.includes(f.key)), data, key) }),
    );
    return;
  }

  view.append(header, card({ children: renderFields(def.fields, data, key) }));
}

function renderTheme(view, header, def, data) {
  const presetField = def.fields.find((f) => f.key === 'preset');
  const colorFields = def.fields.filter((f) => f.key !== 'preset');
  const colors = h('div', { class: 'grid-2 theme-colors' }, renderFields(colorFields, data, 'theme'));
  const colorsCard = card({
    title: 'Власні кольори',
    description: 'Працюють, коли обрано тему «Власні кольори». Щойно ви зміните колір, тема перемкнеться на неї автоматично.',
    className: 'card--colors',
    children: [colors],
  });
  const presetCard = card({ title: 'Кольорова тема', children: [renderField(presetField, data, 'theme.preset')] });

  const sync = () => colorsCard.classList.toggle('is-inactive', data.preset !== 'custom');
  presetCard.addEventListener('fieldchange', sync);
  colorsCard.addEventListener('fieldchange', () => {
    if (data.preset === 'custom') return;
    data.preset = 'custom';
    const radio = presetCard.querySelector('input[value="custom"]');
    if (radio) radio.checked = true;
    changed('theme.preset');
    sync();
  });
  sync();

  view.append(header, presetCard, colorsCard,
    h('p', { class: 'page-note' }, icon('info'), 'Фірмова тема «Пісок» підібрана під ваш логотип. Інші теми — спокійні альтернативи; повернутися до фірмової можна будь-коли.'));
}

/**
 * Спільні елементи інтерфейсу: сповіщення (toast), діалоги, перемикачі, заголовки сторінок.
 */

import { h, focusables } from './dom.js';
import { icon } from './icons.js';

/* ---------------- сповіщення ---------------- */

const TOAST_ICONS = { success: 'check', error: 'alert', info: 'info' };
/** На вузькому екрані показуємо лише одне сповіщення — інакше вони закривають половину форми. */
const NARROW_QUERY = '(max-width: 720px)';
const keyed = new Map(); // key → close()

/**
 * toast('Збережено', { type: 'success' | 'error' | 'info', action: { label, onClick }, timeout, key })
 *
 * key — «тема» сповіщення ('save', 'upload', 'password'…): нове сповіщення з тим самим ключем
 * замінює попереднє (наприклад, «Збережено» прибирає стару помилку збереження).
 * Оголошення для екранних читачів робить контейнер #toasts (aria-live="polite"),
 * тому окремі сповіщення не мають власної ролі (інакше — подвійне читання).
 */
export function toast(message, { type = 'success', action = null, timeout, key } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return () => {};
  const ms = timeout !== undefined ? timeout : (type === 'error' ? 8000 : action ? 7000 : 3800);
  let timer = 0;

  const close = () => {
    clearTimeout(timer);
    if (key && keyed.get(key) === close) keyed.delete(key);
    if (!el.isConnected || el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };

  const el = h('div', { class: ['toast', `toast--${type}`], dataset: { key } },
    h('span', { class: 'toast__icon' }, icon(TOAST_ICONS[type] || 'info')),
    h('p', { class: 'toast__text', text: message }),
    action && h('button', {
      type: 'button',
      class: 'toast__action',
      text: action.label,
      onClick: () => {
        close();
        action.onClick();
      },
    }),
    h('button', { type: 'button', class: 'toast__close', 'aria-label': 'Закрити повідомлення', onClick: close }, icon('close')),
  );

  if (key) closeToast(key, { instant: true });
  const narrow = typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
  // Сповіщення, що вже зникають, не рахуємо
  for (const old of host.querySelectorAll('.toast.is-leaving')) old.remove();
  host.append(el);
  if (key) keyed.set(key, close);
  const limit = narrow ? 1 : 3;
  while (host.children.length > limit) host.firstElementChild.remove();
  if (ms > 0) {
    const start = () => {
      clearTimeout(timer);
      timer = setTimeout(close, ms);
    };
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', start);
    el.addEventListener('focusin', () => clearTimeout(timer));
    el.addEventListener('focusout', start);
    start();
  }
  return close;
}

/** Закриває сповіщення з ключем key (якщо воно ще показане). */
export function closeToast(key, { instant = false } = {}) {
  const host = document.getElementById('toasts');
  if (!host || !key) return;
  keyed.delete(key);
  for (const old of host.querySelectorAll(`.toast[data-key="${CSS.escape(key)}"]`)) {
    if (instant) old.remove();
    else if (!old.classList.contains('is-leaving')) {
      old.classList.add('is-leaving');
      setTimeout(() => old.remove(), 220);
    }
  }
}

/* ---------------- модальні вікна ---------------- */

/**
 * Відкриває модальне вікно (<dialog>).
 * → { dialog, body, footer, close(result) , closed: Promise<result> }
 */
export function openModal({ title, description, size = 'md', className = '', initialFocus } = {}) {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const descId = description ? `${titleId}-desc` : undefined;
  const body = h('div', { class: 'modal__body' });
  const footer = h('div', { class: 'modal__footer' });
  const opener = document.activeElement;

  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let result;

  const dialog = h('dialog', { class: ['modal', `modal--${size}`, className], 'aria-labelledby': titleId, 'aria-describedby': descId },
    h('div', { class: 'modal__panel' },
      h('header', { class: 'modal__header' },
        h('div', { class: 'modal__titles' },
          h('h2', { class: 'modal__title', id: titleId, text: title || '' }),
          description && h('p', { class: 'modal__desc', id: descId, text: description }),
        ),
        h('button', { type: 'button', class: 'icon-btn modal__x', 'aria-label': 'Закрити', onClick: () => close(undefined) }, icon('close')),
      ),
      body,
      footer,
    ),
  );

  function close(value) {
    result = value;
    if (dialog.open) dialog.close();
  }

  dialog.addEventListener('close', () => {
    dialog.remove();
    document.documentElement.classList.toggle('has-modal', !!document.querySelector('dialog.modal[open]'));
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    resolveClosed(result);
  });
  // Клік по затемненню навколо вікна закриває його
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) close(undefined);
  });

  document.body.append(dialog);
  dialog.showModal();
  document.documentElement.classList.add('has-modal');
  requestAnimationFrame(() => {
    const target = initialFocus ? initialFocus() : null;
    const first = target || focusables(body)[0] || focusables(footer)[0];
    if (first) first.focus({ preventScroll: true });
  });

  return { dialog, body, footer, close, closed };
}

/**
 * Власне вікно підтвердження (замість window.confirm).
 * → Promise<boolean>
 */
export function confirmDialog({
  title,
  message = '',
  details = [],
  confirmLabel = 'Так',
  cancelLabel = 'Скасувати',
  danger = false,
} = {}) {
  const modal = openModal({ title, size: 'sm', className: 'modal--confirm' });
  if (message) {
    const messageId = `${modal.dialog.getAttribute('aria-labelledby')}-msg`;
    modal.body.append(h('p', { class: 'modal__message', id: messageId, text: message }));
    modal.dialog.setAttribute('aria-describedby', messageId);
  }
  if (details.length) modal.body.append(h('ul', { class: 'modal__list' }, details.map((d) => h('li', { text: d }))));
  const ok = h('button', { type: 'button', class: ['btn', danger ? 'btn--danger' : 'btn--primary'], text: confirmLabel, onClick: () => modal.close(true) });
  const cancel = h('button', { type: 'button', class: 'btn btn--ghost', text: cancelLabel, onClick: () => modal.close(false) });
  modal.footer.append(cancel, ok);
  requestAnimationFrame(() => (danger ? cancel : ok).focus({ preventScroll: true }));
  return modal.closed.then((v) => v === true);
}

/**
 * Меню дій (на телефоні — панель знизу екрана).
 * actions: [{ label, iconName, danger, disabled, hint }] → Promise<index | null>
 */
export function actionSheet({ title, description, actions }) {
  const modal = openModal({ title, description, size: 'sm', className: 'modal--sheet' });
  const list = h('div', { class: 'sheet', role: 'group', 'aria-label': title });
  actions.forEach((a, i) => {
    if (!a) return;
    list.append(h('button', {
      type: 'button',
      class: ['sheet__btn', a.danger && 'sheet__btn--danger'],
      disabled: a.disabled,
      onClick: () => modal.close(i),
    }, a.iconName && icon(a.iconName), h('span', { class: 'sheet__label', text: a.label }), a.hint && h('span', { class: 'sheet__hint', text: a.hint })));
  });
  modal.body.append(list);
  modal.footer.append(h('button', { type: 'button', class: 'btn btn--ghost', text: 'Закрити', onClick: () => modal.close(null) }));
  return modal.closed.then((v) => (typeof v === 'number' ? v : null));
}

/* ---------------- дрібні компоненти ---------------- */

/** Перемикач «так / ні». onChange(checked) */
export function switchControl({ checked, label, help, onChange, id }) {
  const input = h('input', { type: 'checkbox', class: 'switch__input', role: 'switch', checked: !!checked, id });
  input.addEventListener('change', () => onChange(input.checked));
  const root = h('label', { class: 'switch' },
    input,
    h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' })),
    (label || help) && h('span', { class: 'switch__text' },
      label && h('span', { class: 'switch__label', text: label }),
      help && h('span', { class: 'switch__help', text: help }),
    ),
  );
  return { root, input };
}

/** Кнопка в стані «зачекайте…» */
export function setBusy(btn, busy, busyLabel) {
  if (!btn) return;
  const label = btn.querySelector('.btn__label');
  if (label && !btn.dataset.labelText) btn.dataset.labelText = label.textContent;
  btn.disabled = busy;
  btn.classList.toggle('is-busy', busy);
  if (busy) btn.setAttribute('aria-busy', 'true');
  else btn.removeAttribute('aria-busy');
  if (label) label.textContent = busy && busyLabel ? busyLabel : btn.dataset.labelText;
}

/** Кнопка з іконкою і текстом. */
export function button({ label, iconName, variant = 'secondary', size, onClick, type = 'button', title, className, disabled }) {
  const btn = h('button', {
    type,
    class: ['btn', `btn--${variant}`, size && `btn--${size}`, className],
    title,
    disabled,
    onClick,
  }, iconName && icon(iconName), h('span', { class: 'btn__label', text: label }));
  btn.dataset.labelText = label;
  return btn;
}

/** Квадратна кнопка-іконка з підписом для екранних читачів. */
export function iconButton({ iconName, label, onClick, className, disabled }) {
  return h('button', { type: 'button', class: ['icon-btn', className], 'aria-label': label, title: label, disabled, onClick }, icon(iconName));
}

/** Заголовок сторінки адмінки. */
export function pageHeader({ eyebrow, title, description, actions }) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'page-head__text' },
      eyebrow && h('p', { class: 'page-head__eyebrow', text: eyebrow }),
      h('h1', { class: 'page-head__title', text: title, tabIndex: -1 }),
      description && h('p', { class: 'page-head__desc', text: description }),
    ),
    actions && h('div', { class: 'page-head__actions' }, actions),
  );
}

/** Картка-блок на сторінці. */
export function card({ title, description, className, children = [], headerExtra }) {
  return h('section', { class: ['card', className] },
    (title || description || headerExtra) && h('header', { class: 'card__head' },
      h('div', { class: 'card__titles' },
        title && h('h2', { class: 'card__title', text: title }),
        description && h('p', { class: 'card__desc', text: description }),
      ),
      headerExtra,
    ),
    h('div', { class: 'card__body' }, children),
  );
}

/** Порожній стан. */
export function emptyState({ iconName = 'info', title, text, action }) {
  return h('div', { class: 'empty' },
    h('span', { class: 'empty__icon' }, icon(iconName)),
    h('p', { class: 'empty__title', text: title }),
    text && h('p', { class: 'empty__text', text }),
    action,
  );
}

/** Індикатор завантаження всередині сторінки. */
export function loadingBlock(text = 'Завантаження…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text }));
}

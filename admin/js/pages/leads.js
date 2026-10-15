/**
 * Сторінка «Заявки»: заявки з форми на сайті, найновіші першими.
 */

import { h, formatDate, plural, nextId } from '../dom.js';
import { icon } from '../icons.js';
import { api, urls } from '../api.js';
import { state, emit, on } from '../state.js';
import { pageHeader, toast, confirmDialog, emptyState, loadingBlock, button } from '../ui.js';

export const STATUSES = [
  { value: 'new', label: 'Нова', plural: 'Нові' },
  { value: 'in_progress', label: 'У роботі', plural: 'У роботі' },
  { value: 'done', label: 'Завершена', plural: 'Завершені' },
];

const UNDO_MS = 8000;
/** Заявки, видалені щойно: справжнє видалення на сервері — через кілька секунд, щоб можна було «Повернути». */
const pendingRemovals = new Map(); // id → { timer, lead }

export async function loadLeads({ background = false } = {}) {
  const leads = await api.get('leads', { auth: !background });
  state.leads = (Array.isArray(leads) ? leads : []).filter((l) => !pendingRemovals.has(l.id));
  state.leadsLoaded = true;
  emit('leads');
  return state.leads;
}

const byNewest = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

function putBack(lead) {
  if (state.leads.some((l) => l.id === lead.id)) return;
  state.leads = [...state.leads, lead].sort(byNewest);
  emit('leads');
}

function commitRemoval(id) {
  const pending = pendingRemovals.get(id);
  if (!pending) return Promise.resolve();
  clearTimeout(pending.timer);
  pendingRemovals.delete(id);
  return api.del(`leads/${encodeURIComponent(id)}`).catch((err) => {
    if (err.status === 404) return; // уже видалено
    putBack(pending.lead);
    toast(`Заявку від «${pending.lead.name}» не вдалося видалити: ${err.message}`, { type: 'error' });
  });
}

/** Остаточно видаляє все, що чекає на «Повернути» (перед виходом з адмінки). */
export function flushLeadRemovals() {
  return Promise.all([...pendingRemovals.keys()].map(commitRemoval));
}

// Закрили вкладку, поки висить «Повернути», — видаляємо одразу (keepalive доживе до кінця запиту)
window.addEventListener('pagehide', () => {
  for (const [id, pending] of pendingRemovals) {
    clearTimeout(pending.timer);
    try {
      fetch(`${urls.api}leads/${encodeURIComponent(id)}`, {
        method: 'DELETE', keepalive: true, credentials: 'same-origin', headers: { 'X-Admin-Request': '1' },
      }).catch(() => {});
    } catch {
      // ignore
    }
  }
  pendingRemovals.clear();
});

async function removeLead(lead) {
  if (pendingRemovals.has(lead.id)) return;
  const ok = await confirmDialog({
    title: 'Видалити заявку?',
    message: `Заявку від «${lead.name || 'Без імені'}» буде видалено. Ще кілька секунд після цього її можна буде повернути.`,
    confirmLabel: 'Видалити',
    danger: true,
  });
  if (!ok || pendingRemovals.has(lead.id)) return;
  state.leads = state.leads.filter((l) => l.id !== lead.id);
  emit('leads');
  pendingRemovals.set(lead.id, { lead, timer: setTimeout(() => commitRemoval(lead.id), UNDO_MS) });
  toast(`Заявку від «${lead.name || 'Без імені'}» видалено`, {
    type: 'info',
    timeout: UNDO_MS,
    key: `lead-remove-${lead.id}`,
    action: {
      label: 'Повернути',
      onClick: () => {
        const pending = pendingRemovals.get(lead.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingRemovals.delete(lead.id);
        putBack(lead);
        toast('Заявку повернуто', { type: 'info', key: `lead-remove-${lead.id}` });
      },
    },
  });
}

function replaceLead(updated) {
  state.leads = state.leads.map((l) => (l.id === updated.id ? { ...l, ...updated } : l));
  emit('leads');
}

/** Телефон / Telegram / email → посилання, на яке можна натиснути. */
export function contactLinks(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return [{ href: `mailto:${value}`, label: value, iconName: 'mail' }];
  const tg = value.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\/?$/i)
    || value.match(/^@([A-Za-z0-9_]{4,32})$/)
    || (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value) ? [value, value] : null);
  if (tg) return [{ href: `https://t.me/${tg[1]}`, label: `@${tg[1]}`, iconName: 'telegram', external: true }];
  const digits = value.replace(/\D/g, '');
  if (/^\+?[\d\s()\-.]{7,}$/.test(value) && digits.length >= 9 && digits.length <= 15) {
    let intl = value.trim().startsWith('+') ? `+${digits}` : digits;
    if (!intl.startsWith('+')) {
      if (digits.startsWith('380')) intl = `+${digits}`;
      else if (digits.length === 10 && digits.startsWith('0')) intl = `+38${digits}`;
    }
    const links = [{ href: `tel:${intl}`, label: value, iconName: 'phone' }];
    if (intl.startsWith('+')) links.push({ href: `viber://chat?number=${encodeURIComponent(intl)}`, label: 'Viber', iconName: 'phone', small: true });
    return links;
  }
  return [];
}

export function renderLeadsPage(view) {
  let filter = 'all';
  let lastSignature = '';
  let seen = null; // id заявок, які вже були на екрані, — нові підсвічуємо
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Фільтр за статусом' });
  const listEl = h('div', { class: 'leads' });
  const refreshBtn = button({
    label: 'Оновити',
    iconName: 'refresh',
    variant: 'secondary',
    onClick: async () => {
      refreshBtn.disabled = true;
      try {
        await loadLeads();
      } catch (err) {
        toast(err.message, { type: 'error' });
      } finally {
        refreshBtn.disabled = false;
      }
    },
  });

  view.append(
    pageHeader({
      eyebrow: 'Клієнти',
      title: 'Заявки',
      description: 'Заявки, залишені через форму на сайті. Змінюйте статус, щоб не загубити жодного клієнта.',
      actions: refreshBtn,
    }),
    chips,
    listEl,
  );

  function renderChips() {
    const counts = { all: state.leads.length };
    for (const st of STATUSES) counts[st.value] = state.leads.filter((l) => l.status === st.value).length;
    const opts = [['all', 'Усі'], ...STATUSES.map((st) => [st.value, st.plural])];
    chips.replaceChildren(...opts.map(([key, label]) => h('button', {
      type: 'button',
      class: ['chip', filter === key && 'is-active', key === 'new' && counts.new && 'chip--accent'],
      'aria-pressed': String(filter === key),
      dataset: { ctl: `chip-${key}` },
      onClick: () => {
        filter = key;
        render({ force: true });
      },
    }, label, h('span', { class: 'chip__count', text: String(counts[key]) }))));
  }

  function noteEditor(lead) {
    const id = nextId('note');
    const statusEl = h('span', { class: 'lead__note-state', 'aria-live': 'polite' });
    const input = h('textarea', {
      id, class: 'input lead__note-input', rows: 2, maxLength: 1000,
      placeholder: 'Наприклад: передзвонити в п’ятницю, бюджет до 2000 €',
      dataset: { ctl: 'note' },
    });
    input.value = lead.note;
    let savedValue = lead.note;
    const saveNote = async () => {
      const value = input.value.trim();
      if (value === savedValue.trim()) return;
      statusEl.textContent = 'Зберігаємо…';
      try {
        const updated = await api.patch(`leads/${encodeURIComponent(lead.id)}`, { note: value });
        savedValue = value;
        statusEl.textContent = 'Збережено';
        replaceLead(updated || { id: lead.id, note: value });
      } catch (err) {
        statusEl.textContent = '';
        toast(err.message, { type: 'error', key: 'lead-note' });
      }
    };
    input.addEventListener('change', saveNote);
    return h('div', { class: 'lead__note' },
      h('div', { class: 'lead__note-head' }, h('label', { class: 'lead__note-label', for: id, text: 'Нотатка для себе' }), statusEl),
      input);
  }

  function leadCard(lead, fresh) {
    const statusDef = STATUSES.find((st) => st.value === lead.status) || STATUSES[0];
    const select = h('select', { class: 'input select select--sm', 'aria-label': `Статус заявки від ${lead.name}`, dataset: { ctl: 'status' } },
      STATUSES.map((st) => h('option', { value: st.value, text: st.label })));
    select.value = lead.status;
    select.addEventListener('change', async () => {
      const previous = lead.status;
      select.disabled = true;
      try {
        const updated = await api.patch(`leads/${encodeURIComponent(lead.id)}`, { status: select.value });
        const label = (STATUSES.find((st) => st.value === ((updated && updated.status) || select.value)) || {}).label || '';
        // Замінюємо заявку в списку за id (а не змінюємо старий об'єкт, який після фонового оновлення вже не в списку)
        replaceLead(updated && updated.id ? updated : { id: lead.id, status: select.value });
        toast(`Статус змінено: ${label}`, { key: 'lead-status' });
      } catch (err) {
        select.value = previous;
        select.disabled = false;
        toast(err.message, { type: 'error', key: 'lead-status' });
      }
    });

    const links = contactLinks(lead.contact);
    const details = [
      ['Куди', lead.destination],
      ['Дати', lead.dates],
      ['Скільки людей', lead.travelers],
    ].filter(([, v]) => v);

    return h('article', { class: ['lead', `lead--${lead.status}`, fresh && 'is-fresh'], dataset: { leadId: lead.id } },
      h('header', { class: 'lead__head' },
        h('div', { class: 'lead__who' },
          h('h3', { class: 'lead__name', text: lead.name || 'Без імені' }),
          h('p', { class: 'lead__date' },
            h('time', { dateTime: lead.createdAt, text: formatDate(lead.createdAt) }),
            lead.lang === 'en' ? ' · з англійської версії' : null),
        ),
        h('span', { class: ['badge', lead.status === 'new' ? 'badge--accent' : lead.status === 'done' ? 'badge--success' : 'badge--muted'], text: fresh ? `${statusDef.label} · щойно` : statusDef.label })),
      h('p', { class: 'lead__contact' },
        links.length
          ? links.map((l) => h('a', {
            class: ['lead__link', l.small && 'lead__link--small'],
            href: l.href,
            target: l.external ? '_blank' : undefined,
            rel: l.external ? 'noopener' : undefined,
          }, icon(l.iconName), h('span', { text: l.label })))
          : h('span', { class: 'lead__link lead__link--plain' }, icon('phone'), h('span', { text: lead.contact }))),
      details.length ? h('dl', { class: 'lead__details' }, details.map(([k, v]) => h('div', { class: 'lead__detail' }, h('dt', { text: k }), h('dd', { text: v })))) : null,
      lead.message ? h('blockquote', { class: 'lead__message', text: lead.message }) : null,
      // Нотатки — лише якщо сервер їх підтримує (поле note є в заявці)
      typeof lead.note === 'string' ? noteEditor(lead) : null,
      h('footer', { class: 'lead__foot' },
        h('label', { class: 'lead__status' }, h('span', { text: 'Статус' }), h('span', { class: 'select-wrap select-wrap--sm' }, select, icon('chevron', 'i select-wrap__chev'))),
        h('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm btn--danger-text',
          dataset: { ctl: 'remove' },
          'aria-label': `Видалити заявку від ${lead.name || 'клієнта'}`,
          onClick: () => removeLead(lead),
        }, icon('trash'), h('span', { class: 'btn__label', text: 'Видалити' }))));
  }

  /** Що зараз у фокусі (щоб після оновлення списку повернути фокус туди ж). */
  function captureFocus() {
    const active = document.activeElement;
    if (!active || !view.contains(active)) return null;
    const card = active.closest('[data-lead-id]');
    return { leadId: card ? card.dataset.leadId : '', ctl: active.dataset.ctl || '' };
  }

  function restoreFocus(info) {
    if (!info || !info.ctl) return;
    const scope = info.leadId ? listEl.querySelector(`[data-lead-id="${CSS.escape(info.leadId)}"]`) : chips;
    const target = scope && scope.querySelector(`[data-ctl="${CSS.escape(info.ctl)}"]`);
    if (target) target.focus({ preventScroll: true });
  }

  function render({ force = false } = {}) {
    // Фонове оновлення без змін нічого не перемальовує (не збиває відкритий список статусів чи введення нотатки)
    const signature = JSON.stringify([filter, state.leads]);
    if (!force && signature === lastSignature) return;
    const active = document.activeElement;
    if (!force && active && active.matches && active.matches('.lead__note-input') && listEl.contains(active)) return;
    lastSignature = signature;
    const focusInfo = captureFocus();
    const firstRender = seen === null;
    if (firstRender) seen = new Set(state.leads.map((l) => l.id));

    renderChips();
    const visible = state.leads.filter((l) => filter === 'all' || l.status === filter);
    if (!state.leads.length) {
      listEl.replaceChildren(emptyState({
        iconName: 'inbox',
        title: 'Поки що заявок немає',
        text: 'Щойно хтось заповнить форму на сайті, заявка з’явиться тут. Щоб дізнаватися про нові заявки миттєво, увімкніть сповіщення в Telegram у розділі «Безпека».',
        action: h('a', { class: 'btn btn--secondary', href: '#/security' }, icon('bell'), h('span', { class: 'btn__label', text: 'Налаштувати сповіщення' })),
      }));
    } else if (!visible.length) {
      const label = (STATUSES.find((st) => st.value === filter) || {}).plural || '';
      listEl.replaceChildren(emptyState({ iconName: 'inbox', title: `Немає заявок у розділі «${label}»` }));
    } else {
      listEl.replaceChildren(
        h('p', { class: 'muted leads__count', text: `${visible.length} ${plural(visible.length, ['заявка', 'заявки', 'заявок'])}` }),
        ...visible.map((lead) => leadCard(lead, !seen.has(lead.id))),
      );
    }
    for (const l of state.leads) seen.add(l.id);
    restoreFocus(focusInfo);
  }

  // Список оновлюється сам: після фонової перевірки нових заявок, зміни статусу, видалення чи «Повернути»
  const off = on('leads', () => {
    if (!listEl.isConnected) {
      off();
      return;
    }
    render();
  });

  if (state.leadsLoaded) render();
  else listEl.append(loadingBlock());
  loadLeads().catch((err) => {
    if (!state.leadsLoaded) listEl.replaceChildren(emptyState({ iconName: 'alert', title: 'Не вдалося завантажити заявки', text: err.message }));
    else toast(err.message, { type: 'error' });
  });
}

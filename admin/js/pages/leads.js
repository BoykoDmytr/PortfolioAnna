/**
 * Сторінка «Заявки»: заявки з форми на сайті, найновіші першими.
 */

import { h, formatDate, plural } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, emit } from '../state.js';
import { pageHeader, toast, confirmDialog, emptyState, loadingBlock, button } from '../ui.js';

export const STATUSES = [
  { value: 'new', label: 'Нова', plural: 'Нові' },
  { value: 'in_progress', label: 'В роботі', plural: 'В роботі' },
  { value: 'done', label: 'Завершена', plural: 'Завершені' },
];

export async function loadLeads({ background = false } = {}) {
  const leads = await api.get('leads', { auth: !background });
  state.leads = Array.isArray(leads) ? leads : [];
  state.leadsLoaded = true;
  emit('leads');
  return state.leads;
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
        render();
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
    for (const s of STATUSES) counts[s.value] = state.leads.filter((l) => l.status === s.value).length;
    const opts = [['all', 'Усі'], ...STATUSES.map((s) => [s.value, s.plural])];
    chips.replaceChildren(...opts.map(([key, label]) => h('button', {
      type: 'button',
      class: ['chip', filter === key && 'is-active', key === 'new' && counts.new && 'chip--accent'],
      'aria-pressed': String(filter === key),
      onClick: () => {
        filter = key;
        render();
      },
    }, label, h('span', { class: 'chip__count', text: String(counts[key]) }))));
  }

  function leadCard(lead) {
    const statusDef = STATUSES.find((s) => s.value === lead.status) || STATUSES[0];
    const select = h('select', { class: 'input select select--sm', 'aria-label': `Статус заявки від ${lead.name}` },
      STATUSES.map((s) => h('option', { value: s.value, text: s.label })));
    select.value = lead.status;
    select.addEventListener('change', async () => {
      const previous = lead.status;
      select.disabled = true;
      try {
        const updated = await api.patch(`leads/${encodeURIComponent(lead.id)}`, { status: select.value });
        Object.assign(lead, updated || { status: select.value });
        emit('leads');
        toast(`Статус змінено: ${(STATUSES.find((s) => s.value === lead.status) || {}).label || ''}`);
        render();
      } catch (err) {
        select.value = previous;
        select.disabled = false;
        toast(err.message, { type: 'error' });
      }
    });

    const remove = async () => {
      const ok = await confirmDialog({
        title: 'Видалити заявку?',
        message: `Заявку від «${lead.name}» буде видалено назавжди.`,
        confirmLabel: 'Видалити',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`leads/${encodeURIComponent(lead.id)}`);
        state.leads = state.leads.filter((l) => l.id !== lead.id);
        emit('leads');
        toast('Заявку видалено');
        render();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    };

    const links = contactLinks(lead.contact);
    const details = [
      ['Куди', lead.destination],
      ['Дати', lead.dates],
      ['Скільки людей', lead.travelers],
    ].filter(([, v]) => v);

    return h('article', { class: ['lead', `lead--${lead.status}`] },
      h('header', { class: 'lead__head' },
        h('div', { class: 'lead__who' },
          h('h3', { class: 'lead__name', text: lead.name || 'Без імені' }),
          h('p', { class: 'lead__date' },
            h('time', { dateTime: lead.createdAt, text: formatDate(lead.createdAt) }),
            lead.lang === 'en' ? ' · з англійської версії' : ''),
        ),
        h('span', { class: ['badge', lead.status === 'new' ? 'badge--accent' : lead.status === 'done' ? 'badge--success' : 'badge--muted'], text: statusDef.label })),
      h('p', { class: 'lead__contact' },
        links.length
          ? links.map((l) => h('a', {
            class: ['lead__link', l.small && 'lead__link--small'],
            href: l.href,
            target: l.external ? '_blank' : undefined,
            rel: l.external ? 'noopener' : undefined,
          }, icon(l.iconName), h('span', { text: l.label })))
          : h('span', { class: 'lead__link lead__link--plain' }, icon('phone'), h('span', { text: lead.contact }))),
      details.length && h('dl', { class: 'lead__details' }, details.map(([k, v]) => h('div', { class: 'lead__detail' }, h('dt', { text: k }), h('dd', { text: v })))),
      lead.message && h('blockquote', { class: 'lead__message', text: lead.message }),
      h('footer', { class: 'lead__foot' },
        h('label', { class: 'lead__status' }, h('span', { text: 'Статус' }), h('span', { class: 'select-wrap select-wrap--sm' }, select, icon('chevron', 'i select-wrap__chev'))),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm btn--danger-text', onClick: remove }, icon('trash'), h('span', { class: 'btn__label', text: 'Видалити' }))));
  }

  function render() {
    renderChips();
    const visible = state.leads.filter((l) => filter === 'all' || l.status === filter);
    if (!state.leads.length) {
      listEl.replaceChildren(emptyState({
        iconName: 'inbox',
        title: 'Поки що заявок немає',
        text: 'Щойно хтось заповнить форму на сайті, заявка з’явиться тут. Щоб дізнаватися про нові заявки миттєво, увімкніть сповіщення в Telegram у розділі «Безпека».',
        action: h('a', { class: 'btn btn--secondary', href: '#/security' }, icon('bell'), h('span', { class: 'btn__label', text: 'Налаштувати сповіщення' })),
      }));
      return;
    }
    if (!visible.length) {
      const label = (STATUSES.find((s) => s.value === filter) || {}).plural || '';
      listEl.replaceChildren(emptyState({ iconName: 'inbox', title: `Немає заявок у розділі «${label}»` }));
      return;
    }
    listEl.replaceChildren(
      h('p', { class: 'muted leads__count', text: `${visible.length} ${plural(visible.length, ['заявка', 'заявки', 'заявок'])}` }),
      ...visible.map(leadCard),
    );
  }

  if (state.leadsLoaded) render();
  else listEl.append(loadingBlock());
  loadLeads().then(render).catch((err) => {
    listEl.replaceChildren(emptyState({ iconName: 'alert', title: 'Не вдалося завантажити заявки', text: err.message }));
  });
}

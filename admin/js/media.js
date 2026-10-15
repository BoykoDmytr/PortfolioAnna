/**
 * Фото: завантаження, вибір з медіатеки (модальне вікно) і сторінка «Медіатека».
 */

import { h, formatBytes, plural } from './dom.js';
import { icon } from './icons.js';
import { api, assetUrl, checkUploadFile, uploadImage, ApiError } from './api.js';
import { state, imageRefs, removeImageFromDraft, computeDirty, emit } from './state.js';
import { toast, openModal, confirmDialog, button, pageHeader, emptyState, loadingBlock } from './ui.js';

export const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/gif,.jpg,.jpeg,.png,.webp,.avif,.gif';

/* ---------------- дані ---------------- */

export async function loadMedia(force = false) {
  if (state.media && !force) return state.media;
  state.media = await api.get('media');
  return state.media;
}

function rememberUpload(result) {
  if (!state.media) return;
  state.media = [
    { name: result.name, url: result.url, size: result.size, width: result.width, height: result.height, mtime: new Date().toISOString(), used: false },
    ...state.media.filter((m) => m.name !== result.name),
  ];
}

const isUsed = (item, draftRefs) => Boolean(item.used) || draftRefs.has(item.url);

/** Вибір файлів через системне вікно. → Promise<File[]> */
export function chooseFiles({ multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: ACCEPT, multiple, hidden: true });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/**
 * Завантажує один файл з перевіркою. onProgress(0..1)
 * → результат сервера або null (помилку вже показано)
 */
export async function uploadOne(file, { purpose = 'photo', onProgress } = {}) {
  const problem = checkUploadFile(file);
  if (problem) {
    toast(problem, { type: 'error' });
    return null;
  }
  try {
    const result = await uploadImage(file, { purpose, onProgress });
    rememberUpload(result);
    return result;
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Не вдалося завантажити фото. Спробуйте ще раз.', { type: 'error' });
    return null;
  }
}

/** Черга завантажень з рядком прогресу для кожного файлу. → успішні результати */
async function uploadMany(files, queueEl) {
  const results = [];
  for (const file of files) {
    const bar = h('span', { class: 'upq__bar' });
    const status = h('span', { class: 'upq__status', text: 'Очікує…' });
    const row = h('li', { class: 'upq__row' },
      h('span', { class: 'upq__name', text: file.name }),
      status,
      h('span', { class: 'upq__track' }, bar),
    );
    queueEl.append(row);
    queueEl.hidden = false;
    status.textContent = 'Завантаження…';
    const result = await uploadOne(file, {
      onProgress: (p) => {
        bar.style.width = `${Math.round(p * 100)}%`;
        if (p >= 1) status.textContent = 'Обробка…';
      },
    });
    if (result) {
      row.classList.add('is-done');
      status.textContent = 'Готово';
      bar.style.width = '100%';
      results.push(result);
    } else {
      row.classList.add('is-failed');
      status.textContent = 'Не вдалося';
    }
  }
  const cleanup = (selector) => {
    for (const row of queueEl.querySelectorAll(selector)) row.remove();
    if (!queueEl.children.length) queueEl.hidden = true;
  };
  setTimeout(() => cleanup('.is-done'), 2500);
  setTimeout(() => cleanup('.is-failed'), 10000);
  return results;
}

/* ---------------- видалення ---------------- */

/** → true, якщо файл видалено */
export async function deleteMedia(item) {
  const draftRefs = imageRefs(state.draft);
  const used = isUsed(item, draftRefs);
  const ok = await confirmDialog({
    title: 'Видалити фото?',
    message: used
      ? 'Це фото зараз використовується на сайті. Після видалення ми приберемо його з усіх полів — вам залишиться натиснути «Зберегти зміни» (і за потреби обрати інше фото).'
      : 'Файл буде видалено з медіатеки назавжди.',
    confirmLabel: used ? 'Все одно видалити' : 'Видалити',
    danger: true,
  });
  if (!ok) return false;

  const remove = (force) => api.del(`media/${encodeURIComponent(item.name)}${force ? '?force=1' : ''}`);
  try {
    await remove(used);
  } catch (err) {
    if (err.status === 409) {
      const again = await confirmDialog({
        title: 'Фото використовується',
        message: err.message,
        confirmLabel: 'Видалити',
        danger: true,
      });
      if (!again) return false;
      try {
        await remove(true);
      } catch (err2) {
        toast(err2.message, { type: 'error' });
        return false;
      }
    } else {
      toast(err.message, { type: 'error' });
      return false;
    }
  }

  if (state.media) state.media = state.media.filter((m) => m.name !== item.name);
  const cleared = removeImageFromDraft(item.url);
  if (cleared) {
    computeDirty();
    emit('draft-replaced');
    toast(`Фото видалено і прибрано з ${cleared} ${plural(cleared, ['поля', 'полів', 'полів'])}. Натисніть «Зберегти зміни», щоб оновити сайт.`, { type: 'info', timeout: 9000 });
  } else {
    toast('Фото видалено');
  }
  return true;
}

/* ---------------- вибір з медіатеки ---------------- */

/**
 * Модальне вікно медіатеки. → Promise<url | null>
 */
export function pickImage({ current = '', purpose = 'photo', title = 'Оберіть фото' } = {}) {
  const modal = openModal({ title, description: 'Натисніть на фото, щоб використати його, або завантажте нове.', size: 'lg', className: 'modal--media' });
  const grid = h('div', { class: 'media-grid media-grid--pick' });
  const uploadBtn = button({
    label: 'Завантажити нове фото',
    iconName: 'upload',
    variant: 'secondary',
    onClick: async () => {
      const [file] = await chooseFiles();
      if (!file) return;
      uploadBtn.disabled = true;
      progress.hidden = false;
      const result = await uploadOne(file, { purpose, onProgress: (p) => { progressBar.style.width = `${Math.round(p * 100)}%`; } });
      uploadBtn.disabled = false;
      progress.hidden = true;
      progressBar.style.width = '0';
      if (result) modal.close(result.url);
    },
  });
  const progressBar = h('span', { class: 'progress__bar' });
  const progress = h('div', { class: 'progress', hidden: true }, progressBar);
  modal.body.append(h('div', { class: 'media-pick__bar' }, uploadBtn, progress), grid);
  modal.footer.append(h('button', { type: 'button', class: 'btn btn--ghost', text: 'Скасувати', onClick: () => modal.close(null) }));

  grid.append(loadingBlock('Завантажуємо медіатеку…'));
  loadMedia(true).then((items) => {
    grid.replaceChildren();
    if (!items.length) {
      grid.append(emptyState({ iconName: 'images', title: 'Медіатека поки порожня', text: 'Завантажте перше фото кнопкою вище.' }));
      return;
    }
    const draftRefs = imageRefs(state.draft);
    for (const item of items) {
      const selected = item.url === current;
      grid.append(h('button', {
        type: 'button',
        class: ['media-tile', selected && 'is-selected'],
        'aria-pressed': selected ? 'true' : 'false',
        title: item.name,
        onClick: () => modal.close(item.url),
      },
      h('span', { class: 'media-tile__img' }, h('img', { src: assetUrl(item.url), alt: '', loading: 'lazy', decoding: 'async' })),
      h('span', { class: 'media-tile__meta' },
        h('span', { class: 'media-tile__name', text: item.name }),
        h('span', { class: 'media-tile__size', text: item.width && item.height ? `${item.width}×${item.height}` : formatBytes(item.size) }),
      ),
      isUsed(item, draftRefs) && h('span', { class: 'media-tile__badge', text: 'на сайті' }),
      selected && h('span', { class: 'media-tile__check' }, icon('check'))));
    }
  }).catch((err) => {
    grid.replaceChildren(emptyState({ iconName: 'alert', title: 'Не вдалося відкрити медіатеку', text: err.message }));
  });

  return modal.closed.then((v) => (typeof v === 'string' ? v : null));
}

/* ---------------- сторінка «Медіатека» ---------------- */

export function renderMediaPage(view) {
  let filter = 'all';
  const queue = h('ul', { class: 'upq', hidden: true, 'aria-live': 'polite' });
  const filters = h('div', { class: 'chips', role: 'group', 'aria-label': 'Фільтр' });
  const grid = h('div', { class: 'media-grid' });
  const summary = h('p', { class: 'muted media-summary' });

  const startUpload = async (files) => {
    if (!files.length) return;
    const results = await uploadMany(files, queue);
    if (results.length) {
      toast(results.length === 1 ? 'Фото завантажено' : `Завантажено ${results.length} ${plural(results.length, ['фото', 'фото', 'фото'])}`);
      await refresh();
    }
  };

  const uploadBtn = button({
    label: 'Завантажити фото',
    iconName: 'upload',
    variant: 'primary',
    onClick: async () => startUpload(await chooseFiles({ multiple: true })),
  });

  const drop = h('div', { class: 'dropzone', tabIndex: 0, role: 'button', 'aria-label': 'Завантажити фото: натисніть або перетягніть файли сюди' },
    h('span', { class: 'dropzone__icon' }, icon('upload')),
    h('span', { class: 'dropzone__title', text: 'Перетягніть фото сюди' }),
    h('span', { class: 'dropzone__hint', text: 'або натисніть, щоб обрати на комп’ютері чи телефоні. JPG, PNG, WebP — до 15 МБ. Фото автоматично стискаються.' }),
  );
  const openPicker = async () => startUpload(await chooseFiles({ multiple: true }));
  drop.addEventListener('click', openPicker);
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });
  bindDrop(drop, (files) => startUpload(files));

  view.append(
    pageHeader({
      eyebrow: 'Файли',
      title: 'Медіатека',
      description: 'Усі фото сайту в одному місці. Фото з позначкою «На сайті» зараз використовуються на сторінці.',
      actions: uploadBtn,
    }),
    h('section', { class: 'card card--drop' }, h('div', { class: 'card__body' }, drop)),
    queue,
    h('div', { class: 'media-toolbar' }, filters, summary),
    grid,
  );

  function renderFilters(items, draftRefs) {
    const usedCount = items.filter((i) => isUsed(i, draftRefs)).length;
    const opts = [
      ['all', 'Усі', items.length],
      ['used', 'На сайті', usedCount],
      ['unused', 'Не використовуються', items.length - usedCount],
    ];
    filters.replaceChildren(...opts.map(([key, label, count]) => h('button', {
      type: 'button',
      class: ['chip', filter === key && 'is-active'],
      'aria-pressed': filter === key ? 'true' : 'false',
      onClick: () => {
        filter = key;
        render();
      },
    }, label, h('span', { class: 'chip__count', text: String(count) }))));
    const total = items.reduce((sum, i) => sum + (Number(i.size) || 0), 0);
    summary.textContent = items.length ? `${items.length} ${plural(items.length, ['файл', 'файли', 'файлів'])} · ${formatBytes(total)}` : '';
  }

  function render() {
    const items = state.media || [];
    const draftRefs = imageRefs(state.draft);
    renderFilters(items, draftRefs);
    const visible = items.filter((i) => filter === 'all' || (filter === 'used') === isUsed(i, draftRefs));
    grid.replaceChildren();
    if (!items.length) {
      grid.append(emptyState({ iconName: 'images', title: 'Тут поки немає фото', text: 'Завантажте фото — потім їх можна буде обрати в будь-якому розділі сайту.' }));
      return;
    }
    if (!visible.length) {
      grid.append(emptyState({ iconName: 'images', title: filter === 'used' ? 'Жодне фото не використовується' : 'Усі фото використовуються на сайті' }));
      return;
    }
    for (const item of visible) {
      const used = isUsed(item, draftRefs);
      grid.append(h('article', { class: 'media-card' },
        h('a', { class: 'media-card__img', href: assetUrl(item.url), target: '_blank', rel: 'noopener', title: 'Відкрити в повному розмірі' },
          h('img', { src: assetUrl(item.url), alt: item.name, loading: 'lazy', decoding: 'async' })),
        h('div', { class: 'media-card__body' },
          h('p', { class: 'media-card__name', text: item.name, title: item.name }),
          h('p', { class: 'media-card__meta', text: [item.width && item.height ? `${item.width}×${item.height}` : '', formatBytes(item.size)].filter(Boolean).join(' · ') }),
          h('div', { class: 'media-card__foot' },
            h('span', { class: ['badge', used ? 'badge--accent' : 'badge--muted'], text: used ? 'На сайті' : 'Не на сайті', title: used ? 'Фото використовується на сайті' : 'Фото зараз ніде не використовується — його можна видалити' }),
            h('button', {
              type: 'button',
              class: 'icon-btn icon-btn--danger',
              'aria-label': `Видалити ${item.name}`,
              title: 'Видалити',
              onClick: async () => {
                if (await deleteMedia(item)) render();
              },
            }, icon('trash')),
          ),
        )));
    }
  }

  async function refresh() {
    try {
      await loadMedia(true);
      render();
    } catch (err) {
      grid.replaceChildren(emptyState({ iconName: 'alert', title: 'Не вдалося завантажити медіатеку', text: err.message }));
    }
  }

  grid.append(loadingBlock());
  refresh();
}

/** Перетягування файлів на елемент. */
export function bindDrop(el, onFiles) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    depth += 1;
    el.classList.add('is-dragover');
  });
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) el.classList.remove('is-dragover');
  });
  el.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    depth = 0;
    el.classList.remove('is-dragover');
    onFiles([...e.dataTransfer.files]);
  });
}

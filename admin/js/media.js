/**
 * Фото: завантаження, вибір з медіатеки (модальне вікно) і сторінка «Медіатека».
 */

import { h, formatBytes, plural, clone, isTouch } from './dom.js';
import { icon } from './icons.js';
import { api, assetUrl, checkUploadFile, uploadImage, ApiError, UPLOAD_MAX_BYTES } from './api.js';
import {
  state, imageRefs, removeImageFromDraft, computeDirty, emit, trackUpload, rebaseDraft, routeForPath, unitLabel,
} from './state.js';
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

/* ---------------- підготовка фото на пристрої ---------------- */

/** Сервер однаково зменшує фото до 2400 px (логотип — до 800 px), тож великі файли з телефона стискаємо ще до відправлення. */
const MAX_SIDE = { photo: 2400, logo: 800 };
const SHRINK_OVER_BYTES = 6 * 1024 * 1024;
const extOf = (file) => ((file.name || '').split('.').pop() || '').toLowerCase();
const isHeic = (file) => ['heic', 'heif'].includes(extOf(file)) || /heic|heif/i.test(file.type || '');

/** Перемальовує фото меншим JPEG (з урахуванням повороту з EXIF). → File або null, якщо браузер не впорався. */
async function shrinkImage(file, purpose) {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
  try {
    const max = MAX_SIDE[purpose] || MAX_SIDE.photo;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff'; // JPEG не має прозорості
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) return null;
    const base = (file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

/**
 * Перевіряє файл і за потреби зменшує його / переводить HEIC у JPEG (якщо браузер уміє його відкрити).
 * → { file } або { error }
 */
export async function prepareUpload(file, { purpose = 'photo' } = {}) {
  if (isHeic(file)) {
    const converted = purpose === 'photo' ? await shrinkImage(file, purpose) : null;
    return converted ? { file: converted } : { error: checkUploadFile(file) };
  }
  const problem = checkUploadFile(file);
  const tooBig = file.size > UPLOAD_MAX_BYTES;
  if (problem && !tooBig) return { error: problem };
  const ext = extOf(file);
  const shrinkable = purpose === 'photo' && ext !== 'gif' && file.type !== 'image/gif';
  const worthShrinking = tooBig || (file.size > SHRINK_OVER_BYTES && !/png/i.test(`${file.type} ${ext}`));
  if (shrinkable && worthShrinking) {
    const smaller = await shrinkImage(file, purpose);
    if (smaller && smaller.size < file.size && smaller.size <= UPLOAD_MAX_BYTES) return { file: smaller };
  }
  return problem ? { error: problem } : { file };
}

/**
 * Завантажує один файл з перевіркою. onProgress(0..1)
 * onError(message) — показати помилку біля поля; без нього помилка йде у сповіщення.
 * → результат сервера або null (помилку вже показано)
 */
export function uploadOne(file, { purpose = 'photo', onProgress, onError } = {}) {
  const fail = (message) => {
    if (onError) onError(message);
    else toast(message, { type: 'error', key: 'upload' });
    return null;
  };
  return trackUpload((async () => {
    const prepared = await prepareUpload(file, { purpose });
    if (prepared.error) return fail(prepared.error);
    try {
      const result = await uploadImage(prepared.file, { purpose, onProgress });
      rememberUpload(result);
      return result;
    } catch (err) {
      return fail(err instanceof ApiError ? err.message : 'Не вдалося завантажити фото. Спробуйте ще раз.');
    }
  })());
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
    // eslint-disable-next-line no-await-in-loop
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

/**
 * Прибирає фото з опублікованого контенту ще ДО видалення файлу — щоб сайт ні на мить не показував «биту» картинку,
 * а «Відкинути зміни» не повертав посилання на файл, якого вже немає.
 * → true, якщо вдалося
 */
async function unpublishImage(url) {
  if (state.saving) {
    toast('Зачекайте, доки збережуться зміни, і спробуйте ще раз.', { type: 'info' });
    return false;
  }
  state.saving = true; // поки оновлюємо сайт, звичайне «Зберегти» чекає
  try {
    const fresh = await api.get('content');
    const cleaned = clone(fresh);
    if (!removeImageFromDraft(url, cleaned)) return true; // на сайті його вже немає
    const res = await api.put('content', cleaned);
    rebaseDraft(res.content);
    return true;
  } catch (err) {
    if (err.status === 422 && err.details.length) {
      const route = routeForPath(err.details[0].path);
      const where = route ? ` у розділі «${unitLabel(route.name === 'section' ? `sections.${route.param}` : route.param || 'order')}»` : '';
      toast(`Це фото не можна просто прибрати: воно обов’язкове${where}. Спершу оберіть там інше фото й збережіть зміни, а потім видаліть це.`, { type: 'error', timeout: 12000 });
    } else {
      toast(err.message, { type: 'error' });
    }
    return false;
  } finally {
    state.saving = false;
    computeDirty();
  }
}

/** → true, якщо файл видалено */
export async function deleteMedia(item) {
  const onSite = Boolean(item.used) || imageRefs(state.saved).has(item.url);
  const inDraft = imageRefs(state.draft).has(item.url);
  const ok = await confirmDialog({
    title: 'Видалити фото?',
    message: onSite
      ? 'Це фото зараз є на сайті. Ми одразу приберемо його звідусіль, де воно показується (сайт оновиться без нього), і видалимо файл. Потім за потреби оберіть інше фото.'
      : inDraft
        ? 'Це фото обрано у ваших незбережених змінах. Ми приберемо його з цих полів і видалимо файл.'
        : 'Файл буде видалено з медіатеки назавжди.',
    confirmLabel: onSite || inDraft ? 'Усе одно видалити' : 'Видалити',
    danger: true,
  });
  if (!ok) return false;

  const remove = (force) => api.del(`media/${encodeURIComponent(item.name)}${force ? '?force=1' : ''}`);
  if (onSite && !(await unpublishImage(item.url))) return false;
  try {
    await remove(onSite);
  } catch (err) {
    if (err.status !== 409) {
      toast(err.message, { type: 'error' });
      return false;
    }
    // Фото тим часом з’явилося на сайті (наприклад, збережене з іншого пристрою)
    const again = await confirmDialog({ title: 'Фото використовується', message: err.message, confirmLabel: 'Прибрати з сайту й видалити', danger: true });
    if (!again || !(await unpublishImage(item.url))) return false;
    try {
      await remove(true);
    } catch (err2) {
      toast(err2.message, { type: 'error' });
      return false;
    }
  }

  if (state.media) state.media = state.media.filter((m) => m.name !== item.name);
  const cleared = removeImageFromDraft(item.url);
  if (cleared) computeDirty();
  emit('draft-replaced');
  if (onSite) toast('Фото видалено й прибрано із сайту.', { type: 'info', timeout: 7000 });
  else if (cleared) toast(`Фото видалено і прибрано з ${cleared} ${plural(cleared, ['поля', 'полів', 'полів'])} у ваших змінах.`, { type: 'info', timeout: 7000 });
  else toast('Фото видалено');
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
      isUsed(item, draftRefs) && h('span', { class: 'media-tile__badge', text: 'На сайті' }),
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

  const touch = isTouch();
  const drop = h('div', { class: 'dropzone', tabIndex: 0, role: 'button', 'aria-label': touch ? 'Завантажити фото' : 'Завантажити фото: натисніть або перетягніть файли сюди' },
    h('span', { class: 'dropzone__icon' }, icon('upload')),
    h('span', { class: 'dropzone__title', text: touch ? 'Натисніть, щоб додати фото' : 'Перетягніть фото сюди' }),
    h('span', { class: 'dropzone__hint', text: touch
      ? 'Можна обрати кілька фото одразу. JPG, PNG, WebP; великі фото автоматично зменшуються.'
      : 'або натисніть, щоб обрати файли. JPG, PNG, WebP; великі фото автоматично зменшуються.' }),
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

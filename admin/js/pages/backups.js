/**
 * Сторінка «Резервні копії»: автоматичні копії, завантаження копії на комп'ютер, відновлення з файлу.
 */

import { h, formatBytes, formatDate } from '../dom.js';
import { icon } from '../icons.js';
import { api, saveBlob } from '../api.js';
import { state, setContent, emit, forgetStoredDraft, unitLabel } from '../state.js';
import { pageHeader, card, toast, button, setBusy, confirmDialog, emptyState, loadingBlock } from '../ui.js';

const DIRTY_WARNING = 'Ваші незбережені зміни буде втрачено.';

function applyRestoredContent(content) {
  state.errors.clear();
  setContent(content);
  forgetStoredDraft();
  emit('draft-replaced');
}

export function renderBackupsPage(view) {
  /* --- копія на комп'ютер --- */
  const exportBtn = button({ label: 'Завантажити копію', iconName: 'download', variant: 'primary' });
  exportBtn.addEventListener('click', async () => {
    setBusy(exportBtn, true, 'Готуємо файл…');
    try {
      const { blob, filename } = await api.get('export', { blob: true });
      saveBlob(blob, filename);
      toast(state.dirty ? 'Файл завантажено. Увага: у ньому збережена версія сайту — без ваших незбережених змін.' : 'Файл з копією сайту завантажено', { type: state.dirty ? 'info' : 'success' });
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      setBusy(exportBtn, false);
    }
  });

  /* --- відновлення з файлу --- */
  const importBtn = button({ label: 'Відновити з файлу…', iconName: 'upload', variant: 'secondary' });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    let data;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('size');
      data = JSON.parse(await file.text());
    } catch {
      toast('Цей файл не вдалося прочитати. Оберіть файл .json, завантажений кнопкою «Завантажити копію».', { type: 'error' });
      return;
    }
    const ok = await confirmDialog({
      title: 'Відновити сайт з файлу?',
      message: `Увесь вміст сайту буде замінено вмістом файлу «${file.name}». Поточна версія автоматично збережеться в резервних копіях.`,
      details: state.dirty ? [DIRTY_WARNING] : [],
      confirmLabel: 'Відновити',
    });
    if (!ok) return;
    setBusy(importBtn, true, 'Відновлюємо…');
    try {
      const res = await api.post('import', data);
      applyRestoredContent(res.content);
      toast('Сайт відновлено з файлу');
      loadList();
    } catch (err) {
      const extra = err.details && err.details.length ? ` (проблем у файлі: ${err.details.length})` : '';
      toast(`${err.message}${extra}`, { type: 'error' });
    } finally {
      setBusy(importBtn, false);
    }
  });

  /* --- автоматичні копії --- */
  const listEl = h('div', { class: 'backups' }, loadingBlock());

  async function restore(item, btn) {
    const ok = await confirmDialog({
      title: 'Відновити цю версію?',
      message: `Сайт повернеться до стану на ${formatDate(item.createdAt, { afterVowel: true })}. Поточна версія теж збережеться в копіях, тож це можна буде скасувати.`,
      details: state.dirty ? [DIRTY_WARNING] : [],
      confirmLabel: 'Відновити',
    });
    if (!ok) return;
    setBusy(btn, true, 'Відновлюємо…');
    try {
      const res = await api.post(`backups/${encodeURIComponent(item.name)}/restore`);
      applyRestoredContent(res.content);
      toast('Готово! Сайт відновлено.');
      loadList();
    } catch (err) {
      toast(err.message, { type: 'error' });
      setBusy(btn, false);
    }
  }

  async function download(item, btn) {
    btn.disabled = true;
    try {
      const { blob, filename } = await api.get(`backups/${encodeURIComponent(item.name)}`, { blob: true });
      saveBlob(blob, filename || item.name);
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      btn.disabled = false;
    }
  }

  async function loadList() {
    try {
      const items = await api.get('backups');
      if (!items.length) {
        listEl.replaceChildren(emptyState({ iconName: 'history', title: 'Копій поки немає', text: 'Перша копія з’явиться автоматично, щойно ви збережете зміни.' }));
        return;
      }
      // Кілька копій за одну хвилину розрізняємо секундами
      const minuteOf = (item) => formatDate(item.createdAt);
      const perMinute = new Map();
      for (const item of items) perMinute.set(minuteOf(item), (perMinute.get(minuteOf(item)) || 0) + 1);
      listEl.replaceChildren(h('ul', { class: 'backup-list' }, items.map((item, i) => {
        const when = formatDate(item.createdAt, { seconds: perMinute.get(minuteOf(item)) > 1 });
        const restoreBtn = button({ label: 'Відновити', iconName: 'undo', variant: 'secondary', size: 'sm' });
        restoreBtn.setAttribute('aria-label', `Відновити версію: ${when}`);
        const downloadBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Завантажити копію: ${when}`, title: 'Завантажити файл' }, icon('download'));
        restoreBtn.addEventListener('click', () => restore(item, restoreBtn));
        downloadBtn.addEventListener('click', () => download(item, downloadBtn));
        // Якщо сервер повідомляє, що саме змінило збереження після цієї копії, — показуємо (щоб знати, яку відновлювати)
        const changes = Array.isArray(item.changes) ? item.changes.filter((c) => typeof c === 'string') : [];
        const changesText = changes.length
          ? `Після неї змінено: ${changes.slice(0, 4).map(unitLabel).join(', ')}${changes.length > 4 ? ` та ще ${changes.length - 4}` : ''}`
          : '';
        return h('li', { class: 'backup' },
          h('span', { class: 'backup__icon' }, icon('history')),
          h('div', { class: 'backup__info' },
            h('p', { class: 'backup__date', text: when }),
            changesText ? h('p', { class: 'backup__changes', text: changesText }) : null,
            h('p', { class: 'backup__meta', text: `${i === 0 ? 'Найновіша · ' : ''}${formatBytes(item.size)}` })),
          h('div', { class: 'backup__actions' }, restoreBtn, downloadBtn));
      })));
    } catch (err) {
      listEl.replaceChildren(emptyState({ iconName: 'alert', title: 'Не вдалося завантажити список копій', text: err.message }));
    }
  }

  view.append(
    pageHeader({
      eyebrow: 'Збереження даних',
      title: 'Резервні копії',
      description: 'Перед кожним збереженням попередня версія сайту зберігається автоматично (останні 30). Якщо щось пішло не так — просто відновіть потрібну.',
    }),
    h('div', { class: 'grid-2 grid-2--cards' },
      card({
        title: 'Копія на ваш пристрій',
        description: 'Файл з усіма текстами та налаштуваннями сайту. Фото й заявки у файл не входять: фото лишаються в медіатеці, заявки — у розділі «Заявки».',
        children: [h('div', { class: 'form-actions' }, exportBtn)],
      }),
      card({
        title: 'Відновлення з файлу',
        description: 'Завантажте файл, збережений раніше кнопкою «Завантажити копію».',
        children: [h('div', { class: 'form-actions' }, importBtn, fileInput)],
      })),
    card({ title: 'Автоматичні копії', className: 'card--flush-body', children: [listEl] }),
  );
  loadList();
}

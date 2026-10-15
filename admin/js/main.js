/**
 * Адмін-панель ANNA FROLOVA TRAVEL — точка входу.
 *
 * Вхід → завантаження схеми й контенту → меню + сторінки (маршрути через #/...).
 * Усі зміни контенту накопичуються в одній чернетці і зберігаються кнопкою «Зберегти зміни» (або Ctrl/Cmd+S).
 */

import { h } from './dom.js';
import { icon } from './icons.js';
import { api, setReauthHandler } from './api.js';
import {
  state, on, emit, setContent, computeDirty, readStoredDraft, forgetStoredDraft,
  setErrors, expandForPath, routeForPath, isPageDirty, pageHasErrors, sectionDef, groupDef, newLeadsCount,
} from './state.js';
import { toast, confirmDialog } from './ui.js';
import { paintErrors, focusPath, autosizeAll } from './fields.js';
import { renderStructure, renderSection, renderGroup } from './pages/content.js';
import { renderLeadsPage, loadLeads } from './pages/leads.js';
import { renderMediaPage } from './media.js';
import { renderSecurityPage } from './pages/security.js';
import { renderBackupsPage } from './pages/backups.js';

const $ = (id) => document.getElementById(id);
const el = {
  boot: $('boot'),
  bootText: $('boot-text'),
  bootRetry: $('boot-retry'),
  login: $('login'),
  loginForm: $('login-form'),
  loginPassword: $('login-password'),
  loginToggle: $('login-toggle'),
  loginError: $('login-error'),
  loginNotice: $('login-notice'),
  loginSubmit: $('login-submit'),
  app: $('app'),
  sidebar: $('sidebar'),
  scrim: $('scrim'),
  nav: $('nav'),
  view: $('view'),
  title: $('topbar-title'),
  menuBtn: $('menu-btn'),
  drawerClose: $('drawer-close'),
  savebar: $('savebar'),
  saveState: $('save-state'),
  saveBtn: $('save-btn'),
  discardBtn: $('discard-btn'),
  logoutBtn: $('logout-btn'),
  logoutSide: $('logout-btn-side'),
  banner: $('pw-banner'),
};

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const CONTENT_PAGES = new Set(['structure', 'section', 'group']);
const LEADS_POLL_MS = 60 * 1000;

let route = { name: 'structure' };
let pendingFocusPath = null;
let pollTimer = 0;
const knownLeadIds = new Set();

/* =========================================================================
   Маршрути
   ========================================================================= */

const SIMPLE_ROUTES = {
  structure: 'Структура сторінки',
  leads: 'Заявки',
  media: 'Медіатека',
  security: 'Безпека',
  backups: 'Резервні копії',
};

function parseRoute() {
  const m = /^#\/([a-z]+)(?:\/([a-z]+))?/i.exec(window.location.hash);
  if (!m) return { name: 'structure' };
  const [, name, param] = m;
  if (name === 'section' && sectionDef(param)) return { name, param };
  if (name === 'group' && groupDef(param)) return { name, param };
  if (SIMPLE_ROUTES[name]) return { name };
  return { name: 'structure' };
}

const routeHash = (r) => `#/${r.name}${r.param ? `/${r.param}` : ''}`;
const sameRoute = (a, b) => a && b && a.name === b.name && (a.param || '') === (b.param || '');

function routeTitle(r) {
  if (r.name === 'section') return (sectionDef(r.param) || {}).title || '';
  if (r.name === 'group') return (groupDef(r.param) || {}).title || '';
  return SIMPLE_ROUTES[r.name] || '';
}

function captureFocus() {
  const active = document.activeElement;
  if (!active || !el.view.contains(active)) return null;
  const holder = active.closest('[data-path]');
  if (!holder) return null;
  return {
    path: holder.dataset.path,
    start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
  };
}

function restoreFocus(info) {
  if (!info) return;
  const holder = el.view.querySelector(`[data-path="${CSS.escape(info.path)}"]`);
  const input = holder && holder.querySelector('input, textarea, select');
  if (!input) return;
  input.focus({ preventScroll: true });
  if (info.start !== null && typeof input.setSelectionRange === 'function') {
    try {
      input.setSelectionRange(info.start, info.end);
    } catch {
      // поле без виділення (наприклад, number)
    }
  }
}

function renderRoute({ preserve = false } = {}) {
  if (!state.schema) return;
  route = parseRoute();
  const scrollY = window.scrollY;
  const focusInfo = preserve ? captureFocus() : null;

  el.view.replaceChildren();
  el.view.dataset.page = route.name;
  switch (route.name) {
    case 'section': renderSection(el.view, route.param); break;
    case 'group': renderGroup(el.view, route.param); break;
    case 'leads': renderLeadsPage(el.view); break;
    case 'media': renderMediaPage(el.view); break;
    case 'security': renderSecurityPage(el.view); break;
    case 'backups': renderBackupsPage(el.view); break;
    default: renderStructure(el.view);
  }
  paintErrors(el.view);

  const title = routeTitle(route);
  el.title.textContent = title;
  document.title = `${title} · Адмін-панель · ANNA FROLOVA TRAVEL`;
  renderNav();
  closeDrawer({ restoreFocus: false });

  requestAnimationFrame(() => {
    autosizeAll(el.view);
    if (pendingFocusPath) {
      const path = pendingFocusPath;
      pendingFocusPath = null;
      focusPath(el.view, path);
      return;
    }
    if (preserve) {
      window.scrollTo(0, scrollY);
      restoreFocus(focusInfo);
    } else {
      window.scrollTo(0, 0);
      const heading = el.view.querySelector('.page-head__title');
      if (heading) heading.focus({ preventScroll: true });
    }
  });
}

function navigate(r) {
  const hash = routeHash(r);
  if (window.location.hash === hash) renderRoute();
  else window.location.hash = hash;
}

/* =========================================================================
   Меню
   ========================================================================= */

const GROUP_ICONS = { settings: 'home', contacts: 'phone', theme: 'palette', seo: 'search', ui: 'type' };

function marker(r) {
  if (pageHasErrors(r)) return h('span', { class: 'nav-mark nav-mark--error', title: 'Є помилки' }, h('span', { class: 'sr-only', text: '(є помилки)' }));
  if (isPageDirty(r)) return h('span', { class: 'nav-mark nav-mark--dirty', title: 'Є незбережені зміни' }, h('span', { class: 'sr-only', text: '(є незбережені зміни)' }));
  return null;
}

function navLink(r, label, { iconNode, extra, className } = {}) {
  const active = sameRoute(r, route);
  return h('a', {
    class: ['nav-link', className, active && 'is-active'],
    href: routeHash(r),
    'aria-current': active ? 'page' : undefined,
  }, iconNode, h('span', { class: 'nav-link__label', text: label }), extra, marker(r));
}

function renderNav() {
  if (!state.schema || !state.draft) return;
  const sections = state.draft.order.map((type) => {
    const def = sectionDef(type);
    const data = state.draft.sections[type];
    if (!def || !data) return null;
    const dot = h('span', { class: ['vis-dot', data.enabled ? 'is-on' : 'is-off'], title: data.enabled ? 'Показується на сайті' : 'Приховано' },
      h('span', { class: 'sr-only', text: data.enabled ? 'показується' : 'приховано' }));
    return h('li', null, navLink({ name: 'section', param: type }, def.title, { iconNode: dot, className: ['nav-link--sub', !data.enabled && 'is-muted'].filter(Boolean).join(' ') }));
  });

  const newCount = newLeadsCount();
  const leadsBadge = newCount ? h('span', { class: 'nav-badge', title: 'Нові заявки', text: String(newCount) }, h('span', { class: 'sr-only', text: ' нових' })) : null;

  el.nav.replaceChildren(
    h('div', { class: 'nav-group' },
      h('p', { class: 'nav-group__title', text: 'Сторінка' }),
      navLink({ name: 'structure' }, 'Структура сторінки', { iconNode: icon('layers') }),
      h('ul', { class: 'nav-sub' }, sections)),
    h('div', { class: 'nav-group' },
      h('p', { class: 'nav-group__title', text: 'Налаштування' }),
      state.schema.groups.map((g) => navLink({ name: 'group', param: g.key }, g.title, { iconNode: icon(GROUP_ICONS[g.key] || 'file') }))),
    h('div', { class: 'nav-group' },
      h('p', { class: 'nav-group__title', text: 'Керування' }),
      navLink({ name: 'leads' }, 'Заявки', { iconNode: icon('inbox'), extra: leadsBadge }),
      navLink({ name: 'media' }, 'Медіатека', { iconNode: icon('images') }),
      navLink({ name: 'security' }, 'Безпека', { iconNode: icon('lock') }),
      navLink({ name: 'backups' }, 'Резервні копії', { iconNode: icon('history') })),
  );

  const menuDot = state.dirty || newCount;
  el.menuBtn.classList.toggle('has-dot', Boolean(menuDot));
}

/* ---------------- мобільне меню ---------------- */

const mainEl = document.querySelector('.main');

function openDrawer() {
  el.app.classList.add('drawer-open');
  mainEl.inert = true;
  el.scrim.hidden = false;
  el.menuBtn.setAttribute('aria-expanded', 'true');
  document.documentElement.classList.add('no-scroll');
  const current = el.nav.querySelector('.is-active') || el.nav.querySelector('a');
  if (current) current.focus({ preventScroll: true });
}

function closeDrawer({ restoreFocus: refocus = true } = {}) {
  if (!el.app.classList.contains('drawer-open')) return;
  el.app.classList.remove('drawer-open');
  mainEl.inert = false;
  el.scrim.hidden = true;
  el.menuBtn.setAttribute('aria-expanded', 'false');
  document.documentElement.classList.remove('no-scroll');
  if (refocus) el.menuBtn.focus({ preventScroll: true });
}

/* =========================================================================
   Збереження
   ========================================================================= */

function updateSaveUi() {
  const dirty = state.dirty;
  const hasErrors = state.errors.size > 0;
  let mode = 'clean';
  if (state.saving) mode = 'saving';
  else if (dirty && hasErrors) mode = 'error';
  else if (dirty) mode = 'dirty';
  el.savebar.dataset.state = mode;
  document.documentElement.classList.toggle('is-dirty', dirty || state.saving);

  const texts = {
    clean: 'Усі зміни збережено',
    dirty: 'Є незбережені зміни',
    error: 'Перевірте виділені поля',
    saving: 'Зберігаємо…',
  };
  el.saveState.replaceChildren(icon(mode === 'clean' ? 'check' : mode === 'error' ? 'alert' : 'edit'), h('span', { text: texts[mode] }));
  el.saveBtn.disabled = !dirty || state.saving;
  el.saveBtn.classList.toggle('is-busy', state.saving);
  el.saveBtn.querySelector('.btn__label').textContent = state.saving ? 'Зберігаємо…' : 'Зберегти зміни';
  el.discardBtn.hidden = !dirty || state.saving;
}

async function save() {
  if (state.saving || !state.draft) return;
  if (!computeDirty()) {
    toast('Змін немає — усе вже збережено', { type: 'info' });
    return;
  }
  state.saving = true;
  updateSaveUi();
  const sent = JSON.stringify(state.draft);
  try {
    const res = await api.put('content', JSON.parse(sent));
    const editedMeanwhile = JSON.stringify(state.draft) !== sent;
    state.errors.clear();
    if (editedMeanwhile || JSON.stringify(res.content) === sent) {
      setContent(res.content, { keepDraft: true });
    } else {
      // Сервер дещо нормалізував (пробіли, @ у нікнеймі…) — показуємо остаточний вигляд
      setContent(res.content);
      renderRoute({ preserve: true });
    }
    emit('errors');
    toast(editedMeanwhile ? 'Збережено. Останні правки ще не збережені — натисніть «Зберегти» ще раз.' : 'Збережено — зміни вже на сайті', { type: editedMeanwhile ? 'info' : 'success' });
  } catch (err) {
    if (err.status === 422 && err.details.length) showValidationErrors(err);
    else toast(err.message, { type: 'error' });
  } finally {
    state.saving = false;
    computeDirty();
    updateSaveUi();
  }
}

function showValidationErrors(err) {
  setErrors(err.details);
  for (const d of err.details) expandForPath(d.path);
  const first = err.details.find((d) => routeForPath(d.path)) || err.details[0];
  const n = err.details.length;
  toast(`${err.message}: ${n} ${n === 1 ? 'поле потребує' : n < 5 ? 'поля потребують' : 'полів потребують'} уваги.`, { type: 'error' });
  const target = routeForPath(first.path);
  pendingFocusPath = first.path;
  if (target && !sameRoute(target, route)) {
    navigate(target);
  } else {
    renderRoute({ preserve: true });
  }
}

async function discard() {
  if (!state.dirty) return;
  const ok = await confirmDialog({
    title: 'Скасувати всі незбережені зміни?',
    message: 'Сайт залишиться таким, яким був після останнього збереження. Скасувати це буде неможливо.',
    confirmLabel: 'Скасувати зміни',
    cancelLabel: 'Ні, повернутися',
    danger: true,
  });
  if (!ok) return;
  state.errors.clear();
  setContent(state.saved);
  forgetStoredDraft();
  emit('errors');
  renderRoute({ preserve: true });
  toast('Зміни скасовано', { type: 'info' });
}

/* =========================================================================
   Вхід / вихід
   ========================================================================= */

let reauth = null; // { promise, resolve } — поки показано екран входу після завершення сесії

function showBoot(text, { retry = false } = {}) {
  el.boot.hidden = false;
  el.bootText.textContent = text;
  el.bootRetry.hidden = !retry;
  el.boot.querySelector('.spinner').hidden = retry;
}

function showLogin({ notice = '', noticeType = 'info' } = {}) {
  el.boot.hidden = true;
  el.login.hidden = false;
  el.login.classList.toggle('login--overlay', Boolean(reauth));
  el.loginNotice.hidden = !notice;
  el.loginNotice.textContent = notice;
  el.loginNotice.dataset.type = noticeType;
  el.loginError.hidden = true;
  el.loginPassword.value = '';
  el.loginPassword.removeAttribute('aria-invalid');
  setTimeout(() => el.loginPassword.focus(), 50);
}

function hideLogin() {
  el.login.hidden = true;
  el.login.classList.remove('login--overlay');
}

function requestReauth() {
  if (!reauth) {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    reauth = { promise, resolve };
    for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
    showLogin({
      notice: state.dirty
        ? 'Сесія завершилася. Увійдіть знову — ваші незбережені зміни нікуди не зникнуть.'
        : 'Сесія завершилася. Увійдіть знову, щоб продовжити.',
    });
  }
  return reauth.promise;
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const password = el.loginPassword.value;
  const fail = (msg) => {
    el.loginError.hidden = false;
    el.loginError.textContent = msg;
    el.loginPassword.setAttribute('aria-invalid', 'true');
    el.loginPassword.focus();
    el.loginPassword.select();
  };
  if (!password) {
    fail('Введіть пароль');
    return;
  }
  el.loginSubmit.disabled = true;
  el.loginSubmit.classList.add('is-busy');
  el.loginSubmit.querySelector('.btn__label').textContent = 'Входимо…';
  try {
    const res = await api.post('login', { password }, { auth: false });
    state.session.mustChangePassword = Boolean(res && res.mustChangePassword);
    el.loginPassword.value = '';
    if (reauth) {
      const { resolve } = reauth;
      reauth = null;
      hideLogin();
      updateBanner();
      toast('Ви знову в системі. Можна продовжувати.', { type: 'info' });
      resolve();
    } else {
      hideLogin();
      await enterApp();
    }
  } catch (err) {
    fail(err.message);
  } finally {
    el.loginSubmit.disabled = false;
    el.loginSubmit.classList.remove('is-busy');
    el.loginSubmit.querySelector('.btn__label').textContent = 'Увійти';
  }
}

async function logout() {
  if (computeDirty()) {
    const ok = await confirmDialog({
      title: 'Вийти без збереження?',
      message: 'У вас є незбережені зміни. Якщо вийти зараз, вони зникнуть.',
      confirmLabel: 'Вийти без збереження',
      cancelLabel: 'Залишитися',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await api.post('logout', undefined, { auth: false });
  } catch {
    // навіть якщо сервер недоступний — повертаємося на екран входу
  }
  clearInterval(pollTimer);
  forgetStoredDraft();
  state.draft = null;
  state.saved = null;
  state.savedJson = '';
  state.dirty = false;
  state.errors.clear();
  state.expanded.clear();
  state.media = null;
  state.leads = [];
  state.leadsLoaded = false;
  el.app.hidden = true;
  closeDrawer({ restoreFocus: false });
  document.documentElement.classList.remove('is-dirty');
  showLogin({ notice: 'Ви вийшли з адмін-панелі.' });
}

function updateBanner() {
  el.banner.hidden = !state.session.mustChangePassword || route.name === 'security';
}

/* =========================================================================
   Запуск
   ========================================================================= */

async function enterApp() {
  showBoot('Завантажуємо дані сайту…');
  try {
    const [schema, content, icons] = await Promise.all([api.get('schema'), api.get('content'), api.get('icons')]);
    state.schema = schema;
    state.icons = icons || {};
    state.errors.clear();
    const stored = readStoredDraft();
    setContent(content);
    // Відновлюємо чернетку, лише якщо сайт відтоді не змінювали (інакше могли б затерти новіші зміни)
    if (stored && stored.base === state.savedJson) {
      state.draft = stored.draft;
      if (computeDirty()) {
        toast('Ми відновили ваші незбережені зміни з попереднього разу.', {
          type: 'info',
          timeout: 10000,
          action: { label: 'Скасувати їх', onClick: () => discard() },
        });
      }
    }
  } catch (err) {
    showBoot(err.message || 'Не вдалося завантажити дані.', { retry: true });
    return;
  }

  el.boot.hidden = true;
  el.app.hidden = false;
  renderRoute();
  updateSaveUi();
  updateBanner();

  knownLeadIds.clear();
  try {
    await loadLeads({ background: true });
    for (const lead of state.leads) knownLeadIds.add(lead.id);
  } catch {
    // заявки не критичні для старту
  }
  clearInterval(pollTimer);
  pollTimer = setInterval(pollLeads, LEADS_POLL_MS);
}

async function pollLeads() {
  if (document.hidden || el.app.hidden || reauth) return;
  try {
    await loadLeads({ background: true });
  } catch {
    return;
  }
  const fresh = state.leads.filter((l) => !knownLeadIds.has(l.id));
  for (const lead of state.leads) knownLeadIds.add(lead.id);
  if (fresh.length && route.name !== 'leads') {
    toast(fresh.length === 1 ? `Нова заявка від «${fresh[0].name}»` : `Нових заявок: ${fresh.length}`, {
      type: 'info',
      timeout: 12000,
      action: { label: 'Переглянути', onClick: () => navigate({ name: 'leads' }) },
    });
  }
}

async function boot() {
  showBoot('Завантаження…');
  let session;
  try {
    session = await api.get('session', { auth: false });
  } catch (err) {
    showBoot(err.message, { retry: true });
    return;
  }
  if (session && session.authenticated) {
    state.session.mustChangePassword = Boolean(session.mustChangePassword);
    await enterApp();
  } else {
    showLogin();
  }
}

function bindStatic() {
  // Іконки в статичній розмітці
  el.loginToggle.append(icon('eye'));
  el.menuBtn.append(icon('menu'));
  el.drawerClose.append(icon('close'));
  el.logoutBtn.append(icon('logout'));
  el.saveBtn.prepend(icon('check'));
  el.logoutSide.prepend(icon('logout'));
  for (const a of document.querySelectorAll('.topbar__link[data-site="uk"], .sidebar__site[data-site="uk"]')) a.append(icon('external'));
  el.saveBtn.title = `Зберегти зміни (${isMac ? '⌘S' : 'Ctrl+S'})`;

  // Монограма: якщо файлу немає — просто ховаємо
  for (const img of document.querySelectorAll('.js-mark')) {
    img.addEventListener('error', () => img.classList.add('is-missing'), { once: true });
    if (img.complete && img.naturalWidth === 0) img.classList.add('is-missing');
  }

  el.loginForm.addEventListener('submit', onLoginSubmit);
  el.loginPassword.addEventListener('input', () => {
    el.loginError.hidden = true;
    el.loginPassword.removeAttribute('aria-invalid');
  });
  el.loginToggle.addEventListener('click', () => {
    const show = el.loginPassword.type === 'password';
    el.loginPassword.type = show ? 'text' : 'password';
    el.loginToggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    const text = show ? 'Сховати пароль' : 'Показати пароль';
    el.loginToggle.setAttribute('aria-label', text);
    el.loginToggle.title = text;
    el.loginToggle.setAttribute('aria-pressed', String(show));
    el.loginPassword.focus();
  });
  el.bootRetry.addEventListener('click', () => (state.schema === null ? boot() : enterApp()));

  el.saveBtn.addEventListener('click', save);
  el.discardBtn.addEventListener('click', discard);
  el.logoutBtn.addEventListener('click', logout);
  el.logoutSide.addEventListener('click', logout);
  el.menuBtn.addEventListener('click', openDrawer);
  el.drawerClose.addEventListener('click', () => closeDrawer());
  el.scrim.addEventListener('click', () => closeDrawer());

  window.addEventListener('hashchange', () => {
    renderRoute();
    updateBanner();
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyS' || (e.key || '').toLowerCase() === 's')) {
      e.preventDefault();
      if (!el.app.hidden && !reauth) {
        // Значення поля, що зараз у фокусі, вже в чернетці (оновлюється на кожне натискання)
        save();
      }
      return;
    }
    if (e.key === 'Escape' && el.app.classList.contains('drawer-open')) closeDrawer();
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.draft && computeDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  let resizeTimer = 0;
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      autosizeAll(el.view);
      if (window.innerWidth > 960) closeDrawer({ restoreFocus: false });
    }, 150);
  });

  on('dirty', () => {
    updateSaveUi();
    renderNav();
  });
  on('errors', () => {
    paintErrors(el.view);
    updateSaveUi();
    renderNav();
  });
  on('leads', renderNav);
  on('session', updateBanner);
  on('draft-replaced', () => {
    if (CONTENT_PAGES.has(route.name)) renderRoute({ preserve: true });
    else renderNav();
    updateSaveUi();
  });

  setReauthHandler(requestReauth);
}

bindStatic();
boot();

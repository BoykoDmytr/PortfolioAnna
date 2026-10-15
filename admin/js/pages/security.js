/**
 * Сторінка «Безпека»: зміна пароля і сповіщення про нові заявки в Telegram.
 */

import { h, nextId, describedBy, plural } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, emit } from '../state.js';
import { pageHeader, card, toast, button, setBusy, switchControl, loadingBlock, emptyState, confirmDialog } from '../ui.js';

/** Поле пароля з кнопкою «показати». */
export function passwordInput({ label, autocomplete, help, id = nextId() }) {
  // Без автовеликої літери й автовиправлення: коли пароль показано, телефон інакше перетворить «anna2026» на «Anna2026»
  const input = h('input', { id, type: 'password', class: 'input', autocomplete, required: true, autocapitalize: 'none', autocorrect: 'off' });
  input.spellcheck = false;
  const toggle = h('button', { type: 'button', class: 'input-action', 'aria-label': 'Показати пароль', title: 'Показати пароль', 'aria-pressed': 'false' }, icon('eye'));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    const text = show ? 'Сховати пароль' : 'Показати пароль';
    toggle.setAttribute('aria-label', text);
    toggle.title = text;
    toggle.setAttribute('aria-pressed', String(show));
    input.focus();
  });
  const error = h('p', { class: 'field__error', id: nextId('err'), hidden: true });
  const root = h('div', { class: 'field' },
    h('div', { class: 'field__head' }, h('label', { class: 'field__label', for: id, text: label })),
    help && h('p', { class: 'field__help', id: `${id}-help`, text: help }),
    h('div', { class: 'input-wrap' }, input, toggle),
    error);
  if (help) describedBy(input, `${id}-help`, true);
  const setError = (msg) => {
    root.classList.toggle('has-error', Boolean(msg));
    error.hidden = !msg;
    error.textContent = msg || '';
    if (msg) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    describedBy(input, error.id, Boolean(msg));
  };
  input.addEventListener('input', () => setError(''));
  return { root, input, setError };
}

function passwordCard() {
  const current = passwordInput({ label: 'Поточний пароль', autocomplete: 'current-password' });
  const next = passwordInput({ label: 'Новий пароль', autocomplete: 'new-password', help: 'Щонайменше 8 символів. Найкраще — кілька слів, які легко запам’ятати вам і важко вгадати іншим.' });
  const repeat = passwordInput({ label: 'Повторіть новий пароль', autocomplete: 'new-password' });
  const submit = button({ label: 'Змінити пароль', iconName: 'key', variant: 'primary', type: 'submit' });

  const form = h('form', { class: 'stack', novalidate: true }, current.root, h('div', { class: 'grid-2' }, next.root, repeat.root), h('div', { class: 'form-actions' }, submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let bad = false;
    if (!current.input.value) {
      current.setError('Введіть поточний пароль');
      bad = true;
    }
    if (next.input.value.length < 8) {
      next.setError('Щонайменше 8 символів');
      bad = true;
    } else if (next.input.value === current.input.value) {
      next.setError('Новий пароль має відрізнятися від поточного');
      bad = true;
    }
    if (repeat.input.value !== next.input.value) {
      repeat.setError('Паролі не збігаються');
      bad = true;
    }
    if (bad) {
      form.querySelector('[aria-invalid="true"]').focus();
      return;
    }
    setBusy(submit, true, 'Змінюємо…');
    try {
      await api.post('password', { current: current.input.value, next: next.input.value });
      state.session.mustChangePassword = false;
      emit('session');
      // Картка з новим описом (без «стандартного пароля»)
      const fresh = passwordCard();
      root.replaceWith(fresh);
      const heading = fresh.querySelector('.card__title');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      toast('Пароль змінено. Запам’ятайте його — він знадобиться для наступного входу.', { key: 'password' });
    } catch (err) {
      const fields = { current, next };
      const left = Number.isInteger(err.data.attemptsLeft) ? err.data.attemptsLeft : null;
      const leftText = left !== null && left > 0 && left <= 3
        ? ` ${left === 1 ? 'Залишилася' : 'Залишилося'} ${left} ${plural(left, ['спроба', 'спроби', 'спроб'])}.`
        : '';
      let shown = false;
      for (const d of err.details) {
        if (fields[d.field]) {
          fields[d.field].setError(d.field === 'current' ? `${d.message.replace(/\.$/, '')}.${leftText}` : d.message);
          shown = true;
        }
      }
      if (shown) form.querySelector('[aria-invalid="true"]').focus();
      toast(err.message, { type: 'error', key: 'password' });
      setBusy(submit, false);
    }
  });

  const root = card({
    title: 'Пароль до адмін-панелі',
    description: state.session.mustChangePassword
      ? 'Зараз використовується стандартний пароль. Змініть його на власний — так ніхто інший не зможе змінити ваш сайт.'
      : 'Змініть пароль, якщо вважаєте, що його міг дізнатися хтось інший.',
    className: state.session.mustChangePassword ? 'card--attention' : '',
    children: [form],
  });
  return root;
}

const STEPS = [
  ['У Telegram відкрийте ', { link: 'https://t.me/BotFather', text: '@BotFather' }, ' і надішліть йому команду /newbot.'],
  ['Придумайте назву бота (наприклад, «Заявки Anna Frolova Travel») та ім’я користувача, що закінчується на «bot».'],
  ['BotFather надішле токен — довгий рядок на кшталт 123456789:AAH… Скопіюйте його повністю в поле «Токен бота» нижче.'],
  ['Знайдіть свого нового бота в Telegram і натисніть «Почати» (/start) — інакше бот не зможе вам писати.'],
  ['Дізнайтеся свій Chat ID: напишіть будь-що боту ', { link: 'https://t.me/userinfobot', text: '@userinfobot' }, ' — він відповість числом «Id». Вставте це число в поле «Chat ID».'],
  ['Увімкніть сповіщення, натисніть «Зберегти» і перевірте кнопкою «Надіслати тестове повідомлення».'],
];

function howTo() {
  return h('details', { class: 'howto' },
    h('summary', { class: 'howto__summary' }, icon('info'), h('span', { text: 'Як налаштувати — 6 простих кроків (близько 3 хвилин)' }), icon('chevron', 'i howto__chev')),
    h('ol', { class: 'howto__steps' }, STEPS.map((parts) => h('li', null, parts.map((p) => (typeof p === 'string' ? p : h('a', { href: p.link, target: '_blank', rel: 'noopener', text: p.text })))))),
    h('p', { class: 'howto__note', text: 'Це безкоштовно. Токен зберігається лише на сервері сайту й ніколи не показується відвідувачам.' }));
}

function notificationsCard() {
  const body = h('div', { class: 'stack' }, loadingBlock());
  const root = card({
    title: 'Сповіщення про заявки в Telegram',
    description: 'Отримуйте повідомлення в Telegram щоразу, коли хтось залишає заявку на сайті.',
    children: [body],
  });

  api.get('notifications').then((settings) => {
    const enabled = switchControl({ checked: settings.telegramEnabled, label: 'Надсилати сповіщення про нові заявки', onChange: () => {} });
    const tokenId = nextId();
    const chatId = nextId();
    const token = h('input', { id: tokenId, type: 'password', class: 'input', autocomplete: 'off', placeholder: settings.telegramTokenSet ? `Збережено: ${settings.telegramTokenMasked || '••••'}` : '123456789:AAH…' });
    token.spellcheck = false;
    const chat = h('input', { id: chatId, type: 'text', class: 'input', autocomplete: 'off', inputMode: 'numeric', placeholder: 'Наприклад: 123456789' });
    chat.value = settings.telegramChatId || '';
    const tokenField = h('div', { class: 'field' },
      h('div', { class: 'field__head' }, h('label', { class: 'field__label', for: tokenId, text: 'Токен бота' })),
      h('p', { class: 'field__help', text: settings.telegramTokenSet ? 'Токен уже збережено. Залиште поле порожнім, щоб не змінювати його.' : 'Його надішле @BotFather після створення бота.' }),
      token, h('p', { class: 'field__error', id: nextId('err'), hidden: true }));
    const chatField = h('div', { class: 'field' },
      h('div', { class: 'field__head' }, h('label', { class: 'field__label', for: chatId, text: 'Chat ID' })),
      h('p', { class: 'field__help', text: 'Число, яке надішле @userinfobot.' }),
      chat, h('p', { class: 'field__error', id: nextId('err'), hidden: true }));
    const fieldEls = { telegramToken: tokenField, telegramChatId: chatField };
    const clearErrors = () => {
      for (const el of Object.values(fieldEls)) {
        el.classList.remove('has-error');
        const p = el.querySelector('.field__error');
        p.hidden = true;
        el.querySelector('.input').removeAttribute('aria-invalid');
        describedBy(el.querySelector('.input'), p.id, false);
      }
    };
    const showErrors = (details) => {
      for (const d of details) {
        const el = fieldEls[d.field];
        if (!el) continue;
        el.classList.add('has-error');
        el.querySelector('.input').setAttribute('aria-invalid', 'true');
        const p = el.querySelector('.field__error');
        p.hidden = false;
        p.textContent = d.message;
        describedBy(el.querySelector('.input'), p.id, true);
      }
    };

    const saveBtn = button({ label: 'Зберегти', iconName: 'check', variant: 'primary' });
    const testBtn = button({ label: 'Надіслати тестове повідомлення', iconName: 'send', variant: 'secondary' });
    const removeBtn = settings.telegramTokenSet ? button({ label: 'Видалити токен', iconName: 'trash', variant: 'ghost', className: 'btn--danger-text' }) : null;

    saveBtn.addEventListener('click', async () => {
      clearErrors();
      setBusy(saveBtn, true, 'Зберігаємо…');
      try {
        const payload = { telegramEnabled: enabled.input.checked, telegramChatId: chat.value.trim() };
        if (token.value.trim()) payload.telegramToken = token.value.trim();
        await api.put('notifications', payload);
        toast(enabled.input.checked ? 'Сповіщення увімкнено' : 'Налаштування збережено', { key: 'notify' });
        root.replaceWith(notificationsCard());
      } catch (err) {
        showErrors(err.details);
        toast(err.message, { type: 'error', key: 'notify' });
        setBusy(saveBtn, false);
      }
    });

    testBtn.addEventListener('click', async () => {
      clearErrors();
      setBusy(testBtn, true, 'Надсилаємо…');
      try {
        const payload = {};
        if (token.value.trim()) payload.telegramToken = token.value.trim();
        if (chat.value.trim()) payload.telegramChatId = chat.value.trim();
        await api.post('notifications/test', payload);
        toast('Готово! Перевірте Telegram — там має бути тестове повідомлення.', { key: 'notify' });
      } catch (err) {
        showErrors(err.details);
        toast(err.message, { type: 'error', key: 'notify' });
      } finally {
        setBusy(testBtn, false);
      }
    });

    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Видалити токен бота?', message: 'Сповіщення перестануть надходити, доки ви не вкажете токен знову.', confirmLabel: 'Видалити', danger: true });
        if (!ok) return;
        try {
          await api.put('notifications', { telegramToken: null, telegramEnabled: false });
          toast('Токен видалено');
          root.replaceWith(notificationsCard());
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      });
    }

    const status = settings.telegramEnabled && settings.telegramTokenSet && settings.telegramChatId
      ? h('p', { class: 'status-line status-line--ok' }, icon('check'), 'Сповіщення працюють')
      : h('p', { class: 'status-line' }, icon('bell'), 'Сповіщення вимкнені');

    body.replaceChildren(
      status,
      howTo(),
      enabled.root,
      h('div', { class: 'grid-2' }, tokenField, chatField),
      h('div', { class: 'form-actions' }, saveBtn, testBtn, removeBtn),
    );
  }).catch((err) => {
    body.replaceChildren(emptyState({ iconName: 'alert', title: 'Не вдалося завантажити налаштування', text: err.message }));
  });

  return root;
}

function sessionsCard() {
  const btn = button({ label: 'Вийти на всіх пристроях', iconName: 'logout', variant: 'secondary' });
  btn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Вийти на всіх пристроях?',
      message: 'Адмін-панель закриється на всіх телефонах і комп’ютерах, де ви входили, — і на цьому теж. Щоб продовжити, потрібно буде знову ввести пароль.',
      confirmLabel: 'Вийти всюди',
      danger: true,
    });
    if (ok) emit('logout', { everywhere: true });
  });
  return card({
    title: 'Пристрої, де ви увійшли',
    description: 'Входили в адмінку з чужого пристрою або загубили телефон? Вийдіть на всіх пристроях одразу. Якщо пароль міг дізнатися хтось інший, спершу змініть його.',
    children: [h('div', { class: 'form-actions' }, btn)],
  });
}

export function renderSecurityPage(view) {
  view.append(
    pageHeader({ eyebrow: 'Доступ', title: 'Безпека', description: 'Пароль до адмін-панелі, вихід на всіх пристроях і сповіщення про нові заявки.' }),
    passwordCard(),
    sessionsCard(),
    notificationsCard(),
  );
}

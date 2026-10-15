'use strict';

/**
 * createApp({ dataDir, rootDir, basePath, adminPassword, ... }) → express-застосунок (без listen).
 * Використовується в server.js і в тестах.
 *
 * Публічна частина:  /  /en/  /assets/*  /uploads/*  POST /api/lead  /healthz
 * Адмінка:           /admin/ (статичний інтерфейс)  /admin/api/* (JSON, потрібен вхід)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const ejs = require('ejs');
const multer = require('multer');

const { schema, ICON_NAMES } = require('./schema');
const { collectImageRefs } = require('./validate');
const { ROOT_DIR, loadConfig, dataPaths, projectPaths, normalizeBasePath } = require('./config');
const { ContentStore, isBackupName, isPlainObject } = require('./content-store');
const { Auth, setSessionCookie, clearSessionCookie, createRateLimiter, MAX_PASSWORD_LENGTH } = require('./auth');
const { MediaStore, uploadMiddleware, PURPOSES } = require('./uploads');
const { LeadStore, validateLead, leadLang, LEAD_STATUSES } = require('./leads');
const { Notifier } = require('./notify');
const { buildViewModel } = require('./view-model');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const RATE_WINDOW_MS = 10 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MIN_PASSWORD_LENGTH = 8;

const MSG = {
  serverError: 'Вибачте, сталася помилка на сервері. Спробуйте оновити сторінку трохи згодом.',
  apiServerError: 'Сталася помилка на сервері. Спробуйте ще раз.',
  notFound: 'Не знайдено',
  loginRequired: 'Потрібно увійти',
  csrf: 'Запит відхилено з міркувань безпеки. Оновіть сторінку адмінки і спробуйте ще раз.',
  wrongPassword: 'Невірний пароль',
  invalidFields: 'Перевірте виділені поля',
};

function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (details) err.details = details;
  return err;
}

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req, res, next)).catch(next);
};

const clientKey = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

function queryString(req) {
  const i = req.originalUrl.indexOf('?');
  return i >= 0 ? req.originalUrl.slice(i) : '';
}

function minutesText(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return `${m} хв`;
}

function localDateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const isApiPath = (p) => p.startsWith('/admin/api/') || p === '/admin/api' || p.startsWith('/api/');

/** Перетворює помилку на { status, body } для JSON-відповіді; null — невідома (500). */
function describeError(err) {
  if (err && err.type === 'entity.parse.failed') return { status: 400, body: { error: 'Некоректні дані: помилка у форматі JSON.' } };
  if (err && err.type === 'entity.too.large') return { status: 413, body: { error: 'Занадто великий обсяг даних.' } };
  if (err && (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported')) {
    return { status: 415, body: { error: 'Непідтримуване кодування даних.' } };
  }
  if (err && err.expose && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return { status: err.status, body };
  }
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return { status: err.status, body: { error: err.status === 404 ? MSG.notFound : 'Некоректний запит.' } };
  }
  return null;
}

function wantsJson(req) {
  if (req.is('application/json')) return true;
  const accept = String(req.get('accept') || '');
  return /application\/json/i.test(accept) && !/text\/html/i.test(accept);
}

/**
 * @param {object} [options]
 * @param {string} [options.dataDir]        папка з даними (за замовчуванням DATA_DIR або ./data)
 * @param {string} [options.rootDir]        корінь проєкту (views/, public/, admin/)
 * @param {string} [options.basePath]       префікс для посилань (якщо застосунок змонтовано не в корені)
 * @param {string} [options.adminPassword]  початковий пароль (лише для першого запуску)
 * @param {string} [options.telegramApiBase]
 * @param {boolean} [options.viewCache]     кешувати шаблони (за замовчуванням — у production)
 * @param {object} [options.logger]
 */
function createApp(options = {}) {
  const config = loadConfig();
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const dataDir = path.resolve(options.dataDir || config.dataDir);
  const basePath = normalizeBasePath(options.basePath);
  const logger = options.logger || console;
  const viewCache = options.viewCache !== undefined ? Boolean(options.viewCache) : config.production;
  const paths = { ...projectPaths(rootDir), ...dataPaths(dataDir) };

  /* ---------------- сервіси ---------------- */

  const store = new ContentStore({ contentFile: paths.contentFile, backupsDir: paths.backupsDir, logger });
  store.load();
  const auth = new Auth({
    authFile: paths.authFile,
    defaultPassword: options.adminPassword || config.adminPassword,
    logger,
  }).init();
  const media = new MediaStore({ uploadsDir: paths.uploadsDir, logger });
  const leads = new LeadStore({ leadsFile: paths.leadsFile, logger });
  const notifier = new Notifier({
    settingsFile: paths.settingsFile,
    apiBase: options.telegramApiBase || config.telegramApiBase,
    logger,
    fetch: options.fetch,
  });
  const loginLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 5 });
  const leadLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 5 });

  /* ---------------- express ---------------- */

  const app = express();
  app.disable('x-powered-by');
  app.set('views', paths.viewsDir);
  // Опції передаємо явно: view-model має власне поле `settings`, яке перекриває app.settings.
  app.engine('ejs', (file, data, cb) => ejs.renderFile(file, data, { cache: viewCache }, cb));
  app.set('view engine', 'ejs');

  Object.defineProperty(app, 'services', {
    value: { store, auth, media, leads, notifier, paths, basePath, config },
    enumerable: false,
  });

  function sendServerError(res) {
    if (res.headersSent) return;
    res.status(500).type('text/plain; charset=utf-8').send(MSG.serverError);
  }

  function sendHtml(res, view, locals, status = 200) {
    res.render(view, locals, (err, html) => {
      if (err) {
        logger.error(`Помилка рендерингу шаблону «${view}»:\n${err.stack || err}`);
        sendServerError(res);
        return;
      }
      res.status(status).type('html').send(html);
    });
  }

  function renderPage(lang) {
    return (req, res) => {
      const leadStatus = typeof req.query.lead === 'string' ? req.query.lead : null;
      const vm = buildViewModel(store.get(), lang, { basePath, leadStatus });
      res.set('Cache-Control', 'no-cache');
      sendHtml(res, 'index', vm);
    };
  }

  function sendNotFound(req, res) {
    if (isApiPath(req.path)) {
      res.status(404).json({ error: MSG.notFound });
      return;
    }
    const lang = /^\/en(\/|$)/.test(req.path) ? 'en' : 'uk';
    const plain = () => {
      res.status(404).type('text/plain; charset=utf-8')
        .send(lang === 'en' ? '404 — page not found' : '404 — сторінку не знайдено');
    };
    const isFileRequest = /^\/(assets|uploads|admin)\//.test(req.path);
    const template = path.join(paths.viewsDir, '404.ejs');
    if (!['GET', 'HEAD'].includes(req.method) || isFileRequest || !fs.existsSync(template)) {
      plain();
      return;
    }
    const vm = { ...buildViewModel(store.get(), lang, { basePath }), status: 404 };
    res.set('Cache-Control', 'no-cache');
    res.render('404', vm, (err, html) => {
      if (err) {
        logger.error(`Помилка рендерингу шаблону «404»:\n${err.stack || err}`);
        plain();
        return;
      }
      res.status(404).type('html').send(html);
    });
  }

  /* ---------------- заголовки безпеки ---------------- */

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  /* ---------------- службові ---------------- */

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
  });

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nDisallow: ${basePath}/admin/\nDisallow: ${basePath}/api/\n`);
  });

  app.get('/favicon.ico', (req, res, next) => {
    if (fs.existsSync(path.join(paths.publicDir, 'img', 'favicon-32.png'))) {
      res.redirect(301, `${basePath}/assets/img/favicon-32.png`);
      return;
    }
    next();
  });

  /* ---------------- статика ---------------- */

  const staticTypes = (res, file) => {
    if (file.endsWith('.avif')) res.type('image/avif');
  };
  app.use('/assets', express.static(paths.publicDir, { maxAge: '1h', index: false, redirect: false, setHeaders: staticTypes }));
  app.use('/uploads', express.static(paths.uploadsDir, { maxAge: '1h', index: false, redirect: false, setHeaders: staticTypes }));

  /* ---------------- сторінки сайту ---------------- */

  app.get('/', renderPage('uk'));
  app.get('/en', (req, res, next) => {
    if (req.path === '/en') {
      res.redirect(301, `${basePath}/en/${queryString(req)}`);
      return;
    }
    next();
  }, renderPage('en'));

  /* ---------------- форма заявки ---------------- */

  const leadMultipart = multer({ limits: { files: 0, fields: 20, fieldSize: 4000 } }).none();
  const leadBodyParsers = [
    express.json({ limit: '32kb' }),
    express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 50 }),
    (req, res, next) => {
      if (!req.is('multipart/form-data')) return next();
      return leadMultipart(req, res, (err) => next(err ? httpError(400, 'Некоректні дані форми.') : undefined));
    },
  ];

  app.post('/api/lead', ...leadBodyParsers, asyncHandler(async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const lang = leadLang(body);
    const json = wantsJson(req);
    const reply = (status, payload) => {
      if (json) {
        res.status(status).json(payload);
        return;
      }
      const result = status < 300 ? 'ok' : 'error';
      res.redirect(303, `${basePath}${lang === 'en' ? '/en/' : '/'}?lead=${result}#contact`);
    };

    const ip = clientKey(req);
    const limit = leadLimiter.check(ip);
    if (limit.limited) {
      res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      reply(429, {
        error: lang === 'en'
          ? 'Too many requests in a row. Please try again later or message me directly.'
          : 'Забагато заявок поспіль. Спробуйте пізніше або напишіть мені в месенджер.',
      });
      return;
    }

    const result = validateLead(body);
    if (result.spam) {
      // Бот заповнив приховане поле — вдаємо успіх і нічого не зберігаємо.
      leadLimiter.hit(ip);
      reply(201, { ok: true });
      return;
    }
    if (result.errors.length) {
      reply(400, { error: result.message, details: result.errors });
      return;
    }

    leadLimiter.hit(ip);
    let lead;
    try {
      lead = await leads.add(result.lead);
    } catch (err) {
      logger.error(`Не вдалося зберегти заявку:\n${err.stack || err}`);
      reply(500, {
        error: lang === 'en'
          ? 'Something went wrong. Please message me directly.'
          : 'Не вдалося надіслати заявку. Напишіть мені, будь ласка, в месенджер.',
      });
      return;
    }
    notifier.notifyLead(lead); // не чекаємо: помилки Telegram лише логуються
    reply(201, { ok: true });
  }));

  /* ---------------- адмінка: API ---------------- */

  const api = express.Router();

  api.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });

  // CSRF: будь-який запит, що змінює дані, має містити заголовок X-Admin-Request: 1
  // (його може додати лише JavaScript з нашого ж сайту; звичайна HTML-форма з чужого сайту — ні).
  api.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method) || req.get('X-Admin-Request') === '1') return next();
    res.status(403).json({ error: MSG.csrf });
    return undefined;
  });

  api.use(express.json({ limit: '2mb' }));

  api.post('/login', asyncHandler(async (req, res) => {
    const ip = clientKey(req);
    const limit = loginLimiter.check(ip);
    if (limit.limited) {
      res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      res.status(429).json({ error: `Забагато невдалих спроб. Спробуйте ще раз через ${minutesText(limit.retryAfterMs)}.` });
      return;
    }
    const password = isPlainObject(req.body) && typeof req.body.password === 'string' ? req.body.password : '';
    if (!password) {
      res.status(400).json({ error: 'Введіть пароль' });
      return;
    }
    if (!(await auth.verifyPassword(password))) {
      loginLimiter.hit(ip);
      res.status(401).json({ error: MSG.wrongPassword });
      return;
    }
    loginLimiter.reset(ip);
    setSessionCookie(req, res, auth.issueToken());
    res.json({ ok: true, mustChangePassword: auth.mustChangePassword });
  }));

  api.post('/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  api.get('/session', (req, res) => {
    const authenticated = auth.isAuthenticated(req);
    // Ознаку «стандартний пароль» показуємо лише після входу, щоб не підказувати стороннім.
    res.json({ authenticated, mustChangePassword: authenticated && auth.mustChangePassword });
  });

  // Усе нижче — лише після входу
  api.use((req, res, next) => {
    if (auth.isAuthenticated(req)) return next();
    res.status(401).json({ error: MSG.loginRequired });
    return undefined;
  });

  api.get('/schema', (req, res) => {
    res.json(schema);
  });

  api.get('/icons', (req, res) => {
    const vm = buildViewModel(store.get(), 'uk');
    const out = {};
    for (const name of ICON_NAMES) out[name] = vm.icon(name, 'icon');
    res.json(out);
  });

  api.get('/content', (req, res) => {
    res.json(store.get());
  });

  const saveContent = (badShapeMessage) => asyncHandler(async (req, res) => {
    let input = req.body;
    // Підтримуємо також обгортку { content: {...} }
    if (isPlainObject(input) && !isPlainObject(input.sections) && isPlainObject(input.content)) input = input.content;
    if (!isPlainObject(input) || !isPlainObject(input.sections)) throw httpError(400, badShapeMessage);
    const result = await store.save(input);
    if (result.errors) {
      res.status(422).json({ error: MSG.invalidFields, details: result.errors });
      return;
    }
    res.json({ ok: true, content: result.content });
  });

  api.put('/content', saveContent('Некоректні дані: очікувався повний вміст сайту.'));
  api.post('/import', saveContent('Це не схоже на файл з вмістом сайту. Оберіть файл, збережений через «Завантажити копію».'));

  api.get('/export', (req, res) => {
    res.set('Content-Disposition', `attachment; filename="anna-frolova-content-${localDateStamp()}.json"`);
    res.type('application/json').send(`${JSON.stringify(store.get(), null, 2)}\n`);
  });

  // Завантаження фото
  api.post('/upload', (req, res, next) => {
    const { purpose } = req.query;
    if (purpose !== undefined && purpose !== '' && !Object.prototype.hasOwnProperty.call(PURPOSES, purpose)) {
      next(httpError(400, 'Невідоме призначення файлу (очікується photo або logo).'));
      return;
    }
    next();
  }, uploadMiddleware, asyncHandler(async (req, res) => {
    if (!req.file) throw httpError(400, 'Файл не отримано. Оберіть фото і спробуйте ще раз.');
    const purpose = req.query.purpose || 'photo';
    const saved = await media.saveUpload({ buffer: req.file.buffer, originalName: req.file.originalname, purpose });
    res.status(201).json(saved);
  }));

  // Медіатека
  api.get('/media', asyncHandler(async (req, res) => {
    res.json(await media.list(collectImageRefs(store.get())));
  }));

  api.delete('/media/:name', asyncHandler(async (req, res) => {
    const force = req.query.force === '1' || req.query.force === 'true';
    await media.remove(req.params.name, { force, usedRefs: collectImageRefs(store.get()) });
    res.json({ ok: true });
  }));

  // Заявки
  api.get('/leads', (req, res) => {
    res.json(leads.list());
  });

  api.patch('/leads/:id', asyncHandler(async (req, res) => {
    const status = isPlainObject(req.body) ? req.body.status : undefined;
    if (!LEAD_STATUSES.includes(status)) {
      throw httpError(400, 'Невідомий статус заявки', [{ field: 'status', message: 'Оберіть: Нова, В роботі або Завершена' }]);
    }
    const lead = await leads.setStatus(req.params.id, status);
    if (!lead) throw httpError(404, 'Заявку не знайдено — можливо, її вже видалили.');
    res.json(lead);
  }));

  api.delete('/leads/:id', asyncHandler(async (req, res) => {
    if (!(await leads.remove(req.params.id))) throw httpError(404, 'Заявку не знайдено — можливо, її вже видалили.');
    res.json({ ok: true });
  }));

  // Сповіщення в Telegram
  api.get('/notifications', (req, res) => {
    res.json(notifier.publicSettings());
  });

  api.put('/notifications', asyncHandler(async (req, res) => {
    res.json(await notifier.update(req.body));
  }));

  api.post('/notifications/test', asyncHandler(async (req, res) => {
    await notifier.sendTest(req.body);
    res.json({ ok: true });
  }));

  // Зміна пароля
  api.post('/password', asyncHandler(async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';
    const ip = clientKey(req);

    if (!current) throw httpError(400, 'Введіть поточний пароль', [{ field: 'current', message: 'Введіть поточний пароль' }]);
    const limit = loginLimiter.check(ip);
    if (limit.limited) {
      res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      throw httpError(429, `Забагато невдалих спроб. Спробуйте ще раз через ${minutesText(limit.retryAfterMs)}.`);
    }
    // Не 401: інакше адмінка вирішить, що сесія завершилась, і поверне на екран входу.
    if (!(await auth.verifyPassword(current))) {
      loginLimiter.hit(ip);
      throw httpError(400, 'Поточний пароль невірний', [{ field: 'current', message: 'Поточний пароль невірний' }]);
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, `Новий пароль має містити щонайменше ${MIN_PASSWORD_LENGTH} символів`, [
        { field: 'next', message: `Щонайменше ${MIN_PASSWORD_LENGTH} символів` },
      ]);
    }
    if (next.length > MAX_PASSWORD_LENGTH) {
      throw httpError(400, 'Занадто довгий пароль', [{ field: 'next', message: `Максимум ${MAX_PASSWORD_LENGTH} символів` }]);
    }
    if (next === current) {
      throw httpError(400, 'Новий пароль має відрізнятися від поточного', [{ field: 'next', message: 'Пароль не змінився' }]);
    }
    await auth.changePassword(next);
    setSessionCookie(req, res, auth.issueToken()); // поточна сесія лишається, інші — завершуються
    res.json({ ok: true, mustChangePassword: false });
  }));

  // Резервні копії
  api.get('/backups', asyncHandler(async (req, res) => {
    res.json(await store.listBackups());
  }));

  api.get('/backups/:name', (req, res, next) => {
    const file = store.backupPath(req.params.name);
    if (!file) {
      next(httpError(404, 'Резервну копію не знайдено.'));
      return;
    }
    res.set('Content-Disposition', `attachment; filename="anna-frolova-${req.params.name}"`);
    res.type('application/json').sendFile(file, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  api.post('/backups/:name/restore', asyncHandler(async (req, res) => {
    if (!isBackupName(req.params.name)) throw httpError(400, 'Недопустима назва резервної копії.');
    const result = await store.restoreBackup(req.params.name);
    if (result.notFound) throw httpError(404, 'Резервну копію не знайдено.');
    if (result.invalid) throw httpError(422, 'Резервна копія пошкоджена — її не вдалося прочитати.');
    if (result.errors) {
      res.status(422).json({ error: 'Резервна копія не відповідає поточній структурі сайту.', details: result.errors });
      return;
    }
    res.json({ ok: true, content: result.content });
  }));

  api.use((req, res) => {
    res.status(404).json({ error: MSG.notFound });
  });

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    const described = describeError(err);
    if (!described) logger.error(`Помилка API ${req.method} ${req.originalUrl}:\n${err.stack || err}`);
    res.status(described ? described.status : 500).json(described ? described.body : { error: MSG.apiServerError });
  });

  /* ---------------- адмінка: інтерфейс ---------------- */

  app.get('/admin', (req, res, next) => {
    if (req.path === '/admin') {
      res.redirect(302, `${basePath}/admin/${queryString(req)}`);
      return;
    }
    next();
  });
  app.use('/admin/api', api);
  app.use('/admin', express.static(paths.adminDir, {
    index: 'index.html',
    setHeaders: (res) => res.set({ 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' }),
  }));

  /* ---------------- 404 і помилки ---------------- */

  app.use(sendNotFound);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      logger.error(err.stack || err);
      return;
    }
    const described = describeError(err);
    if (described && described.status === 404) {
      sendNotFound(req, res);
      return;
    }
    if (!described) logger.error(`Помилка ${req.method} ${req.originalUrl}:\n${err.stack || err}`);
    if (isApiPath(req.path)) {
      res.status(described ? described.status : 500).json(described ? described.body : { error: MSG.apiServerError });
      return;
    }
    res.status(described ? described.status : 500)
      .type('text/plain; charset=utf-8')
      .send(described ? described.body.error : MSG.serverError);
  });

  return app;
}

module.exports = { createApp, CONTENT_SECURITY_POLICY };

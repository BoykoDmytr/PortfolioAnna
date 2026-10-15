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
const { collectImageRefs, charsAtLeast } = require('./validate');
const { ROOT_DIR, loadConfig, dataPaths, projectPaths, normalizeBasePath, DEFAULT_ADMIN_PASSWORD } = require('./config');
const { ContentStore, isBackupName, isPlainObject } = require('./content-store');
const { Auth, setSessionCookie, clearSessionCookie, MAX_PASSWORD_LENGTH } = require('./auth');
const { createRateLimiter } = require('./limits');
const { isLocalRequest, createHostGuard, requestOrigin } = require('./net');
const { MediaStore, uploadMiddleware, PURPOSES } = require('./uploads');
const { LeadStore, validateLead, validateLeadNote, leadLang, LEAD_STATUSES } = require('./leads');
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
const HSTS = 'max-age=15552000'; // 180 днів; лише для відповідей через HTTPS
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MIN_PASSWORD_LENGTH = 8;

const MSG = {
  serverError: 'Вибачте, сталася помилка на сервері. Спробуйте оновити сторінку трохи згодом.',
  apiServerError: 'Сталася помилка на сервері. Спробуйте ще раз.',
  notFound: 'Не знайдено',
  loginRequired: 'Потрібно увійти',
  csrf: 'Запит відхилено з міркувань безпеки. Оновіть сторінку адмінки і спробуйте ще раз.',
  wrongPassword: 'Неправильний пароль',
  wrongCurrentPassword: 'Поточний пароль неправильний',
  invalidFields: 'Перевірте виділені поля',
  busy: 'Сервер зараз зайнятий. Спробуйте ще раз за хвилину.',
  contentConflict: 'Сайт щойно змінили на іншому пристрої або в іншій вкладці. Натисніть «Зберегти» ще раз — зміни буде поєднано.',
  unknownHost: (host) => `Адмінка не відкривається за адресою «${host || '(без адреси)'}». Відкрийте її за адресою localhost або IP-адресою комп’ютера (її показано в терміналі після запуску). Якщо це домен вашого сайту — вкажіть його в «SEO та соцмережі → Адреса сайту» або в змінній ALLOWED_HOSTS.`,
};

const toAttemptsLeft = (n) => Math.max(0, n);

function tooManyAttempts(retryAfterMs) {
  const m = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return `Забагато невдалих спроб. Спробуйте ще раз через ${m} хв.`;
}

/** If-Match: "abc" | W/"abc" | abc → 'abc' ('' — заголовка немає або '*'). */
function parseIfMatch(value) {
  const v = String(value || '').split(',')[0].trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
  return v === '*' ? '' : v;
}

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

// За TRUST_PROXY req.ip — справжня адреса відвідувача з X-Forwarded-For, інакше — адреса з'єднання.
const clientKey = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

function queryString(req) {
  const i = req.originalUrl.indexOf('?');
  return i >= 0 ? req.originalUrl.slice(i) : '';
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
 * @param {boolean} [options.production]    робочий режим (NODE_ENV=production): стандартний пароль не діє
 * @param {*}      [options.trustProxy]     значення для app.set('trust proxy') (TRUST_PROXY)
 * @param {string[]} [options.allowedHosts] додаткові домени адмінки (ALLOWED_HOSTS)
 * @param {object} [options.scryptParams]   {N, r, p} для хешу пароля — лише для тестів (швидше)
 * @param {object} [options.logger]
 */
function createApp(options = {}) {
  const config = loadConfig();
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const dataDir = path.resolve(options.dataDir || config.dataDir);
  const basePath = normalizeBasePath(options.basePath);
  const logger = options.logger || console;
  const production = options.production !== undefined ? Boolean(options.production) : config.production;
  const viewCache = options.viewCache !== undefined ? Boolean(options.viewCache) : production;
  const trustProxy = options.trustProxy !== undefined ? options.trustProxy : config.trustProxy;
  const allowedHosts = options.allowedHosts || config.allowedHosts;
  const paths = { ...projectPaths(rootDir), ...dataPaths(dataDir) };

  /* ---------------- сервіси ---------------- */

  const store = new ContentStore({ contentFile: paths.contentFile, backupsDir: paths.backupsDir, logger });
  store.load();
  const auth = new Auth({
    authFile: paths.authFile,
    defaultPassword: options.adminPassword || config.adminPassword,
    scryptParams: options.scryptParams,
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
  if (trustProxy) app.set('trust proxy', trustProxy);

  const hostGuard = createHostGuard({
    allowedHosts,
    trustProxy: Boolean(trustProxy),
    siteUrl: () => (store.get().seo || {}).siteUrl || '',
  });

  /**
   * Стандартний пароль «anna2026» є в інструкції, тож його знає будь-хто. Поки він діє, вхід з ним —
   * лише з браузера на цьому ж комп'ютері (не з телефона в Wi-Fi і не через інтернет-проксі),
   * а в робочому режимі (NODE_ENV=production, сервер в інтернеті) — взагалі ні.
   */
  const defaultPasswordBlocked = (req) => auth.usingPublicDefault && (production || !isLocalRequest(req));

  function defaultPasswordMessage(req) {
    if (production) {
      return 'Стандартний пароль на сервері в інтернеті не діє. Зупиніть сервер, видаліть файл data/private/auth.json '
        + 'і запустіть сервер знову з власним паролем: ADMIN_PASSWORD="ваш-пароль" (див. README, варіант Б).';
    }
    const port = req.socket && req.socket.localPort ? `:${req.socket.localPort}` : '';
    return 'Пароль ще стандартний (з інструкції), тому з телефона чи іншого пристрою ним увійти не можна — '
      + 'щоб ніхто сторонній у вашій Wi-Fi не відкрив адмінку. '
      + `Змініть пароль на комп’ютері, де запущено сайт: http://localhost${port}/admin/ → «Безпека». `
      + 'Потім входьте з телефона з новим паролем.';
  }
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
      const vm = buildViewModel(store.get(), lang, { basePath, leadStatus, origin: requestOrigin(req) });
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
    const vm = { ...buildViewModel(store.get(), lang, { basePath, origin: requestOrigin(req) }), status: 404 };
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
    // HTTPS (напряму або через проксі з TRUST_PROXY): браузер і надалі ходитиме лише по HTTPS
    if (req.secure) res.set('Strict-Transport-Security', HSTS);
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
  // Додатково: якщо браузер вказав Origin, він має збігатися з адресою сайту.
  api.use((req, res, next) => {
    if (SAFE_METHODS.has(req.method) || (req.get('X-Admin-Request') === '1' && hostGuard.originMatches(req))) return next();
    res.status(403).json({ error: MSG.csrf });
    return undefined;
  });

  api.use(express.json({ limit: '2mb' }));

  /**
   * Перевіряє пароль з урахуванням ліміту спроб. Спробу враховано ще ДО перевірки (consume),
   * тож сотня паралельних запитів не отримає сотню перевірок замість п'яти.
   * → { ok: true } | { ok: false, attemptsLeft } ; відповідь 429/503 надсилає сама (→ null).
   */
  async function checkPassword(req, res, password) {
    const attempt = loginLimiter.consume(clientKey(req));
    if (attempt.limited) {
      res.set('Retry-After', String(Math.ceil(attempt.retryAfterMs / 1000)));
      res.status(429).json({ error: tooManyAttempts(attempt.retryAfterMs), attemptsLeft: 0 });
      return null;
    }
    let ok;
    try {
      ok = await auth.verifyPassword(password);
    } catch (err) {
      attempt.undo(); // пароль не перевірявся — спробу не рахуємо
      if (err.code !== 'BUSY') throw err;
      res.set('Retry-After', '30');
      res.status(503).json({ error: MSG.busy });
      return null;
    }
    if (!ok) return { ok: false, attemptsLeft: toAttemptsLeft(attempt.remaining) };
    loginLimiter.reset(clientKey(req));
    return { ok: true };
  }

  api.post('/login', asyncHandler(async (req, res) => {
    const password = isPlainObject(req.body) && typeof req.body.password === 'string' ? req.body.password : '';
    if (!password) {
      res.status(400).json({ error: 'Введіть пароль' });
      return;
    }
    if (password === DEFAULT_ADMIN_PASSWORD && defaultPasswordBlocked(req)) {
      res.status(403).json({ error: defaultPasswordMessage(req), reason: 'default-password' });
      return;
    }
    const result = await checkPassword(req, res, password);
    if (!result) return;
    if (!result.ok) {
      res.status(401).json({ error: MSG.wrongPassword, attemptsLeft: result.attemptsLeft });
      return;
    }
    setSessionCookie(req, res, auth.issueToken());
    res.json({ ok: true, mustChangePassword: auth.mustChangePassword });
  }));

  // { everywhere: true } — «Вийти на всіх пристроях» (усі видані входи стають недійсними).
  // Інакше відкликається лише поточний вхід: навіть скопійована cookie більше не діятиме.
  api.post('/logout', asyncHandler(async (req, res) => {
    const token = auth.tokenFrom(req);
    if (isPlainObject(req.body) && req.body.everywhere === true) {
      if (!auth.verifyToken(token)) {
        res.status(401).json({ error: MSG.loginRequired });
        return;
      }
      await auth.revokeAllSessions();
    } else if (token) {
      await auth.revokeToken(token).catch((err) => logger.warn(`Не вдалося відкликати сесію: ${err.message}`));
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }));

  // Вхід зі стандартним паролем з іншого пристрою (наприклад, cookie, видана до оновлення) не діє.
  const isSignedIn = (req) => auth.isAuthenticated(req) && !defaultPasswordBlocked(req);

  api.get('/session', (req, res) => {
    const authenticated = isSignedIn(req);
    // Ознаку «стандартний пароль» показуємо лише після входу, щоб не підказувати стороннім.
    res.json({ authenticated, mustChangePassword: authenticated && auth.mustChangePassword });
  });

  // Усе нижче — лише після входу
  api.use((req, res, next) => {
    if (isSignedIn(req)) return next();
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

  // X-Content-Revision — відбиток збереженого вмісту. Адмінка надсилає його назад в If-Match,
  // і якщо тим часом сайт зберегли з іншого пристрою, отримує 412 замість тихого затирання чужих змін.
  const sendRevision = (res) => res.set('X-Content-Revision', store.revision);

  api.get('/content', (req, res) => {
    sendRevision(res);
    res.json(store.get());
  });

  const saveContent = (badShapeMessage, { checkRevision = false } = {}) => asyncHandler(async (req, res) => {
    let input = req.body;
    // Підтримуємо також обгортку { content: {...} }
    if (isPlainObject(input) && !isPlainObject(input.sections) && isPlainObject(input.content)) input = input.content;
    if (!isPlainObject(input) || !isPlainObject(input.sections)) throw httpError(400, badShapeMessage);
    const expectedRevision = checkRevision ? parseIfMatch(req.get('If-Match')) : '';
    const result = await store.save(input, { expectedRevision });
    sendRevision(res);
    if (result.conflict) {
      res.status(412).json({ error: MSG.contentConflict });
      return;
    }
    if (result.errors) {
      res.status(422).json({ error: MSG.invalidFields, details: result.errors });
      return;
    }
    res.json({ ok: true, content: result.content });
  });

  api.put('/content', saveContent('Некоректні дані: очікувався повний вміст сайту.', { checkRevision: true }));
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

  // { status } і/або { note } — нотатка для себе (до 1000 символів)
  api.patch('/leads/:id', asyncHandler(async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const changes = {};
    if (body.status !== undefined) {
      if (!LEAD_STATUSES.includes(body.status)) {
        throw httpError(400, 'Невідомий статус заявки', [{ field: 'status', message: 'Оберіть: Нова, У роботі або Завершена' }]);
      }
      changes.status = body.status;
    }
    if (body.note !== undefined) {
      const note = validateLeadNote(body.note);
      if (note.error) throw httpError(400, note.error, [{ field: 'note', message: note.error }]);
      changes.note = note.value;
    }
    if (!Object.keys(changes).length) {
      throw httpError(400, 'Невідомий статус заявки', [{ field: 'status', message: 'Оберіть: Нова, У роботі або Завершена' }]);
    }
    const lead = await leads.update(req.params.id, changes);
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

    if (!current) throw httpError(400, 'Введіть поточний пароль', [{ field: 'current', message: 'Введіть поточний пароль' }]);
    const result = await checkPassword(req, res, current);
    if (!result) return;
    // Не 401: інакше адмінка вирішить, що сесія завершилась, і поверне на екран входу.
    if (!result.ok) {
      res.status(400).json({
        error: MSG.wrongCurrentPassword,
        details: [{ field: 'current', message: MSG.wrongCurrentPassword }],
        attemptsLeft: result.attemptsLeft,
      });
      return;
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      throw httpError(400, `Новий пароль має містити ${charsAtLeast(MIN_PASSWORD_LENGTH)}`, [
        { field: 'next', message: `Щонайменше ${MIN_PASSWORD_LENGTH} символів` },
      ]);
    }
    if (next.length > MAX_PASSWORD_LENGTH) {
      throw httpError(400, 'Занадто довгий пароль', [{ field: 'next', message: `Не більше ${MAX_PASSWORD_LENGTH} символів` }]);
    }
    if (next === current) {
      throw httpError(400, 'Новий пароль має відрізнятися від поточного', [{ field: 'next', message: 'Пароль не змінився' }]);
    }
    if (next === DEFAULT_ADMIN_PASSWORD) {
      throw httpError(400, 'Це стандартний пароль з інструкції — його знають усі', [
        { field: 'next', message: 'Це стандартний пароль з інструкції. Придумайте власний.' },
      ]);
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

  // DNS rebinding: сторінка чужого сайту, чий домен раптом «вказує» на 127.0.0.1, для браузера
  // має ту саму адресу, що й адмінка. Такі запити розпізнаємо за доменом у заголовку Host.
  app.use('/admin', (req, res, next) => {
    if (hostGuard.allows(req)) return next();
    const message = MSG.unknownHost(String(req.headers.host || '').slice(0, 100));
    res.set('Cache-Control', 'no-store');
    if (isApiPath(req.originalUrl.split('?')[0])) res.status(421).json({ error: message });
    else res.status(421).type('text/plain; charset=utf-8').send(message);
    return undefined;
  });

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

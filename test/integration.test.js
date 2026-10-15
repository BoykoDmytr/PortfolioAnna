'use strict';

/**
 * Інтеграційні перевірки «все разом»: seed-контент, шаблони, статика, адмінка, експорт.
 * Ловлять те, що окремі модульні тести не бачать: биті посилання на файли, неперекладені тексти,
 * відсутні іконки, зламані імпорти модулів адмінки.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, createClient, makeTempDataDir, readJson, ROOT_DIR, SEED_DATA_DIR } = require('./helpers');
const { sanitizeContent, collectImageRefs } = require('../src/validate');
const { schema } = require('../src/schema');
const { ICONS } = require('../src/icons');
const { buildViewModel } = require('../src/view-model');

const CYRILLIC = /[А-Яа-яЇїІіЄєҐґ]/;
const seed = () => readJson(path.join(SEED_DATA_DIR, 'content.json'));

/** Локальні посилання (src/href/srcset) з HTML: лише /assets/… і /uploads/… */
function localRefs(html, base = '') {
  const refs = new Set();
  for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
    const url = m[1].replace(/&amp;/g, '&');
    if (url.startsWith(`${base}/assets/`) || url.startsWith(`${base}/uploads/`)) refs.add(url.split(/[?#]/)[0]);
  }
  return [...refs];
}

/** Видимий текст сторінки без svg, script, style і елементів з lang="uk" (перемикач мови). */
function visibleText(html) {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<a [^>]*lang="uk"[^>]*>[\s\S]*?<\/a>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

let ctx;
let client;

before(async () => {
  ctx = await startServer();
  client = createClient(ctx.base);
});

after(() => ctx.close());

/* ---------------- seed-контент ---------------- */

test('seed: content.json уже в очищеному вигляді (sanitize нічого не змінює)', () => {
  const raw = seed();
  const { content, errors } = sanitizeContent(raw);
  assert.deepEqual(errors, []);
  assert.deepEqual(content, raw);
});

test('seed: усі фото, на які посилається контент, є в data/uploads', () => {
  const refs = [...collectImageRefs(seed())];
  assert.ok(refs.length >= 20, `очікувалось багато фото, є ${refs.length}`);
  for (const ref of refs) {
    assert.match(ref, /^\/uploads\//, ref);
    assert.ok(fs.existsSync(path.join(SEED_DATA_DIR, ref)), `немає файлу ${ref}`);
  }
});

test('seed: папка uploads не перевищує 10 МБ', () => {
  const dir = path.join(SEED_DATA_DIR, 'uploads');
  const total = fs.readdirSync(dir).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(total <= 10 * 1024 * 1024, `${(total / 1048576).toFixed(1)} МБ`);
});

test('seed: усі тексти інтерфейсу й SEO заповнені обома мовами', () => {
  const c = seed();
  for (const field of schema.groups.find((g) => g.key === 'ui').fields) {
    assert.ok(c.ui[field.key].uk && c.ui[field.key].en, `ui.${field.key}`);
  }
  for (const key of ['title', 'description']) assert.ok(c.seo[key].uk && c.seo[key].en, `seo.${key}`);
});

test('seed: усі 10 секцій увімкнені, hero перша', () => {
  const c = seed();
  assert.equal(c.order[0], 'hero');
  for (const def of schema.sections) assert.equal(c.sections[def.type].enabled, true, def.type);
});

/* ---------------- сторінки ---------------- */

for (const page of ['/', '/en/']) {
  test(`${page}: кожне локальне посилання (/assets, /uploads) відповідає 200`, async () => {
    const res = await client.get(page);
    assert.equal(res.status, 200);
    const refs = localRefs(res.text);
    assert.ok(refs.some((r) => r.startsWith('/assets/css/')), 'є стилі');
    assert.ok(refs.some((r) => r.startsWith('/uploads/')), 'є фото');
    for (const ref of refs) {
      const r = await fetch(ctx.base + ref);
      assert.equal(r.status, 200, ref);
      await r.arrayBuffer();
    }
  });

  test(`${page}: без inline-скриптів і обробників подій (CSP)`, async () => {
    const { text } = await client.get(page);
    assert.doesNotMatch(text, /<script(?![^>]*\ssrc=)[^>]*>/, 'inline <script>');
    assert.doesNotMatch(text, /\son[a-z]+="/i, 'inline on*= handler');
    assert.equal((text.match(/<h1[\s>]/g) || []).length, 1, 'рівно один h1');
  });
}

test('/en/: видимий текст без кирилиці (усе перекладено)', async () => {
  const { text } = await client.get('/en/');
  const leftovers = visibleText(text).split(/\s{2,}|\n/).filter((chunk) => CYRILLIC.test(chunk));
  assert.deepEqual(leftovers, []);
});

test('/: усі месенджери (Telegram, Viber, Instagram, телефон) мають посилання', async () => {
  const { text } = await client.get('/');
  assert.match(text, /href="https:\/\/t\.me\/anna_frolova_travel"/);
  assert.match(text, /href="viber:\/\/chat\?number=%2B380\d{9}"/);
  assert.match(text, /href="https:\/\/instagram\.com\/anna\.frolova\.travel"/);
  assert.match(text, /href="tel:\+380\d{9}"/);
});

test('CSS: усі url(...) у public/css вказують на наявні файли', () => {
  const cssDir = path.join(ROOT_DIR, 'public', 'css');
  for (const file of fs.readdirSync(cssDir).filter((f) => f.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(cssDir, file), 'utf8');
    for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/g)) {
      const ref = m[1] || m[2] || m[3];
      if (/^(data:|https?:|#)/.test(ref)) continue;
      assert.ok(fs.existsSync(path.resolve(cssDir, ref)), `${file}: ${ref}`);
    }
  }
});

test('іконки: усі назви зі схеми та з шаблонів є в src/icons.js', () => {
  const used = new Set(schema.icons.map((i) => i.value));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const file of walk(path.join(ROOT_DIR, 'views'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/icon\('([a-z0-9-]+)'/g)) used.add(m[1]);
  }
  // динамічні: месенджери (m.key) і деталі контактів (d.icon)
  for (const name of ['telegram', 'viber', 'instagram', 'phone', 'mail', 'pin', 'clock']) used.add(name);
  for (const name of used) assert.ok(ICONS[name], `немає іконки «${name}»`);
});

/* ---------------- відгуки: ім’я перекладається ---------------- */

test('відгуки: старе ім’я-рядок мігрує в { uk, en } без помилок', () => {
  const c = seed();
  c.sections.reviews.items[0].name = 'Олена та Андрій';
  const { content, errors } = sanitizeContent(c);
  assert.deepEqual(errors, []);
  assert.deepEqual(content.sections.reviews.items[0].name, { uk: 'Олена та Андрій', en: '' });
});

test('відгуки: ім’я й ініціали локалізовані, сполучники пропускаються', async () => {
  const c = seed();
  c.sections.reviews.items = [{ id: 'r1', name: { uk: 'Олена та Андрій', en: 'Olena & Andriy' }, trip: { uk: '', en: '' }, text: { uk: 'Дуже дякуємо!', en: 'Thank you!' }, photo: '', rating: 5 }];
  const ejs = require('ejs');
  const render = (lang) => ejs.renderFile(path.join(ROOT_DIR, 'views', 'index.ejs'), buildViewModel(sanitizeContent(c).content, lang));
  const uk = await render('uk');
  const en = await render('en');
  assert.match(uk, /review__initials[^>]*>ОА</);
  assert.match(uk, /review__name">Олена та Андрій</);
  assert.match(en, /review__initials[^>]*>OA</);
  assert.match(en, /review__name">Olena &amp; Andriy</);
});

/* ---------------- адмінка ---------------- */

test('адмінка: файли з index.html існують, усі ES-імпорти розв’язуються й експортуються', () => {
  const adminDir = path.join(ROOT_DIR, 'admin');
  const html = fs.readFileSync(path.join(adminDir, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/, 'inline <script> в адмінці');
  assert.doesNotMatch(html, /\son[a-z]+="/i, 'inline on*= в адмінці');
  for (const m of html.matchAll(/\s(?:src|href)="([^"#]+)"/g)) {
    if (/^https?:/.test(m[1]) || m[1].endsWith('/')) continue; // зовнішні посилання і сторінки сайту (../, ../en/)
    // URL-мапінг: /admin/ → admin/, /assets/ → public/
    const file = m[1].startsWith('../assets/') ? path.join(ROOT_DIR, 'public', m[1].slice('../assets/'.length)) : path.resolve(adminDir, m[1]);
    assert.ok(fs.existsSync(file), `index.html → ${m[1]}`);
  }

  const exportsOf = (file) => {
    const src = fs.readFileSync(file, 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop());
    }
    return names;
  };
  const jsFiles = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) walk(path.join(dir, d.name));
      else if (d.name.endsWith('.js')) jsFiles.push(path.join(dir, d.name));
    }
  };
  walk(path.join(adminDir, 'js'));
  assert.ok(jsFiles.length >= 10);
  for (const file of jsFiles) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /\.innerHTML\s*=/, `${path.basename(file)}: innerHTML`);
    for (const m of src.matchAll(/import\s*(?:\{([^}]*)\}\s*from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[2]);
      assert.ok(fs.existsSync(target), `${path.relative(adminDir, file)} → ${m[2]}`);
      if (!m[1]) continue;
      const available = exportsOf(target);
      for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        const name = part.split(/\s+as\s+/)[0].trim();
        assert.ok(available.has(name), `${path.relative(adminDir, file)}: «${name}» не експортується з ${m[2]}`);
      }
    }
  }
});

test('адмінка: /admin/ і її модулі віддаються сервером', async () => {
  for (const url of ['/admin/', '/admin/admin.css', '/admin/js/main.js', '/assets/img/monogram.svg', '/assets/img/favicon.svg']) {
    const res = await client.get(url);
    assert.equal(res.status, 200, url);
  }
  assert.match((await client.get('/admin/js/main.js')).headers.get('content-type'), /javascript/);
});

/* ---------------- статичний експорт seed-контенту ---------------- */

test('експорт seed-контенту з BASE_PATH: без форми, месенджери є, усі посилання на місці', () => {
  const tmp = makeTempDataDir();
  const outDir = path.join(tmp.root, 'site');
  try {
    execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'export-static.js')], {
      cwd: ROOT_DIR,
      env: { ...process.env, DATA_DIR: tmp.dataDir, OUT_DIR: outDir, BASE_PATH: '/PortfolioAnna' },
      stdio: 'pipe',
    });
    for (const page of ['index.html', 'en/index.html']) {
      const html = fs.readFileSync(path.join(outDir, page), 'utf8');
      assert.doesNotMatch(html, /<form/, `${page}: форми не має бути`);
      assert.doesNotMatch(html, /\/api\/lead|\/admin/, `${page}: без API й адмінки`);
      assert.match(html, /messenger--telegram/, page);
      assert.match(html, /messenger--viber/, page);
      for (const ref of localRefs(html, '/PortfolioAnna')) {
        const file = path.join(outDir, ref.replace(/^\/PortfolioAnna\//, ''));
        assert.ok(fs.existsSync(file), `${page} → ${ref}`);
      }
    }
  } finally {
    fs.rmSync(tmp.root, { recursive: true, force: true });
  }
});

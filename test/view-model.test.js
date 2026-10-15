'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeContent } = require('../src/validate');
const { buildViewModel, viberNumber } = require('../src/view-model');

function fixture(patch = {}) {
  const { content } = sanitizeContent({
    settings: { brandName: 'ANNA FROLOVA', brandTagline: 'TRAVEL', logo: '', showAgency: true, agencyName: { uk: 'Агенція «Світ»', en: 'World Agency' } },
    contacts: {
      phone: '+380 67 123 45 67',
      telegram: '@anna_frolova_travel',
      viber: '+380671234567',
      instagram: 'https://instagram.com/anna.frolova.travel/',
      email: 'anna@example.com',
    },
    ui: {
      writeTelegram: { uk: 'Написати в Telegram', en: 'Message on Telegram' },
      writeViber: { uk: 'Написати у Viber', en: 'Message on Viber' },
      writeInstagram: { uk: 'Instagram', en: 'Instagram' },
      call: { uk: 'Зателефонувати', en: 'Call' },
      rights: { uk: 'Усі права захищено', en: '' },
    },
    seo: { title: { uk: 'Анна Фролова — подорожі', en: 'Anna Frolova — travel' }, description: { uk: 'Опис', en: '' }, ogImage: '/uploads/og-image.jpg' },
    order: ['hero', 'faq', 'about', 'contact'],
    sections: {
      hero: { enabled: true, showInNav: true, navLabel: { uk: 'Головна' }, title: { uk: 'Подорожі', en: 'Journeys' }, image: '/uploads/hero.webp' },
      about: { enabled: true, showInNav: true, navLabel: { uk: 'Про мене', en: 'About' }, text: { uk: 'Перший абзац.\n\nДругий абзац.\n\n\n  \n', en: '' } },
      services: { enabled: false, navLabel: { uk: 'Послуги' } },
      faq: { enabled: true, showInNav: false, navLabel: { uk: 'Питання' } },
      contact: { enabled: true, showInNav: true, navLabel: { uk: 'Контакти', en: 'Contact' }, formEnabled: true },
      gallery: { enabled: true, showInNav: true, navLabel: { uk: '', en: '' } },
    },
    ...patch,
  });
  return content;
}

test('мови, t(), paras(), u()', () => {
  const vm = buildViewModel(fixture(), 'uk');
  assert.equal(vm.lang, 'uk');
  assert.equal(vm.htmlLang, 'uk');
  assert.deepEqual(vm.langs.map(({ code, short, href, active }) => ({ code, short, href, active })), [
    { code: 'uk', short: 'UA', href: '/', active: true },
    { code: 'en', short: 'EN', href: '/en/', active: false },
  ]);
  assert.equal(vm.t({ uk: 'Так', en: 'Yes' }), 'Так');
  assert.equal(vm.t({ uk: '', en: 'Yes' }), 'Yes', 'запасний варіант — інша мова');
  assert.equal(vm.t(undefined), '');
  assert.equal(vm.t(null), '');
  assert.equal(vm.t({}), '');
  assert.deepEqual(vm.paras(vm.section('about').text), ['Перший абзац.', 'Другий абзац.']);
  assert.deepEqual(vm.paras(undefined), []);
  assert.equal(vm.u('rights'), 'Усі права захищено');

  const en = buildViewModel(fixture(), 'en');
  assert.equal(en.lang, 'en');
  assert.equal(en.langs.find((l) => l.active).code, 'en');
  assert.equal(en.u('rights'), 'Усі права захищено', 'EN порожній → UA');
  assert.equal(en.t({ uk: 'Так', en: 'Yes' }), 'Yes');

  assert.equal(buildViewModel(fixture(), 'de').lang, 'uk', 'невідома мова → українська');
});

test('asset(), img() і basePath', () => {
  const vm = buildViewModel(fixture(), 'uk', { basePath: '/PortfolioAnna/' });
  assert.equal(vm.asset('/assets/css/site.css'), '/PortfolioAnna/assets/css/site.css');
  assert.equal(vm.img('/uploads/a.webp'), '/PortfolioAnna/uploads/a.webp');
  assert.equal(vm.img('/assets/img/monogram.svg'), '/PortfolioAnna/assets/img/monogram.svg');
  assert.equal(vm.img('https://images.example.com/x.jpg'), 'https://images.example.com/x.jpg');
  assert.equal(vm.img(''), '');
  assert.equal(vm.img(undefined), '');
  assert.equal(vm.img('javascript:alert(1)'), '');
  assert.equal(vm.img('http://insecure.example/x.jpg'), '');
  assert.equal(vm.leadAction, '/PortfolioAnna/api/lead');
  assert.deepEqual(vm.langs.map((l) => l.href), ['/PortfolioAnna/', '/PortfolioAnna/en/']);
  assert.equal(buildViewModel(fixture(), 'uk').leadAction, '/api/lead');
});

test('links і messengers за контрактом', () => {
  const vm = buildViewModel(fixture(), 'uk');
  assert.deepEqual(vm.links, {
    phone: { display: '+380 67 123 45 67', href: 'tel:+380671234567' },
    telegram: { display: '@anna_frolova_travel', href: 'https://t.me/anna_frolova_travel' },
    viber: { display: '+380671234567', href: 'viber://chat?number=%2B380671234567' },
    instagram: { display: '@anna.frolova.travel', href: 'https://instagram.com/anna.frolova.travel' },
    email: { display: 'anna@example.com', href: 'mailto:anna@example.com' },
  });
  assert.deepEqual(vm.messengers.map((m) => m.key), ['telegram', 'viber', 'instagram', 'phone']);
  assert.deepEqual(vm.messengers[0], { key: 'telegram', label: 'Написати в Telegram', href: 'https://t.me/anna_frolova_travel', display: '@anna_frolova_travel' });
  assert.equal(vm.messengers[3].label, 'Зателефонувати');

  const empty = buildViewModel(fixture({ contacts: { telegram: 'anna_frolova_travel' } }), 'en');
  assert.equal(empty.links.phone, null);
  assert.equal(empty.links.viber, null);
  assert.equal(empty.links.email, null);
  assert.deepEqual(empty.messengers.map((m) => m.key), ['telegram']);
  assert.equal(empty.messengers[0].label, 'Message on Telegram');

  assert.equal(viberNumber('067 123 45 67'), '380671234567', 'український номер без коду країни');
  assert.equal(viberNumber('+48 600 000 000'), '48600000000');
});

test('sections, section(), nav', () => {
  const vm = buildViewModel(fixture(), 'uk');
  assert.deepEqual(vm.sections.map((s) => s.type), ['hero', 'faq', 'about', 'contact', 'destinations', 'process', 'gallery', 'reviews', 'certificates']
    .filter((type) => vm.content.sections[type].enabled));
  assert.equal(vm.sections[0].type, 'hero');
  assert.equal(vm.sections[0].data, vm.content.sections.hero);
  assert.equal(vm.section('services'), null, 'вимкнена секція');
  assert.equal(vm.section('about'), vm.content.sections.about);
  assert.equal(vm.section('nope'), null);
  assert.deepEqual(vm.nav, [
    { id: 'about', label: 'Про мене' },
    { id: 'contact', label: 'Контакти' },
  ], 'без hero, без showInNav=false, без порожніх назв');
  assert.deepEqual(buildViewModel(fixture(), 'en').nav.map((n) => n.label), ['About', 'Contact']);
});

test('brand, agency, тема', () => {
  const vm = buildViewModel(fixture(), 'en');
  assert.deepEqual(vm.brand, { name: 'ANNA FROLOVA', tagline: 'TRAVEL', logo: '' });
  assert.equal(vm.agency, 'World Agency');
  assert.equal(buildViewModel(fixture({ settings: { showAgency: false, agencyName: { uk: 'X' } } }), 'uk').agency, '');
  assert.equal(buildViewModel(fixture({ settings: { logo: '/uploads/logo.webp' } }), 'uk', { basePath: '/b' }).brand.logo, '/b/uploads/logo.webp');

  assert.equal(vm.themePreset, 'sand');
  assert.equal(vm.themeStyle, '');
  const custom = buildViewModel(fixture({ theme: { preset: 'custom', accent: '#AA5500', background: '#fafafa' } }), 'uk');
  assert.equal(custom.themePreset, 'custom');
  assert.equal(custom.themeStyle, '--accent:#aa5500;--bg:#fafafa;');
  assert.equal(buildViewModel(fixture({ theme: { preset: 'sea', accent: '#000000' } }), 'uk').themeStyle, '');
});

test('meta: без адреси сайту — відносні посилання', () => {
  const vm = buildViewModel(fixture(), 'uk');
  assert.equal(vm.meta.title, 'Анна Фролова — подорожі');
  assert.equal(vm.meta.description, 'Опис');
  assert.equal(vm.meta.ogImage, '/uploads/og-image.jpg');
  assert.equal(vm.meta.canonical, '');
  assert.deepEqual(vm.meta.alternates, [
    { hreflang: 'uk', href: '/' },
    { hreflang: 'en', href: '/en/' },
    { hreflang: 'x-default', href: '/' },
  ]);
  assert.equal(buildViewModel(fixture(), 'en').meta.description, 'Опис');
  const untitled = buildViewModel(fixture({ seo: {} }), 'uk');
  assert.equal(untitled.meta.title, 'ANNA FROLOVA TRAVEL', 'порожній SEO-заголовок → назва бренду');
  assert.equal(untitled.meta.ogImage, '/uploads/hero.webp', 'без ogImage — фото з головного екрана');
});

test('meta: з адресою сайту — абсолютні посилання', () => {
  const vm = buildViewModel(fixture({ seo: { siteUrl: 'https://annafrolova.travel/', ogImage: '/uploads/og-image.jpg' } }), 'en');
  assert.equal(vm.meta.canonical, 'https://annafrolova.travel/en/');
  assert.equal(vm.meta.ogImage, 'https://annafrolova.travel/uploads/og-image.jpg');
  assert.deepEqual(vm.meta.alternates, [
    { hreflang: 'uk', href: 'https://annafrolova.travel/' },
    { hreflang: 'en', href: 'https://annafrolova.travel/en/' },
    { hreflang: 'x-default', href: 'https://annafrolova.travel/' },
  ]);
});

test('форма, статус заявки, рік', () => {
  const vm = buildViewModel(fixture(), 'uk', { leadStatus: 'ok' });
  assert.equal(vm.formEnabled, true);
  assert.equal(vm.isStatic, false);
  assert.equal(vm.leadStatus, 'ok');
  assert.equal(vm.year, new Date().getFullYear());
  assert.equal(buildViewModel(fixture(), 'uk', { leadStatus: '<script>' }).leadStatus, null);
  assert.equal(buildViewModel(fixture(), 'uk', { leadStatus: 'error' }).leadStatus, 'error');

  const stat = buildViewModel(fixture(), 'uk', { isStatic: true });
  assert.equal(stat.isStatic, true);
  assert.equal(stat.formEnabled, false, 'у статичній версії форми немає');
  assert.equal(buildViewModel(fixture({ sections: { contact: { enabled: true, formEnabled: false } } }), 'uk').formEnabled, false);
  assert.equal(buildViewModel(fixture({ sections: { contact: { enabled: false, formEnabled: true } } }), 'uk').formEnabled, false);
});

test('icon() повертає SVG-рядок (навіть для невідомої назви)', () => {
  const vm = buildViewModel(fixture(), 'uk');
  assert.match(vm.icon('plane'), /^<svg[\s>]/);
  assert.match(vm.icon('plane', 'icon icon--lg'), /class="icon icon--lg"/);
  assert.match(vm.icon('definitely-unknown'), /^<svg[\s>]/);
});

test('порожній контент не ламає view-model', () => {
  const vm = buildViewModel(undefined, 'uk');
  assert.deepEqual(vm.sections, []);
  assert.deepEqual(vm.nav, []);
  assert.deepEqual(vm.messengers, []);
  assert.equal(vm.meta.title, '');
  assert.equal(vm.formEnabled, false);
  const defaults = buildViewModel(sanitizeContent({}).content, 'en');
  assert.equal(defaults.sections[0].type, 'hero');
});

'use strict';

/**
 * Схема контенту сайту — єдине джерело правди.
 *
 * - Сервер використовує її для валідації та очищення того, що надсилає адмінка.
 * - Адмінка отримує її через GET /admin/api/schema і будує форми автоматично.
 * - Шаблони сайту читають content.json, структура якого описана тут.
 *
 * Типи полів:
 *   text      — локалізований рядок        { uk: string, en: string }
 *   textarea  — локалізований багаторядковий текст { uk, en }; абзаци розділяються порожнім рядком
 *   string    — звичайний рядок (не перекладається)
 *   number    — число (min / max)
 *   boolean   — так / ні
 *   image     — шлях до зображення: '' | '/uploads/...' | '/assets/...' | 'https://...'
 *   color     — '#rrggbb'
 *   select    — одне значення з options[].value
 *   icon      — назва іконки з ICON_NAMES
 *   list      — масив об'єктів; поля елемента описані в `item`; кожен елемент має службовий `id`
 *
 * Додаткові властивості поля: label, help, default, max (довжина / кількість), min,
 * required, pattern (для string), normalize: 'handle' (прибирає @ і посилання t.me/instagram.com),
 * options (для select), item та itemLabel (для list).
 */

const LANGUAGES = [
  { code: 'uk', label: 'Українська', short: 'UA' },
  { code: 'en', label: 'English', short: 'EN' },
];

const ICON_NAMES = [
  'plane', 'palm', 'sun', 'family', 'heart', 'rings', 'mountain', 'snowflake',
  'passport', 'shield', 'hotel', 'ship', 'compass', 'camera', 'star', 'clock',
  'map', 'car', 'spa', 'gift', 'globe', 'suitcase',
];

const ICON_LABELS = {
  plane: 'Літак', palm: 'Пальма', sun: 'Сонце', family: 'Сім’я', heart: 'Серце',
  rings: 'Обручки', mountain: 'Гори', snowflake: 'Сніжинка', passport: 'Паспорт / візи',
  shield: 'Щит / страхування', hotel: 'Готель', ship: 'Круїз', compass: 'Компас',
  camera: 'Фотоапарат', star: 'Зірка', clock: 'Годинник', map: 'Мапа', car: 'Авто',
  spa: 'SPA', gift: 'Подарунок', globe: 'Глобус', suitcase: 'Валіза',
};

// Регулярні вирази для полів типу string (перевіряються, лише якщо значення непорожнє)
const PATTERNS = {
  phone: '^\\+?[0-9 ()\\-]{7,20}$',
  telegram: '^[A-Za-z0-9_]{4,32}$',
  instagram: '^[A-Za-z0-9._]{1,30}$',
  email: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
  url: '^https?://[^\\s]+$',
  year: '^[0-9]{4}$',
};

// Спільні поля для кожної секції
const SECTION_COMMON = [
  { key: 'enabled', type: 'boolean', label: 'Показувати секцію на сайті', default: true },
  { key: 'showInNav', type: 'boolean', label: 'Показувати в меню', default: true },
  { key: 'navLabel', type: 'text', label: 'Назва в меню', max: 40 },
];

const HEADING = [
  { key: 'eyebrow', type: 'text', label: 'Надзаголовок', help: 'Маленький напис над заголовком', max: 80 },
  { key: 'title', type: 'text', label: 'Заголовок', help: 'Слово між *зірочками* буде показано елегантним курсивом, наприклад: Подорож *під ключ*', max: 140 },
];

const SUBTITLE = { key: 'subtitle', type: 'textarea', label: 'Підзаголовок', max: 600 };

const SECTIONS = [
  {
    type: 'hero',
    title: 'Головний екран',
    description: 'Перше, що бачить відвідувач: велике фото, заголовок і кнопки.',
    pinned: true, // завжди перша, не перетягується
    fields: [
      ...HEADING,
      { key: 'subtitle', type: 'textarea', label: 'Текст під заголовком', max: 400 },
      { key: 'primaryCta', type: 'text', label: 'Головна кнопка', help: 'Веде до форми заявки', max: 40 },
      { key: 'secondaryCta', type: 'text', label: 'Друга кнопка', help: 'Веде до напрямків', max: 40 },
      { key: 'image', type: 'image', label: 'Фонове фото', help: 'Горизонтальне фото, бажано від 2000 px завширшки', required: true },
      { key: 'overlay', type: 'number', label: 'Затемнення фото, %', help: 'Текст завжди лишається читабельним; більше значення — темніше фото', min: 0, max: 80, default: 30 },
    ],
  },
  {
    type: 'about',
    title: 'Про мене',
    description: 'Ваша історія, фото та цифри досвіду.',
    fields: [
      ...HEADING,
      { key: 'text', type: 'textarea', label: 'Текст про себе', help: 'Абзаци розділяйте порожнім рядком', max: 3000 },
      { key: 'photo', type: 'image', label: 'Ваше фото' },
      { key: 'photoAlt', type: 'text', label: 'Опис фото (для незрячих)', help: 'Що на фото — читають програми екранного доступу. Наприклад: Анна Фролова, тревел-експертка', max: 120 },
      { key: 'signature', type: 'string', label: 'Підпис', help: 'Наприклад: Anna Frolova', max: 60 },
      {
        key: 'stats', type: 'list', label: 'Цифри', itemLabel: 'value', max: 4,
        item: [
          { key: 'value', type: 'string', label: 'Значення', help: 'Наприклад: 8+', max: 12 },
          { key: 'label', type: 'text', label: 'Підпис', help: 'Наприклад: років досвіду', max: 60 },
        ],
      },
    ],
  },
  {
    type: 'services',
    title: 'Послуги',
    description: 'Що ви робите для клієнтів.',
    fields: [
      ...HEADING,
      SUBTITLE,
      {
        key: 'items', type: 'list', label: 'Послуги', itemLabel: 'title', max: 12,
        item: [
          { key: 'icon', type: 'icon', label: 'Іконка', default: 'plane' },
          { key: 'title', type: 'text', label: 'Назва', max: 80 },
          { key: 'text', type: 'textarea', label: 'Опис', max: 400 },
        ],
      },
    ],
  },
  {
    type: 'destinations',
    title: 'Напрямки',
    description: 'Країни та типи відпочинку, які ви пропонуєте.',
    fields: [
      ...HEADING,
      SUBTITLE,
      {
        key: 'items', type: 'list', label: 'Напрямки', itemLabel: 'name', max: 12,
        item: [
          { key: 'image', type: 'image', label: 'Фото' },
          { key: 'name', type: 'text', label: 'Назва', max: 60 },
          { key: 'tag', type: 'text', label: 'Тип відпочинку', help: 'Коротко, до ~16 символів (напр.: Гірські лижі) — довший обріжеться трикрапкою', max: 40 },
          { key: 'text', type: 'textarea', label: 'Опис', max: 400 },
          { key: 'price', type: 'text', label: 'Ціна', help: 'Необов’язково. Наприклад: від $850', max: 40 },
        ],
      },
    ],
  },
  {
    type: 'process',
    title: 'Як я працюю',
    description: 'Кроки від заявки до подорожі.',
    fields: [
      ...HEADING,
      SUBTITLE,
      {
        key: 'items', type: 'list', label: 'Кроки', itemLabel: 'title', max: 6,
        item: [
          { key: 'title', type: 'text', label: 'Назва кроку', max: 80 },
          { key: 'text', type: 'textarea', label: 'Опис', max: 400 },
        ],
      },
    ],
  },
  {
    type: 'gallery',
    title: 'Галерея',
    description: 'Фото з ваших подорожей.',
    fields: [
      ...HEADING,
      SUBTITLE,
      {
        key: 'items', type: 'list', label: 'Фото', itemLabel: 'caption', max: 24, help: 'Фото 1, 5 і 7 показуються великими',
        item: [
          { key: 'image', type: 'image', label: 'Фото', required: true },
          { key: 'caption', type: 'text', label: 'Підпис', max: 80 },
        ],
      },
    ],
  },
  {
    type: 'reviews',
    title: 'Відгуки',
    description: 'Що кажуть клієнти.',
    fields: [
      ...HEADING,
      SUBTITLE,
      {
        key: 'items', type: 'list', label: 'Відгуки', itemLabel: 'name', max: 20,
        item: [
          { key: 'name', type: 'text', label: 'Ім’я клієнта', help: 'Для англійської версії — латиницею, наприклад: Olena & Andriy', max: 60 },
          { key: 'trip', type: 'text', label: 'Подорож', help: 'Наприклад: Мальдіви, 2025', max: 60 },
          { key: 'text', type: 'textarea', label: 'Текст відгуку', max: 1200 },
          { key: 'photo', type: 'image', label: 'Фото клієнта', help: 'Необов’язково' },
          { key: 'rating', type: 'number', label: 'Оцінка (1–5)', min: 1, max: 5, default: 5 },
        ],
      },
    ],
  },
  {
    type: 'certificates',
    title: 'Сертифікати',
    description: 'Навчання, сертифікати туроператорів, нагороди.',
    fields: [
      ...HEADING,
      SUBTITLE,
      {
        key: 'items', type: 'list', label: 'Сертифікати', itemLabel: 'title', max: 12,
        item: [
          { key: 'image', type: 'image', label: 'Скан або фото' },
          { key: 'title', type: 'text', label: 'Назва', max: 120 },
          { key: 'issuer', type: 'text', label: 'Хто видав', max: 80 },
          { key: 'year', type: 'string', label: 'Рік', pattern: PATTERNS.year, max: 4 },
        ],
      },
    ],
  },
  {
    type: 'faq',
    title: 'Питання та відповіді',
    description: 'Відповіді на часті запитання клієнтів.',
    fields: [
      ...HEADING,
      {
        key: 'items', type: 'list', label: 'Питання', itemLabel: 'question', max: 12,
        item: [
          { key: 'question', type: 'text', label: 'Питання', max: 160 },
          { key: 'answer', type: 'textarea', label: 'Відповідь', max: 1200 },
        ],
      },
    ],
  },
  {
    type: 'contact',
    title: 'Контакти та заявка',
    description: 'Блок зі способами зв’язку та формою заявки.',
    fields: [
      ...HEADING,
      { key: 'text', type: 'textarea', label: 'Текст', max: 600 },
      { key: 'note', type: 'text', label: 'Примітка', help: 'Наприклад: Відповідаю протягом години', max: 120 },
      { key: 'formEnabled', type: 'boolean', label: 'Показувати форму заявки', default: true },
      { key: 'formTitle', type: 'text', label: 'Заголовок форми', max: 80 },
      { key: 'image', type: 'image', label: 'Фото біля контактів', help: 'Необов’язково. Показується під формою заявки (на телефоні не показується) або поруч із контактами, якщо форму вимкнено' },
    ],
  },
];

const GROUPS = [
  {
    key: 'settings',
    title: 'Загальне',
    description: 'Назва, логотип та підвал сайту.',
    fields: [
      { key: 'brandName', type: 'string', label: 'Назва бренду', default: 'ANNA FROLOVA', max: 40 },
      { key: 'brandTagline', type: 'string', label: 'Підпис під назвою', default: 'TRAVEL', max: 30 },
      { key: 'logo', type: 'image', label: 'Логотип (файл)', help: 'Необов’язково. PNG або WebP з прозорим фоном. Якщо порожньо — використовується вбудована монограма AF' },
      { key: 'footerText', type: 'text', label: 'Текст у підвалі', max: 200 },
      { key: 'showAgency', type: 'boolean', label: 'Показувати назву агенції', default: false },
      { key: 'agencyName', type: 'text', label: 'Назва агенції', help: 'Наприклад: Працюю у складі агенції «…»', max: 120 },
    ],
  },
  {
    key: 'contacts',
    title: 'Контакти',
    description: 'Телефон і месенджери. Використовуються в шапці, блоці контактів і плаваючій кнопці.',
    fields: [
      { key: 'phone', type: 'string', label: 'Телефон', help: 'У форматі +380 XX XXX XX XX', pattern: PATTERNS.phone, max: 20 },
      { key: 'telegram', type: 'string', label: 'Telegram (ім’я користувача)', help: 'Без @, наприклад: anna_frolova_travel', pattern: PATTERNS.telegram, normalize: 'handle', max: 32 },
      { key: 'viber', type: 'string', label: 'Viber (номер)', help: 'У форматі +380…', pattern: PATTERNS.phone, max: 20 },
      { key: 'instagram', type: 'string', label: 'Instagram (ім’я користувача)', help: 'Без @', pattern: PATTERNS.instagram, normalize: 'handle', max: 30 },
      { key: 'email', type: 'string', label: 'Email', help: 'Необов’язково', pattern: PATTERNS.email, max: 80 },
      { key: 'city', type: 'text', label: 'Місто', max: 60 },
      { key: 'hours', type: 'text', label: 'Графік роботи', help: 'Наприклад: Пн–Сб, 10:00–20:00', max: 80 },
      { key: 'showFloatingButton', type: 'boolean', label: 'Плаваюча кнопка зв’язку', help: 'Кругла кнопка в куті екрана з месенджерами', default: true },
    ],
  },
  {
    key: 'theme',
    title: 'Дизайн',
    description: 'Кольорова гама сайту.',
    fields: [
      {
        key: 'preset', type: 'select', label: 'Кольорова тема', default: 'sand',
        options: [
          { value: 'sand', label: 'Пісок (фірмова)' },
          { value: 'sea', label: 'Море' },
          { value: 'olive', label: 'Олива' },
          { value: 'terracotta', label: 'Теракота' },
          { value: 'custom', label: 'Власні кольори' },
        ],
      },
      { key: 'accent', type: 'color', label: 'Акцентний колір', help: 'Діє, якщо обрано «Власні кольори»', default: '#8a6a4a' },
      { key: 'background', type: 'color', label: 'Колір фону', help: 'Діє, якщо обрано «Власні кольори»', default: '#f8f4ef' },
    ],
  },
  {
    key: 'seo',
    title: 'SEO та соцмережі',
    description: 'Як сайт виглядає в Google і коли ним діляться в месенджерах.',
    fields: [
      { key: 'title', type: 'text', label: 'Заголовок сторінки', help: 'Бажано до 60 символів — довший Google обріже', max: 80, recommended: 60 },
      { key: 'description', type: 'textarea', label: 'Опис', help: 'Бажано до 160 символів — довший Google обріже', max: 300, recommended: 160 },
      { key: 'ogImage', type: 'image', label: 'Картинка для поширення', help: '1200×630 px' },
      { key: 'siteUrl', type: 'string', label: 'Адреса сайту', help: 'Заповніть після публікації, наприклад https://annafrolova.travel', pattern: PATTERNS.url, max: 120 },
    ],
  },
  {
    key: 'ui',
    title: 'Тексти інтерфейсу',
    description: 'Підписи кнопок, полів форми та службові повідомлення.',
    fields: [
      { key: 'navCta', type: 'text', label: 'Кнопка в шапці', max: 40 },
      { key: 'formName', type: 'text', label: 'Поле «Ім’я»', max: 60 },
      { key: 'formContact', type: 'text', label: 'Поле «Телефон або Telegram»', max: 60 },
      { key: 'formDestination', type: 'text', label: 'Поле «Куди хочете поїхати»', max: 60 },
      { key: 'formDates', type: 'text', label: 'Поле «Дати»', max: 60 },
      { key: 'formTravelers', type: 'text', label: 'Поле «Кількість людей»', max: 60 },
      { key: 'formMessage', type: 'text', label: 'Поле «Побажання»', max: 60 },
      { key: 'formSubmit', type: 'text', label: 'Кнопка «Надіслати»', max: 40 },
      { key: 'formSending', type: 'text', label: 'Під час надсилання', max: 60 },
      { key: 'formSuccess', type: 'text', label: 'Після успішного надсилання', max: 200 },
      { key: 'formError', type: 'text', label: 'Помилка надсилання', max: 200 },
      { key: 'formConsent', type: 'text', label: 'Згода на обробку даних', max: 200 },
      { key: 'writeTelegram', type: 'text', label: 'Кнопка Telegram', max: 40 },
      { key: 'writeViber', type: 'text', label: 'Кнопка Viber', max: 40 },
      { key: 'writeInstagram', type: 'text', label: 'Кнопка Instagram', max: 40 },
      { key: 'call', type: 'text', label: 'Кнопка «Зателефонувати»', max: 40 },
      { key: 'contactMe', type: 'text', label: 'Плаваюча кнопка та посилання в розділі «Питання»', max: 40 },
      { key: 'menu', type: 'text', label: 'Меню (для мобільних)', max: 30 },
      { key: 'close', type: 'text', label: 'Закрити', max: 30 },
      { key: 'prev', type: 'text', label: 'Кнопка «Попередній відгук»', help: 'Підказка для програм екранного доступу в каруселі відгуків', max: 30 },
      { key: 'next', type: 'text', label: 'Кнопка «Наступний відгук»', help: 'Підказка для програм екранного доступу в каруселі відгуків', max: 30 },
      { key: 'backToTop', type: 'text', label: 'Нагору', max: 30 },
      { key: 'rights', type: 'text', label: 'Права захищено', max: 60 },
    ],
  },
];

const schema = {
  version: 1,
  languages: LANGUAGES,
  icons: ICON_NAMES.map((name) => ({ value: name, label: ICON_LABELS[name] })),
  groups: GROUPS,
  sectionCommon: SECTION_COMMON,
  sections: SECTIONS,
};

module.exports = {
  schema,
  LANGUAGES,
  LANG_CODES: LANGUAGES.map((l) => l.code),
  ICON_NAMES,
  PATTERNS,
  SECTION_TYPES: SECTIONS.map((s) => s.type),
};

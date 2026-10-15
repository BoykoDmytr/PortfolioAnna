/**
 * Звернення до API адмінки (/admin/api/*).
 *
 * - Кожен запит, що змінює дані, несе заголовок X-Admin-Request: 1 (захист від CSRF).
 * - Якщо сервер відповів 401 (сесія завершилась), викликається обробник повторного входу:
 *   адмінка показує екран входу, а після успішного входу запит повторюється автоматично.
 *   Незбережені зміни при цьому лишаються в пам'яті.
 */

/** Префікс шляхів, якщо сайт змонтовано не в корені (/admin/ → ''). */
const BASE = window.location.pathname.replace(/\/admin(\/.*)?$/, '');

export const urls = {
  base: BASE,
  api: `${BASE}/admin/api/`,
  site: `${BASE}/`,
  siteEn: `${BASE}/en/`,
};

/** Шлях до зображення з контенту → URL для <img> в адмінці. */
export function assetUrl(path) {
  if (!path) return '';
  if (/^https:\/\//i.test(path)) return path;
  if (path.startsWith('/')) return BASE + path;
  return path;
}

const MESSAGES = {
  network: 'Немає зв’язку із сайтом. Перевірте інтернет і спробуйте ще раз.',
  400: 'Сервер не прийняв дані. Перевірте введене і спробуйте ще раз.',
  403: 'Запит відхилено з міркувань безпеки. Оновіть сторінку і спробуйте ще раз.',
  404: 'Не знайдено — можливо, це вже видалено.',
  413: 'Завеликий обсяг даних або файлу.',
  415: 'Непідтримуваний формат файлу.',
  429: 'Забагато спроб поспіль. Зачекайте кілька хвилин і спробуйте знову.',
  500: 'Сталася помилка на сервері. Спробуйте ще раз трохи згодом.',
};

export class ApiError extends Error {
  constructor(message, status = 0, details = undefined, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = Array.isArray(details) ? details : [];
    this.data = data && typeof data === 'object' ? data : {}; // уся відповідь сервера (наприклад, attemptsLeft)
  }
}

function fallbackMessage(status) {
  if (MESSAGES[status]) return MESSAGES[status];
  return status >= 500 ? MESSAGES[500] : MESSAGES[400];
}

function errorFrom(status, data) {
  const message = data && typeof data.error === 'string' && data.error ? data.error : fallbackMessage(status);
  return new ApiError(message, status, data && data.details, data);
}

let reauthHandler = null;

/** main.js реєструє функцію, що показує екран входу і повертає Promise, який виконується після входу. */
export function setReauthHandler(fn) {
  reauthHandler = fn;
}

function filenameFrom(disposition, fallback) {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition || '');
  return match ? decodeURIComponent(match[1]) : fallback;
}

/**
 * @param {string} method
 * @param {string} path      шлях відносно /admin/api/, наприклад 'content'
 * @param {object} [opts]
 * @param {*}      [opts.body]  буде надіслано як JSON
 * @param {boolean}[opts.auth=true]  false — не показувати екран входу на 401 (для фонових запитів)
 * @param {boolean}[opts.blob]  повернути { blob, filename } замість JSON
 * @param {object} [opts.headers]  додаткові заголовки запиту
 * @param {function}[opts.onHeaders]  отримує заголовки відповіді (наприклад, X-Content-Revision)
 */
export async function request(method, path, opts = {}) {
  const { body, auth = true, blob = false, onHeaders } = opts;
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  if (method !== 'GET') headers['X-Admin-Request'] = '1';
  const init = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(urls.api + path, init);
  } catch {
    throw new ApiError(MESSAGES.network, 0);
  }

  if (res.status === 401 && auth && reauthHandler) {
    await reauthHandler();
    return request(method, path, opts);
  }
  if (onHeaders) onHeaders(res.headers);

  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      // не JSON
    }
    throw errorFrom(res.status, data);
  }

  if (blob) {
    return { blob: await res.blob(), filename: filenameFrom(res.headers.get('Content-Disposition'), 'download.json') };
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('Сервер повернув незрозумілу відповідь. Оновіть сторінку.', res.status);
  }
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  put: (path, body, opts) => request('PUT', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  del: (path, opts) => request('DELETE', path, opts),
};

export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;

/** Перевірка файлу перед завантаженням → текст помилки або ''. */
export function checkUploadFile(file) {
  const name = file.name || 'файл';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'heic' || ext === 'heif' || /heic|heif/i.test(file.type)) {
    return `«${name}»: формат HEIC (фото з iPhone) цей браузер не відкриває. Збережіть фото як JPG або надішліть його собі в месенджер і завантажте вже звідти.`;
  }
  if (ext === 'svg' || file.type === 'image/svg+xml') {
    return `«${name}»: SVG-файли не підтримуються. Завантажте PNG, JPG або WebP.`;
  }
  const okType = UPLOAD_TYPES.includes(file.type) || ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'].includes(ext);
  if (!okType) return `«${name}» — це не фото. Підходять файли JPG, PNG, WebP, AVIF або GIF.`;
  if (file.size > UPLOAD_MAX_BYTES) return `«${name}» завеликий (понад 15 МБ), і зменшити його автоматично не вдалося. Оберіть інше фото або надішліть це фото собі в месенджер і завантажте вже звідти — так воно стане меншим.`;
  return '';
}

/**
 * Завантаження фото з прогресом (XMLHttpRequest, бо fetch не повідомляє про прогрес відправлення).
 * → { url, name, width, height, size }
 */
export function uploadImage(file, { purpose = 'photo', onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const send = () => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${urls.api}upload?purpose=${encodeURIComponent(purpose)}`);
      xhr.setRequestHeader('X-Admin-Request', '1');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener('error', () => reject(new ApiError(MESSAGES.network, 0)));
      xhr.addEventListener('load', () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          // не JSON
        }
        if (xhr.status === 401 && reauthHandler) {
          reauthHandler().then(send, reject);
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.url) resolve(data);
        else reject(errorFrom(xhr.status, data));
      });
      const form = new FormData();
      form.append('file', file, file.name || 'image');
      xhr.send(form);
    };
    send();
  });
}

/** Запускає завантаження файлу (Blob) у браузері. */
export function saveBlob(blob, filename) {
  const link = document.createElement('a');
  const href = URL.createObjectURL(blob);
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

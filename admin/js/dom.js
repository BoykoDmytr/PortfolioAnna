/**
 * Невеликі помічники для роботи з DOM.
 * Увесь вміст вставляється лише через textContent / DOM API — жодного innerHTML.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function setProps(el, props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) el.dataset[k] = v;
    } else if (key === 'style' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k.startsWith('--')) el.style.setProperty(k, v);
        else el.style[k] = v;
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (el.namespaceURI === SVG_NS || key.includes('-') || !(key in el)) {
      el.setAttribute(key, value === true ? '' : String(value));
    } else {
      el[key] = value;
    }
  }
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
}

/** h('button', { class: 'btn', onClick }, 'Текст', childNode, [...]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  setProps(el, props);
  appendChildren(el, children);
  return el;
}

/** SVG-елемент: s('path', { d: '…' }) */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  setProps(el, attrs);
  appendChildren(el, children);
  return el;
}

/** Розбирає SVG-розмітку з сервера (іконки) без innerHTML і прибирає все потенційно небезпечне. */
export function parseSvg(markup) {
  if (typeof markup !== 'string' || !markup.trim().startsWith('<svg')) return null;
  let src = markup.trim();
  if (!/^<svg[^>]*\sxmlns=/.test(src)) src = src.replace(/^<svg/, `<svg xmlns="${SVG_NS}"`);
  const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || root.namespaceURI !== SVG_NS || doc.getElementsByTagName('parsererror').length) return null;
  for (const bad of root.querySelectorAll('script, foreignObject, iframe, image, use')) bad.remove();
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value) || /href$/i.test(attr.name)) node.removeAttribute(attr.name);
    }
  }
  return document.importNode(root, true);
}

let idCounter = 0;
/** Унікальний id для зв'язки label ↔ input. */
export function nextId(prefix = 'f') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Короткий випадковий id для нових елементів списку (як на сервері: 8 hex). */
export function uid() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

const dateTimeFmt = new Intl.DateTimeFormat('uk-UA', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' });

/** «сьогодні о 14:05», «вчора о 09:12», «3 жовтня 2026 р. о 18:40» */
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return `сьогодні о ${timeFmt.format(d)}`;
  if (diffDays === 1) return `вчора о ${timeFmt.format(d)}`;
  return dateTimeFmt.format(d);
}

/** Правильна форма слова після числа: plural(5, ['заявка', 'заявки', 'заявок']) */
export function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/** Чекає наступного кадру (після вставки в DOM). */
export const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Елементи, на які можна перевести фокус. */
export function focusables(root) {
  return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.closest('[hidden]') && el.getClientRects().length > 0);
}

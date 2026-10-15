/**
 * Службові іконки адмінки (тонкі лінійні, 24×24).
 * Кожна іконка — масив фігур: рядок = <path d>, об'єкт = інший SVG-елемент.
 */

import { s } from './dom.js';

const ICONS = {
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  up: ['M12 19V5', 'M6 11l6-6 6 6'],
  down: ['M12 5v14', 'M18 13l-6 6-6-6'],
  copy: [{ tag: 'rect', x: 8, y: 8, width: 12, height: 12, rx: 2 }, 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4.5h6V7'],
  plus: ['M12 5v14', 'M5 12h14'],
  more: [{ tag: 'circle', cx: 5, cy: 12, r: 1.3 }, { tag: 'circle', cx: 12, cy: 12, r: 1.3 }, { tag: 'circle', cx: 19, cy: 12, r: 1.3 }],
  toTop: ['M5 4h14', 'M12 20V9', 'M7 13l5-5 5 5'],
  toBottom: ['M5 20h14', 'M12 4v11', 'M7 11l5 5 5-5'],
  chevron: ['M6 9l6 6 6-6'],
  chevronRight: ['M9 6l6 6-6 6'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', { tag: 'circle', cx: 12, cy: 12, r: 3 }],
  eyeOff: [
    'M3 3l18 18',
    'M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2',
    'M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
  ],
  upload: ['M12 15V4', 'M7.5 8.5 12 4l4.5 4.5', 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'],
  download: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3'],
  image: [{ tag: 'rect', x: 3, y: 4, width: 18, height: 16, rx: 2 }, { tag: 'circle', cx: 9, cy: 10, r: 1.8 }, 'M21 15.5l-5-5L6 20'],
  images: [
    { tag: 'rect', x: 7, y: 3, width: 14, height: 14, rx: 2 },
    'M3 8v11a2 2 0 0 0 2 2h11',
    { tag: 'circle', cx: 12, cy: 8, r: 1.5 },
    'M21 13l-3.5-3.5L10 17',
  ],
  check: ['M5 12.5l4.5 4.5L19 7'],
  logout: ['M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3', 'M16 17l5-5-5-5', 'M21 12H9'],
  layers: ['M12 2.5 3 7.5l9 5 9-5z', 'M3 12l9 5 9-5', 'M3 16.5l9 5 9-5'],
  home: ['M3.5 11 12 4l8.5 7', 'M6 9.5V20h12V9.5', 'M10 20v-5h4v5'],
  phone: ['M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2'],
  palette: [
    'M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z',
    { tag: 'circle', cx: 7.5, cy: 11, r: 1 }, { tag: 'circle', cx: 9.5, cy: 7, r: 1 },
    { tag: 'circle', cx: 14.5, cy: 7, r: 1 }, { tag: 'circle', cx: 17, cy: 11, r: 1 },
  ],
  search: [{ tag: 'circle', cx: 11, cy: 11, r: 7 }, 'M20 20l-4-4'],
  type: ['M5 7V5h14v2', 'M12 5v14', 'M9 19h6'],
  inbox: ['M3 13l3-8h12l3 8', 'M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5', 'M3 13h5l1.5 2.5h5L16 13h5'],
  lock: [{ tag: 'rect', x: 5, y: 11, width: 14, height: 10, rx: 2 }, 'M8 11V8a4 4 0 0 1 8 0v3'],
  history: ['M3.5 12a8.5 8.5 0 1 0 2.6-6.1', 'M3.5 4.5v4h4', 'M12 8v4.2l2.8 1.8'],
  alert: ['M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z', 'M12 10v4', 'M12 17.2v.01'],
  info: [{ tag: 'circle', cx: 12, cy: 12, r: 9 }, 'M12 11v5', 'M12 7.8v.01'],
  grip: { stroke: 2.4, shapes: ['M9 6h.01', 'M9 12h.01', 'M9 18h.01', 'M15 6h.01', 'M15 12h.01', 'M15 18h.01'] },
  refresh: ['M20 11.5A8 8 0 1 1 17.7 6', 'M20 4v5h-5'],
  send: ['M21 3 10.5 13.5', 'M21 3l-6.5 18-4-7.5L3 9.5z'],
  star: ['M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z'],
  key: [{ tag: 'circle', cx: 8, cy: 15, r: 4 }, 'M11 12l9-9', 'M17 6l3 3', 'M14.5 8.5l2 2'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  arrowLeft: ['M19 12H5', 'M11 6l-6 6 6 6'],
  edit: ['M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z', 'M13.5 6.5l4 4'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  bell: ['M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z', 'M10 20a2.2 2.2 0 0 0 4 0'],
  mail: [{ tag: 'rect', x: 3, y: 5, width: 18, height: 14, rx: 2 }, 'M3.5 6.5 12 13l8.5-6.5'],
  telegram: ['M21 4 3 11l6.5 2.5L18 7.5l-6.5 7.5 6 4.5z'],
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  hidden: [{ tag: 'circle', cx: 12, cy: 12, r: 8.5 }, 'M6 18 18 6'],
};

/** Повертає <svg> з іконкою. */
export function icon(name, cls = 'i') {
  const def = ICONS[name] || ICONS.info;
  const shapes = Array.isArray(def) ? def : def.shapes;
  const stroke = Array.isArray(def) ? 1.6 : def.stroke;
  return s('svg', {
    class: cls,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': stroke,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }, shapes.map((shape) => {
    if (typeof shape === 'string') return s('path', { d: shape });
    const { tag, ...attrs } = shape;
    return s(tag, attrs);
  }));
}

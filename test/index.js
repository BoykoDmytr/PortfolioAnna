'use strict';

/**
 * Точка входу для `node --test test/` (скрипт `npm test`).
 *
 * Node 22+ не шукає тести в папці, переданій аргументом, а запускає її як модуль —
 * тобто цей файл. Тут ми підключаємо всі test/*.test.js в одному процесі.
 *
 * Якщо ж тести запущено інакше (`node --test` без аргументів, Node 20 з папкою,
 * або glob `test/*.test.js`), цей файл виконується як звичайний файл (argv[1] = …/index.js)
 * і нічого не робить — щоб тести не запускалися двічі.
 */

const fs = require('fs');
const path = require('path');

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (entry === __dirname) {
  for (const name of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(path.join(__dirname, name));
  }
}

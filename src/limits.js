'use strict';

/**
 * Обмеження навантаження (у пам'яті одного процесу).
 *
 * createRateLimiter — не більше `max` подій за `windowMs` на ключ (IP).
 * createSemaphore   — не більше `max` важких операцій одночасно (scrypt, обробка фото), решта чекає в черзі.
 *   Важливо: scrypt і sharp працюють у спільному пулі потоків Node (4 потоки), з якого читаються й файли.
 *   Без обмеження потік запитів на вхід займає весь пул, і сайт перестає віддавати стилі й фото.
 */

/**
 * Ковзне вікно.
 *   check(key)   → { limited, retryAfterMs }
 *   consume(key) → { limited, retryAfterMs, remaining, undo() } — перевірка і облік спроби одним кроком
 *                  (до await!), тож паралельні запити не проскочать повз ліміт;
 *   hit(key)     — врахувати подію;   reset(key) — забути всі події ключа.
 */
function createRateLimiter({ windowMs, max }) {
  const events = new Map();

  function recent(key, now) {
    const list = events.get(key);
    if (!list) return [];
    const fresh = list.filter((ts) => now - ts < windowMs);
    if (fresh.length) events.set(key, fresh);
    else events.delete(key);
    return fresh;
  }

  function sweep(now) {
    if (events.size < 1000) return;
    for (const key of [...events.keys()]) recent(key, now);
  }

  const limitedResult = (list, now) => ({
    limited: true,
    retryAfterMs: Math.max(1000, windowMs - (now - list[0])),
    remaining: 0,
    undo() {},
  });

  return {
    check(key, now = Date.now()) {
      const list = recent(String(key), now);
      if (list.length < max) return { limited: false, retryAfterMs: 0, remaining: max - list.length };
      return limitedResult(list, now);
    },
    consume(key, now = Date.now()) {
      sweep(now);
      const k = String(key);
      const list = recent(k, now);
      if (list.length >= max) return limitedResult(list, now);
      list.push(now);
      events.set(k, list);
      let undone = false;
      return {
        limited: false,
        retryAfterMs: 0,
        remaining: max - list.length,
        /** Повернути спробу (наприклад, сервер був зайнятий і пароль не перевірявся). */
        undo() {
          if (undone) return;
          undone = true;
          const current = events.get(k);
          const i = current ? current.indexOf(now) : -1;
          if (i >= 0) current.splice(i, 1);
          if (current && !current.length) events.delete(k);
        },
      };
    },
    hit(key, now = Date.now()) {
      sweep(now);
      const k = String(key);
      const list = recent(k, now);
      list.push(now);
      events.set(k, list);
    },
    reset(key) {
      events.delete(String(key));
    },
  };
}

class BusyError extends Error {
  constructor(message = 'Сервер зараз зайнятий. Спробуйте ще раз за хвилину.') {
    super(message);
    this.name = 'BusyError';
    this.code = 'BUSY';
    this.status = 503;
    this.expose = true;
  }
}

/**
 * run(fn) виконує fn, коли звільниться місце. Якщо черга повна — одразу BusyError (503).
 */
function createSemaphore({ max = 1, maxQueue = Infinity } = {}) {
  let active = 0;
  const queue = [];

  function release() {
    const next = queue.shift();
    if (next) next(); // місце переходить наступному в черзі
    else active -= 1;
  }

  return {
    async run(fn) {
      if (active < max) {
        active += 1;
      } else {
        if (queue.length >= maxQueue) throw new BusyError();
        await new Promise((resolve) => queue.push(resolve));
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
  };
}

module.exports = { createRateLimiter, createSemaphore, BusyError };

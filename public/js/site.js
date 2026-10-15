/* ANNA FROLOVA TRAVEL — public site behaviour (vanilla JS, no dependencies).
 * Progressive enhancement: the page is complete without JS; this file only adds polish. */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var $ = function (sel, ctx) { return (ctx || doc).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || doc).querySelectorAll(sel)); };
  var prefersReduced = function () { return reducedMotion.matches; };

  /* ---------- 0. html.js + reveal without a flash ---------- */
  var revealEls = $$('[data-reveal]');
  var vh = window.innerHeight || root.clientHeight;
  revealEls.forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.top < vh * 0.98 && r.bottom > 0) el.classList.add('is-visible');
  });
  root.classList.remove('no-js');
  root.classList.add('js');

  // Прибираємо «?lead=…» з адреси після відправки без JS — інакше перезавантаження чи поширене
  // посилання знову показуватимуть «Дякую» замість форми.
  if (/[?&]lead=/.test(window.location.search) && window.history.replaceState) {
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }

  /* ---------- 1. Reveal on scroll ---------- */
  (function initReveal() {
    var pending = revealEls.filter(function (el) { return !el.classList.contains('is-visible'); });
    if (!pending.length) return;
    if (prefersReduced() || !('IntersectionObserver' in window)) {
      pending.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0 }); // 0: також слайди каруселі, що лише «визирають» збоку
    pending.forEach(function (el) { io.observe(el); });
    doc.addEventListener('focusin', function (e) {
      var block = e.target.closest && e.target.closest('[data-reveal]');
      if (block && !block.classList.contains('is-visible')) {
        block.classList.add('is-visible');
        io.unobserve(block);
      }
    });
  })();

  /* ---------- 2. Header state + active nav link ---------- */
  var header = $('[data-header]');
  (function initHeader() {
    if (!header) return;
    var ticking = false;
    var update = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 24);
      ticking = false;
    };
    update();
    window.addEventListener('scroll', function () {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    }, { passive: true });

    var links = $$('[data-nav-link]');
    if (!links.length || !('IntersectionObserver' in window)) return;
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var targets = Object.keys(byId).map(function (id) { return doc.getElementById(id); }).filter(Boolean);
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var link = byId[entry.target.id];
        if (!link) return;
        if (entry.isIntersecting) {
          links.forEach(function (l) { l.classList.remove('is-active'); l.removeAttribute('aria-current'); });
          link.classList.add('is-active');
          link.setAttribute('aria-current', 'location');
        } else if (link.classList.contains('is-active')) {
          link.classList.remove('is-active');
          link.removeAttribute('aria-current');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    targets.forEach(function (t) { spy.observe(t); });
  })();

  /* ---------- Scroll lock (menu, lightbox) ---------- */
  var locks = 0;
  function lockScroll() {
    if (locks++ === 0) {
      var sbw = window.innerWidth - root.clientWidth;
      if (sbw > 0) doc.body.style.paddingRight = sbw + 'px';
      doc.body.classList.add('is-locked');
    }
  }
  function unlockScroll() {
    if (locks > 0 && --locks === 0) {
      doc.body.classList.remove('is-locked');
      doc.body.style.paddingRight = '';
    }
  }

  function focusables(container) {
    return $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea, select, [tabindex]:not([tabindex="-1"])', container)
      .filter(function (el) { return el.offsetParent !== null || el === doc.activeElement; });
  }

  /* ---------- 3. Mobile menu ---------- */
  (function initMenu() {
    var toggle = $('[data-menu-toggle]');
    var menu = $('[data-mobile-menu]');
    if (!toggle || !menu || !header) return;
    var isOpen = false;
    var closeTimer = null;
    // Поки меню відкрите, решта сторінки недоступна (як у модальному вікні)
    var behind = [doc.getElementById('main'), $('.site-footer'), $('[data-fab]')].filter(Boolean);
    function setBehindInert(on) {
      behind.forEach(function (el) {
        if (on) el.setAttribute('inert', '');
        else el.removeAttribute('inert');
      });
    }

    function setLabel(open) {
      var label = toggle.getAttribute(open ? 'data-label-close' : 'data-label-open');
      if (label) toggle.setAttribute('aria-label', label);
    }
    function open() {
      if (isOpen) return;
      isOpen = true;
      clearTimeout(closeTimer);
      menu.hidden = false;
      // force reflow so the opacity transition runs
      void menu.offsetWidth;
      menu.classList.add('is-open');
      header.classList.add('is-menu-open');
      toggle.setAttribute('aria-expanded', 'true');
      setLabel(true);
      lockScroll();
      setBehindInert(true);
      doc.addEventListener('keydown', onKey);
    }
    function close(returnFocus) {
      if (!isOpen) return;
      isOpen = false;
      menu.classList.remove('is-open');
      header.classList.remove('is-menu-open');
      toggle.setAttribute('aria-expanded', 'false');
      setLabel(false);
      unlockScroll();
      setBehindInert(false);
      doc.removeEventListener('keydown', onKey);
      closeTimer = setTimeout(function () { menu.hidden = true; }, prefersReduced() ? 0 : 400);
      if (returnFocus) toggle.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key !== 'Tab') return;
      // Trap focus inside the header (toggle) + menu while open
      var items = focusables(header).concat(focusables(menu));
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      var idx = items.indexOf(doc.activeElement);
      if (e.shiftKey && (doc.activeElement === first || idx === -1)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (doc.activeElement === last || idx === -1)) {
        e.preventDefault();
        first.focus();
      }
    }
    toggle.addEventListener('click', function () {
      if (isOpen) close(false); else open();
    });
    menu.addEventListener('click', function (e) {
      var link = e.target.closest('a');
      if (!link) return;
      close(false);
      // Пункт меню веде до секції — переносимо туди фокус, щоб він не «губився» на <body>
      var hash = link.getAttribute('href') || '';
      var target = hash.charAt(0) === '#' && hash.length > 1 ? doc.getElementById(hash.slice(1)) : null;
      if (target) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    });
    var NAV_WIDE = 1280; // те саме значення, що й у site.css (повне меню в шапці)
    var wide = window.matchMedia('(min-width: ' + NAV_WIDE + 'px)');

    // Fall back to the burger when the nav does not fit (long labels / many sections)
    var inner = $('.site-header__inner', header);
    var nav = $('.site-nav', header);
    var brandWord = $('.brand__word', header);
    function fitNav() {
      if (!inner || !nav) return;
      root.classList.remove('nav-compact');
      if (!wide.matches) return;
      // не вміщається рядок шапки або назва бренду стискається через меню → лишаємо «бургер»
      var squeezed = brandWord && $$('.brand__name, .brand__tagline', brandWord).some(function (el) {
        return el.scrollWidth > el.clientWidth + 1;
      });
      if (inner.scrollWidth > inner.clientWidth + 1 || squeezed) root.classList.add('nav-compact');
    }
    function onLayoutChange() {
      fitNav();
      if (wide.matches && !root.classList.contains('nav-compact')) close(false);
    }
    var resizeTimer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(onLayoutChange, 120);
    });
    wide.addEventListener('change', onLayoutChange);
    fitNav();
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(fitNav);
  })();

  /* ---------- 4. Reviews carousel ---------- */
  $$('[data-carousel]').forEach(function (viewport) {
    var track = $('[data-carousel-track]', viewport);
    var section = viewport.closest('section');
    var nav = section && $('[data-carousel-nav]', section);
    if (!track || !nav) return;
    var prev = $('[data-carousel-prev]', nav);
    var next = $('[data-carousel-next]', nav);
    var count = $('[data-carousel-count]', nav);
    var slides = $$(':scope > li', track);
    if (slides.length < 2) return;
    nav.hidden = false;

    function step() {
      var a = slides[0].getBoundingClientRect();
      var b = slides[1].getBoundingClientRect();
      return Math.max(1, b.left - a.left);
    }
    function currentIndex() {
      return Math.round(track.scrollLeft / step());
    }
    function maxScroll() {
      return track.scrollWidth - track.clientWidth;
    }
    // aria-disabled замість disabled: вимкнена кнопка втратила б фокус (він падав на <body>)
    function setDisabled(btn, off) {
      btn.setAttribute('aria-disabled', String(off));
    }
    function isDisabled(btn) {
      return btn.getAttribute('aria-disabled') === 'true';
    }
    function update() {
      var max = maxScroll();
      setDisabled(prev, track.scrollLeft <= 2);
      setDisabled(next, track.scrollLeft >= max - 2);
      if (count) {
        var visible = Math.max(1, Math.round(track.clientWidth / step()));
        var idx = isDisabled(next) ? slides.length - visible : currentIndex();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        count.textContent = pad(Math.min(slides.length, idx + 1)) + ' / ' + pad(slides.length);
      }
      // overflow? hide nav if everything fits
      nav.hidden = max <= 2;
    }
    function go(dir) {
      var target = (currentIndex() + dir) * step();
      track.scrollTo({ left: target, behavior: prefersReduced() ? 'auto' : 'smooth' });
    }
    prev.addEventListener('click', function () { if (!isDisabled(prev)) go(-1); });
    next.addEventListener('click', function () { if (!isDisabled(next)) go(1); });
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    });
    var raf = 0;
    track.addEventListener('scroll', function () {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    }, { passive: true });
    window.addEventListener('resize', update);
    // slides revealed later shouldn't wait for the observer once scrolled horizontally
    track.addEventListener('scroll', function () {
      slides.forEach(function (s) { s.classList.add('is-visible'); });
    }, { passive: true, once: true });
    update();
  });

  /* ---------- 5. Lightbox (gallery + certificates) ---------- */
  (function initLightbox() {
    var dialog = $('[data-lightbox-dialog]');
    var triggers = $$('[data-lightbox]');
    if (!dialog || !triggers.length || typeof dialog.showModal !== 'function') return;
    var imgEl = $('[data-lightbox-img]', dialog);
    var capEl = $('[data-lightbox-caption]', dialog);
    var counterEl = $('[data-lightbox-counter]', dialog);
    var prevBtn = $('[data-lightbox-prev]', dialog);
    var nextBtn = $('[data-lightbox-next]', dialog);
    var closeBtn = $('[data-lightbox-close]', dialog);
    var stage = $('[data-lightbox-stage]', dialog);
    var group = [];
    var index = 0;
    var opener = null;

    function show(i) {
      index = (i + group.length) % group.length;
      var a = group[index];
      var img = a.querySelector('img');
      imgEl.classList.add('is-loading');
      imgEl.onload = function () { imgEl.classList.remove('is-loading'); };
      imgEl.onerror = imgEl.onload;
      imgEl.src = a.getAttribute('href');
      imgEl.alt = (img && img.getAttribute('alt')) || a.getAttribute('data-caption') || '';
      capEl.textContent = a.getAttribute('data-caption') || '';
      counterEl.textContent = group.length > 1 ? (index + 1) + ' / ' + group.length : '';
      dialog.classList.toggle('is-single', group.length < 2);
      // preload neighbours
      if (group.length > 1) {
        [index + 1, index - 1].forEach(function (n) {
          var src = group[(n + group.length) % group.length].getAttribute('href');
          var pre = new Image();
          pre.src = src;
        });
      }
    }
    function open(a) {
      var name = a.getAttribute('data-lightbox');
      group = triggers.filter(function (t) { return t.getAttribute('data-lightbox') === name; });
      opener = a;
      show(group.indexOf(a));
      dialog.showModal();
      lockScroll();
      closeBtn.focus();
    }
    triggers.forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        open(a);
      });
    });
    prevBtn.addEventListener('click', function () { show(index - 1); });
    nextBtn.addEventListener('click', function () { show(index + 1); });
    closeBtn.addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('close', function () {
      unlockScroll();
      imgEl.removeAttribute('src');
      if (opener) opener.focus();
    });
    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    });
    // click on the dark area (not the photo or buttons) closes
    stage.addEventListener('click', function (e) {
      if (e.target === stage) dialog.close();
    });
    // swipe
    var startX = 0;
    var startY = 0;
    var tracking = false;
    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (!tracking) return;
      tracking = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3 && group.length > 1) {
        show(index + (dx < 0 ? 1 : -1));
      } else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.3) {
        dialog.close();
      }
    }, { passive: true });
  })();

  /* ---------- 6. FAQ: smooth <details> ---------- */
  $$('.faq__item').forEach(function (details) {
    var summary = $('summary', details);
    var panel = $('.faq__a', details);
    if (!summary || !panel || typeof panel.animate !== 'function') return;
    var anim = null;
    summary.addEventListener('click', function (e) {
      if (prefersReduced()) return;
      e.preventDefault();
      if (anim) anim.cancel();
      var opening = !details.open || details.classList.contains('is-closing');
      details.classList.toggle('is-closing', !opening);
      if (opening) details.open = true;
      var full = panel.scrollHeight;
      var from = opening ? 0 : panel.offsetHeight;
      var to = opening ? full : 0;
      anim = panel.animate(
        [{ height: from + 'px', opacity: opening ? 0 : 1 }, { height: to + 'px', opacity: opening ? 1 : 0 }],
        { duration: Math.min(520, 260 + full * 0.4), easing: 'cubic-bezier(.2,.7,.2,1)' }
      );
      anim.onfinish = function () {
        anim = null;
        if (!opening) {
          details.open = false;
          details.classList.remove('is-closing');
        }
      };
      anim.oncancel = function () { anim = null; };
    });
  });

  /* ---------- 7. Floating contact button ---------- */
  (function initFab() {
    var fab = $('[data-fab]');
    if (!fab) return;
    var toggle = $('[data-fab-toggle]', fab);
    var list = $('[data-fab-list]', fab);
    var isOpen = false;
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('aria-expanded', 'false');

    function setOpen(open, returnFocus) {
      isOpen = open;
      fab.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      var label = toggle.getAttribute(open ? 'data-label-close' : 'data-label-open');
      if (label) toggle.setAttribute('aria-label', label);
      list.querySelectorAll('a').forEach(function (a) { a.tabIndex = open ? 0 : -1; });
      if (!open && returnFocus) toggle.focus();
    }
    setOpen(false);
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      setOpen(!isOpen);
      if (isOpen) {
        var first = list.querySelector('a');
        if (first && e.detail === 0) first.focus(); // keyboard activation
      }
    });
    toggle.addEventListener('keydown', function (e) {
      if (e.key === ' ') { e.preventDefault(); toggle.click(); }
    });
    doc.addEventListener('keydown', function (e) {
      if (isOpen && e.key === 'Escape') setOpen(false, true);
    });
    doc.addEventListener('click', function (e) {
      if (isOpen && !fab.contains(e.target)) setOpen(false);
    });
    list.addEventListener('click', function () { setOpen(false); });

    // Показуємо після головного екрана; ховаємо, щойно на екрані контакти або підвал
    // (там ті самі месенджери, а кнопка лише закривала б кнопку «Нагору» й текст).
    // Прихована кнопка — inert: її не можна «знайти» клавішею Tab.
    var hero = doc.getElementById('hero');
    var pastHero = !hero;
    var covered = 0; // скільки «заборонених» зон зараз на екрані
    var sync = function () {
      var visible = pastHero && covered === 0;
      fab.classList.toggle('is-visible', visible);
      if (!visible && isOpen) setOpen(false);
      if (visible || isOpen) fab.removeAttribute('inert');
      else fab.setAttribute('inert', '');
    };
    if (!('IntersectionObserver' in window)) {
      fab.classList.add('is-visible');
      return;
    }
    if (hero) {
      new IntersectionObserver(function (entries) {
        pastHero = !entries[0].isIntersecting;
        sync();
      }, { threshold: 0.35 }).observe(hero);
    }
    var zones = [doc.getElementById('contact'), $('.site-footer')].filter(Boolean);
    if (zones.length) {
      var seen = new Map();
      var zoneIo = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) { seen.set(entry.target, entry.isIntersecting); });
        covered = 0;
        seen.forEach(function (v) { if (v) covered += 1; });
        sync();
      }, { threshold: 0 });
      zones.forEach(function (z) { zoneIo.observe(z); });
    }
    sync();
  })();

  /* ---------- 8. Back to top ---------- */
  $$('[data-to-top]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: prefersReduced() ? 'auto' : 'smooth' });
      var main = doc.getElementById('main');
      if (main) main.focus({ preventScroll: true });
    });
  });

  /* ---------- 9. Destination card → prefill the form ---------- */
  var destField = $('[data-destination-field]');
  if (destField) {
    var lastPrefill = '';
    $$('[data-destination]').forEach(function (a) {
      a.addEventListener('click', function () {
        var value = a.getAttribute('data-destination') || '';
        if (!destField.value || destField.value === lastPrefill) {
          destField.value = value;
          lastPrefill = value;
        }
      });
    });
  }

  /* ---------- 10. Lead form (fetch JSON, falls back to normal POST) ---------- */
  $$('[data-lead-form]').forEach(function (form) {
    var card = form.closest('[data-form-card]');
    var success = card && $('[data-form-success]', card);
    var status = $('[data-form-status]', form);
    var submit = $('[data-submit]', form);
    var submitLabel = $('[data-submit-label]', form);
    var labelIdle = submitLabel ? submitLabel.textContent : '';
    var msg = {
      sending: form.getAttribute('data-msg-sending') || '…',
      success: form.getAttribute('data-msg-success') || '',
      error: form.getAttribute('data-msg-error') || '',
      fields: form.getAttribute('data-msg-fields') || '',
    };
    var busy = false;

    // Власні підказки під полями замість системних «бульбашок» (вони мовою браузера, а не сторінки).
    // Без JS лишається звичайна перевірка браузера.
    form.noValidate = true;

    function setStatus(text, isError) {
      status.textContent = text;
      status.classList.toggle('is-error', !!isError);
    }
    function errorBox(field) {
      var id = field.id + '-error';
      var box = doc.getElementById(id);
      if (!box) {
        box = doc.createElement('p');
        box.className = 'field__error';
        box.id = id;
        box.hidden = true;
        field.insertAdjacentElement('afterend', box);
      }
      return box;
    }
    function setFieldError(field, text) {
      var box = errorBox(field);
      box.textContent = text;
      box.hidden = false;
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', box.id);
    }
    function clearFieldError(field) {
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
      var box = doc.getElementById(field.id + '-error');
      if (box) {
        box.hidden = true;
        box.textContent = '';
      }
    }
    function clearInvalid() {
      $$('[aria-invalid]', form).forEach(clearFieldError);
    }
    function setBusy(on) {
      busy = on;
      submit.disabled = on;
      submit.setAttribute('aria-busy', String(on));
      if (submitLabel) submitLabel.textContent = on ? msg.sending : labelIdle;
    }
    /** Перевірка обов’язкових полів (ті самі межі, що й на сервері) → масив полів з помилкою */
    function validate() {
      var bad = [];
      $$('input[required], textarea[required]', form).forEach(function (field) {
        var value = field.value.trim();
        var min = Number(field.getAttribute('minlength')) || 1;
        if (value.length < min) {
          setFieldError(field, field.getAttribute('data-msg-invalid') || msg.fields);
          bad.push(field);
        }
      });
      return bad;
    }
    form.addEventListener('input', function (e) {
      if (e.target.getAttribute('aria-invalid')) clearFieldError(e.target);
    });

    form.addEventListener('submit', function (e) {
      if (!window.fetch || !window.FormData) return; // native POST fallback
      e.preventDefault();
      if (busy) return;
      clearInvalid();
      var invalid = validate();
      if (invalid.length) {
        setStatus(msg.fields, true);
        invalid[0].focus();
        return;
      }
      var data = {};
      new FormData(form).forEach(function (value, key) { data[key] = typeof value === 'string' ? value.trim() : ''; });
      setBusy(true);
      setStatus(msg.sending, false);

      fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
        credentials: 'same-origin',
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          return { ok: res.ok, status: res.status, body: body || {} };
        });
      }).then(function (r) {
        setBusy(false);
        if (r.ok) {
          form.reset();
          setStatus('', false);
          if (success && card) {
            var title = $('.form-card__title', card);
            if (title) title.hidden = true;
            form.hidden = true;
            card.classList.add('is-sent');
            success.hidden = false;
            success.setAttribute('tabindex', '-1');
            success.focus({ preventScroll: true });
            var top = card.getBoundingClientRect().top;
            if (top < 60 || top > window.innerHeight * 0.6) {
              card.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'center' });
            }
          } else {
            setStatus(msg.success, false);
          }
          return;
        }
        // Сервер відповідає мовою форми (поле lang): повідомлення — під відповідними полями
        var details = Array.isArray(r.body.details) ? r.body.details : [];
        var firstBad = null;
        var unplaced = [];
        details.forEach(function (d) {
          var field = d && d.field && form.elements.namedItem(d.field);
          if (field && field.id && field.setAttribute) {
            setFieldError(field, d.message || field.getAttribute('data-msg-invalid') || msg.fields);
            if (!firstBad) firstBad = field;
          } else if (d && d.message) {
            unplaced.push(d.message);
          }
        });
        var serverText = [r.body.error].concat(unplaced).filter(Boolean).join(' ');
        setStatus(serverText || msg.error, true);
        if (firstBad) firstBad.focus();
      }).catch(function () {
        setBusy(false);
        setStatus(msg.error, true);
      });
    });
  });
})();

/* v2.js — page interactions and motion for the home.
   The split-flap board in the headline, the request state shared by the crew forms, the request ticket, header and
   fixed bar, menu, the tape after the hero, smooth scrolling and the motion system.
   Every block looks for its own data-* hook and does nothing when it is missing. Content is never hidden in CSS:
   without JS, without GSAP or with reduced motion everything is visible in its final state. */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGsap = typeof window.gsap !== 'undefined';
  var hasST = hasGsap && typeof window.ScrollTrigger !== 'undefined';
  var gsap = window.gsap;
  var hasIO = 'IntersectionObserver' in window;
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  var desktop = window.matchMedia('(min-width: 1024px)');

  if (hasST) gsap.registerPlugin(window.ScrollTrigger);

  /* ── smooth scrolling (desktop, fine pointer) ── */
  var lenis = null;
  if (!reduceMotion && typeof window.Lenis !== 'undefined' && window.matchMedia('(pointer: fine) and (min-width: 1024px)').matches) {
    try {
      lenis = new window.Lenis({ duration: 1.1, easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); }, smoothWheel: true });
      if (hasST) {
        lenis.on('scroll', window.ScrollTrigger.update);
        gsap.ticker.add(function (time) { lenis.raf(time * 1000); });
        gsap.ticker.lagSmoothing(0);
      } else {
        var rafLoop = function (time) { lenis.raf(time); window.requestAnimationFrame(rafLoop); };
        window.requestAnimationFrame(rafLoop);
      }
    } catch (error) {
      lenis = null;
    }
  }
  var hdr = $('[data-hdr]');
  var headerOffset = function () { return (hdr ? hdr.offsetHeight : 0) + 8; };
  var scrollToEl = function (el, done) {
    if (!el) return;
    if (lenis) {
      lenis.scrollTo(el, { offset: -headerOffset(), duration: 1.1, onComplete: done });
      return;
    }
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    if (done) setTimeout(done, reduceMotion ? 0 : 700);
  };
  var focusQuietly = function (el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (error) { el.focus(); }
  };

  /* ── the split-flap board in the headline ──
     Twelve flaps. The word in the HTML is the final state; the script only adds the moving halves.
     Each flip: the old top half falls, then the new bottom half rises (~110 ms). */
  var board = (function () {
    var el = $('[data-flaps]');
    var srText = $('[data-flaps-text]');
    var isStatic = el && el.hasAttribute('data-flaps-static');
    if (!el) return { show: function () {}, boot: function () {}, setInstant: function () {} };
    var SLOTS = 12;
    var DRUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    var FLIP_MS = 112;
    var canAnimate = !reduceMotion && typeof el.animate === 'function';
    var visible = true;
    var pending = null;
    var current = null;

    var tiles = $$('.flap', el).map(function (node) {
      var make = function (cls) {
        var half = document.createElement('span');
        half.className = 'flap__h ' + cls;
        node.appendChild(half);
        return half;
      };
      return { node: node, c: node.getAttribute('data-c') || ' ', target: null, spins: 0, busy: false, under: make('flap__h--under'), fall: make('flap__h--fall'), rise: make('flap__h--rise') };
    });
    SLOTS = tiles.length;
    current = tiles.map(function (t) { return t.c; }).join('');

    var pad = function (word) {
      var w = String(word || '').toUpperCase().slice(0, SLOTS);
      var left = Math.floor((SLOTS - w.length) / 2);
      var out = new Array(left + 1).join(' ') + w;
      return out + new Array(SLOTS - out.length + 1).join(' ');
    };
    var randomChar = function (not) {
      var ch;
      do { ch = DRUM.charAt(Math.floor(Math.random() * DRUM.length)); } while (ch === not);
      return ch;
    };
    var setNow = function (tile, ch) {
      tile.c = ch;
      tile.node.setAttribute('data-c', ch);
    };
    var flip = function (tile, next, done) {
      var old = tile.c;
      tile.under.setAttribute('data-c', next);
      tile.fall.setAttribute('data-c', old);
      tile.rise.setAttribute('data-c', next);
      tile.node.classList.add('is-flipping');
      var a = tile.fall.animate([{ transform: 'perspective(4em) rotateX(0deg)' }, { transform: 'perspective(4em) rotateX(-90deg)' }], { duration: FLIP_MS * 0.5, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
      a.onfinish = function () {
        var b = tile.rise.animate([{ transform: 'perspective(4em) rotateX(90deg)' }, { transform: 'perspective(4em) rotateX(0deg)' }], { duration: FLIP_MS * 0.5, easing: 'cubic-bezier(0,.55,.45,1)', fill: 'forwards' });
        b.onfinish = function () {
          setNow(tile, next);
          tile.node.classList.remove('is-flipping');
          a.cancel();
          b.cancel();
          done();
        };
      };
    };
    var run = function (tile) {
      if (tile.spins > 0) {
        tile.spins -= 1;
        flip(tile, randomChar(tile.c), function () { run(tile); });
        return;
      }
      if (tile.c !== tile.target) {
        flip(tile, tile.target, function () { run(tile); });
        return;
      }
      tile.busy = false;
    };
    var send = function (tile, ch, spins, delay) {
      tile.target = ch;
      tile.spins = Math.max(tile.spins, spins);
      if (tile.busy) return;
      tile.busy = true;
      setTimeout(function () { run(tile); }, delay);
    };
    var apply = function (word, spinsFor) {
      var text = pad(word);
      tiles.forEach(function (tile, i) {
        var ch = text.charAt(i);
        if (!canAnimate) { setNow(tile, ch); return; }
        send(tile, ch, spinsFor(i, ch), i * 38);
      });
      current = text;
    };

    /* the board only moves where it can be seen: a word chosen off screen waits for the headline */
    if (hasIO) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible && pending) { var w = pending; pending = null; show(w); }
      }, { threshold: 0.6 }).observe(el);
    }
    var show = function (word, label) {
      if (isStatic) return;
      if (label && srText) srText.textContent = label;
      if (pad(word) === current && !pending) return;
      if (!visible && canAnimate) { pending = word; return; }
      apply(word, function (i, ch) { return ch === ' ' ? (Math.random() < 0.5 ? 1 : 0) : 1 + Math.floor(Math.random() * 3); });
    };
    /* calls back once every flap has stopped */
    var whenIdle = function (cb) {
      var check = function () {
        if (tiles.some(function (t) { return t.busy; })) { setTimeout(check, 90); return; }
        cb();
      };
      check();
    };
    /* data-flaps-cycle="water fire mold": on load the board runs through these words once and comes back to its own word,
       then stays (about 5 s in all) */
    var cycle = (el.getAttribute('data-flaps-cycle') || '').split(/\s+/).filter(Boolean);
    var HOLD_MS = 650;
    var runCycle = function () {
      var seq = cycle.concat([current.trim()]);
      var n = 0;
      var next = function () {
        var first = n === 0;
        apply(seq[n], function (i, ch) {
          if (ch === ' ') return Math.random() < 0.5 ? 1 : 0;
          return first ? 3 + (i % 3) + Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 2);
        });
        n += 1;
        if (n < seq.length) whenIdle(function () { setTimeout(next, HOLD_MS); });
      };
      next();
    };
    /* first paint: every flap spins a few times and settles, left to right (about 1.3 s) */
    var boot = function () {
      if (!canAnimate) return;
      if (cycle.length) { runCycle(); return; }
      var word = current;
      tiles.forEach(function (tile, i) {
        var ch = word.charAt(i);
        if (ch === ' ') return;
        send(tile, ch, 3 + (i % 3) + Math.floor(Math.random() * 3), 120 + i * 45);
      });
    };
    var setInstant = function (word, label) {
      if (isStatic) return;
      var text = pad(word);
      tiles.forEach(function (tile, i) { setNow(tile, text.charAt(i)); });
      current = text;
      if (label && srText) srText.textContent = label;
    };
    return { show: show, boot: boot, setInstant: setInstant };
  })();

  /* the word the board settles on for each labor option (pages whose board turns; the home board is static): "supervisor" and "other" keep
     RESTORATION, since "Hire a supervisor crew." is not English. Longest word: RESTORATION (11 of 12 flaps). */
  var BOARD_WORD = {
    'general-labor': 'labor',
    painting: 'painting',
    drywall: 'drywall',
    carpentry: 'carpentry',
    finishing: 'finishing',
    supervisor: 'restoration',
    other: 'restoration'
  };

  /* ── the request: what the visitor has told us so far, from whichever crew form they use ──
     The ticket in "How it works" shows it (never the contact details), and step 3 of each form sums it up. */
  var crewForms = $$('form[data-cs-form^="crew-"]');
  var ticketVals = {};
  var EMPTY = {};
  $$('[data-ticket] [data-v]').forEach(function (v) {
    var key = v.getAttribute('data-v');
    ticketVals[key] = v;
    EMPTY[key] = v.textContent;
  });
  var labelOf = function (input) {
    var span = input && input.parentNode && input.parentNode.querySelector('span');
    return span ? span.textContent.trim() : '';
  };
  var setTicket = function (key, value) {
    var out = ticketVals[key];
    if (!out) return;
    var text = value || EMPTY[key];
    if (out.textContent === text) return;
    out.textContent = text;
    out.classList.toggle('is-set', !!value);
    var row = out.closest('.ticket__row');
    if (!row) return;
    row.classList.remove('is-pulse');
    void row.offsetWidth;
    if (value && !reduceMotion) row.classList.add('is-pulse');
  };
  var summarize = function (form) {
    var box = $('[data-request-summary]', form);
    var out = $('[data-request-summary-text]', form);
    if (!box || !out) return;
    var pick = function (name) { return labelOf($('input[name="' + name + '"]:checked', form)); };
    var zipEl = $('input[name="zip"]', form);
    var zip = zipEl ? zipEl.value.replace(/\D/g, '').slice(0, 5) : '';
    var parts = [pick('service'), zip ? 'ZIP ' + zip : '', pick('crew_size'), pick('start_window')].filter(Boolean);
    out.textContent = parts.join(' · ');
    box.hidden = !parts.length;
  };
  var rackCells = $$('[data-rack] .trade');
  var markRack = function (value) {
    rackCells.forEach(function (cell) { cell.classList.toggle('is-picked', cell.getAttribute('data-trade') === value); });
  };
  var onTrade = function (value, label) {
    markRack(value);
    setTicket('service', label);
    if (BOARD_WORD[value]) board.show(BOARD_WORD[value], BOARD_WORD[value]);
  };
  crewForms.forEach(function (form) {
    var read = function (event) {
      var t = event.target;
      if (!t || !t.name) return;
      if (t.name === 'zip') setTicket('zip', (t.value || '').replace(/\D/g, '').slice(0, 5));
      else if (t.name === 'service' && t.checked) onTrade(t.value, labelOf(t));
      else if ((t.name === 'crew_size' || t.name === 'start_window') && t.checked) setTicket(t.name, labelOf(t));
      if (t.name === 'zip' || t.name === 'service' || t.name === 'crew_size' || t.name === 'start_window') summarize(form);
    };
    form.addEventListener('input', read);
    form.addEventListener('change', read);
    summarize(form);
  });

  /* ── trade preselection (rack cells and ?trade= for ad groups) ── */
  var SERVICE_RE = /^[a-z-]{2,40}$/;
  var preselect = function (value, only) {
    if (!value || !SERVICE_RE.test(value)) return null;
    var label = '';
    var forms = only && !/^crew-/.test(only.getAttribute('data-cs-form') || '') ? [only] : crewForms;
    forms.forEach(function (form) {
      var radio = form.querySelector('input[name="service"][value="' + value + '"]');
      if (radio) { radio.checked = true; label = label || labelOf(radio); }
      summarize(form);
    });
    return label || null;
  };
  try {
    var fromAd = new URLSearchParams(window.location.search).get('trade') || document.body.getAttribute('data-trade');
    var adLabel = preselect(fromAd);
    if (adLabel && BOARD_WORD[fromAd]) {
      board.setInstant(BOARD_WORD[fromAd], BOARD_WORD[fromAd]);
      markRack(fromAd);
      setTicket('service', adLabel);
    }
  } catch (error) {
    /* URLSearchParams missing: no preselection */
  }

  /* the board settles on load, unless the script arrived late and the headline has been on screen for a while */
  var late = window.performance && performance.now() > 2600;
  if (!late) board.boot();

  /* ── links to a section of this page (also "/#how" while on the home) ── */
  var samePageHash = function (a) {
    if (!a.hash || a.hash.length < 2) return null;
    if (a.pathname.replace(/index\.html$/, '') !== window.location.pathname.replace(/index\.html$/, '') || a.host !== window.location.host) return null;
    return a.hash;
  };

  /* ── "Hire a crew" / "Apply": scroll to the form of this page and put the cursor on its current step;
     a cell of the trades board checks its trade first. A link to another page (/contact/) just navigates. ── */
  var focusForm = function (form) {
    if (!form) return;
    var step = $('[data-cs-step]:not([hidden])', form) || form;
    var field = $('input:not([type="hidden"]):not([tabindex="-1"]), textarea', step);
    if (!field) return;
    var checked = field.type === 'radio' && $('input[name="' + field.name + '"]:checked', step);
    focusQuietly(checked || field);
  };
  $$('[data-focus-request]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      var hash = samePageHash(link);
      var target = hash && document.getElementById(hash.slice(1));
      if (!target) return;
      var form = target.matches('form') ? target : $('form[data-cs-form]', target);
      var trade = link.getAttribute('data-trade');
      if (trade) {
        var label = preselect(trade, form);
        if (label) onTrade(trade, label);
      }
      e.preventDefault();
      if (window.history && window.history.pushState && window.location.hash !== hash) window.history.pushState(null, '', hash);
      scrollToEl(target, function () { focusForm(form); });
    });
  });

  /* ── header: solid after the first scroll; the rule measures the read ── */
  var progress = $('[data-progress]');
  var lastSolid = null;
  var onScroll = function () {
    var y = window.pageYOffset || root.scrollTop;
    var solid = y > 24;
    if (hdr && solid !== lastSolid) { hdr.classList.toggle('is-solid', solid); lastSolid = solid; }
    if (progress) {
      var max = root.scrollHeight - window.innerHeight;
      progress.style.setProperty('--read', max > 0 ? Math.min(1, y / max).toFixed(4) : '0');
    }
  };
  if (lenis) lenis.on('scroll', onScroll); else window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ── the hero card scrolls inside on short desktop screens: wheel stays in it, and each new step starts at its top ── */
  var heroCard = $('#crew-hero');
  if (heroCard) {
    heroCard.setAttribute('data-lenis-prevent', '');
    if ('MutationObserver' in window) {
      new MutationObserver(function (records) {
        var stepShown = records.some(function (r) { return r.attributeName === 'hidden' && r.target.hasAttribute('data-cs-step') && !r.target.hidden; });
        if (stepShown) heroCard.scrollTop = 0;
      }).observe(heroCard, { attributes: true, attributeFilter: ['hidden'], subtree: true });
    }
  }

  /* ── header button outlined while the hero form is on screen; fixed bar after it, never over another form ── */
  var heroForm = $('[data-hero-form]');
  var hdrCta = $('.hdr__cta');
  var mbar = $('[data-mbar]');
  var menuOpen = false;
  var pastHero = false;
  var others = new Set();
  var updateBar = function () {
    if (mbar) mbar.classList.toggle('is-visible', pastHero && others.size === 0 && !menuOpen);
  };
  var heroRef = heroForm || $('.hero');
  if (hasIO && heroRef) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (hdrCta && heroForm) hdrCta.classList.toggle('is-quiet', entry.isIntersecting);
        pastHero = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      });
      updateBar();
    }).observe(heroRef);
    var otherIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) others.add(entry.target); else others.delete(entry.target);
      });
      updateBar();
    });
    $$('[data-other-form]').forEach(function (el) { otherIo.observe(el); });
  } else if (mbar) {
    pastHero = true;
    updateBar();
  }

  /* ── menu (phone and tablet): focus trapped, Escape closes, page behind does not scroll ── */
  (function menu() {
    var toggle = $('[data-menu-toggle]');
    var panel = $('[data-menu]');
    if (!toggle || !panel) return;
    var label = $('.menu-btn__label', toggle);
    var prevOverflow = '';
    panel.inert = true;
    var focusables = function () { return [toggle].concat($$('a[href], button:not([disabled])', panel)); };
    var set = function (open) {
      menuOpen = open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (label) label.textContent = open ? 'Close' : 'Menu';
      panel.classList.toggle('is-open', open);
      panel.inert = !open;
      root.classList.toggle('is-menu-open', open);
      updateBar();
    };
    var openMenu = function () {
      if (menuOpen) return;
      prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      if (lenis) lenis.stop();
      set(true);
      var first = focusables()[1];
      if (first) setTimeout(function () { first.focus(); }, reduceMotion ? 0 : 120);
    };
    var closeMenu = function (returnFocus) {
      if (!menuOpen) return;
      set(false);
      document.body.style.overflow = prevOverflow;
      if (lenis) lenis.start();
      if (returnFocus !== false) toggle.focus();
    };
    toggle.addEventListener('click', function () { if (menuOpen) closeMenu(); else openMenu(); });
    panel.addEventListener('click', function (e) { if (e.target.closest('a[href]')) closeMenu(false); });
    document.addEventListener('keydown', function (e) {
      if (!menuOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
      if (e.key !== 'Tab') return;
      var items = focusables();
      if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === items[items.length - 1]) { e.preventDefault(); items[0].focus(); }
    });
    desktop.addEventListener('change', function (mq) { if (mq.matches) closeMenu(false); });
    window.addEventListener('pagehide', function () { closeMenu(false); });
  })();

  /* ── tape after the hero: it only runs with JS (CSS animation); pause button (WCAG 2.2.2); stops while off screen ── */
  var tape = $('[data-tape]');
  if (tape) {
    var tapeBtn = $('[data-tape-toggle]', tape);
    if (tapeBtn) {
      tapeBtn.addEventListener('click', function () {
        var paused = tapeBtn.getAttribute('aria-pressed') !== 'true';
        tapeBtn.setAttribute('aria-pressed', String(paused));
        tape.classList.toggle('is-paused', paused);
      });
    }
    if (hasIO) new IntersectionObserver(function (entries) { tape.classList.toggle('is-off', !entries[0].isIntersecting); }).observe(tape);
  }

  /* ── in-page links: with smooth scrolling every anchor goes through it ── */
  if (lenis) {
    $$('a[href*="#"]').forEach(function (link) {
      if (link.hasAttribute('data-focus-request')) return;
      var href = samePageHash(link);
      if (!href) return;
      link.addEventListener('click', function (e) {
        var target = document.getElementById(href.slice(1));
        if (!target) return;
        e.preventDefault();
        if (window.history && window.history.pushState) window.history.pushState(null, '', href);
        scrollToEl(target);
      });
    });
  }

  /* ── header: the trades menu (hover opens it with a mouse; click, Escape and focus leaving close it).
     Closing while the pointer is still on it keeps it closed until the pointer leaves. ── */
  (function tradesMenu() {
    var item = $('[data-drop]');
    var btn = item && $('[data-drop-toggle]', item);
    if (!btn) return;
    var set = function (open) {
      item.classList.toggle('is-open', open);
      item.classList.toggle('is-closed', !open && item.matches(':hover'));
      btn.setAttribute('aria-expanded', String(open));
    };
    item.addEventListener('mouseleave', function () { item.classList.remove('is-closed'); });
    btn.addEventListener('click', function () { set(!item.classList.contains('is-open')); });
    document.addEventListener('click', function (e) { if (!item.contains(e.target)) set(false); });
    // Escape also dismisses the panel opened by hover alone (WCAG 1.4.13); focus moves back only from inside the menu
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !(item.classList.contains('is-open') || item.matches(':hover'))) return;
      var inside = item.contains(document.activeElement);
      set(false);
      if (inside) btn.focus();
    });
    item.addEventListener('focusout', function (e) { if (!item.contains(e.relatedTarget)) set(false); });
  })();

  if (!hasGsap || reduceMotion) return;

  var EXPO = 'expo.out';
  var ST = hasST ? window.ScrollTrigger : null;
  if (!ST) return;

  /* ── section titles: each sentence rises from its mask ── */
  $$('[data-lines]').forEach(function (title) {
    gsap.from($$('.ln > span', title), { yPercent: 108, duration: 1.05, ease: EXPO, stagger: 0.1, clearProps: 'transform', scrollTrigger: { trigger: title, start: 'top 88%', once: true } });
  });

  /* ── reveals ── */
  $$('[data-reveal]').forEach(function (group) {
    var items = group.hasAttribute('data-reveal-children') ? group.children : [group];
    gsap.from(items, { y: 22, opacity: 0, duration: 0.85, ease: EXPO, stagger: 0.08, clearProps: 'transform,opacity', scrollTrigger: { trigger: group, start: 'top 88%', once: true } });
  });

  /* ── hero photo band: drifts slower than the page (desktop) ── */
  var mm = gsap.matchMedia();
  var band = $('[data-band] img');
  mm.add('(min-width: 1024px)', function () {
    if (!band) return;
    gsap.fromTo(band, { yPercent: -6, scale: 1.12 }, { yPercent: 6, scale: 1.12, ease: 'none', scrollTrigger: { trigger: '[data-band]', start: 'top bottom', end: 'bottom top', scrub: true } });
  });

  /* ── the trade rack: cells come in across the grid, then each pictogram is drawn ── */
  var rack = $('[data-rack]');
  if (rack) {
    var cells = $$('.trade', rack);
    var tl = gsap.timeline({ scrollTrigger: { trigger: rack, start: 'top 82%', once: true } });
    tl.from(cells, { y: 26, opacity: 0, duration: 0.8, ease: EXPO, stagger: { grid: 'auto', from: 'start', amount: 0.42 }, clearProps: 'transform,opacity' })
      .from($$('.trade__ic path', rack), { strokeDashoffset: 1, duration: 0.9, ease: 'power2.inOut', stagger: 0.035, clearProps: 'strokeDashoffset' }, 0.15);
  }

  /* ── the request ticket: one line per step of the form; each line writes itself in as its step passes the middle of
     the screen, and step 03 stamps it "In review." (on phones the lines write in one after the other) ── */
  var ticket = $('[data-ticket]');
  var stamp = $('[data-stamp]');
  var stampIn = function () {
    if (!stamp) return;
    gsap.fromTo(stamp, { scale: 1.9, opacity: 0, rotation: -2 }, { scale: 1, opacity: 1, rotation: -8, duration: 0.42, ease: 'power4.in', overwrite: true, clearProps: 'transform,opacity', onComplete: function () {
      if (ticket) gsap.fromTo(ticket, { x: -3, y: 2 }, { x: 0, y: 0, duration: 0.35, ease: 'elastic.out(1.2, 0.4)', clearProps: 'transform' });
    } });
  };
  if (ticket) {
    var tRows = $$('.ticket__row', ticket);
    var tVals = tRows.map(function (row) { return $('.ticket__v', row); });
    mm.add('(min-width: 1024px)', function () {
      var steps = $$('[data-how-step]');
      gsap.set(tVals, { clipPath: 'inset(0% 100% 0% 0%)' });
      if (stamp) gsap.set(stamp, { opacity: 0 });
      var fill = function (i, on) {
        tRows.forEach(function (row, k) { row.classList.toggle('is-on', k === (on ? i : i - 1)); });
        gsap.to(tVals[i], { clipPath: on ? 'inset(0% 0% 0% 0%)' : 'inset(0% 100% 0% 0%)', duration: on ? 0.55 : 0.3, ease: on ? 'power3.out' : 'power2.in', overwrite: true });
      };
      steps.forEach(function (step, i) {
        if (!tVals[i]) return;
        var last = i === steps.length - 1;
        ST.create({ trigger: step, start: 'top 62%', end: 'max', onEnter: function () { fill(i, true); if (last) stampIn(); }, onLeaveBack: function () {
          fill(i, false);
          if (last && stamp) gsap.to(stamp, { opacity: 0, duration: 0.2, overwrite: true });
        } });
      });
      return function () {
        gsap.set(tVals, { clearProps: 'clipPath' });
        tRows.forEach(function (row) { row.classList.remove('is-on'); });
        if (stamp) gsap.set(stamp, { clearProps: 'opacity,transform' });
      };
    });
    mm.add('(max-width: 1023px)', function () {
      if (stamp) gsap.set(stamp, { opacity: 0 });
      var t2 = gsap.timeline({ scrollTrigger: { trigger: ticket, start: 'top 72%', once: true } });
      tRows.forEach(function (row, i) {
        t2.call(function () { row.classList.add('is-on'); }, null, 0.18 + i * 0.3)
          .from(tVals[i], { clipPath: 'inset(0% 100% 0% 0%)', duration: 0.5, ease: 'power3.out', clearProps: 'clipPath' }, 0.18 + i * 0.3);
      });
      t2.call(function () { tRows.forEach(function (row) { row.classList.remove('is-on'); }); stampIn(); }, null, 0.18 + tRows.length * 0.3 + 0.15);
      return function () { if (stamp) gsap.set(stamp, { clearProps: 'opacity' }); };
    });
  }

  /* ── the bridge (about): both beams reach out from the ends, the shield sets in the middle like a keystone ── */
  var bridge = $('[data-bridge]');
  if (bridge) {
    var beams = $$('.bridge__beam i', bridge);
    var key = $('.bridge__key', bridge);
    var ends = $$('.bridge__end', bridge);
    var notes = $$('.bnote', bridge);
    var btl = gsap.timeline({ scrollTrigger: { trigger: bridge, start: 'top 80%', end: 'center 52%', scrub: 0.6 } });
    btl.from(ends[0], { xPercent: -14, opacity: 0, ease: 'none', duration: 0.3 }, 0)
      .from(ends[1], { xPercent: 14, opacity: 0, ease: 'none', duration: 0.3 }, 0)
      .from(beams, { scaleX: 0, ease: 'none', duration: 0.6 }, 0.1)
      .from(key, { y: -70, opacity: 0, scale: 0.86, ease: 'power2.in', duration: 0.3 }, 0.55);
    if (notes.length) btl.from(notes, { opacity: 0, x: function (i) { return i === 1 ? 12 : -12; }, stagger: 0.04, ease: 'none', duration: 0.15 }, 0.85);
  }

  /* ── final (home): the red beam runs in from the edge of the screen and the shield drops onto its end ── */
  var arrive = $('[data-arrive]');
  if (arrive) {
    var atl = gsap.timeline({ scrollTrigger: { trigger: arrive, start: 'top 90%', toggleActions: 'play none none reverse' } });
    atl.from($('.arrive__beam i', arrive), { scaleX: 0, ease: 'expo.inOut', duration: 0.95 }, 0)
      .from($('.arrive__shield', arrive), { y: -80, opacity: 0, scale: 0.86, rotation: -6, ease: 'back.out(1.5)', duration: 0.6 }, 0.72);
  }

  /* ── final (inner pages): the shield settles under the yard sign ── */
  var finalShield = $('.final__shield');
  if (finalShield) gsap.from(finalShield, { rotation: -14, scale: 0.7, opacity: 0, duration: 0.9, ease: 'back.out(1.7)', clearProps: 'transform,opacity', scrollTrigger: { trigger: finalShield, start: 'top 92%', once: true } });

  /* ── the photo of the crew opening a wall: uncovered from the bottom, like a wall going up ── */
  $$('.yours__photo img').forEach(function (img) {
    gsap.from(img, { clipPath: 'inset(100% 0% 0% 0%)', duration: 1.2, ease: 'expo.inOut', clearProps: 'clipPath', scrollTrigger: { trigger: img, start: 'top 85%', once: true } });
  });

  /* ── footer: the slogan rises from its line ── */
  var slogan = $$('.foot__in');
  if (slogan.length) gsap.from(slogan, { yPercent: 100, duration: 1.15, ease: EXPO, stagger: 0.12, clearProps: 'transform', scrollTrigger: { trigger: '[data-slogan]', start: 'top 90%', once: true } });

  /* images and fonts change heights: recalculate trigger positions */
  window.addEventListener('load', function () { ST.refresh(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { ST.refresh(); });
})();

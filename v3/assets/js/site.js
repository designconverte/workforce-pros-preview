/* site.js — page interactions and motion.
   The split-flap board in the headline, the request state shared by the crew forms, the request ticket, header and
   fixed bar, menu, the tape after the hero, smooth scrolling and the motion system. The home (body.v3) adds the
   scroll-driven tape, the pinned request scene with the stamp, the drywall tear-out, the small flap boards and the
   pointer details of the labor board.
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
  /* the home runs the richer motion set (body.v3); every other page keeps the base set */
  var isV3 = document.body.classList.contains('v3');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (hasST) gsap.registerPlugin(window.ScrollTrigger);

  /* scrambles a short mono label into place, left to right (the text in the HTML is the final state) */
  var SCRAMBLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  var scramble = function (el, dur) {
    if (!el || el.scrambling || reduceMotion) return;
    var final = el.finalText || (el.finalText = el.textContent);
    var start = 0;
    dur = dur || 520;
    el.scrambling = true;
    var tick = function (now) {
      if (!start) start = now;
      var p = Math.min(1, (now - start) / dur);
      var n = Math.floor(p * final.length);
      var out = final.slice(0, n);
      for (var i = n; i < final.length; i++) {
        var ch = final.charAt(i);
        out += /[\s\/·.,:]/.test(ch) ? ch : SCRAMBLE.charAt(Math.floor(Math.random() * SCRAMBLE.length));
      }
      el.textContent = out;
      if (p < 1) { window.requestAnimationFrame(tick); return; }
      el.textContent = final;
      el.scrambling = false;
    };
    window.requestAnimationFrame(tick);
  };

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

  /* ── split-flap engine ──
     The character in the HTML (data-c) is the final state; the engine only adds the moving halves.
     Each flip: the old top half falls, then the new bottom half rises (~110 ms). With `shade` the falling half dims as
     it turns away from the light and the rising half brightens into place. */
  var FLIP_MS = 112;
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var flapEngine = function (el, drum, shade) {
    var canAnimate = !reduceMotion && typeof el.animate === 'function';
    var tiles = $$('.flap', el).map(function (node) {
      var make = function (cls) {
        var half = document.createElement('span');
        half.className = 'flap__h ' + cls;
        node.appendChild(half);
        return half;
      };
      return { node: node, c: node.getAttribute('data-c') || ' ', target: null, spins: 0, busy: false, under: make('flap__h--under'), fall: make('flap__h--fall'), rise: make('flap__h--rise') };
    });
    var randomChar = function (not) {
      var ch;
      do { ch = drum.charAt(Math.floor(Math.random() * drum.length)); } while (ch === not && drum.length > 1);
      return ch;
    };
    var setNow = function (tile, ch) {
      tile.c = ch;
      tile.node.setAttribute('data-c', ch);
    };
    var FALL = shade
      ? [{ transform: 'perspective(4em) rotateX(0deg)', filter: 'brightness(1)' }, { transform: 'perspective(4em) rotateX(-90deg)', filter: 'brightness(.42)' }]
      : [{ transform: 'perspective(4em) rotateX(0deg)' }, { transform: 'perspective(4em) rotateX(-90deg)' }];
    var RISE = shade
      ? [{ transform: 'perspective(4em) rotateX(90deg)', filter: 'brightness(.62)' }, { transform: 'perspective(4em) rotateX(0deg)', filter: 'brightness(1)' }]
      : [{ transform: 'perspective(4em) rotateX(90deg)' }, { transform: 'perspective(4em) rotateX(0deg)' }];
    var flip = function (tile, next, done) {
      var old = tile.c;
      tile.under.setAttribute('data-c', next);
      tile.fall.setAttribute('data-c', old);
      tile.rise.setAttribute('data-c', next);
      tile.node.classList.add('is-flipping');
      var a = tile.fall.animate(FALL, { duration: FLIP_MS * 0.5, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
      a.onfinish = function () {
        var b = tile.rise.animate(RISE, { duration: FLIP_MS * 0.5, easing: 'cubic-bezier(0,.55,.45,1)', fill: 'forwards' });
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
    /* calls back once every flap has stopped */
    var whenIdle = function (cb) {
      var check = function () {
        if (tiles.some(function (t) { return t.busy; })) { setTimeout(check, 90); return; }
        cb();
      };
      check();
    };
    return { tiles: tiles, canAnimate: canAnimate, setNow: setNow, send: send, whenIdle: whenIdle };
  };

  /* ── the split-flap board in the headline ── */
  var board = (function () {
    var el = $('[data-flaps]');
    var srText = $('[data-flaps-text]');
    var isStatic = el && el.hasAttribute('data-flaps-static');
    if (!el) return { show: function () {}, boot: function () {}, setInstant: function () {} };
    var engine = flapEngine(el, LETTERS, isV3);
    var tiles = engine.tiles;
    var SLOTS = tiles.length;
    var canAnimate = engine.canAnimate;
    var setNow = engine.setNow;
    var send = engine.send;
    var whenIdle = engine.whenIdle;
    var visible = true;
    var pending = null;
    var current = tiles.map(function (t) { return t.c; }).join('');

    /* the tag above the headline lights the word the board is showing (home) */
    var syncWords = $$('[data-flaps-sync] [data-sync]');
    var sync = function (word) {
      syncWords.forEach(function (w) { w.classList.toggle('is-lit', !!word && w.getAttribute('data-sync') === word); });
    };
    /* a light sweeps across the board when it comes to rest (home) */
    var sheen = function () {
      if (!isV3 || !canAnimate) return;
      el.classList.remove('is-settled');
      void el.offsetWidth;
      el.classList.add('is-settled');
    };

    var pad = function (word) {
      var w = String(word || '').toUpperCase().slice(0, SLOTS);
      var left = Math.floor((SLOTS - w.length) / 2);
      var out = new Array(left + 1).join(' ') + w;
      return out + new Array(SLOTS - out.length + 1).join(' ');
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
    /* data-flaps-cycle="water fire mold": on load the board runs through these words once and comes back to its own word,
       then stays (about 5 s in all) */
    var cycle = (el.getAttribute('data-flaps-cycle') || '').split(/\s+/).filter(Boolean);
    var HOLD_MS = 650;
    var cycling = false;
    var runCycle = function () {
      var seq = cycle.concat([current.trim()]);
      var n = 0;
      cycling = true;
      var next = function () {
        var first = n === 0;
        var word = seq[n];
        apply(word, function (i, ch) {
          if (ch === ' ') return Math.random() < 0.5 ? 1 : 0;
          return first ? 3 + (i % 3) + Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 2);
        });
        n += 1;
        whenIdle(function () {
          sync(word.toLowerCase());
          if (n < seq.length) { setTimeout(next, HOLD_MS); return; }
          cycling = false;
          sheen();
          setTimeout(function () { sync(null); }, 1600);
        });
      };
      next();
    };
    /* home, mouse: pointing at the board shuffles it once and it lands on its word again */
    if (isV3 && cycle.length && canAnimate && finePointer) {
      var lastShuffle = 0;
      el.parentNode.addEventListener('pointerenter', function () {
        var now = Date.now();
        if (cycling || now - lastShuffle < 2600) return;
        lastShuffle = now;
        var word = current;
        tiles.forEach(function (tile, i) {
          var ch = word.charAt(i);
          if (ch === ' ') return;
          send(tile, ch, 1 + Math.floor(Math.random() * 3), i * 28);
        });
        whenIdle(sheen);
      });
    }
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

  /* ── small boards (home, "We supply the labor" numbers): each one spins in when it comes into view ── */
  if (isV3 && !reduceMotion && hasIO) {
    $$('[data-miniflaps]').forEach(function (el) {
      var mini = flapEngine(el, '0123456789', true);
      if (!mini.canAnimate) return;
      var io = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        mini.tiles.forEach(function (tile, i) { send0(mini, tile, i); });
      }, { threshold: 0.9, rootMargin: '0px 0px -12% 0px' });
      io.observe(el);
    });
  }
  function send0(mini, tile, i) { mini.send(tile, tile.c, 4 + i * 3 + Math.floor(Math.random() * 2), 120 + i * 90); }

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
    var tapePaused = false;
    var tapeHover = false;
    var tapeOn = true;
    if (tapeBtn) {
      tapeBtn.addEventListener('click', function () {
        tapePaused = tapeBtn.getAttribute('aria-pressed') !== 'true';
        tapeBtn.setAttribute('aria-pressed', String(tapePaused));
        tape.classList.toggle('is-paused', tapePaused);
      });
    }
    if (hasIO) new IntersectionObserver(function (entries) { tapeOn = entries[0].isIntersecting; tape.classList.toggle('is-off', !tapeOn); }).observe(tape);

    /* home: the tape is driven by the scroll. It runs at a walking pace, speeds up and leans with the scroll, and turns
       the way the page is going; the hazard tape behind it runs the other way. Pause, hover and off screen stop both. */
    var track = $('.tape__track', tape);
    var haz = $('.tape__haz span', tape);
    if (isV3 && hasGsap && !reduceMotion && track) {
      tape.classList.add('is-driven');
      var half = 0;
      var tx = 0;
      var hx = 0;
      var vel = 0;
      var lean = 0;
      var dir = 1;
      var lastY = window.pageYOffset;
      var lastT = 0;
      var HAZ_PERIOD = 28 / Math.SQRT1_2;
      var measure = function () { half = track.scrollWidth / 2; };
      measure();
      window.addEventListener('resize', measure);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
      var band = $('.tape__band', tape);
      if (band && finePointer) {
        band.addEventListener('pointerenter', function () { tapeHover = true; });
        band.addEventListener('pointerleave', function () { tapeHover = false; });
      }
      window.addEventListener('scroll', function () {
        var now = performance.now();
        var y = window.pageYOffset;
        if (lastT) {
          var v = (y - lastY) / Math.max(8, now - lastT) * 1000;
          vel = vel * 0.55 + v * 0.45;
          if (Math.abs(v) > 40) dir = v > 0 ? 1 : -1;
        }
        lastY = y;
        lastT = now;
      }, { passive: true });
      gsap.ticker.add(function (time, deltaMs) {
        vel *= 0.9;
        if (tapePaused || tapeHover || !tapeOn || !half) return;
        var dt = Math.min(deltaMs, 50) / 1000;
        var speed = 46 * (1 + Math.min(Math.abs(vel) / 700, 5));
        tx -= speed * dir * dt;
        if (tx <= -half) tx += half;
        if (tx > 0) tx -= half;
        hx = (hx + speed * 0.7 * dir * dt) % HAZ_PERIOD;
        var targetLean = Math.max(-9, Math.min(9, -vel / 160));
        lean += (targetLean - lean) * 0.14;
        track.style.transform = 'translate3d(' + tx.toFixed(2) + 'px,0,0) skewX(' + lean.toFixed(2) + 'deg)';
        if (haz) haz.style.transform = 'translate3d(' + (hx - HAZ_PERIOD).toFixed(2) + 'px,0,0)';
      });
    }
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

  /* ── home, mouse only: the labor board answers the pointer. A red work light follows it inside the cell, the edge
     nearest to it lights up, the cell code reshuffles and the pictogram draws itself again. ── */
  var rackEl = $('[data-rack]');
  if (isV3 && rackEl && finePointer && !reduceMotion) {
    $$('.trade', rackEl).forEach(function (cell) {
      var code = $('.trade__code', cell);
      var paths = $$('.trade__ic path', cell);
      var frame = 0;
      var px = 0;
      var py = 0;
      var paint = function () {
        frame = 0;
        var r = cell.getBoundingClientRect();
        var x = px - r.left;
        var y = py - r.top;
        cell.style.setProperty('--mx', x.toFixed(0) + 'px');
        cell.style.setProperty('--my', y.toFixed(0) + 'px');
        cell.style.setProperty('--ang', (Math.atan2(y - r.height / 2, x - r.width / 2) * 180 / Math.PI + 90).toFixed(1) + 'deg');
      };
      cell.addEventListener('pointermove', function (e) {
        px = e.clientX;
        py = e.clientY;
        if (!frame) frame = window.requestAnimationFrame(paint);
      });
      cell.addEventListener('pointerenter', function (e) {
        px = e.clientX;
        py = e.clientY;
        paint();
        scramble(code, 380);
        if (hasGsap && paths.length) gsap.fromTo(paths, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.75, ease: 'power2.inOut', stagger: 0.06, overwrite: true, clearProps: 'strokeDashoffset' });
      });
    });
  }

  /* ── home, mouse only: the big "Hire a crew" buttons lean toward the pointer (CSS translate, apart from the press) ── */
  if (isV3 && finePointer && !reduceMotion) {
    $$('[data-magnet]').forEach(function (btn) {
      btn.addEventListener('pointermove', function (e) {
        var r = btn.getBoundingClientRect();
        var dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        var dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        btn.style.setProperty('--mgx', (Math.max(-1, Math.min(1, dx)) * 7).toFixed(1) + 'px');
        btn.style.setProperty('--mgy', (Math.max(-1, Math.min(1, dy)) * 5).toFixed(1) + 'px');
      });
      btn.addEventListener('pointerleave', function () {
        btn.style.setProperty('--mgx', '0px');
        btn.style.setProperty('--mgy', '0px');
      });
    });
  }

  if (!hasGsap || reduceMotion) return;

  var EXPO = 'expo.out';
  var ST = hasST ? window.ScrollTrigger : null;
  if (!ST) return;

  /* ── section titles: each sentence rises from its mask ── */
  $$('[data-lines]').forEach(function (title) {
    var from = { yPercent: 108, duration: 1.05, ease: EXPO, stagger: 0.1, clearProps: 'transform', scrollTrigger: { trigger: title, start: 'top 88%', once: true } };
    if (isV3) { from.rotation = 3; from.transformOrigin = '0% 100%'; }
    gsap.from($$('.ln > span', title), from);
  });

  /* ── home: section labels are typed in by the board (the real text stays for screen readers) ── */
  var scrambleOnReveal = isV3 ? $$('.eyebrow[data-reveal], .final__copy .tag[data-reveal]') : [];
  scrambleOnReveal.forEach(function (label) {
    var text = label.textContent;
    var real = document.createElement('span');
    real.className = 'sr-only';
    real.textContent = text;
    var shown = document.createElement('span');
    shown.setAttribute('aria-hidden', 'true');
    shown.textContent = text;
    label.textContent = '';
    label.appendChild(real);
    label.appendChild(shown);
    label.scrambleTarget = shown;
  });

  /* ── reveals ── */
  $$('[data-reveal]').forEach(function (group) {
    var items = group.hasAttribute('data-reveal-children') ? group.children : [group];
    gsap.from(items, { y: 22, opacity: 0, duration: 0.85, ease: EXPO, stagger: 0.08, clearProps: 'transform,opacity', scrollTrigger: { trigger: group, start: 'top 88%', once: true, onEnter: function () { if (group.scrambleTarget) scramble(group.scrambleTarget, 640); } } });
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
  /* home: the stamp lands with weight: it drops from above the paper, the ticket jolts, ink spatters around the frame */
  var ink = null;
  var makeInk = function () {
    var anySvg = $('svg');
    if (ink || !stamp || !anySvg) return ink;
    var NS = anySvg.namespaceURI;
    ink = document.createElementNS(NS, 'svg');
    ink.setAttribute('class', 'stamp__ink');
    ink.setAttribute('viewBox', '0 0 200 100');
    ink.setAttribute('preserveAspectRatio', 'none');
    ink.setAttribute('aria-hidden', 'true');
    [[6, 18, 3.2], [16, 84, 2.2], [192, 22, 2.6], [184, 88, 3.6], [100, 2, 1.8], [62, 97, 2.4], [140, 98, 1.6], [3, 54, 1.4], [198, 56, 2], [36, 6, 1.5]].forEach(function (d) {
      var c = document.createElementNS(NS, 'ellipse');
      c.setAttribute('cx', d[0]);
      c.setAttribute('cy', d[1]);
      c.setAttribute('rx', d[2] * 1.3);
      c.setAttribute('ry', d[2]);
      ink.appendChild(c);
    });
    stamp.appendChild(ink);
    return ink;
  };
  var stampIn = function () {
    if (!stamp) return;
    if (!isV3) {
      gsap.fromTo(stamp, { scale: 1.9, opacity: 0, rotation: -2 }, { scale: 1, opacity: 1, rotation: -8, duration: 0.42, ease: 'power4.in', overwrite: true, clearProps: 'transform,opacity', onComplete: function () {
        if (ticket) gsap.fromTo(ticket, { x: -3, y: 2 }, { x: 0, y: 0, duration: 0.35, ease: 'elastic.out(1.2, 0.4)', clearProps: 'transform' });
      } });
      return;
    }
    var inkEl = makeInk();
    var dots = inkEl ? $$('ellipse', inkEl) : [];
    if (dots.length) gsap.set(dots, { scale: 0, transformOrigin: '50% 50%' });
    gsap.timeline()
      .fromTo(stamp, { scale: 2.6, opacity: 0, rotation: 6, filter: 'blur(3px)' }, { scale: 1, opacity: 1, rotation: -8, filter: 'blur(0px)', duration: 0.36, ease: 'power4.in', overwrite: true })
      .add(function () {
        if (ticket) gsap.fromTo(ticket, { x: -7, y: 5, rotation: -0.8 }, { x: 0, y: 0, rotation: 0, duration: 0.7, ease: 'elastic.out(1.5, 0.28)', clearProps: 'transform' });
        if (dots.length) gsap.to(dots, { scale: function () { return 0.7 + Math.random() * 0.6; }, duration: 0.22, ease: 'expo.out', stagger: 0.012 });
      })
      .fromTo(stamp, { scale: 0.94 }, { scale: 1, duration: 0.3, ease: 'back.out(3)', clearProps: 'filter' });
  };
  var stampOut = function () {
    if (!stamp) return;
    gsap.to(stamp, { opacity: 0, duration: 0.2, overwrite: true });
    if (ink) gsap.to($$('ellipse', ink), { scale: 0, duration: 0.15 });
  };
  var howStage = $('[data-how-stage]');
  if (ticket && isV3 && howStage) {
    var hRows = $$('.ticket__row', ticket);
    var hVals = hRows.map(function (row) { return $('.ticket__v', row); });
    var hSteps = $$('[data-how-step]');
    var hRail = $('[data-how-rail]');
    var howEl = $('.how');
    var lit = -1;
    var light = function (k) {
      if (k === lit) return;
      lit = k;
      hSteps.forEach(function (s, i) { s.classList.toggle('is-on', i < k); });
      hRows.forEach(function (row, i) { row.classList.toggle('is-on', i === k - 1); });
    };
    /* tall desktop screens: the scene holds still while the request is filled in, one step per stretch of scroll;
       the stamp lands at the end and the page moves on (the scroll is never taken over: the pin only spaces it) */
    var pinMode = function () {
      howEl.classList.add('how--live');
      lit = -1;
      light(0);
      gsap.set(hVals, { clipPath: 'inset(0% 100% 0% 0%)' });
      if (stamp) gsap.set(stamp, { opacity: 0 });
      var stamped = false;
      var tl = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: {
        trigger: howStage,
        start: 'top top',
        end: function () { return '+=' + Math.round(window.innerHeight * 1.5); },
        pin: true,
        scrub: 0.5,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: function (self) {
          var p = self.progress;
          light(p < 0.04 ? 0 : p < 0.36 ? 1 : p < 0.68 ? 2 : 3);
          if (p >= 0.8 && !stamped) { stamped = true; stampIn(); }
          else if (p < 0.74 && stamped) { stamped = false; stampOut(); }
        }
      } });
      if (hRail) tl.fromTo(hRail, { scaleY: 0 }, { scaleY: 1, duration: 1 }, 0);
      [0.04, 0.36, 0.68].forEach(function (at, i) {
        if (hVals[i]) tl.to(hVals[i], { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.2, ease: 'steps(14)' }, at);
      });
      return function () {
        howEl.classList.remove('how--live');
        gsap.set(hVals, { clearProps: 'clipPath' });
        if (hRail) gsap.set(hRail, { clearProps: 'transform' });
        hSteps.forEach(function (s) { s.classList.remove('is-on'); });
        hRows.forEach(function (row) { row.classList.remove('is-on'); });
        if (stamp) gsap.set(stamp, { clearProps: 'opacity,transform,filter' });
        lit = -1;
      };
    };
    /* short desktop screens (the scene does not fit): no pin, each line writes in as its step passes the middle */
    var fillMode = function () {
      gsap.set(hVals, { clipPath: 'inset(0% 100% 0% 0%)' });
      if (stamp) gsap.set(stamp, { opacity: 0 });
      hSteps.forEach(function (step, i) {
        if (!hVals[i]) return;
        var last = i === hSteps.length - 1;
        ST.create({ trigger: step, start: 'top 70%', end: 'max', onEnter: function () {
          hRows.forEach(function (row, k) { row.classList.toggle('is-on', k === i); });
          gsap.to(hVals[i], { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.5, ease: 'steps(14)', overwrite: true });
          if (last) stampIn();
        }, onLeaveBack: function () {
          gsap.to(hVals[i], { clipPath: 'inset(0% 100% 0% 0%)', duration: 0.25, overwrite: true });
          if (last) stampOut();
        } });
      });
      return function () {
        gsap.set(hVals, { clearProps: 'clipPath' });
        hRows.forEach(function (row) { row.classList.remove('is-on'); });
        if (stamp) gsap.set(stamp, { clearProps: 'opacity,transform,filter' });
      };
    };
    mm.add('(min-width: 1024px)', function () {
      return howStage.offsetHeight > window.innerHeight + 4 ? fillMode() : pinMode();
    });
    /* phones and tablets: the lines write in one after the other, then the stamp */
    mm.add('(max-width: 1023px)', function () {
      if (stamp) gsap.set(stamp, { opacity: 0 });
      var t3 = gsap.timeline({ scrollTrigger: { trigger: ticket, start: 'top 72%', once: true } });
      hRows.forEach(function (row, i) {
        t3.call(function () { row.classList.add('is-on'); }, null, 0.18 + i * 0.32)
          .from(hVals[i], { clipPath: 'inset(0% 100% 0% 0%)', duration: 0.5, ease: 'steps(12)', clearProps: 'clipPath' }, 0.18 + i * 0.32);
      });
      t3.call(function () { hRows.forEach(function (row) { row.classList.remove('is-on'); }); stampIn(); }, null, 0.18 + hRows.length * 0.32 + 0.15);
      return function () { if (stamp) gsap.set(stamp, { clearProps: 'opacity,transform,filter' }); };
    });
  }
  if (ticket && !(isV3 && howStage)) {
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
  if (arrive && isV3) {
    /* home: the red tape unrolls from the edge of the screen and the shield is stamped onto its end */
    var ring = $('.arrive__ring', arrive);
    var atl3 = gsap.timeline({ scrollTrigger: { trigger: arrive, start: 'top 90%', toggleActions: 'play none none reverse' } });
    atl3.from($('.arrive__beam i', arrive), { scaleX: 0, ease: 'expo.inOut', duration: 1 }, 0)
      .from($('.arrive__shield', arrive), { y: -120, opacity: 0, scale: 1.7, rotation: -16, ease: 'power4.in', duration: 0.44 }, 0.74);
    if (ring) atl3.fromTo(ring, { scale: 0.55, opacity: 1 }, { scale: 1.75, opacity: 0, ease: 'expo.out', duration: 0.7, immediateRender: false }, 1.18);
    atl3.fromTo(arrive, { y: 6 }, { y: 0, ease: 'elastic.out(1.4, 0.3)', duration: 0.6, immediateRender: false, clearProps: 'transform' }, 1.18);
  } else if (arrive) {
    var atl = gsap.timeline({ scrollTrigger: { trigger: arrive, start: 'top 90%', toggleActions: 'play none none reverse' } });
    atl.from($('.arrive__beam i', arrive), { scaleX: 0, ease: 'expo.inOut', duration: 0.95 }, 0)
      .from($('.arrive__shield', arrive), { y: -80, opacity: 0, scale: 0.86, rotation: -6, ease: 'back.out(1.5)', duration: 0.6 }, 0.72);
  }

  /* ── home final: a hazard tape is pulled across the top edge as the night section comes in; the red hatch drifts ── */
  var wipe = $('[data-final-wipe]');
  if (wipe) gsap.fromTo(wipe, { scaleX: 0 }, { scaleX: 1, ease: 'none', scrollTrigger: { trigger: wipe.parentNode, start: 'top bottom', end: 'top 35%', scrub: 0.4 } });
  var hatch = isV3 ? $('.final__hatch') : null;
  if (hatch) {
    mm.add('(min-width: 1024px)', function () {
      gsap.fromTo(hatch, { y: -60 }, { y: 60, ease: 'none', scrollTrigger: { trigger: hatch.parentNode, start: 'top bottom', end: 'bottom top', scrub: true } });
    });
  }

  /* ── home "We supply the labor": the drywall comes off the wall. Four sheets drop away (scrubbed on desktop, played
     once on phones) and the crew opening the wall to the studs is behind them; the seal slides in last ── */
  var tear = isV3 ? $('[data-tearout]') : null;
  if (tear) {
    var sheets = $$('i', tear);
    var photo = $('img', tear.parentNode);
    var seal = $('.yours__seal', tear.parentNode);
    var tearTl = function (tl) {
      tl.to(sheets, { yPercent: 118, rotation: function (i) { return i % 2 ? 6 : -5; }, transformOrigin: function (i) { return i % 2 ? '100% 0%' : '0% 0%'; }, ease: 'power2.in', stagger: 0.11, duration: 0.55 }, 0);
      if (photo) tl.fromTo(photo, { scale: 1.16 }, { scale: 1, ease: 'power1.out', duration: 0.95 }, 0);
      if (seal) tl.from(seal, { xPercent: -106, ease: 'expo.out', duration: 0.4 }, 0.62);
      return tl;
    };
    tear.classList.add('is-armed');
    mm.add('(min-width: 1024px)', function () {
      tearTl(gsap.timeline({ scrollTrigger: { trigger: tear.parentNode, start: 'top 84%', end: 'top 30%', scrub: 0.5 } }));
      return function () { gsap.set(sheets.concat(photo ? [photo] : [], seal ? [seal] : []), { clearProps: 'transform' }); };
    });
    mm.add('(max-width: 1023px)', function () {
      tearTl(gsap.timeline({ scrollTrigger: { trigger: tear.parentNode, start: 'top 72%', once: true } }));
      return function () { gsap.set(sheets.concat(photo ? [photo] : [], seal ? [seal] : []), { clearProps: 'transform' }); };
    });
  }

  /* ── final (inner pages): the shield settles under the yard sign ── */
  var finalShield = $('.final__shield');
  if (finalShield) gsap.from(finalShield, { rotation: -14, scale: 0.7, opacity: 0, duration: 0.9, ease: 'back.out(1.7)', clearProps: 'transform,opacity', scrollTrigger: { trigger: finalShield, start: 'top 92%', once: true } });

  /* ── the photo of the crew opening a wall: uncovered from the bottom, like a wall going up ── */
  if (!tear) $$('.yours__photo img').forEach(function (img) {
    gsap.from(img, { clipPath: 'inset(100% 0% 0% 0%)', duration: 1.2, ease: 'expo.inOut', clearProps: 'clipPath', scrollTrigger: { trigger: img, start: 'top 85%', once: true } });
  });

  /* ── footer: the slogan rises from its line ── */
  var slogan = $$('.foot__in');
  if (slogan.length) gsap.from(slogan, { yPercent: 100, duration: 1.15, ease: EXPO, stagger: 0.12, clearProps: 'transform', scrollTrigger: { trigger: '[data-slogan]', start: 'top 90%', once: true } });

  /* images and fonts change heights: recalculate trigger positions */
  window.addEventListener('load', function () { ST.refresh(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { ST.refresh(); });
})();

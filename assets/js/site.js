/* site.js — page interactions and motion.
   Header button state, fixed bar, menu, trade preselection, focus on the request form, English/Spanish tabs and
   the motion system (the beam set in the hero, section reveals, the trade board, the request ticket, the shield).
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
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  var hasIO = 'IntersectionObserver' in window;

  if (hasST) gsap.registerPlugin(window.ScrollTrigger);

  /* ── trade preselection (board cells and ?trade= for ad groups) ── */
  var SERVICE_RE = /^[a-z-]{2,40}$/;
  var preselect = function (value) {
    if (!value || !SERVICE_RE.test(value)) return false;
    var found = false;
    $$('form[data-cs-form^="crew-"]').forEach(function (form) {
      var radio = form.querySelector('input[name="service"][value="' + value + '"]');
      if (radio) { radio.checked = true; found = true; }
    });
    return found;
  };
  try {
    preselect(new URLSearchParams(window.location.search).get('trade'));
  } catch (error) {
    /* URLSearchParams missing: no preselection */
  }

  /* ── focus the request form after a "Hire a crew" link scrolls to it ── */
  var focusRequest = function () {
    var form = $('#crew-hero');
    if (!form) return;
    var step = $('[data-cs-step]:not([hidden])', form);
    var field = step && $('input:not([type="hidden"]):not([tabindex="-1"]), textarea', step);
    if (!field) return;
    var checked = field.type === 'radio' && $('input[name="' + field.name + '"]:checked', step);
    var target = checked || field;
    setTimeout(function () {
      try { target.focus({ preventScroll: true }); } catch (error) { target.focus(); }
    }, reduceMotion ? 0 : 650);
  };
  $$('[data-focus-request]').forEach(function (link) {
    link.addEventListener('click', function () {
      preselect(link.getAttribute('data-trade'));
      focusRequest();
    });
  });

  /* ── header button: outlined while the hero form is on screen (one red button per screen) ── */
  var heroForm = $('[data-hero-form]');
  var hdrCta = $('.hdr__cta');
  var mbar = $('[data-mbar]');
  var menuOpen = false;
  var pastHero = false;
  var others = new Set();
  var updateBar = function () {
    if (mbar) mbar.classList.toggle('is-visible', pastHero && others.size === 0 && !menuOpen);
  };
  if (hasIO && heroForm) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (hdrCta) hdrCta.classList.toggle('is-quiet', entry.isIntersecting);
        pastHero = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      });
      updateBar();
    }).observe(heroForm);
    /* the fixed bar never sits on top of another form */
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
      set(true);
      var first = focusables()[1];
      if (first) setTimeout(function () { first.focus(); }, reduceMotion ? 0 : 120);
    };
    var closeMenu = function (returnFocus) {
      if (!menuOpen) return;
      set(false);
      document.body.style.overflow = prevOverflow;
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
    window.matchMedia('(min-width: 1024px)').addEventListener('change', function (mq) { if (mq.matches) closeMenu(false); });
    window.addEventListener('pagehide', function () { closeMenu(false); });
  })();

  /* ── English / Spanish tabs in the workers block (#unete opens in Spanish) ── */
  (function langs() {
    var list = $('[data-langs]');
    var section = $('#join');
    var tabs = $$('[data-lang-tab]', list || document);
    var panels = $$('[data-lang-panel]');
    if (!list || !section || tabs.length < 2 || panels.length < 2) return;
    list.setAttribute('role', 'tablist');
    var panelFor = function (lang) { return panels.filter(function (p) { return p.getAttribute('data-lang-panel') === lang; })[0]; };
    tabs.forEach(function (tab) {
      var lang = tab.getAttribute('data-lang-tab');
      var panel = panelFor(lang);
      tab.setAttribute('role', 'tab');
      if (panel) {
        tab.setAttribute('aria-controls', panel.id);
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
      }
    });
    var current = null;
    var select = function (lang, moveFocus) {
      if (!panelFor(lang)) return;
      current = lang;
      tabs.forEach(function (tab) {
        var on = tab.getAttribute('data-lang-tab') === lang;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        if (on && moveFocus) tab.focus();
      });
      panels.forEach(function (panel) { panel.hidden = panel.getAttribute('data-lang-panel') !== lang; });
      var title = $('#workers-title-' + lang);
      if (title) section.setAttribute('aria-labelledby', title.id);
      if (hasST) window.ScrollTrigger.refresh();
    };
    var fromHash = function () { return window.location.hash === '#unete' ? 'es' : null; };
    select(fromHash() || 'en', false);
    if (fromHash()) {
      /* land on the top of the block (the tabs), also after the browser re-applies the fragment on load */
      var land = function () { section.scrollIntoView(); };
      land();
      if (document.readyState !== 'complete') window.addEventListener('load', function () { if (window.location.hash === '#unete') land(); }, { once: true });
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(tab.getAttribute('data-lang-tab'), false); });
      tab.addEventListener('keydown', function (e) {
        var step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        var next = tabs[(i + step + tabs.length) % tabs.length];
        select(next.getAttribute('data-lang-tab'), true);
      });
    });
    /* links to #join / #unete pick the language before scrolling (the hidden panel has no box to scroll to) */
    $$('a[href="#unete"], a[href="#join"]').forEach(function (link) {
      link.addEventListener('click', function (e) {
        var lang = link.getAttribute('href') === '#unete' ? 'es' : 'en';
        e.preventDefault();
        select(lang, false);
        if (window.history && window.history.pushState) window.history.pushState(null, '', link.getAttribute('href'));
        section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
      });
    });
    window.addEventListener('hashchange', function () {
      var lang = fromHash() || (window.location.hash === '#join' ? 'en' : null);
      if (lang && lang !== current) select(lang, false);
    });
  })();

  /* "Join the team" in the workers block: focus the first trade of its own form after the scroll */
  $$('[data-focus-join]').forEach(function (link) {
    link.addEventListener('click', function () {
      var form = document.getElementById((link.getAttribute('href') || '').slice(1));
      var first = form && $('input[name="service"]', form);
      if (!first) return;
      setTimeout(function () {
        try { first.focus({ preventScroll: true }); } catch (error) { first.focus(); }
      }, reduceMotion ? 0 : 600);
    });
  });

  if (!hasGsap || reduceMotion) return;

  var EXPO = 'expo.out';

  /* ── hero: line 1 rises from its mask; the beam is carried in from the side and set in place ──
     The beam travels on x while slightly raised, then drops 10px and its solid shadow grows (weight landing).
     Desktop moves the whole beam; phone and tablet move each bar of the beam one after the other. */
  (function beam() {
    /* on a slow connection the script arrives after the headline was already painted in place: then it stays
       still (moving a beam the visitor has already read would look like a glitch) */
    var painted = window.performance && performance.getEntriesByType &&
      performance.getEntriesByType('paint').some(function (e) { return e.name === 'first-contentful-paint'; });
    if (painted || (window.performance && performance.now() > 1200)) return;
    var line = $('.hero__title .hl__in');
    var el = $('[data-beam]');
    if (!el) return;
    var targets = window.matchMedia('(min-width: 1024px)').matches ? [el] : $$('.beam__bar', el);
    if (!targets.length) return;
    var shadow = (getComputedStyle(targets[0]).getPropertyValue('--beam-sh') || '').trim() || '4px';
    var tl = gsap.timeline({
      delay: 0.12,
      onComplete: function () {
        targets.forEach(function (t) { t.style.removeProperty('--beam-sh'); });
        gsap.set(targets, { clearProps: 'transform' });
      }
    });
    if (line) tl.from(line, { yPercent: 105, duration: 0.9, ease: EXPO }, 0);
    targets.forEach(function (t, i) {
      var at = 0.22 + i * 0.12;
      tl.fromTo(t, {
        x: function () { return Math.max(180, window.innerWidth - t.getBoundingClientRect().left + 32); },
        y: -10,
        '--beam-sh': '0px'
      }, { x: 0, duration: 0.95, ease: EXPO, immediateRender: true }, at)
        .to(t, { y: 0, '--beam-sh': shadow, duration: 0.3, ease: 'power2.out' }, at + 0.72);
    });
  })();

  if (!hasST) return;
  var ST = window.ScrollTrigger;

  /* ── section titles slide into place like a piece set on its rack ── */
  $$('[data-slide]').forEach(function (el) {
    gsap.from(el, { x: -28, opacity: 0, duration: 0.9, ease: EXPO, clearProps: 'transform,opacity', scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
  });

  /* ── reveals ── */
  $$('[data-reveal]').forEach(function (group) {
    var items = group.hasAttribute('data-reveal-children') ? group.children : [group];
    gsap.from(items, { y: 20, opacity: 0, duration: 0.8, ease: EXPO, stagger: 0.07, clearProps: 'transform,opacity', scrollTrigger: { trigger: group, start: 'top 88%', once: true } });
  });

  /* ── trade board: cells switch on across the grid ── */
  var board = $('[data-tboard]');
  if (board) {
    gsap.from($$('.tcell, .tnote', board), {
      y: 18, opacity: 0, duration: 0.7, ease: EXPO, clearProps: 'transform,opacity',
      stagger: { grid: 'auto', from: 'start', amount: 0.45 },
      scrollTrigger: { trigger: board, start: 'top 85%', once: true }
    });
  }

  /* ── request ticket: each line is written in from the left ── */
  $$('[data-ticket]').forEach(function (ticket) {
    gsap.from($$('dd', ticket), { clipPath: 'inset(0% 100% 0% 0%)', duration: 0.75, ease: 'power3.out', stagger: 0.09, clearProps: 'clipPath', scrollTrigger: { trigger: ticket, start: 'top 82%', once: true } });
  });

  /* ── shield: the numbered markers switch on ── */
  var shield = $('[data-shield]');
  if (shield) {
    gsap.from($$('.mark', shield), { scale: 0, duration: 0.55, ease: 'back.out(2.2)', stagger: 0.12, clearProps: 'transform', scrollTrigger: { trigger: shield, start: 'top 78%', once: true } });
  }

  /* ── footer: the slogan rises from its line ── */
  var slogan = $$('.foot__in');
  if (slogan.length) gsap.from(slogan, { yPercent: 100, duration: 1.1, ease: EXPO, stagger: 0.12, clearProps: 'transform', scrollTrigger: { trigger: '.foot__slogan', start: 'top 90%', once: true } });

  /* images and fonts change heights: recalculate trigger positions */
  window.addEventListener('load', function () { ST.refresh(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { ST.refresh(); });
})();

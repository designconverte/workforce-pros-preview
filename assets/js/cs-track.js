/*!
 * cs-track.js v0.2.0 — tracking engine
 *
 * One event bus -> adapters per destination: GA4 (gtag), Google Ads (gtag), Meta Pixel (fbq)
 * or, in `gtm` mode, ONLY window.dataLayer.push (the client's GTM decides the tags).
 * Vanilla ES2020, classic script (IIFE), zero dependencies. Load with <script defer>
 * after cs-config.js and before cs-lead-form.js.
 *
 * Hard rules:
 *  - Zero PII in GA4 parameters, in GA4 page_location/page_referrer and in the dataLayer.
 *  - Lead user_data (email/phone) only reaches Google Ads enhanced conversions and Meta
 *    advanced matching, normalized + SHA-256 hashed in the browser. Never logged, never stored.
 *  - generate_lead only from `cs:lead` (server said ok:true) or the deduplicated thank-you backup.
 *  - `gtm` mode never loads nor calls gtag/fbq. `off` mode loads nothing.
 *  - CS_CONFIG.preview === true (static preview copy) forces `off`: no tag, no destination.
 *  - A broken config or a blocked storage never breaks the page.
 *
 * Snippet formats checked on 2026-10-22 against the official docs (P-07):
 *  developers.google.com/tag-platform/gtagjs/install · .../gtagjs/reference
 *  developers.google.com/tag-platform/security/guides/consent · support.google.com/tagmanager/answer/14847097
 *  support.google.com/google-ads/answer/13258081 · support.google.com/google-ads/answer/7548399
 *  developers.facebook.com/docs/meta-pixel/get-started · .../advanced/advanced-matching · .../reference
 *  developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const VERSION = '0.2.0';
  const DAY_MS = 86400000;
  const ATTR_KEY = 'cs_attr';
  const ATTR_TTL_MS = 90 * DAY_MS;
  const FBC_MAX_AGE_S = 90 * 86400;
  const LEAD_TRACKED_KEY = 'cs_lead_tracked'; // written by lead-form, read-only here
  const LEAD_SENT_KEY = 'cs_track_leads'; // written by this engine (lead_ids already sent)
  const LEAD_SENT_MAX = 20;
  const DEBUG_STORE_KEY = 'cs_debug';
  const SCROLL_MARKS = [25, 50, 75, 90];
  const ENGAGEMENT_MARKS = [15, 30, 60, 120];
  const VIDEO_MARKS = [25, 50, 75];
  const SECTION_RATIO = 0.5;
  const SECTION_DWELL_MS = 1000;
  const HASH_TIMEOUT_MS = 300;
  const MAX_PARAM_LEN = 100;
  const MAX_ATTR_LEN = 200;
  const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid'];
  const CONSENT_KEYS = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];
  const MODES = ['direct', 'gtm', 'off'];

  const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js?id=';
  const GTM_SRC = 'https://www.googletagmanager.com/gtm.js?id=';
  const FBQ_SRC = 'https://connect.facebook.net/en_US/fbevents.js';

  const ID_RE = {
    ga4: /^G-[A-Z0-9]{4,20}$/,
    ads: /^AW-\d{6,15}$/,
    label: /^[A-Za-z0-9_-]{1,64}$/,
    pixel: /^\d{6,20}$/,
    gtm: /^GTM-[A-Z0-9]{4,12}$/,
  };
  const LEAD_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
  const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
  const CLICK_ID_VALUE_RE = /^[A-Za-z0-9_-]{1,512}$/;
  const FB_COOKIE_RE = /^fb\.\d{1,2}\.\d{10,13}\.[A-Za-z0-9_.-]{1,512}$/;
  const HEX64_RE = /^[a-f0-9]{64}$/;

  /**
   * Canonical event table. `params` is the ALLOWLIST: any other key is dropped
   * before reaching any destination. meta: 'custom' -> fbq('trackCustom', <canonical name>).
   * ads: which google_ads label fires a conversion.
   */
  const EVENTS = Object.freeze({
    page_view: { ga4: null, params: [], meta: 'PageView' },
    scroll_depth: { ga4: 'scroll_depth', params: ['percent'], meta: 'custom' },
    section_view: { ga4: 'section_view', params: ['section'] },
    engagement_time: { ga4: 'engagement_milestone', params: ['seconds'], meta: 'custom' },
    cta_click: { ga4: 'cta_click', params: ['cta_id', 'location'], meta: 'custom' },
    float_click: { ga4: 'float_click', params: ['type'], meta: 'custom' },
    phone_click: { ga4: 'phone_click', params: ['location'], meta: 'Contact', contact: 'phone', ads: 'callLabel' },
    sms_click: { ga4: 'sms_click', params: ['location'], meta: 'Contact', contact: 'sms' },
    email_click: { ga4: 'email_click', params: ['location'], meta: 'Contact', contact: 'email' },
    form_start: { ga4: 'form_start', params: ['form_id'], meta: 'custom' },
    form_step: { ga4: 'form_step', params: ['form_id', 'step', 'step_name'], meta: 'custom' },
    form_error: { ga4: 'form_error', params: ['form_id', 'step', 'field', 'error'] },
    form_zip_out_of_area: { ga4: 'form_zip_out_of_area', params: ['form_id'], meta: 'custom' },
    form_submit: { ga4: 'form_submit', params: ['form_id'] },
    form_submit_error: { ga4: 'form_submit_error', params: ['form_id', 'reason'] },
    form_abandon: { ga4: 'form_abandon', params: ['form_id', 'last_step', 'last_field', 'seconds'], meta: 'custom' },
    generate_lead: { ga4: 'generate_lead', params: ['form_id', 'service', 'value', 'currency'], meta: 'Lead', ads: 'leadLabel' },
    video_progress: { ga4: 'video_progress', params: ['video_title', 'video_percent'], meta: 'custom' },
    faq_open: { ga4: 'faq_open', params: ['faq_id'] },
    gallery_open: { ga4: 'gallery_open', params: ['gallery'] },
    outbound_click: { ga4: 'outbound_click', params: ['link_domain'] },
  });

  /** Events the public API can never fire (generate_lead only from cs:lead). */
  const INTERNAL_ONLY = ['page_view', 'generate_lead'];

  /** DOM CustomEvents emitted by lead-form -> canonical event. cs:lead is separate. */
  const FORM_EVENTS = Object.freeze({
    'cs:form_start': 'form_start',
    'cs:form_step': 'form_step',
    'cs:form_error': 'form_error',
    'cs:form_zip_out_of_area': 'form_zip_out_of_area',
    'cs:form_submit': 'form_submit',
    'cs:form_submit_error': 'form_submit_error',
    'cs:form_abandon': 'form_abandon',
  });

  // ---------------------------------------------------------------------------
  // PII guard (pure)
  // ---------------------------------------------------------------------------
  const PII_KEY_TOKEN_RE =
    /(?:^|_)(?:e_?mail|email_?address|phone|phone_?number|tel|telephone|mobile|cell_?phone|first_?name|last_?name|full_?name|user_?name|customer_?name|contact_?name|address|street|street_?address|address_?line_?\d?|postal_?code|zip|zip_?code|user_?data|em|ph|fn|ln)(?:_|$)/;
  const EMAIL_VALUE_RE = /[^\s@<>()[\]\\,;:"]+@[^\s@]+\.[a-z]{2,}/i;
  const PHONE_VALUE_RE = /(?:^|[^\w])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?:[^\w]|$)/;

  /** True when a parameter KEY names personal data (email, phone, name, address, zip...). */
  function isPiiKey(key) {
    if (typeof key !== 'string' || !key) return false;
    const k = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[\s.-]+/g, '_')
      .toLowerCase();
    return k === 'name' || PII_KEY_TOKEN_RE.test(k);
  }

  /** True when a VALUE looks like an email address or a (US/E.164) phone number. */
  function looksLikePii(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    const s = String(value);
    return EMAIL_VALUE_RE.test(s) || PHONE_VALUE_RE.test(s);
  }

  function cleanValue(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      // eslint-disable-next-line no-control-regex
      const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_PARAM_LEN);
      return s ? s : undefined;
    }
    return undefined;
  }

  /**
   * Allowlist + PII scrub. Returns a NEW object with only the allowlisted keys of `name`,
   * minus PII-like keys/values, strings trimmed to 100 chars. Unknown event -> null.
   */
  function sanitizeParams(name, params) {
    const def = EVENTS[name];
    if (!def) return null;
    const src = params && typeof params === 'object' ? params : {};
    const out = {};
    for (const key of def.params) {
      if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
      if (isPiiKey(key)) continue;
      const v = cleanValue(src[key]);
      if (v === undefined || looksLikePii(v)) continue;
      out[key] = v;
    }
    return out;
  }

  /**
   * URL for GA4 page_location / page_referrer: drops the fragment, credentials and any query
   * parameter whose key or value is PII (click ids are kept: GA4 <-> Ads linking needs gclid).
   */
  function sanitizeUrl(href) {
    let u;
    try {
      u = new URL(String(href));
    } catch (e) {
      return '';
    }
    u.hash = '';
    u.username = '';
    u.password = '';
    const drop = [];
    u.searchParams.forEach((value, key) => {
      if (CLICK_IDS.indexOf(key.toLowerCase()) !== -1) return;
      if (isPiiKey(key) || looksLikePii(value)) drop.push(key);
    });
    for (const key of drop) u.searchParams.delete(key);
    return u.toString();
  }

  /** Copy for the debug overlay/console: PII-looking values redacted, hashes shortened. */
  function maskForDebug(value, key) {
    if (Array.isArray(value)) return value.map((v) => maskForDebug(v, key));
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = maskForDebug(value[k], k);
      return out;
    }
    if (typeof value === 'string' && HEX64_RE.test(value)) return 'sha256:' + value.slice(0, 8) + '…';
    if (key && isPiiKey(key) && value != null && value !== '') return '[redacted]';
    if (looksLikePii(value)) return '[redacted]';
    return value;
  }

  // ---------------------------------------------------------------------------
  // Enhanced conversions / advanced matching (pure + Web Crypto)
  // ---------------------------------------------------------------------------
  /**
   * trim + lowercase. With { gmailDots: true } (Google rule) removes the dots of the local part
   * of gmail.com / googlemail.com addresses. Invalid -> ''.
   */
  function normalizeEmail(raw, options) {
    if (typeof raw !== 'string') return '';
    let e = raw.trim().toLowerCase();
    if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return '';
    if (options && options.gmailDots) {
      const at = e.lastIndexOf('@');
      const domain = e.slice(at + 1);
      if (domain === 'gmail.com' || domain === 'googlemail.com') e = e.slice(0, at).replace(/\./g, '') + '@' + domain;
    }
    return e;
  }

  /** E.164 (`+1XXXXXXXXXX` for US). 10 digits -> +1; 11 starting with 1 -> +; '+' + 11..15 digits kept. */
  function normalizePhoneE164(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return '';
    const s = String(raw).trim();
    const digits = s.replace(/\D/g, '');
    if (s.charAt(0) === '+' && digits.length >= 11 && digits.length <= 15) return '+' + digits;
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
    return '';
  }

  async function sha256Hex(str, subtle) {
    if (!subtle || typeof subtle.digest !== 'function') throw new Error('subtle_crypto_unavailable');
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Normalizes and hashes lead user_data. Returns
   * { google: { sha256_email_address?, sha256_phone_number? } | null, meta: { em?, ph? } | null }.
   * Google phone = E.164 with '+'; Meta ph = digits with country code, no '+'. Throws without
   * Web Crypto: the caller then sends NO user data (never raw values).
   */
  async function hashUserData(userData, subtle) {
    const ud = userData && typeof userData === 'object' ? userData : {};
    const googleEmail = normalizeEmail(ud.email, { gmailDots: true });
    const metaEmail = normalizeEmail(ud.email);
    const phone = normalizePhoneE164(ud.phone);
    const google = {};
    const meta = {};
    if (googleEmail) google.sha256_email_address = await sha256Hex(googleEmail, subtle);
    if (phone) google.sha256_phone_number = await sha256Hex(phone, subtle);
    if (metaEmail) meta.em = await sha256Hex(metaEmail, subtle);
    if (phone) meta.ph = await sha256Hex(phone.slice(1), subtle);
    return {
      google: Object.keys(google).length ? google : null,
      meta: Object.keys(meta).length ? meta : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Attribution (pure)
  // ---------------------------------------------------------------------------
  function hostOf(href) {
    try {
      return new URL(String(href)).hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  /** origin + pathname only (no query/fragment: they can carry PII). Non-http(s) -> ''. */
  function originPath(href) {
    try {
      const u = new URL(String(href));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return (u.origin + u.pathname).slice(0, MAX_ATTR_LEN);
    } catch (e) {
      return '';
    }
  }

  function cleanAttrValue(v) {
    // eslint-disable-next-line no-control-regex
    return String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_ATTR_LEN);
  }

  /**
   * Touch of the current page view: utm_* (max 10), gclid/gbraid/wbraid/fbclid/msclkid,
   * landing, referrer, ts and type: 'campaign' | 'referral' | 'internal' | 'direct'.
   */
  function parseTouch(href, referrer, now) {
    let u;
    try {
      u = new URL(String(href));
    } catch (e) {
      return null;
    }
    const touch = { ts: now };
    let campaign = false;
    let utmCount = 0;
    u.searchParams.forEach((value, rawKey) => {
      const key = rawKey.toLowerCase();
      if (/^utm_[a-z0-9_]{1,40}$/.test(key)) {
        const v = cleanAttrValue(value);
        if (v && utmCount < 10 && !(key in touch) && !looksLikePii(v)) {
          touch[key] = v;
          utmCount++;
          campaign = true;
        }
      } else if (CLICK_IDS.indexOf(key) !== -1) {
        const v = String(value).trim(); // click ids are case sensitive: never modify them
        if (CLICK_ID_VALUE_RE.test(v) && !(key in touch)) {
          touch[key] = v;
          campaign = true;
        }
      }
    });
    touch.landing = originPath(u.href);
    const ref = referrer ? originPath(referrer) : '';
    if (ref) touch.referrer = ref;
    const refHost = ref ? hostOf(ref) : '';
    if (campaign) touch.type = 'campaign';
    else if (refHost && refHost !== hostOf(u.href)) touch.type = 'referral';
    else if (refHost) touch.type = 'internal';
    else touch.type = 'direct';
    return touch;
  }

  function isTouch(t) {
    return !!t && typeof t === 'object' && typeof t.ts === 'number' && Number.isFinite(t.ts);
  }

  /** Drops touches older than `ttl` (default 90 days) or absurdly in the future. */
  function pruneAttribution(stored, now, ttl) {
    const limit = typeof ttl === 'number' ? ttl : ATTR_TTL_MS;
    const s = stored && typeof stored === 'object' ? stored : {};
    const alive = (t) => (isTouch(t) && now - t.ts <= limit && t.ts <= now + DAY_MS ? t : null);
    return { v: 1, first: alive(s.first), last: alive(s.last) };
  }

  /**
   * First/last touch. Campaign or external-referral visits replace `last` (and seed `first`
   * when there is none or it expired). Direct/internal visits never overwrite a live touch.
   */
  function mergeAttribution(stored, touch, now, ttl) {
    const cur = pruneAttribution(stored, now, ttl);
    let first = cur.first;
    let last = cur.last;
    if (touch && (touch.type === 'campaign' || touch.type === 'referral')) {
      last = touch;
      if (!first) first = touch;
    } else if (touch) {
      if (!first) first = touch;
      if (!last) last = touch;
    }
    return { v: 1, first: first || null, last: last || null };
  }

  function readCookie(cookieStr, name) {
    const parts = String(cookieStr || '').split(';');
    for (const part of parts) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() !== name) continue;
      const v = part.slice(i + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch (e) {
        return v;
      }
    }
    return null;
  }

  /** `_ga` = GA1.1.<random>.<timestamp> -> client_id `<random>.<timestamp>`. */
  function gaClientIdFromCookie(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split('.');
    if (parts.length < 4 || !/^GA\d+$/.test(parts[0])) return null;
    const id = parts.slice(2).join('.');
    return /^\d+\.\d+$/.test(id) ? id : null;
  }

  /** Meta `_fbc` = fb.<subdomainIndex=1>.<creation ms>.<fbclid untouched>. Invalid fbclid -> null. */
  function buildFbc(fbclid, now) {
    if (typeof fbclid !== 'string' || !CLICK_ID_VALUE_RE.test(fbclid)) return null;
    return 'fb.1.' + Math.floor(now) + '.' + fbclid;
  }

  // ---------------------------------------------------------------------------
  // Lead dedupe (pure)
  // ---------------------------------------------------------------------------
  /** Accepts a plain id, a comma list, a JSON array, or a JSON object {lead_id|id|ids}. */
  function parseLeadIdList(raw) {
    if (raw == null || raw === '') return [];
    let v = raw;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.charAt(0) === '[' || s.charAt(0) === '{' || s.charAt(0) === '"') {
        try {
          v = JSON.parse(s);
        } catch (e) {
          v = s;
        }
      } else {
        v = s;
      }
    }
    let list;
    if (Array.isArray(v)) list = v;
    else if (v && typeof v === 'object') list = Array.isArray(v.ids) ? v.ids : [v.lead_id, v.id];
    else list = String(v).split(',');
    return list
      .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim() : ''))
      .filter((x) => LEAD_ID_RE.test(x));
  }

  /**
   * Thank-you backup fires only on the thank-you page, with a valid ?lead=, a WORKING storage
   * (otherwise every reload would fire again) and a lead_id nobody marked as sent.
   */
  function shouldFireBackup(o) {
    if (!o || !o.isThankYou || !o.storageOk) return false;
    const id = typeof o.leadId === 'string' ? o.leadId : '';
    if (!LEAD_ID_RE.test(id)) return false;
    const tracked = Array.isArray(o.trackedIds) ? o.trackedIds : [];
    const sent = Array.isArray(o.sentIds) ? o.sentIds : [];
    return tracked.indexOf(id) === -1 && sent.indexOf(id) === -1;
  }

  // ---------------------------------------------------------------------------
  // Page-reading helpers (pure)
  // ---------------------------------------------------------------------------
  function pendingMilestones(value, marks, sent) {
    const out = [];
    if (!(value >= 0)) return out;
    for (const m of marks) if (value >= m && !sent.has(m)) out.push(m);
    return out;
  }

  /** Bottom of the viewport relative to the document height, 0..100. */
  function scrollPercent(scrollTop, viewportHeight, docHeight) {
    if (!(docHeight > 0)) return 0;
    return Math.max(0, Math.min(100, ((scrollTop + viewportHeight) / docHeight) * 100));
  }

  /** >= 50% of the section visible, OR the section covers >= 50% of the viewport (tall sections). */
  function isSectionVisible(ratio, visibleHeight, viewportHeight) {
    return ratio >= SECTION_RATIO || (viewportHeight > 0 && visibleHeight >= viewportHeight * SECTION_RATIO);
  }

  /** Accumulates time only while the tab is visible. */
  function createVisibleClock(now, visible) {
    let acc = 0;
    let since = visible ? now() : null;
    return {
      show() {
        if (since === null) since = now();
      },
      hide() {
        if (since !== null) {
          acc += now() - since;
          since = null;
        }
      },
      elapsedMs() {
        return acc + (since !== null ? now() - since : 0);
      },
      isRunning() {
        return since !== null;
      },
    };
  }

  function resolveDebug(search, stored, param) {
    let v = null;
    try {
      v = new URLSearchParams(search || '').get(param || DEBUG_STORE_KEY);
    } catch (e) {
      v = null;
    }
    if (v === '1' || v === 'true') return { enabled: true, store: '1' };
    if (v === '0' || v === 'false') return { enabled: false, store: '0' };
    return { enabled: stored === '1', store: null };
  }

  function uuid(cryptoObj) {
    const c = cryptoObj || root.crypto;
    if (c && typeof c.randomUUID === 'function') {
      try {
        return c.randomUUID();
      } catch (e) {
        /* insecure context: fall through */
      }
    }
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // ---------------------------------------------------------------------------
  // Config + consent (pure)
  // ---------------------------------------------------------------------------
  function pickFirst(obj, keys) {
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    return null;
  }

  function validId(value, re, upper) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    let s = String(value).trim();
    if (upper) s = s.toUpperCase();
    return re.test(s) ? s : null;
  }

  /**
   * window.CS_CONFIG (camelCase) -> internal config. Also accepts snake_case aliases.
   * Invalid fields become null + a warning.
   */
  function normalizeConfig(raw) {
    const warnings = [];
    const r = raw && typeof raw === 'object' ? raw : {};
    const t = r.tracking && typeof r.tracking === 'object' ? r.tracking : {};
    if (!raw) warnings.push('window.CS_CONFIG missing: nothing external is loaded');

    let mode = pickFirst(t, ['mode']);
    if (mode === null) mode = 'direct';
    else mode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
    if (MODES.indexOf(mode) === -1) {
      warnings.push('invalid tracking.mode -> off');
      mode = 'off';
    }
    const preview = r.preview === true;
    if (preview) {
      if (mode !== 'off') warnings.push('preview: tracking off');
      mode = 'off';
    }

    const field = (keys, re, upper, label) => {
      const v = pickFirst(t, keys);
      if (v === null) return null;
      const ok = validId(v, re, upper);
      if (!ok) warnings.push('invalid tracking.' + label + ' ignored');
      return ok;
    };
    const ga4 = field(['ga4'], ID_RE.ga4, true, 'ga4');
    const metaPixel = field(['metaPixel', 'meta_pixel'], ID_RE.pixel, false, 'metaPixel');
    const gtm = field(['gtm'], ID_RE.gtm, true, 'gtm');

    let googleAds = null;
    const adsRaw = pickFirst(t, ['googleAds', 'google_ads']);
    if (adsRaw && typeof adsRaw === 'object') {
      const id = validId(adsRaw.id, ID_RE.ads, true);
      if (id) {
        const label = (a, b, name) => {
          const v = pickFirst(adsRaw, [a, b]);
          if (v === null) return null;
          const ok = validId(v, ID_RE.label, false);
          if (!ok) warnings.push('invalid googleAds.' + name + ' ignored');
          return ok;
        };
        googleAds = {
          id,
          leadLabel: label('leadLabel', 'lead_label', 'leadLabel'),
          callLabel: label('callLabel', 'call_label', 'callLabel'),
        };
      } else {
        warnings.push('invalid googleAds.id ignored');
      }
    } else if (adsRaw !== null) {
      warnings.push('invalid googleAds ignored');
    }

    let consentDefault = pickFirst(t, ['consentDefault', 'consent_default']);
    if (consentDefault === null) consentDefault = 'granted';
    else if (consentDefault !== 'granted' && consentDefault !== 'denied') {
      warnings.push('invalid consentDefault -> denied');
      consentDefault = 'denied';
    }

    let leadValue = null;
    const lv = pickFirst(t, ['leadValue', 'lead_value']);
    if (lv && typeof lv === 'object') {
      const value = Number(lv.value);
      const currency = typeof lv.currency === 'string' ? lv.currency.trim().toUpperCase() : '';
      if (Number.isFinite(value) && value >= 0 && /^[A-Z]{3}$/.test(currency)) leadValue = { value, currency };
      else warnings.push('invalid leadValue ignored');
    }

    let debugParam = pickFirst(t, ['debugParam', 'debug_param']);
    if (typeof debugParam !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(debugParam)) debugParam = 'cs_debug';

    if (mode === 'direct' && gtm) warnings.push('tracking.gtm ignored in direct mode');
    if (mode === 'gtm' && (ga4 || metaPixel || googleAds)) warnings.push('gtm mode: ga4/metaPixel/googleAds ignored (the GTM container owns the tags)');
    if (mode === 'gtm' && !gtm) warnings.push('gtm mode without tracking.gtm: dataLayer only, no container loaded');
    if (googleAds && !googleAds.leadLabel) warnings.push('googleAds.leadLabel missing: no lead conversion');

    return { mode, preview, ga4, metaPixel, googleAds, gtm, consentDefault, leadValue, debugParam, warnings };
  }

  function consentState(value) {
    const v = value === 'denied' ? 'denied' : 'granted';
    const o = {};
    for (const k of CONSENT_KEYS) o[k] = v;
    return o;
  }

  /** 'granted' | 'denied' | { ad_storage?, analytics_storage?, ad_user_data?, ad_personalization? } */
  function normalizeConsent(input, current) {
    if (input === 'granted' || input === 'denied') return consentState(input);
    if (!input || typeof input !== 'object') return null;
    const out = Object.assign({}, current || consentState('denied'));
    let changed = false;
    for (const k of CONSENT_KEYS) {
      if (input[k] === 'granted' || input[k] === 'denied') {
        out[k] = input[k];
        changed = true;
      }
    }
    return changed ? out : null;
  }

  // ---------------------------------------------------------------------------
  // Canonical event -> destination payloads (pure)
  // ---------------------------------------------------------------------------
  function resolveGa4Name(name, params) {
    if (name === 'video_progress') {
      const p = params ? params.video_percent : undefined;
      if (p === 0) return 'video_start';
      if (p === 100) return 'video_complete';
      return 'video_progress';
    }
    const def = EVENTS[name];
    return def ? def.ga4 : null;
  }

  /**
   * Builds the calls for every active destination. `params` must already be sanitized.
   * Each payload: { dest: 'ga4'|'gads'|'meta', args: [...] } or { dest: 'dataLayer', push: {...} }.
   * `extra` carries lead_id / event_id for generate_lead (never user data).
   */
  function buildPayloads(name, params, cfg, extra) {
    const def = EVENTS[name];
    const out = [];
    if (!def || !cfg || cfg.mode === 'off') return out;
    const p = params || {};
    const x = extra || {};
    const ga4Name = resolveGa4Name(name, p);

    if (cfg.mode === 'gtm') {
      if (name === 'page_view') return out; // GTM's own page view trigger owns it (no double page_view)
      const push = { event: ga4Name, cs_event: name };
      // every allowlisted key is set (undefined when absent) so GTM's data model never keeps stale values
      for (const k of def.params) push[k] = p[k];
      if (name === 'generate_lead') {
        push.lead_id = x.lead_id;
        push.event_id = x.event_id;
      }
      out.push({ dest: 'dataLayer', push });
      return out;
    }

    // direct mode
    if (cfg.ga4 && ga4Name) {
      out.push({ dest: 'ga4', args: ['event', ga4Name, Object.assign({}, p, { send_to: cfg.ga4 })] });
    }
    if (cfg.metaPixel && def.meta) {
      if (def.meta === 'custom') {
        out.push({ dest: 'meta', args: ['trackCustom', name, Object.assign({}, p)] });
      } else if (name === 'generate_lead') {
        const mp = {};
        if (p.service) mp.content_name = p.service;
        if (typeof p.value === 'number') mp.value = p.value;
        if (p.currency) mp.currency = p.currency;
        const opts = {};
        if (x.event_id) opts.eventID = x.event_id;
        out.push({ dest: 'meta', args: ['track', 'Lead', mp, opts] });
      } else if (def.contact) {
        out.push({ dest: 'meta', args: ['track', def.meta, Object.assign({ contact_method: def.contact }, p)] });
      } else {
        out.push({ dest: 'meta', args: ['track', def.meta] });
      }
    }
    if (cfg.googleAds && def.ads && cfg.googleAds[def.ads]) {
      const conv = { send_to: cfg.googleAds.id + '/' + cfg.googleAds[def.ads] };
      if (name === 'generate_lead') {
        if (typeof p.value === 'number') conv.value = p.value;
        if (p.currency) conv.currency = p.currency;
        if (x.lead_id) conv.transaction_id = x.lead_id;
      }
      out.push({ dest: 'gads', args: ['event', 'conversion', conv] });
    }
    return out;
  }

  /** Inserts the hashed user data right before the Ads lead conversion and the Meta Lead. */
  function withUserData(payloads, cfg, hashed) {
    const out = [];
    for (const pl of payloads) {
      if (hashed && hashed.google && pl.dest === 'gads' && pl.args[1] === 'conversion') {
        out.push({ dest: 'gads', args: ['set', 'user_data', Object.assign({}, hashed.google)] });
      }
      if (hashed && hashed.meta && pl.dest === 'meta' && pl.args[1] === 'Lead') {
        out.push({ dest: 'meta', args: ['init', cfg.metaPixel, Object.assign({}, hashed.meta)] });
      }
      out.push(pl);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Storage helpers (never throw)
  // ---------------------------------------------------------------------------
  function getStorage(win, kind) {
    try {
      const s = win[kind];
      if (!s) return null;
      s.setItem('__cs_t', '1');
      s.removeItem('__cs_t');
      return s;
    } catch (e) {
      return null;
    }
  }

  function sGet(s, k) {
    if (!s) return null;
    try {
      return s.getItem(k);
    } catch (e) {
      return null;
    }
  }

  function sSet(s, k, v) {
    if (!s) return false;
    try {
      s.setItem(k, v);
      return true;
    } catch (e) {
      return false;
    }
  }

  function sDel(s, k) {
    if (!s) return;
    try {
      s.removeItem(k);
    } catch (e) {
      /* ignore */
    }
  }

  function withTimeout(promise, ms, win) {
    return new Promise((resolve) => {
      const timer = win.setTimeout(() => resolve(null), ms);
      promise.then(
        (v) => {
          win.clearTimeout(timer);
          resolve(v);
        },
        () => {
          win.clearTimeout(timer);
          resolve(null);
        },
      );
    });
  }

  function safeJson(v) {
    try {
      return JSON.stringify(v);
    } catch (e) {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Tracker (browser runtime; injectable win/doc for tests)
  // ---------------------------------------------------------------------------
  function createTracker(win, doc, options) {
    if (win.csTrack && win.csTrack.version) return { api: win.csTrack, skipped: true }; // double include

    const opts = options || {};
    const clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const cfg = normalizeConfig(win.CS_CONFIG);
    const local = getStorage(win, 'localStorage');
    const session = getStorage(win, 'sessionStorage');
    const href = String((win.location && win.location.href) || '');
    const state = {
      pageView: false,
      leadFired: false,
      abandonSent: false,
      fbclid: null,
      formStarted: new Set(),
      leadsSent: new Set(),
      faqSeen: new Set(),
      pending: [],
    };
    let consent = consentState(cfg.consentDefault);
    const dbg = createDebugger();

    // ----- debug ---------------------------------------------------------------
    function createDebugger() {
      const resolved = resolveDebug(win.location && win.location.search, sGet(session, DEBUG_STORE_KEY), cfg.debugParam);
      if (resolved.store === '1') sSet(session, DEBUG_STORE_KEY, '1');
      else if (resolved.store === '0') sDel(session, DEBUG_STORE_KEY);
      if (!resolved.enabled) return null; // nothing below is created without the flag

      const rows = [];
      let panel = null;
      let list = null;
      let counter = null;
      const BTN = 'all:unset;cursor:pointer;padding:0 6px;border:1px solid #555;border-radius:4px;color:#f5f5f5;line-height:18px;';
      const el = (tag, css, text) => {
        const e = doc.createElement(tag);
        if (css) e.style.cssText = css;
        if (text !== undefined) e.textContent = text;
        return e;
      };
      function ensurePanel() {
        if (panel) return panel;
        if (!doc.body) return null;
        panel = el(
          'div',
          'position:fixed;left:max(8px,env(safe-area-inset-left));bottom:max(8px,env(safe-area-inset-bottom));' +
            'z-index:2147483647;width:min(360px,calc(100vw - 16px));max-height:40vh;display:flex;flex-direction:column;' +
            'background:#111;color:#f5f5f5;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
            'border:1px solid #444;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.45);',
        );
        panel.id = 'cs-track-debug';
        panel.setAttribute('role', 'log');
        panel.setAttribute('aria-label', 'cs-track debug log');
        const head = el('div', 'display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid #333;');
        const title = el('strong', 'flex:1;font-weight:600;', 'cs-track ' + VERSION + ' · ' + cfg.mode);
        counter = el('span', 'color:#bdbdbd;', '0');
        const toggle = el('button', BTN, '–');
        toggle.type = 'button';
        toggle.setAttribute('aria-label', 'Minimize debug log');
        toggle.setAttribute('aria-expanded', 'true');
        const close = el('button', BTN, '×');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close debug log');
        list = el('ol', 'list-style:none;margin:0;padding:0;overflow:auto;');
        toggle.addEventListener('click', () => {
          const show = list.style.display === 'none';
          list.style.display = show ? '' : 'none';
          toggle.setAttribute('aria-expanded', String(show));
        });
        close.addEventListener('click', () => {
          panel.style.display = 'none';
        });
        head.appendChild(title);
        head.appendChild(counter);
        head.appendChild(toggle);
        head.appendChild(close);
        panel.appendChild(head);
        panel.appendChild(list);
        doc.body.appendChild(panel);
        return panel;
      }
      function write(row) {
        rows.push(row);
        if (rows.length > 200) rows.shift();
        try {
          if (win.console && typeof win.console.table === 'function') win.console.table([row]);
        } catch (e) {
          /* ignore */
        }
        try {
          if (!ensurePanel()) return;
          const li = el('li', 'padding:4px 8px;border-top:1px solid #262626;word-break:break-word;');
          li.appendChild(el('span', 'color:#a3a3a3;', row.time + ' '));
          li.appendChild(el('strong', 'color:#7dd3fc;', row.event));
          li.appendChild(el('span', 'color:#d4d4d4;', ' → ' + row.destinations));
          li.appendChild(el('div', 'color:#e5e5e5;', row.params + (row.note ? '  // ' + row.note : '')));
          list.insertBefore(li, list.firstChild);
          while (list.children.length > 60) list.removeChild(list.lastChild);
          counter.textContent = String(rows.length);
        } catch (e) {
          /* the overlay never breaks the page */
        }
      }
      return {
        rows,
        log(name, params, destinations, note) {
          write({
            time: new Date(clock()).toISOString().slice(11, 23),
            event: name,
            destinations: destinations.length ? destinations.join(', ') : '(none)',
            params: safeJson(maskForDebug(params || {})),
            note: note ? String(note) : '',
          });
        },
        note(label, detail) {
          write({
            time: new Date(clock()).toISOString().slice(11, 23),
            event: '[' + label + ']',
            destinations: '-',
            params: detail ? String(detail) : '',
            note: '',
          });
        },
      };
    }

    function note(label, detail) {
      if (dbg) dbg.note(label, detail);
    }

    function describe(name, payloads) {
      const dests = [];
      if (name === 'page_view' && cfg.mode === 'direct') {
        if (cfg.ga4) dests.push('ga4 (config)');
        if (cfg.googleAds) dests.push('gads (config)');
      }
      for (const pl of payloads) if (dests.indexOf(pl.dest) === -1) dests.push(pl.dest);
      return dests;
    }

    // ----- dispatch ------------------------------------------------------------
    function runOne(pl) {
      try {
        if (pl.dest === 'dataLayer') {
          win.dataLayer = win.dataLayer || [];
          win.dataLayer.push(pl.push);
        } else if (pl.dest === 'meta') {
          if (typeof win.fbq === 'function') win.fbq.apply(win, pl.args);
        } else if (typeof win.gtag === 'function') {
          win.gtag.apply(win, pl.args);
        }
      } catch (e) {
        note('dispatch error', e && e.message);
      }
    }

    function run(payloads) {
      for (const pl of payloads) runOne(pl);
    }

    function emit(name, rawParams, extra, debugNote) {
      try {
        const params = sanitizeParams(name, rawParams);
        if (!params) return [];
        const payloads = buildPayloads(name, params, cfg, extra);
        run(payloads);
        if (dbg) dbg.log(name, params, describe(name, payloads), debugNote);
        return payloads;
      } catch (e) {
        note('error', e && e.message);
        return [];
      }
    }

    // ----- loaders -------------------------------------------------------------
    function hasScript(prefix) {
      const list = doc.getElementsByTagName('script');
      for (let i = 0; i < list.length; i++) {
        const src = list[i].src || (list[i].getAttribute && list[i].getAttribute('src')) || '';
        if (String(src).indexOf(prefix) === 0) return true;
      }
      return false;
    }

    function injectScript(src) {
      const s = doc.createElement('script');
      s.async = true;
      s.src = src;
      const first = doc.getElementsByTagName('script')[0];
      if (first && first.parentNode) first.parentNode.insertBefore(s, first);
      else (doc.head || doc.documentElement).appendChild(s);
    }

    function consentDefaultParams() {
      const def = Object.assign({}, consent);
      if (cfg.consentDefault === 'denied') def.wait_for_update = 500; // lets the client's banner update first
      return def;
    }

    /** gtag.js + Meta Pixel, only for the configured IDs. Consent default goes first. */
    function loadDirect() {
      if (cfg.ga4 || cfg.googleAds) {
        win.dataLayer = win.dataLayer || [];
        if (typeof win.gtag !== 'function') {
          win.gtag = function gtag() {
            // gtag.js needs the Arguments object itself, not an array
            // eslint-disable-next-line prefer-rest-params
            win.dataLayer.push(arguments);
          };
        }
        win.gtag('consent', 'default', consentDefaultParams());
        win.gtag('js', new Date());
        if (cfg.ga4) {
          const ga4Config = {};
          const location = sanitizeUrl(href);
          if (location) ga4Config.page_location = location;
          const ref = doc.referrer ? sanitizeUrl(doc.referrer) : '';
          if (ref) ga4Config.page_referrer = ref;
          win.gtag('config', cfg.ga4, ga4Config); // sends the GA4 page_view (send_page_view default)
        }
        if (cfg.googleAds) win.gtag('config', cfg.googleAds.id);
        if (!hasScript('https://www.googletagmanager.com/gtag/js')) {
          injectScript(GTAG_SRC + encodeURIComponent(cfg.ga4 || cfg.googleAds.id));
        }
      }
      if (cfg.metaPixel) {
        if (typeof win.fbq !== 'function') {
          // Same stub as the official base code (queue until fbevents.js loads)
          const n = function () {
            // eslint-disable-next-line prefer-rest-params
            if (n.callMethod) n.callMethod.apply(n, arguments);
            // eslint-disable-next-line prefer-rest-params
            else n.queue.push(arguments);
          };
          win.fbq = n;
          if (!win._fbq) win._fbq = n;
          n.push = n;
          n.loaded = true;
          n.version = '2.0';
          n.queue = [];
          if (!hasScript(FBQ_SRC)) injectScript(FBQ_SRC);
        }
        if (consent.ad_storage === 'denied') win.fbq('consent', 'revoke'); // before init (Meta GDPR guide)
        win.fbq('init', cfg.metaPixel);
      }
    }

    /** GTM container + dataLayer only. Never defines nor calls gtag/fbq. */
    function loadGtm() {
      win.dataLayer = win.dataLayer || [];
      const dlCommand = function () {
        // gtag-style command object (Arguments) understood by GTM's consent APIs
        // eslint-disable-next-line prefer-rest-params
        win.dataLayer.push(arguments);
      };
      dlCommand('consent', 'default', consentDefaultParams());
      if (!cfg.gtm) return;
      if (win.google_tag_manager && win.google_tag_manager[cfg.gtm]) return;
      if (hasScript('https://www.googletagmanager.com/gtm.js')) return;
      win.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
      injectScript(GTM_SRC + encodeURIComponent(cfg.gtm));
    }

    // ----- attribution ---------------------------------------------------------
    let attrMemory = null; // fallback when localStorage is blocked

    function readStoredAttribution() {
      const raw = sGet(local, ATTR_KEY);
      if (!raw) return attrMemory;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return attrMemory;
      }
    }

    function captureAttribution() {
      const touch = parseTouch(href, doc.referrer || '', clock());
      if (!touch) return;
      if (touch.fbclid) state.fbclid = touch.fbclid;
      const merged = mergeAttribution(readStoredAttribution(), touch, clock());
      attrMemory = merged;
      sSet(local, ATTR_KEY, JSON.stringify(merged));
    }

    function cookieString() {
      try {
        return String(doc.cookie || '');
      } catch (e) {
        return '';
      }
    }

    function getAttribution() {
      const pruned = pruneAttribution(readStoredAttribution(), clock());
      const out = {};
      if (pruned.first) out.first = Object.assign({}, pruned.first);
      if (pruned.last) out.last = Object.assign({}, pruned.last);
      const cookies = cookieString();
      const fbp = readCookie(cookies, '_fbp');
      if (fbp && FB_COOKIE_RE.test(fbp)) out.fbp = fbp;
      const fbc = readCookie(cookies, '_fbc');
      if (fbc && FB_COOKIE_RE.test(fbc)) out.fbc = fbc;
      const ga = gaClientIdFromCookie(readCookie(cookies, '_ga'));
      if (ga) out.ga_client_id = ga;
      return out;
    }

    /** Creates `_fbc` from ?fbclid= when absent — only with ad_storage granted. */
    function maybeWriteFbc() {
      if (!state.fbclid || consent.ad_storage !== 'granted') return;
      if (readCookie(cookieString(), '_fbc')) return;
      const value = buildFbc(state.fbclid, clock());
      if (!value) return;
      const secure = win.location && win.location.protocol === 'https:' ? '; Secure' : '';
      try {
        doc.cookie = '_fbc=' + value + '; Max-Age=' + FBC_MAX_AGE_S + '; Path=/; SameSite=Lax' + secure;
      } catch (e) {
        /* cookies blocked */
      }
    }

    // ----- consent -------------------------------------------------------------
    function setConsent(input) {
      const next = normalizeConsent(input, consent);
      if (!next) {
        note('setConsent rejected', safeJson(input));
        return false;
      }
      consent = next;
      try {
        if (cfg.mode === 'direct') {
          if (typeof win.gtag === 'function' && (cfg.ga4 || cfg.googleAds)) win.gtag('consent', 'update', Object.assign({}, next));
          if (typeof win.fbq === 'function' && cfg.metaPixel) win.fbq('consent', next.ad_storage === 'granted' ? 'grant' : 'revoke');
        } else if (cfg.mode === 'gtm') {
          win.dataLayer = win.dataLayer || [];
          (function () {
            // eslint-disable-next-line prefer-rest-params
            win.dataLayer.push(arguments);
          })('consent', 'update', Object.assign({}, next));
        }
      } catch (e) {
        note('consent error', e && e.message);
      }
      maybeWriteFbc();
      note('consent update', safeJson(next));
      return true;
    }

    // ----- lead ----------------------------------------------------------------
    function readSentLeads() {
      const ids = parseLeadIdList(sGet(session, LEAD_SENT_KEY)).concat(parseLeadIdList(sGet(local, LEAD_SENT_KEY)));
      return ids.filter((id, i) => ids.indexOf(id) === i);
    }

    function rememberSentLead(id) {
      const ids = readSentLeads().filter((x) => x !== id);
      ids.push(id);
      const json = JSON.stringify(ids.slice(-LEAD_SENT_MAX));
      sSet(session, LEAD_SENT_KEY, json);
      sSet(local, LEAD_SENT_KEY, json);
    }

    /**
     * generate_lead for every active destination, once per lead_id.
     * GA4 / dataLayer go first and synchronously (no user data exists there); then user_data is
     * hashed and the Ads conversion + Meta Lead are sent. user_data is never stored nor logged.
     */
    function handleLead(detail, source) {
      const d = detail && typeof detail === 'object' ? detail : {};
      const leadId = d.lead_id === undefined || d.lead_id === null ? '' : String(d.lead_id);
      if (!LEAD_ID_RE.test(leadId)) {
        note('generate_lead skipped', 'missing or invalid lead_id (' + source + ')');
        return Promise.resolve(false);
      }
      if (state.leadsSent.has(leadId) || readSentLeads().indexOf(leadId) !== -1) {
        note('generate_lead skipped', 'lead_id already sent (' + source + ')');
        return Promise.resolve(false);
      }
      state.leadsSent.add(leadId);
      state.leadFired = true;
      rememberSentLead(leadId);

      const eventId = typeof d.event_id === 'string' && EVENT_ID_RE.test(d.event_id) ? d.event_id : leadId;
      const lv = cfg.leadValue;
      const params = sanitizeParams('generate_lead', {
        form_id: d.form_id,
        service: d.service,
        value: lv ? lv.value : undefined,
        currency: lv ? lv.currency : undefined,
      });
      const payloads = buildPayloads('generate_lead', params, cfg, { lead_id: leadId, event_id: eventId });
      run(payloads.filter((pl) => pl.dest === 'ga4' || pl.dest === 'dataLayer'));
      const deferred = payloads.filter((pl) => pl.dest === 'gads' || pl.dest === 'meta');

      const userData = d.user_data;
      const subtle = win.crypto && win.crypto.subtle;
      const hashing =
        deferred.length && userData && typeof userData === 'object'
          ? withTimeout(hashUserData(userData, subtle), HASH_TIMEOUT_MS, win)
          : Promise.resolve(null);
      const job = hashing.then((hashed) => {
        run(withUserData(deferred, cfg, hashed));
        if (dbg) {
          const keys = hashed ? [].concat(Object.keys(hashed.google || {}), Object.keys(hashed.meta || {})) : [];
          dbg.log(
            'generate_lead',
            params,
            describe('generate_lead', payloads),
            source + '; lead_id=' + leadId + '; event_id=' + eventId + (keys.length ? '; hashed: ' + keys.join(',') : '; no user_data'),
          );
        }
        return true;
      });
      state.pending.push(job);
      return job;
    }

    function thankYouBackup() {
      const body = doc.body;
      if (!body || !body.getAttribute || body.getAttribute('data-cs-page') !== 'thank-you') return;
      let leadId = null;
      try {
        leadId = new URL(href).searchParams.get('lead');
      } catch (e) {
        leadId = null;
      }
      if (!leadId) return;
      const fire = shouldFireBackup({
        isThankYou: true,
        leadId,
        storageOk: !!session,
        trackedIds: parseLeadIdList(sGet(session, LEAD_TRACKED_KEY)),
        sentIds: readSentLeads(),
      });
      if (fire) handleLead({ form_id: 'thank-you', lead_id: leadId }, 'thank-you backup');
      else if (!session) note('thank-you backup skipped', 'storage unavailable (no dedupe possible)');
      else if (!LEAD_ID_RE.test(leadId)) note('thank-you backup skipped', 'invalid ?lead=');
      else note('thank-you backup skipped', 'lead_id already tracked');
    }

    // ----- collectors ----------------------------------------------------------
    function attr(el, name) {
      return el && el.getAttribute ? el.getAttribute(name) : null;
    }

    function locationOf(el) {
      const explicit = el.closest('[data-cta-location]');
      if (explicit) return attr(explicit, 'data-cta-location');
      if (el.closest('[data-float]')) return 'float';
      const section = el.closest('[data-section]');
      if (section) return attr(section, 'data-section') || section.id || 'section';
      if (el.closest('header')) return 'header';
      if (el.closest('footer')) return 'footer';
      if (el.closest('nav')) return 'nav';
      return 'body';
    }

    function outboundDomain(link) {
      try {
        const u = new URL(link.href || attr(link, 'href'), href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        return host && host !== hostOf(href) ? host : null;
      } catch (e) {
        return null;
      }
    }

    function onClick(e) {
      const t = e && e.target;
      if (!t || typeof t.closest !== 'function') return;
      const cta = t.closest('[data-cta]');
      if (cta) {
        emit('cta_click', {
          cta_id: attr(cta, 'data-cta-id') || attr(cta, 'data-cta') || cta.id || 'cta',
          location: locationOf(cta),
        });
      }
      const float = t.closest('[data-float]');
      if (float) emit('float_click', { type: attr(float, 'data-float-type') || attr(float, 'data-float') || 'float' });
      const link = t.closest('a[href]');
      if (link) {
        const raw = String(attr(link, 'href') || '').trim();
        if (/^tel:/i.test(raw)) emit('phone_click', { location: locationOf(link) });
        else if (/^sms:/i.test(raw)) emit('sms_click', { location: locationOf(link) });
        else if (/^mailto:/i.test(raw)) emit('email_click', { location: locationOf(link) });
        else {
          const domain = outboundDomain(link);
          if (domain) emit('outbound_click', { link_domain: domain });
        }
      }
      const gallery = t.closest('[data-gallery]');
      if (gallery) {
        const item = t.closest('a, button, img, [data-gallery-item]');
        if (item && gallery.contains(item)) emit('gallery_open', { gallery: attr(gallery, 'data-gallery') || 'gallery' });
      }
    }

    function startScroll() {
      const sent = new Set();
      let queued = false;
      const schedule = (fn) =>
        typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(fn) : win.setTimeout(fn, 100);
      function measure() {
        queued = false;
        const de = doc.documentElement || {};
        const body = doc.body || {};
        const top = win.scrollY || win.pageYOffset || de.scrollTop || 0;
        const vh = win.innerHeight || de.clientHeight || 0;
        const height = Math.max(de.scrollHeight || 0, body.scrollHeight || 0);
        for (const m of pendingMilestones(scrollPercent(top, vh, height), SCROLL_MARKS, sent)) {
          sent.add(m);
          emit('scroll_depth', { percent: m });
        }
        if (sent.size >= SCROLL_MARKS.length) win.removeEventListener('scroll', onScroll);
      }
      function onScroll() {
        if (queued) return;
        queued = true;
        schedule(measure);
      }
      win.addEventListener('scroll', onScroll, { passive: true });
    }

    function startEngagement() {
      const sent = new Set();
      const visible = createVisibleClock(clock, doc.visibilityState !== 'hidden');
      let timer = null;
      function check() {
        timer = null;
        for (const m of pendingMilestones(visible.elapsedMs() / 1000, ENGAGEMENT_MARKS, sent)) {
          sent.add(m);
          emit('engagement_time', { seconds: m });
        }
        schedule();
      }
      function schedule() {
        if (timer !== null) {
          win.clearTimeout(timer);
          timer = null;
        }
        if (!visible.isRunning()) return;
        const next = ENGAGEMENT_MARKS.find((m) => !sent.has(m));
        if (next === undefined) return;
        timer = win.setTimeout(check, Math.max(50, next * 1000 - visible.elapsedMs() + 25));
      }
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'hidden') visible.hide();
        else visible.show();
        schedule();
      });
      schedule();
    }

    function startSections() {
      if (typeof win.IntersectionObserver !== 'function' || typeof doc.querySelectorAll !== 'function') return;
      const els = doc.querySelectorAll('[data-section]');
      if (!els.length) return;
      const seen = new Set();
      const timers = new Map();
      const viewport = () => win.innerHeight || (doc.documentElement && doc.documentElement.clientHeight) || 0;
      const nameOf = (el) => cleanValue(attr(el, 'data-section') || el.id || '');
      const io = new win.IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            const el = en.target;
            const name = nameOf(el);
            if (!name || seen.has(name)) {
              io.unobserve(el);
              continue;
            }
            const visibleH = en.intersectionRect ? en.intersectionRect.height : 0;
            if (en.isIntersecting && isSectionVisible(en.intersectionRatio, visibleH, viewport())) {
              if (timers.has(el)) continue;
              timers.set(
                el,
                win.setTimeout(() => {
                  timers.delete(el);
                  if (seen.has(name) || doc.visibilityState === 'hidden') return;
                  seen.add(name);
                  io.unobserve(el);
                  emit('section_view', { section: name });
                }, SECTION_DWELL_MS),
              );
            } else if (timers.has(el)) {
              win.clearTimeout(timers.get(el));
              timers.delete(el);
            }
          }
        },
        { threshold: [0, 0.25, 0.5, 0.75, 1] },
      );
      for (let i = 0; i < els.length; i++) io.observe(els[i]);
    }

    const videoState = new WeakMap();
    function videoTitle(v) {
      const own = attr(v, 'data-track');
      if (own && own !== 'true') return own;
      const label = attr(v, 'title') || attr(v, 'aria-label');
      if (label) return label;
      try {
        const file = new URL(v.currentSrc || attr(v, 'src') || '', href).pathname.split('/').pop();
        if (file) return file;
      } catch (e) {
        /* ignore */
      }
      return 'video';
    }

    function onMedia(e) {
      const v = e && e.target;
      if (!v || typeof v.matches !== 'function' || !v.matches('video[data-track]')) return;
      let sent = videoState.get(v);
      if (!sent) {
        sent = new Set();
        videoState.set(v, sent);
      }
      const title = videoTitle(v);
      if (e.type === 'play' && !sent.has(0)) {
        sent.add(0);
        emit('video_progress', { video_title: title, video_percent: 0 });
      } else if (e.type === 'timeupdate' && v.duration > 0 && Number.isFinite(v.duration)) {
        for (const m of pendingMilestones((v.currentTime / v.duration) * 100, VIDEO_MARKS, sent)) {
          sent.add(m);
          emit('video_progress', { video_title: title, video_percent: m });
        }
      } else if (e.type === 'ended' && !sent.has(100)) {
        sent.add(100);
        emit('video_progress', { video_title: title, video_percent: 100 });
      }
    }

    function onToggle(e) {
      const d = e && e.target;
      if (!d || typeof d.matches !== 'function' || !d.matches('details[data-faq]') || !d.open) return;
      let id = attr(d, 'data-faq');
      if (!id && typeof d.querySelector === 'function') {
        const summary = d.querySelector('summary');
        id = summary ? summary.textContent : '';
      }
      id = cleanValue(String(id || '').replace(/\s+/g, ' ')) || 'faq';
      if (state.faqSeen.has(id)) return;
      state.faqSeen.add(id);
      emit('faq_open', { faq_id: id });
    }

    function onFormEvent(name, detail) {
      const d = detail && typeof detail === 'object' ? detail : {};
      if (name === 'form_start') {
        const fid = String(d.form_id || '');
        if (state.formStarted.has(fid)) return;
        state.formStarted.add(fid);
      }
      if (name === 'form_abandon') {
        if (state.abandonSent || state.leadFired) return;
        state.abandonSent = true;
      }
      emit(name, d);
    }

    function startListeners() {
      doc.addEventListener('click', onClick, true);
      // media and toggle events do not bubble: capture on document catches them
      doc.addEventListener('play', onMedia, true);
      doc.addEventListener('timeupdate', onMedia, true);
      doc.addEventListener('ended', onMedia, true);
      doc.addEventListener('toggle', onToggle, true);
      for (const evt of Object.keys(FORM_EVENTS)) {
        const name = FORM_EVENTS[evt];
        doc.addEventListener(evt, (e) => onFormEvent(name, e && e.detail));
      }
      doc.addEventListener('cs:lead', (e) => {
        handleLead(e && e.detail, 'cs:lead');
      });
    }

    // ----- public API ----------------------------------------------------------
    const api = {
      version: VERSION,
      event(name, params) {
        if (typeof name !== 'string' || !EVENTS[name] || INTERNAL_ONLY.indexOf(name) !== -1) {
          note('csTrack.event rejected', String(name));
          return false;
        }
        emit(name, params);
        return true;
      },
      getAttribution,
      eventId: () => uuid(win.crypto),
      setConsent,
      get debug() {
        return !!dbg;
      },
    };

    // ----- boot ----------------------------------------------------------------
    function step(label, fn) {
      try {
        fn();
      } catch (e) {
        note(label + ' failed', e && e.message);
      }
    }

    win.csTrack = api;
    for (const w of cfg.warnings) note('config', w);
    step('attribution', captureAttribution);
    step('loader', () => {
      if (cfg.mode === 'direct') loadDirect();
      else if (cfg.mode === 'gtm') loadGtm();
    });
    step('fbc', maybeWriteFbc);
    step('page_view', () => {
      if (state.pageView) return;
      state.pageView = true;
      emit('page_view', {});
    });
    step('listeners', startListeners);
    step('scroll', startScroll);
    step('engagement', startEngagement);
    step('sections', startSections);
    step('thank-you', thankYouBackup);

    return {
      api,
      cfg,
      flush: () => Promise.all(state.pending),
      debugRows: dbg ? dbg.rows : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Exports (Node tests) + browser auto-boot
  // ---------------------------------------------------------------------------
  const exported = {
    VERSION,
    EVENTS,
    FORM_EVENTS,
    INTERNAL_ONLY,
    SCROLL_MARKS,
    ENGAGEMENT_MARKS,
    ATTR_TTL_MS,
    isPiiKey,
    looksLikePii,
    sanitizeParams,
    sanitizeUrl,
    maskForDebug,
    normalizeEmail,
    normalizePhoneE164,
    sha256Hex,
    hashUserData,
    parseTouch,
    pruneAttribution,
    mergeAttribution,
    readCookie,
    gaClientIdFromCookie,
    buildFbc,
    parseLeadIdList,
    shouldFireBackup,
    pendingMilestones,
    scrollPercent,
    isSectionVisible,
    createVisibleClock,
    resolveDebug,
    uuid,
    normalizeConfig,
    consentState,
    normalizeConsent,
    resolveGa4Name,
    buildPayloads,
    withUserData,
    createTracker,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = exported;

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && root === window) {
    try {
      createTracker(window, document);
    } catch (e) {
      /* tracking must never break the page */
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
